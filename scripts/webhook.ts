import { Api } from 'grammy';
import { botConfigs } from '../src/config.js';
import { ensureBot } from '../src/runtime.js';
import { closeStore } from '../src/db.js';

const appUrl = process.env.APP_URL;
if (!appUrl) throw new Error('Set APP_URL');
const url = new URL('/api/webhook', appUrl);
if (url.protocol !== 'https:') throw new Error('APP_URL must use HTTPS');
try {
  const configs = botConfigs();
  await Promise.all(configs.map(config => ensureBot(config)));
  for (const config of configs) {
    url.searchParams.set('bot',config.id);
    const api = new Api(config.token,{ timeoutSeconds: 8 });
    await api.setWebhook(url.href, { secret_token: config.webhookSecret, allowed_updates: ['message', 'callback_query'], max_connections: 5 });
    await api.setMyCommands([
      { command: 'start', description: 'Главное меню' },
      { command: 'tasks', description: 'Мои задачи' },
      { command: 'group', description: 'Группа и личные имена' },
      { command: 'admin', description: 'Админка' },
      { command: 'new', description: 'Создать задачу' },
      { command: 'join', description: 'Вступить по коду' },
      { command: 'cancel', description: 'Отменить текущее действие' },
    ]);
    const info = await api.getWebhookInfo();
    console.log(`[${config.id}] Webhook configured: ${info.url}; pending updates: ${info.pending_update_count}`);
  }
} finally { await closeStore(); }
