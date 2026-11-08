export interface BotConfig {
  id: string; name: string; token: string; webhookSecret: string; adminIds: string[];
}
interface ConfigEntry { id?: unknown; name?: unknown; tokenEnv?: unknown; webhookSecretEnv?: unknown; adminIds?: unknown }
export function databaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.DATABASE_URL || env.DATABASE_POSTGRES_URL;
  if (!url) throw new Error('Set DATABASE_URL or the Neon integration variable DATABASE_POSTGRES_URL');
  return url;
}
export function botConfigs(env: NodeJS.ProcessEnv = process.env): BotConfig[] {
  const fallbackIds = (env.ADMIN_TELEGRAM_IDS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  let entries: ConfigEntry[];
  if (env.BOTS_JSON) {
    let value: unknown;
    try { value = JSON.parse(env.BOTS_JSON); } catch { throw new Error('BOTS_JSON must be a JSON array'); }
    if (!Array.isArray(value) || value.length < 1 || value.length > 20 || value.some(x => !x || typeof x !== 'object' || Array.isArray(x))) throw new Error('BOTS_JSON must contain 1 to 20 bot entries');
    entries = value;
  } else entries = [{ id: 'default', name: 'Task Tracker', tokenEnv: 'BOT_TOKEN', webhookSecretEnv: 'WEBHOOK_SECRET' }];
  const ids = new Set<string>(), tokenIds = new Set<string>(), secrets = new Set<string>();
  return entries.map(entry => {
    if (typeof entry.id !== 'string' || !/^[a-z][a-z0-9_-]{0,39}$/.test(entry.id) || ids.has(entry.id)) throw new Error('Bot IDs must be unique stable slugs (1-40 characters)');
    if (typeof entry.name !== 'string' || !entry.name.trim() || entry.name.length > 80) throw new Error('Each bot needs a name (1-80 characters)');
    const readSecret = (key: unknown) => {
      if (typeof key !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(key) || !env[key]) throw new Error('Each bot must reference populated token and webhook secret environment variables');
      return env[key]!;
    };
    const token = readSecret(entry.tokenEnv), webhookSecret = readSecret(entry.webhookSecretEnv);
    const telegramId = token.split(':')[0]!;
    if (!/^\d+:[A-Za-z0-9_-]+$/.test(token) || tokenIds.has(telegramId)) throw new Error('Each bot needs its own valid Telegram token');
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(webhookSecret) || secrets.has(webhookSecret)) throw new Error('Each bot needs a different webhook secret (32-256 allowed characters)');
    const adminIds = entry.adminIds === undefined ? fallbackIds : entry.adminIds;
    if (!Array.isArray(adminIds) || adminIds.some(x => typeof x !== 'string' || !/^[1-9]\d*$/.test(x))) throw new Error('adminIds must contain numeric Telegram IDs as strings');
    ids.add(entry.id); tokenIds.add(telegramId); secrets.add(webhookSecret);
    return { id: entry.id, name: entry.name.trim(), token, webhookSecret, adminIds };
  });
}
export function findBot(id: unknown, configs = botConfigs()): BotConfig | undefined {
  return typeof id === 'string' ? configs.find(bot => bot.id === id) : undefined;
}
