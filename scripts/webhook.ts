import { Api } from 'grammy';
import { token } from '../src/runtime.js';

const appUrl = process.env.APP_URL;
const secret = process.env.WEBHOOK_SECRET;
if (!appUrl || !secret || secret.length < 32 || !/^[A-Za-z0-9_-]+$/.test(secret)) throw new Error('Set APP_URL and a 32+ character WEBHOOK_SECRET (letters, digits, _ or -)');
const url = new URL('/api/webhook', appUrl);
if (url.protocol !== 'https:') throw new Error('APP_URL must use HTTPS');
const api = new Api(token());
await api.setWebhook(url.href, { secret_token: secret, allowed_updates: ['message', 'callback_query'], max_connections: 5 });
await api.setMyCommands([
  { command: 'start', description: 'Главное меню' },
  { command: 'tasks', description: 'Мои задачи' },
  { command: 'family', description: 'Семья и личные имена' },
  { command: 'history', description: 'Журнал за неделю' },
  { command: 'new', description: 'Создать задачу (админ)' },
  { command: 'join', description: 'Вступить по коду' },
  { command: 'cancel', description: 'Отменить текущее действие' },
]);
const info = await api.getWebhookInfo();
console.log(`Webhook configured: ${info.url}; pending updates: ${info.pending_update_count}`);
