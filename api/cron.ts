import type { VercelRequest, VercelResponse } from '@vercel/node';
import { matchesSecret } from '../src/security.js';
import { getStore } from '../src/db.js';
import { Service } from '../src/service.js';
import { deliver, ensureBot } from '../src/runtime.js';
import { botConfigs } from '../src/config.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).end(); }
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.authorization;
  if (!matchesSecret(typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : undefined, secret)) return res.status(401).end();
  try {
    const configs = botConfigs();
    const initialized = await Promise.allSettled(configs.map(config => ensureBot(config)));
    const results = [];
    let failed = false;
    for (const [index,config] of configs.entries()) {
      try {
        if (initialized[index]?.status !== 'fulfilled') throw new Error('Bot initialization failed');
        await getStore().transaction(async db => {
          await db.query('SELECT id FROM task_groups WHERE bot_id=$1 ORDER BY id FOR UPDATE',[config.id]);
          await new Service(db, `cron:${Date.now()}`,undefined,config.id).reminders();
          await db.query('DELETE FROM sessions WHERE bot_id=$1 AND expires_at<now()',[config.id]);
          await db.query("DELETE FROM processed_updates WHERE bot_id=$1 AND created_at<now()-interval '30 days'",[config.id]);
        });
        results.push({ bot: config.id, ...await deliver(config,25,Math.max(500,Math.floor(18000/configs.length))) });
      } catch {
        failed = true;
        console.error(`Reminder job failed for bot ${config.id}`);
        results.push({ bot: config.id,error: 'processing failed' });
      }
    }
    return res.status(failed ? 500 : 200).json({ ok: !failed, bots: results });
  } catch {
    console.error('Reminder job failed');
    return res.status(500).json({ ok: false });
  }
}
