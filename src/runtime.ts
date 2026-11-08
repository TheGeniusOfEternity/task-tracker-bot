import { Api } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import { getStore } from './db.js';
import { processUpdate } from './bot.js';
import { flushOutbox, telegramTransport } from './outbox.js';
import type { Update } from 'grammy/types';

let botInfoPromise: Promise<UserFromGetMe> | undefined;
export function token() {
  if (!process.env.BOT_TOKEN) throw new Error('BOT_TOKEN is required');
  return process.env.BOT_TOKEN;
}
export async function handleUpdate(update: Update) {
  const botToken = token();
  botInfoPromise ??= new Api(botToken).getMe().catch(error => { botInfoPromise = undefined; throw error; });
  await processUpdate(getStore(), update, {
    token: botToken, botInfo: await botInfoPromise,
    adminIds: (process.env.ADMIN_TELEGRAM_IDS ?? '').split(',').map(s => s.trim()).filter(Boolean),
  });
}
export async function deliver() { return flushOutbox(getStore(), telegramTransport(token())); }
