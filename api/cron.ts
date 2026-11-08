import type { VercelRequest, VercelResponse } from '@vercel/node';
import { matchesSecret } from '../src/security.js';
import { getStore } from '../src/db.js';
import { Service } from '../src/service.js';
import { deliver } from '../src/runtime.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).end(); }
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.authorization;
  if (!matchesSecret(typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : undefined, secret)) return res.status(401).end();
  try {
    await getStore().transaction(async db => {
      // Lock one row so overlapping invocations never generate duplicate reminders.
      await db.query('SELECT id FROM task_groups ORDER BY id FOR UPDATE');
      await new Service(db, `cron:${Date.now()}`).reminders();
      await db.query('DELETE FROM sessions WHERE expires_at<now()');
      await db.query("DELETE FROM processed_updates WHERE created_at<now()-interval '30 days'");
    });
    const result = await deliver();
    return res.status(200).json({ ok: true, ...result });
  } catch {
    console.error('Reminder job failed');
    return res.status(500).json({ ok: false });
  }
}
