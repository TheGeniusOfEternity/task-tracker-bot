import { Api } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import { getStore } from './db.js';
import { processUpdate } from './bot.js';
import { flushOutbox, telegramTransport } from './outbox.js';
import type { Update } from 'grammy/types';
import type { BotConfig } from './config.js';
import { bindBot } from './registry.js';

const botInfos = new Map<string,Promise<UserFromGetMe>>();
export async function ensureBot(config: BotConfig) {
  let promise = botInfos.get(config.token);
  if (!promise) {
    promise = new Api(config.token,{ timeoutSeconds: 8 }).getMe().catch(error => { botInfos.delete(config.token); throw error; });
    botInfos.set(config.token,promise);
  }
  const info = await promise;
  await bindBot(getStore(),config,info.id);
  return info;
}
export async function handleUpdate(update: Update, config: BotConfig) {
  await processUpdate(getStore(), update, {
    token: config.token, botInfo: await ensureBot(config), adminIds: config.adminIds,botId: config.id,
  });
}
export async function deliver(config: BotConfig, limit = 25, budgetMs = 18_000) {
  await ensureBot(config);
  return flushOutbox(getStore(),telegramTransport(config.token,Math.min(8000,budgetMs)),config.id,limit,budgetMs);
}
