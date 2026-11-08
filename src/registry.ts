import type { Database } from './db.js';
import type { BotConfig } from './config.js';

export async function bindBot(db: Database, config: Pick<BotConfig,'id' | 'name'>, telegramId: number) {
  const result = await db.query(`INSERT INTO bots (id,name,telegram_id) VALUES ($1,$2,$3)
    ON CONFLICT (id) DO UPDATE SET name=excluded.name,telegram_id=excluded.telegram_id
    WHERE bots.telegram_id IS NULL OR bots.telegram_id=excluded.telegram_id RETURNING id`, [config.id,config.name,telegramId]);
  if (!result.rows.length) throw new Error('Bot identity changed: keep the stable bot ID and its matching Telegram token');
}
