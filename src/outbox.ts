import type { Store } from './db.js';
import { Service } from './service.js';

export interface Delivery {
  id: number; method: string; payload: Record<string, unknown>; attempts: number;
  guard_help_id: number | null; recipient_id: number | null;
}
export class TelegramError extends Error {
  constructor(readonly code: number, readonly retryAfter?: number) { super(`Telegram error ${code}`); }
}
export type Transport = (method: string, payload: Record<string, unknown>) => Promise<{ message_id?: number }>;
export function telegramTransport(token: string, timeoutMs = 8000): Transport {
  return async (method, payload) => {
    if (!['sendMessage', 'editMessageReplyMarkup', 'answerCallbackQuery'].includes(method)) throw new Error('Unsupported outbox method');
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await response.json() as { ok: boolean; result: { message_id?: number }; error_code?: number; parameters?: { retry_after?: number } };
    if (!body.ok) throw new TelegramError(body.error_code ?? response.status, body.parameters?.retry_after);
    return typeof body.result === 'object' ? body.result : {};
  };
}
export async function flushOutbox(store: Store, transport: Transport, botId = 'default', limit = 25, budgetMs = 18_000) {
  let sent = 0, failed = 0;
  const deadline = Date.now() + budgetMs;
  for (let i = 0; i < limit && Date.now() < deadline; i++) {
    const job = await store.transaction(async db => {
      const selected = (await db.query<Delivery>(`SELECT id,method,payload,attempts,guard_help_id,recipient_id FROM outbox
        WHERE bot_id=$1 AND ((state='pending' AND available_at<=now()) OR (state='sending' AND lease_until<now()))
        ORDER BY (method='answerCallbackQuery') DESC,id FOR UPDATE SKIP LOCKED LIMIT 1`,[botId])).rows[0];
      if (!selected) return;
      if (selected.guard_help_id) {
        const state = (await db.query<{ state: string }>('SELECT state FROM help_requests WHERE id=$1', [selected.guard_help_id])).rows[0]?.state;
        if (state !== 'pending') { await db.query("UPDATE outbox SET state='sent' WHERE id=$1", [selected.id]); return { skip: true } as const; }
      }
      await db.query("UPDATE outbox SET state='sending',lease_until=now()+interval '45 seconds',attempts=attempts+1 WHERE id=$1", [selected.id]);
      return selected;
    });
    if (!job) break;
    if ('skip' in job) continue;
    try {
      const result = await transport(job.method, job.payload);
      await store.transaction(async db => {
        await db.query("UPDATE outbox SET state='sent',lease_until=NULL WHERE id=$1", [job.id]);
        if (job.guard_help_id && job.recipient_id && result.message_id) {
          await db.query('UPDATE help_recipients SET message_id=$1 WHERE request_id=$2 AND member_id=$3', [result.message_id, job.guard_help_id, job.recipient_id]);
          const state = (await db.query<{ state: string }>('SELECT state FROM help_requests WHERE id=$1', [job.guard_help_id])).rows[0]?.state;
          if (state !== 'pending') {
            const s = new Service(db, `late-help:${job.id}`,undefined,botId);
            await s.enqueue('editMessageReplyMarkup', { chat_id: job.payload.chat_id, message_id: result.message_id, reply_markup: { inline_keyboard: [] } });
          }
        }
      });
      sent++;
    } catch (error) {
      const permanent = error instanceof TelegramError && [400, 401, 403, 404].includes(error.code);
      const exhausted = job.attempts + 1 >= 8;
      const delay = error instanceof TelegramError && error.retryAfter ? error.retryAfter : Math.min(3600, 2 ** (job.attempts + 1) * 5);
      await store.query(`UPDATE outbox SET state=$1,lease_until=NULL,available_at=now()+($2 * interval '1 second') WHERE id=$3`,
        [permanent || exhausted ? 'dead' : 'pending', delay, job.id]);
      failed++;
      if (error instanceof TelegramError && error.code === 429) break;
    }
  }
  return { sent, failed };
}
