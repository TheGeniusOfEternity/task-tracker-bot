import type { VercelRequest, VercelResponse } from '@vercel/node';
import { matchesSecret } from '../src/security.js';
import { deliver, handleUpdate } from '../src/runtime.js';
import type { Update } from 'grammy/types';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).end(); }
  if (!matchesSecret(req.headers['x-telegram-bot-api-secret-token'], process.env.WEBHOOK_SECRET)) return res.status(401).end();
  const update = req.body as Update | undefined;
  if (!update || !Number.isSafeInteger(update.update_id)) return res.status(400).end();
  try {
    await handleUpdate(update);
    // Commit the domain operation before delivery. Retried Telegram updates are deduplicated.
    await deliver();
    return res.status(200).json({ ok: true });
  } catch {
    console.error('Webhook processing failed');
    return res.status(500).json({ ok: false });
  }
}
