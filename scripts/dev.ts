import { Bot } from 'grammy';
import { closeStore } from '../src/db.js';
import { deliver, ensureBot, handleUpdate } from '../src/runtime.js';
import { botConfigs } from '../src/config.js';

const configs = botConfigs();
const bots: Bot[] = [];
const timers: ReturnType<typeof setInterval>[] = [];
try {
  // Validate every bot before starting any polling process.
  for (const config of configs) {
    await ensureBot(config);
    const bot = new Bot(config.token);
    if ((await bot.api.getWebhookInfo()).url) throw new Error(`Bot ${config.id} has an active webhook. Use a separate development bot or explicitly remove the webhook first.`);
    bot.use(async ctx => { await handleUpdate(ctx.update,config); await deliver(config); });
    bot.catch(() => console.error(`Update failed for bot ${config.id}`));
    bots.push(bot);
  }
  for (const config of configs) {
    let delivering = false;
    timers.push(setInterval(() => {
      if (delivering) return;
      delivering = true;
      void deliver(config).catch(() => console.error(`Delivery retry failed for bot ${config.id}`)).finally(() => { delivering = false; });
    },15_000));
  }
  for (const signal of ['SIGINT','SIGTERM'] as const) process.once(signal,() => {
    for (const timer of timers) clearInterval(timer);
    void Promise.allSettled(bots.map(bot => bot.isRunning() ? bot.stop() : Promise.resolve()));
  });
  console.log(`Development bots listening: ${configs.map(c => c.id).join(', ')}. Stop with Ctrl+C.`);
  await Promise.all(bots.map(bot => bot.start()));
} finally {
  for (const timer of timers) clearInterval(timer);
  await Promise.allSettled(bots.map(bot => bot.isRunning() ? bot.stop() : Promise.resolve()));
  await closeStore();
}
