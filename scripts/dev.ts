import { Bot } from 'grammy';
import { closeStore } from '../src/db.js';
import { deliver, handleUpdate, token } from '../src/runtime.js';

const bot = new Bot(token());
const webhook = await bot.api.getWebhookInfo();
if (webhook.url) throw new Error('A webhook is active. Use a separate development bot, or explicitly remove the webhook first.');
bot.use(async ctx => { await handleUpdate(ctx.update); await deliver(); });
const timer = setInterval(() => { void deliver().catch(() => console.error('Delivery retry failed')); }, 15_000);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { clearInterval(timer); void bot.stop().finally(closeStore); });
console.log('Development bot is listening. Stop with Ctrl+C.');
await bot.start();
