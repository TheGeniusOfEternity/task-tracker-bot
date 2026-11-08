import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import type { QueryResultRow } from 'pg';
import pgDriver from 'pg';
import type { Database, Store } from '../src/db.js';
import { Service, type Member } from '../src/service.js';
import { processUpdate } from '../src/bot.js';
import { flushOutbox, TelegramError } from '../src/outbox.js';
import { matchesSecret, UserError } from '../src/security.js';
import { addDays, firstDue, localDay, nextDue, scheduleLabel, shouldRemind, validDay, weekdaysLabel, type Schedule } from '../src/schedule.js';
import webhook from '../api/webhook.js';
import cron from '../api/cron.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { Update } from 'grammy/types';
import { botConfigs, databaseUrl, findBot } from '../src/config.js';
import { bindBot } from '../src/registry.js';
import { failureDetails } from '../src/diagnostics.js';

const now = new Date('2026-11-08T16:00:00Z');
const options = { token: '123456:fake-test-token', adminIds: ['101'], now,
  botInfo: { id: 123456, is_bot: true as const, first_name: 'Test', username: 'test_bot', can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false, allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false } };
let pg: PGlite | undefined;
let pool: pgDriver.Pool | undefined;
let store: Store;
let a: Member, b: Member, c: Member, outsider: Member;
let sequence = 0;
const run = <T>(fn: (s: Service) => Promise<T>) => store.transaction(db => fn(new Service(db, `test:${sequence++}`, now)));
const runAt = <T>(day: string, fn: (s: Service) => Promise<T>) => store.transaction(db => fn(new Service(db, `day:${sequence++}`, new Date(`${day}T16:00:00Z`))));
const runFor = <T>(botId: string, fn: (s: Service) => Promise<T>) => store.transaction(db => fn(new Service(db, `bot:${sequence++}`,now,botId)));
const firstSaturday: Schedule = { kind: 'monthly_weekday', start: '2026-11-01', ordinal: 1, weekday: 6, overdue: 'weekends' };
function adapter(db: { query: PGlite['query'] }): Database {
  return { async query<T extends QueryResultRow>(sql: string, values?: unknown[]) { return { rows: (await db.query(sql, values)).rows as T[] }; } };
}
before(async () => {
  const sql = await readFile(new URL('../migrations/001_init.sql', import.meta.url), 'utf8')
    + '\n' + await readFile(new URL('../migrations/002_groups.sql', import.meta.url), 'utf8')
    + '\n' + await readFile(new URL('../migrations/003_coalesced_occurrences.sql', import.meta.url), 'utf8')
    + '\n' + await readFile(new URL('../migrations/004_multiple_bots.sql', import.meta.url), 'utf8');
  if (process.env.TEST_DATABASE_URL) {
    pool = new pgDriver.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 5 });
    await pool.query(sql);
    const p = pool;
    store = { query: (sql,values) => p.query(sql,values), async transaction(fn) {
      const client = await p.connect();
      try { await client.query('BEGIN'); const value = await fn(client); await client.query('COMMIT'); return value; }
      catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    } };
  } else {
    const embedded = new PGlite(); pg = embedded;
    await embedded.exec(sql);
    store = { ...adapter(embedded), transaction: fn => embedded.transaction(tx => fn(adapter(tx))) };
  }
});
beforeEach(async () => {
  await store.query('TRUNCATE app_users,task_groups,processed_updates RESTART IDENTITY CASCADE');
  await store.query("DELETE FROM bots WHERE id<>'default'");
  await store.query("UPDATE bots SET telegram_id=NULL WHERE id='default'");
  await run(async s => {
    for (const [uid, name] of [['101','Максим'],['102','Елена Иванова'],['103','Алексей'],['104','Чужой']]) {
      await s.db.query('INSERT INTO app_users (telegram_id,profile_name) VALUES ($1,$2)', [uid,name]);
    }
    a = await s.createGroup('101', 'Команда', ['101']);
    const code = await s.invite(a);
    await s.join('102', code); await s.join('103', code);
    b = await s.requireMember('102'); c = await s.requireMember('103');
    outsider = await s.createGroup('104', 'Другая группа', ['104']);
  });
});
after(async () => { await pg?.close(); await pool?.end(); });

async function otherBot() {
  await store.query("INSERT INTO bots (id,name) VALUES ('work','Рабочие задачи')");
  for (const uid of ['101','102','103','105']) await store.query('INSERT INTO app_users (bot_id,telegram_id,profile_name) VALUES ($1,$2,$3)',['work',uid,`Work ${uid}`]);
  const admin = await runFor('work',s => s.createGroup('101','Проект',['101']));
  const code = await runFor('work',s => s.invite(admin));
  await runFor('work',s => s.join('102',code));
  const member = await runFor('work',s => s.requireMember('102'));
  return { admin,member };
}

test('bot configuration supports old settings, secret references and Neon prefix', () => {
  const env = { BOT_TOKEN: options.token,WEBHOOK_SECRET: 'a'.repeat(32),ADMIN_TELEGRAM_IDS: '101, 102' };
  const single = botConfigs(env);
  assert.equal(single[0]!.id,'default');
  assert.deepEqual(single[0]!.adminIds,['101','102']);
  const config = [
    { id: 'default',name: 'Уборка',tokenEnv: 'BOT_TOKEN',webhookSecretEnv: 'WEBHOOK_SECRET' },
    { id: 'work',name: 'Работа',tokenEnv: 'WORK_TOKEN',webhookSecretEnv: 'WORK_SECRET',adminIds: ['103'] },
  ];
  const multi = { ...env,WORK_TOKEN: '223456:fake-work-token',WORK_SECRET: 'b'.repeat(32),BOTS_JSON: JSON.stringify(config) };
  const bots = botConfigs(multi);
  assert.equal(bots.length,2); assert.deepEqual(bots[1]!.adminIds,['103']);
  assert.equal(findBot('work',bots)?.token,multi.WORK_TOKEN);
  assert.equal(findBot('unknown',bots),undefined);
  assert.equal(findBot(['work'],bots),undefined);
  assert.throws(() => botConfigs({ ...multi,WORK_TOKEN: options.token }),/own valid/);
  assert.throws(() => botConfigs({ ...multi,WORK_SECRET: env.WEBHOOK_SECRET }),/different webhook secret/);
  assert.throws(() => botConfigs({ ...multi,BOTS_JSON: JSON.stringify([config[0],config[0]]) }),/unique/);
  assert.throws(() => botConfigs({ BOTS_JSON: 'bad json' }),/JSON array/);
  assert.equal(databaseUrl({ DATABASE_POSTGRES_URL: 'integration-url' }),'integration-url');
  assert.equal(databaseUrl({ DATABASE_URL: 'explicit',DATABASE_POSTGRES_URL: 'integration' }),'explicit');
  assert.throws(() => databaseUrl({}),/DATABASE_URL/);
});

test('failure diagnostics retain timeout categories without exposing nested credentials or payloads', () => {
  const cause = Object.assign(new Error('Connection timeout: postgres://user:secret@example/db'),{ code: 'ETIMEDOUT',query: 'secret SQL' });
  const result = failureDetails(new Error('token=secret', { cause }));
  assert.deepEqual(result,{ kind: 'Error',code: 'ETIMEDOUT',timeout: true });
  assert.equal(JSON.stringify(result).includes('secret'),false);
  assert.deepEqual(failureDetails({ name: 'secret',code: 'secret',message: 'private' }),{ kind: 'Error',timeout: false });
});

test('invitations contain one shareable deep link to the current bot and support joining', async () => {
  await update(message(910,'/invite'));
  const payload = (await store.query("SELECT payload FROM outbox WHERE method='sendMessage' ORDER BY id DESC LIMIT 1")).rows[0]!.payload;
  const match = payload.text.match(/https:\/\/t\.me\/test_bot\?start=join_([A-F0-9]+)/);
  assert.ok(match);
  assert.equal(payload.text.split(match[1]).length - 1,1);
  assert.equal(payload.text.includes('/join '),false);
  assert.equal(payload.reply_markup.inline_keyboard[0][0].url,match[0]);
  await update(message(911,`/start join_${match[1]}`,105));
  assert.equal((await run(s => s.requireMember('105'))).group_id,a.group_id);
  assert.equal((await run(s => s.requireMember('105'))).role,'member');
  await otherBot();
  await processUpdate(store,message(912,'/invite'),{ ...options,botId: 'work',botInfo: { ...options.botInfo,id: 223456,username: 'work_test_bot' } });
  const workPayload = (await store.query("SELECT payload FROM outbox WHERE bot_id='work' AND method='sendMessage' ORDER BY id DESC LIMIT 1")).rows[0]!.payload;
  assert.match(workPayload.text,/https:\/\/t\.me\/work_test_bot\?start=join_/);
});

test('group creation leaves the invitation visible until the user opens the menu', async () => {
  await processUpdate(store,message(920,'/create Новая группа',106),{ ...options,adminIds: ['106'] });
  const messages = (await store.query("SELECT payload FROM outbox WHERE payload->>'chat_id'='106' AND method='sendMessage'")).rows;
  assert.equal(messages.length,1);
  assert.match(messages[0]!.payload.text,/Группа создана/);
  assert.equal(messages[0]!.payload.reply_markup.inline_keyboard[1][0].callback_data,'menu');
});

test('opening an invite as an existing member shows an inline menu without changing groups', async () => {
  const anotherGroupCode = await run(s => s.invite(outsider));
  await update(message(950,`/start join_${anotherGroupCode}`));
  const reply = (await store.query("SELECT payload FROM outbox WHERE dedupe_key LIKE 'update:950:%' AND method='sendMessage'")).rows[0]!.payload;
  assert.match(reply.text,/Ты уже состоишь в группе/);
  assert.equal(reply.reply_markup.keyboard,undefined);
  const labels = reply.reply_markup.inline_keyboard.flat().map((button: { text: string }) => button.text);
  for (const label of ['📋 Мои задачи','👥 Группа','📖 Журнал','➕ Создать задачу','🔗 Приглашение']) assert.ok(labels.includes(label));
  assert.equal((await run(s => s.requireMember('101'))).group_id,a.group_id);
  assert.equal((await store.query("SELECT id FROM outbox WHERE dedupe_key LIKE 'error:950:%'")).rows.length,0);
});

test('fresh and repeated joins give ordinary members role-appropriate inline menus', async () => {
  const code = await run(s => s.invite(a));
  await update(message(951,`/start join_${code}`,105));
  for (const updateId of [951,952]) {
    if (updateId === 952) await update(message(952,`/join ${code}`,105));
    const reply = (await store.query("SELECT payload FROM outbox WHERE dedupe_key LIKE $1 AND method='sendMessage'",[`update:${updateId}:%`])).rows[0]!.payload;
    assert.equal(reply.reply_markup.keyboard,undefined);
    const labels = reply.reply_markup.inline_keyboard.flat().map((button: { text: string }) => button.text);
    assert.ok(labels.includes('👥 Группа'));
    assert.equal(labels.includes('➕ Создать задачу'),false);
    assert.equal(labels.includes('🔗 Приглашение'),false);
  }
  assert.equal((await run(s => s.requireMember('105'))).role,'member');
});

test('inline navigation exits a wizard and admin-only buttons remain protected', async () => {
  await update(callback(953,'new'));
  assert.equal((await run(s => s.session('101')))?.step,'task_title');
  await update(callback(954,'group'));
  assert.equal(await run(s => s.session('101')),undefined);
  assert.equal((await store.query('SELECT id FROM tasks')).rows.length,0);
  const groupView = (await store.query("SELECT payload FROM outbox WHERE dedupe_key='update:954:0'")).rows[0]!.payload;
  assert.match(groupView.text,/Участники группы/);
  await update(callback(955,'new',102));
  const denied = (await store.query("SELECT payload FROM outbox WHERE dedupe_key='error:955:0'")).rows[0]!.payload;
  assert.match(denied.text,/администратору/);
  assert.equal(denied.show_alert,true);
  await update(callback(956,'new'));
  await update(callback(957,'cancel'));
  assert.equal(await run(s => s.session('101')),undefined);
  const cancelled = (await store.query("SELECT payload FROM outbox WHERE dedupe_key='update:957:0'")).rows[0]!.payload;
  assert.equal(cancelled.reply_markup.keyboard,undefined);
  assert.ok(cancelled.reply_markup.inline_keyboard.length > 0);
});

test('an invalid invite leaves a guest with a working menu button', async () => {
  await update(message(958,'/start join_INVALID',105));
  assert.equal(await run(s => s.member('105')),undefined);
  const error = (await store.query("SELECT payload FROM outbox WHERE dedupe_key='error:958:0'")).rows[0]!.payload;
  assert.match(error.text,/Код не найден/);
  assert.equal(error.reply_markup.inline_keyboard[0][0].callback_data,'menu');
  await update(callback(959,'menu',105));
  const menu = (await store.query("SELECT payload FROM outbox WHERE dedupe_key='update:959:0'")).rows[0]!.payload;
  assert.match(menu.text,/Открой ссылку-приглашение/);
});

test('first menu removes the old reply keyboard once and retires the removal notice', async () => {
  await update(message(960,'/start'));
  await update(message(961,'/start'));
  const removals = (await store.query("SELECT payload FROM outbox WHERE dedupe_key='remove-reply-keyboard:101'")).rows;
  assert.equal(removals.length,1);
  assert.deepEqual(removals[0]!.payload.reply_markup,{ remove_keyboard: true });
  const sent: Record<string,unknown>[] = [],deleted: unknown[] = [];
  let messageId = 600;
  await flushOutbox(store,async (method,payload) => {
    if (method === 'sendMessage') { sent.push(payload); return { message_id: messageId++ }; }
    if (method === 'deleteMessage') deleted.push(payload.message_id);
    return {};
  });
  assert.deepEqual(deleted,[600,601]);
  assert.equal((sent.at(-1)!.reply_markup as { inline_keyboard: unknown[] }).inline_keyboard.length > 0,true);
  assert.equal(sent.some(p => !!(p.reply_markup as { keyboard?: unknown }).keyboard),false);
});

test('text prompts have an inline escape and old keyboard labels are ordinary task input', async () => {
  await update(callback(962,'new'));
  const prompt = (await store.query("SELECT payload FROM outbox WHERE dedupe_key='update:962:0'")).rows[0]!.payload;
  assert.deepEqual(prompt.reply_markup.inline_keyboard,[[{ text: 'Отмена',callback_data: 'cancel' }]]);
  assert.doesNotMatch(prompt.text,/отменит/);
  await update(message(963,'📋 Мои задачи'));
  assert.equal((await run(s => s.session('101')))?.title,'📋 Мои задачи');
  assert.equal((await run(s => s.session('101')))?.step,'task_owner');
  const choice = (await store.query("SELECT payload FROM outbox WHERE dedupe_key='update:963:0'")).rows[0]!.payload;
  assert.deepEqual(choice.reply_markup.inline_keyboard.at(-1).map((b: { callback_data: string }) => b.callback_data),['taskback','cancel']);
});

test('new screens delete previous bot screens after successful delivery, retaining notifications', async () => {
  await run(s => s.screen('101','Первый экран'));
  await run(s => s.send('101','Важное уведомление'));
  await run(s => s.screen('101','Второй экран'));
  const calls: { method: string; payload: Record<string,unknown> }[] = [];
  let messageId = 100;
  await flushOutbox(store,async (method,payload) => {
    assert.equal(Object.keys(payload).some(key => key.startsWith('__')),false);
    calls.push({ method,payload });
    return method === 'sendMessage' ? { message_id: messageId++ } : {};
  });
  assert.deepEqual(calls.filter(c => c.method === 'deleteMessage').map(c => c.payload.message_id),[100]);
  const current = (await store.query("SELECT payload FROM outbox WHERE payload->>'__screen'='true' AND payload->>'__retired'='false'")).rows;
  assert.equal(current.length,1); assert.equal(current[0]!.payload.__message_id,102);
});

test('failed replacement keeps the previous screen until the new screen is delivered', async () => {
  await run(s => s.screen('101','Первый'));
  await flushOutbox(store,async () => ({ message_id: 200 }));
  await run(s => s.screen('101','Второй'));
  await flushOutbox(store,async () => { throw new TelegramError(500); });
  assert.equal((await store.query("SELECT id FROM outbox WHERE method='deleteMessage'")).rows.length,0);
  await store.query("UPDATE outbox SET available_at=now()-interval '1 second' WHERE state='pending'");
  const removed: unknown[] = [];
  await flushOutbox(store,async (method,payload) => {
    if (method === 'deleteMessage') removed.push(payload.message_id);
    return method === 'sendMessage' ? { message_id: 201 } : {};
  });
  assert.deepEqual(removed,[200]);
});

test('late delivery of an older screen cannot replace or delete the newest screen', async () => {
  await run(s => s.screen('101','Старый'));
  await run(s => s.screen('101','Новый'));
  let release!: () => void,started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const active = new Promise<void>(resolve => { started = resolve; });
  const older = flushOutbox(store,async () => { started(); await gate; return { message_id: 301 }; },'default',1);
  await active;
  await flushOutbox(store,async () => ({ message_id: 302 }),'default',1);
  release(); await older;
  const removed: unknown[] = [];
  await flushOutbox(store,async (method,payload) => { if (method === 'deleteMessage') removed.push(payload.message_id); return {}; });
  assert.deepEqual(removed,[301]);
  const current = (await store.query("SELECT payload FROM outbox WHERE payload->>'__screen'='true' AND payload->>'__retired'='false'")).rows;
  assert.equal(current[0]!.payload.__message_id,302);
});

test('screen cleanup is isolated by bot and can retire the clicked legacy menu', async () => {
  await otherBot();
  await runFor('work',s => s.screen('101','Рабочий экран'));
  await flushOutbox(store,async () => ({ message_id: 401 }),'work');
  await update(callback(930,'group'));
  const removed: unknown[] = [];
  await flushOutbox(store,async (method,payload) => {
    if (method === 'deleteMessage') removed.push(payload.message_id);
    return method === 'sendMessage' ? { message_id: 402 } : {};
  });
  assert.deepEqual(removed,[1]);
  assert.equal((await store.query("SELECT payload FROM outbox WHERE bot_id='work' AND payload->>'__screen'='true'")).rows[0]!.payload.__retired,false);
});

test('history paginates on one screen instead of deleting earlier chunks of the same view', async () => {
  const t = await occurrence();
  await run(async s => { for (let i = 0;i < 13;i++) await s.event(t.id,a.id,'help_cancelled'); });
  await update(message(940,'/history'));
  let screens = (await store.query("SELECT payload FROM outbox WHERE dedupe_key LIKE 'update:940:%' AND method='sendMessage'")).rows;
  assert.equal(screens.length,1);
  assert.match(screens[0]!.payload.text,/страница 1/);
  assert.ok(screens[0]!.payload.text.length < 4096);
  assert.equal(screens[0]!.payload.reply_markup.inline_keyboard[0][0].callback_data,'history:1');
  await update(callback(941,'history:1'));
  screens = (await store.query("SELECT payload FROM outbox WHERE dedupe_key LIKE 'update:941:%' AND method='sendMessage'")).rows;
  assert.equal(screens.length,1); assert.match(screens[0]!.payload.text,/страница 2/);
});

test('an expired or already deleted old message does not prevent displaying the replacement', async () => {
  await run(s => s.screen('101','Старый'));
  await flushOutbox(store,async () => ({ message_id: 501 }));
  await run(s => s.screen('101','Новый'));
  await flushOutbox(store,async method => {
    if (method === 'deleteMessage') throw new TelegramError(400);
    return { message_id: 502 };
  });
  const current = (await store.query("SELECT payload,state FROM outbox WHERE payload->>'__message_id'='502'")).rows[0]!;
  assert.equal(current.state,'sent'); assert.equal(current.payload.__retired,false);
  assert.equal((await store.query("SELECT state FROM outbox WHERE method='deleteMessage'")).rows[0]!.state,'dead');
});

test('same Telegram users can belong to different bots with private names and groups', async () => {
  const { admin,member } = await otherBot();
  assert.equal(admin.telegram_id,a.telegram_id);
  assert.notEqual(admin.id,a.id);
  await run(s => s.alias(a,b.id,'Мама'));
  await runFor('work',s => s.alias(admin,member.id,'Координатор'));
  assert.equal(await run(s => s.name(a,b.id)),'Мама');
  assert.equal(await runFor('work',s => s.name(admin,member.id)),'Координатор');
  assert.equal((await runFor('work',s => s.members(admin))).length,2);
  assert.equal((await run(s => s.members(a))).length,3);
  await assert.rejects(runFor('work',s => s.alias(admin,b.id,'Другой')),UserError);
  await assert.rejects(runFor('work',s => s.members(a)),UserError);
  const code = await run(s => s.invite(a));
  await assert.rejects(runFor('work',s => s.join('105',code)),/Код не найден/);
});

test('identical update IDs and persistent wizards are independent for each bot', async () => {
  await otherBot();
  await processUpdate(store,message(800,'/new'),options);
  await processUpdate(store,message(800,'/group'),{ ...options,botId: 'work' });
  await processUpdate(store,message(800,'/new'),{ ...options,botId: 'work' }); // Retried ID is ignored in work only.
  assert.equal((await run(s => s.session('101')))?.step,'task_title');
  assert.equal(await runFor('work',s => s.session('101')),undefined);
  assert.equal((await store.query('SELECT bot_id FROM processed_updates WHERE update_id=800')).rows.length,2);
  await processUpdate(store,message(801,'/new'),{ ...options,botId: 'work' });
  await processUpdate(store,message(802,'Рабочая задача'),{ ...options,botId: 'work' });
  assert.equal((await runFor('work',s => s.session('101')))?.step,'task_owner');
  assert.equal((await run(s => s.session('101')))?.step,'task_title');
  await processUpdate(store,callback(803,`rename:${b.id}`),{ ...options,botId: 'work' });
  assert.equal((await store.query("SELECT payload FROM outbox WHERE bot_id='work' AND dedupe_key='error:803:0'")).rows[0]!.payload.show_alert,true);
});

test('task reads, help callbacks, completion and reminders stay within a bot', async () => {
  const { admin,member } = await otherBot();
  const t = await occurrence();
  await runFor('work',s => s.createTask(admin,'Рабочая проверка',admin.id,{ kind: 'once',start: '2026-11-08' }));
  const request = await run(s => s.requestHelp(a,t.id,[b.id]));
  await assert.rejects(runFor('work',s => s.occurrence(admin,t.id)),UserError);
  await assert.rejects(runFor('work',s => s.complete(admin,t.id)),UserError);
  await assert.rejects(runFor('work',s => s.acceptHelp(member,request)),UserError);
  await assert.rejects(runFor('work',s => s.materialize(a.group_id)),UserError);
  await runFor('work',s => s.reminders());
  const reminders = (await store.query("SELECT bot_id,payload FROM outbox WHERE dedupe_key LIKE 'reminder:%'")).rows;
  assert.equal(reminders.length,1); assert.equal(reminders[0]!.bot_id,'work');
  assert.match(reminders[0]!.payload.text,/Рабочая проверка/);
  assert.equal(reminders[0]!.payload.text.includes('Проверить отчёт'),false);
  assert.equal((await runFor('work',s => s.history(admin))).length,0);
});

test('outbox deduplication and sender selection are per bot', async () => {
  await otherBot();
  await store.query('DELETE FROM outbox');
  await run(s => s.send('101','Уборка',undefined,'shared-key'));
  await runFor('work',s => s.send('101','Работа',undefined,'shared-key'));
  const first: string[] = [],second: string[] = [];
  await flushOutbox(store,async (_method,payload) => { first.push(String(payload.text)); return {}; });
  assert.deepEqual(first,['Уборка']);
  assert.equal((await store.query("SELECT state FROM outbox WHERE bot_id='work'")).rows[0]!.state,'pending');
  await flushOutbox(store,async (_method,payload) => { second.push(String(payload.text)); return {}; },'work');
  assert.deepEqual(second,['Работа']);
});

test('database rejects mixed-bot memberships and registry prevents identity reuse', async () => {
  const { admin } = await otherBot();
  await assert.rejects(store.transaction(db => db.query(`INSERT INTO members (bot_id,group_id,telegram_id,role) VALUES ('work',$1,105,'member')`,[a.group_id])),/foreign key/i);
  await bindBot(store,{ id: 'default',name: 'Уборка' },123456);
  await bindBot(store,{ id: 'default',name: 'Переименованный' },123456);
  await assert.rejects(bindBot(store,{ id: 'default',name: 'Другой' },223456),/identity changed/);
  await assert.rejects(bindBot(store,{ id: 'work',name: 'Дубль' },123456),/unique|duplicate/i);
  assert.equal((await store.query("SELECT name FROM bots WHERE id='default'")).rows[0]!.name,'Переименованный');
  assert.equal((await runFor('work',s => s.requireMember('101'))).id,admin.id);
});

test('multiple-bot migration preserves legacy profiles, sessions, updates and pending delivery', async () => {
  const legacy = new PGlite();
  try {
    for (const name of ['001_init.sql','002_groups.sql','003_coalesced_occurrences.sql']) {
      await legacy.exec(await readFile(new URL(`../migrations/${name}`,import.meta.url),'utf8'));
    }
    await legacy.exec(`INSERT INTO app_users (telegram_id,profile_name) VALUES (201,'Админ'),(202,'Участник');
      INSERT INTO task_groups (name) VALUES ('Проект');
      INSERT INTO members (group_id,telegram_id,role) VALUES (1,201,'admin'),(1,202,'member');
      INSERT INTO sessions (telegram_id,data) VALUES (201,'{"step":"task_title"}');
      INSERT INTO processed_updates (update_id) VALUES (77);
      INSERT INTO tasks (group_id,title,owner_id,schedule) VALUES (1,'Проверка',1,'{"kind":"once","start":"2026-11-08"}');
      INSERT INTO occurrences (task_id,group_id,due_on,original_owner_id,assignee_id,coalesced) VALUES (1,1,'2026-11-08',1,1,true);
      INSERT INTO help_requests (occurrence_id,requester_id) VALUES (1,1);
      INSERT INTO help_recipients (request_id,member_id,message_id) VALUES (1,2,42);
      INSERT INTO outbox (dedupe_key,method,payload,guard_help_id,recipient_id) VALUES ('legacy','sendMessage','{"chat_id":202,"text":"Помоги"}',1,2);`);
    await legacy.exec(await readFile(new URL('../migrations/004_multiple_bots.sql',import.meta.url),'utf8'));
    for (const table of ['app_users','members','task_groups','sessions','processed_updates','outbox']) {
      const rows = (await legacy.query<{ bot_id: string }>(`SELECT bot_id FROM ${table}`)).rows;
      assert.ok(rows.length); assert.ok(rows.every(row => row.bot_id === 'default'));
    }
    assert.equal((await legacy.query<{ step: string }>("SELECT data->>'step' AS step FROM sessions")).rows[0]!.step,'task_title');
    assert.equal((await legacy.query<{ message_id: number }>('SELECT message_id FROM help_recipients')).rows[0]!.message_id,42);
    await legacy.exec(`INSERT INTO bots (id,name) VALUES ('work','Работа');
      INSERT INTO app_users (bot_id,telegram_id,profile_name) VALUES ('work',201,'Другой профиль');
      INSERT INTO processed_updates (bot_id,update_id) VALUES ('work',77);
      INSERT INTO sessions (bot_id,telegram_id,data) VALUES ('work',201,'{"step":"join"}');
      INSERT INTO outbox (bot_id,dedupe_key,method,payload) VALUES ('work','legacy','sendMessage','{"chat_id":201,"text":"Работа"}');`);
    assert.equal((await legacy.query('SELECT bot_id FROM processed_updates WHERE update_id=77')).rows.length,2);
    assert.equal((await legacy.query('SELECT bot_id FROM sessions WHERE telegram_id=201')).rows.length,2);
    assert.equal((await legacy.query("SELECT bot_id FROM outbox WHERE dedupe_key='legacy'")).rows.length,2);
  } finally { await legacy.close(); }
});

test('webhook routing requires the selected bot secret and retains the legacy default URL', async () => {
  const variables: NodeJS.ProcessEnv = {
    BOT_TOKEN: options.token,WEBHOOK_SECRET: 'a'.repeat(32),WORK_BOT_TOKEN: '223456:work-test',WORK_WEBHOOK_SECRET: 'b'.repeat(32),
    BOTS_JSON: JSON.stringify([
      { id: 'default',name: 'Основной',tokenEnv: 'BOT_TOKEN',webhookSecretEnv: 'WEBHOOK_SECRET' },
      { id: 'work',name: 'Рабочий',tokenEnv: 'WORK_BOT_TOKEN',webhookSecretEnv: 'WORK_WEBHOOK_SECRET' },
    ]),
  };
  const saved = Object.fromEntries(Object.keys(variables).map(key => [key,process.env[key]]));
  Object.assign(process.env,variables);
  try {
    for (const [bot,secret,expected] of [
      ['work','a'.repeat(32),401],['work','b'.repeat(32),400],['default','a'.repeat(32),400],
      [undefined,'a'.repeat(32),400],[['work'],'b'.repeat(32),401],['unknown','b'.repeat(32),401],
    ] as const) {
      let status = 0;
      const response = { status(code: number) { status = code; return this; },end() {},json() {} };
      await webhook({ method: 'POST',query: { bot },headers: { 'x-telegram-bot-api-secret-token': secret },body: {} } as unknown as VercelRequest,response as unknown as VercelResponse);
      assert.equal(status,expected);
    }
  } finally {
    for (const [key,value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

async function occurrence(kind: 'once' | 'daily' = 'once') {
  await run(s => s.createTask(a, 'Проверить отчёт', a.id, { kind, start: '2026-11-08' }));
  return (await run(s => s.tasks(a, a.id)))[0]!;
}
function message(updateId: number, text: string, uid = 101): Update {
  return { update_id: updateId, message: { message_id: updateId, date: 1794153600, chat: { id: uid, type: 'private', first_name: 'Максим' }, from: { id: uid, first_name: uid === 101 ? 'Максим' : 'Елена Иванова', is_bot: false }, text,
    ...(text.startsWith('/') ? { entities: [{ type: 'bot_command' as const, offset: 0, length: text.split(' ')[0]!.length }] } : {}) } };
}
function callback(updateId: number, data: string, uid = 101): Update {
  return { update_id: updateId, callback_query: { id: `cb${updateId}`, chat_instance: 'test', data,
    from: { id: uid, is_bot: false, first_name: uid === 101 ? 'Максим' : 'Елена Иванова' },
    message: { message_id: 1, date: 1794153600, chat: { id: uid, type: 'private', first_name: 'Test' }, text: 'menu' } } };
}
async function update(value: Update) { await processUpdate(store, value, options); }

test('date and recurrence rules cover Moscow midnight, leap years and short months', () => {
  assert.equal(localDay(new Date('2026-11-08T21:30:00Z')), '2026-11-09');
  assert.equal(validDay('2026-02-30'), false);
  assert.equal(validDay('2028-02-29'), true);
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(firstDue({ kind: 'weekly', start: '2026-11-08', weekdays: [1,3,5] }), '2026-11-09');
  assert.equal(nextDue({ kind: 'weekly', start: '2026-11-08', weekdays: [1,3,5] }, '2026-11-13'), '2026-11-16');
  const monthly = { kind: 'monthly' as const, start: '2028-01-31' };
  assert.equal(nextDue(monthly, '2028-01-31'), '2028-02-29');
  assert.equal(nextDue(monthly, '2028-02-29'), '2028-03-31');
  assert.equal(nextDue({ kind: 'once', start: '2026-11-08' }, '2026-11-08'), null);
});

test('monthly weekday calendar handles first/last dates, leap years and year rollover', () => {
  assert.equal(firstDue(firstSaturday), '2026-11-07');
  assert.equal(firstDue({ ...firstSaturday,start: '2026-11-07' }), '2026-11-07');
  assert.equal(firstDue({ ...firstSaturday,start: '2026-11-08' }), '2026-12-05');
  assert.equal(nextDue(firstSaturday,'2026-12-05'), '2027-01-02');
  assert.equal(firstDue({ kind: 'monthly_weekday',start: '2028-02-01',ordinal: -1,weekday: 2 }), '2028-02-29');
  assert.equal(firstDue({ kind: 'monthly_weekday',start: '2026-02-01',ordinal: 4,weekday: 6 }), '2026-02-28');
  assert.equal(firstDue({ ...firstSaturday,start: '2026-08-01' }), '2026-08-01');
  assert.equal(shouldRemind(firstSaturday,'2026-11-07','2026-11-06'),false);
  assert.equal(shouldRemind(firstSaturday,'2026-11-07','2026-11-07'),true);
  assert.equal(shouldRemind(firstSaturday,'2026-11-07','2026-11-08'),true);
  assert.equal(shouldRemind(firstSaturday,'2026-11-07','2026-11-09'),false);
  assert.equal(shouldRemind(firstSaturday,'2026-11-07','2026-11-14'),true);
  assert.equal(shouldRemind({ ...firstSaturday,weekday: 2 },'2026-11-03','2026-11-03'),true);
});

test('missed monthly cycles retain one task and remind on weekends only', async () => {
  const taskId = await runAt('2026-11-01',s => s.createTask(a,'Месячная проверка',a.id,firstSaturday));
  const pending = async () => (await store.query('SELECT id,due_on::text FROM occurrences WHERE task_id=$1 AND completed_at IS NULL',[taskId])).rows;
  const firstId = (await pending())[0]!.id;
  for (const day of ['2026-11-07','2026-11-08','2026-11-09','2026-11-14','2026-12-05','2027-01-02']) {
    await runAt(day,s => s.reminders());
    await runAt(day,s => s.reminders());
    assert.deepEqual(await pending(),[{ id: firstId,due_on: '2026-11-07' }]);
  }
  const reminders = (await store.query("SELECT dedupe_key,payload FROM outbox WHERE dedupe_key LIKE 'reminder:%' ORDER BY id")).rows;
  assert.equal(reminders.length,5);
  assert.equal(reminders.some(r => r.dedupe_key.endsWith('2026-11-09')),false);
  assert.ok(reminders.every(r => r.payload.text.includes('Месячная проверка')));
  const mondayList = await runAt('2027-01-04',s => s.tasks(a,a.id));
  assert.equal(mondayList.length,1); // Still visible outside reminder days.
  assert.equal(mondayList[0]!.id,firstId);
});

test('late completion covers skipped cycles even without cron and resumes future calendar', async () => {
  const taskId = await runAt('2026-11-01',s => s.createTask(a,'Проверка',a.id,firstSaturday));
  const first = (await store.query('SELECT id FROM occurrences WHERE task_id=$1',[taskId])).rows[0]!.id;
  // No cron or listing between November and January: January's calendar date is already covered.
  await runAt('2027-01-05',s => s.complete(a,first));
  assert.equal((await store.query('SELECT next_on::text FROM tasks WHERE id=$1',[taskId])).rows[0]!.next_on,'2027-02-06');
  assert.equal((await runAt('2027-01-05',s => s.tasks(a,a.id))).length,0);
  assert.equal((await runAt('2027-02-05',s => s.tasks(a,a.id))).length,0);
  const next = await runAt('2027-02-06',s => s.tasks(a,a.id));
  assert.equal(next.length,1); assert.equal(next[0]!.due_on,'2027-02-06');
  assert.notEqual(next[0]!.id,first);
  await assert.rejects(runAt('2027-02-06',s => s.complete(a,first,true)),/следующий цикл/);
  assert.equal((await store.query('SELECT id FROM occurrences WHERE task_id=$1 AND completed_at IS NULL',[taskId])).rows.length,1);
});

test('single pending task can be transferred and reopened without changing future owner', async () => {
  const taskId = await runAt('2026-11-01',s => s.createTask(a,'Проверка',a.id,firstSaturday));
  const first = (await store.query('SELECT id FROM occurrences WHERE task_id=$1',[taskId])).rows[0]!.id;
  const request = await runAt('2026-11-14',s => s.requestHelp(a,first,[b.id,c.id]));
  await runAt('2026-11-14',s => s.acceptHelp(b,request));
  await runAt('2026-12-05',s => s.materialize(a.group_id));
  const pending = (await store.query('SELECT assignee_id FROM occurrences WHERE task_id=$1 AND completed_at IS NULL',[taskId])).rows;
  assert.deepEqual(pending,[{ assignee_id: b.id }]);
  await runAt('2026-12-06',s => s.complete(b,first));
  await runAt('2026-12-06',s => s.complete(b,first,true));
  assert.equal((await runAt('2026-12-06',s => s.tasks(b,b.id))).length,1);
  await runAt('2026-12-06',s => s.complete(b,first));
  const next = await runAt('2027-01-02',s => s.tasks(a,a.id));
  assert.equal(next.length,1); assert.equal(next[0]!.assignee_id,a.id);
  assert.equal(next[0]!.due_on,'2027-01-02');
});

test('database constraint and concurrent materialization prevent duplicate pending copies', async () => {
  const taskId = await runAt('2026-11-01',s => s.createTask(a,'Проверка',a.id,firstSaturday));
  await Promise.all([runAt('2026-12-05',s => s.materialize(a.group_id)),runAt('2026-12-05',s => s.materialize(a.group_id))]);
  await assert.rejects(store.transaction(db => db.query(`INSERT INTO occurrences (task_id,group_id,due_on,original_owner_id,assignee_id,coalesced)
    VALUES ($1,$2,'2027-01-02',$3,$3,true)`,[taskId,a.group_id,a.id])),/unique|duplicate/i);
  assert.equal((await store.query('SELECT id FROM occurrences WHERE task_id=$1 AND completed_at IS NULL',[taskId])).rows.length,1);
});

test('monthly weekday and weekend recovery can be configured through buttons', async () => {
  await update(message(100,'/new'));
  await update(message(101,'Месячная проверка'));
  await update(callback(102,`owner:${b.id}`));
  await update(callback(103,'taskday:6'));
  await update(callback(109,'taskdaysdone'));
  await update(callback(110,'period:monthly'));
  await update(callback(104,'ordinal:1'));
  assert.equal((await run(s => s.session('101')))?.step,'task_confirm');
  await update(callback(108,'createtask'));
  const task = (await store.query('SELECT schedule FROM tasks')).rows[0]!;
  assert.deepEqual(task.schedule,{ kind: 'monthly_weekday',start: '2026-11-08',ordinal: 1,weekdays: [6],overdue: 'weekends' });
  assert.equal((await store.query('SELECT due_on::text FROM occurrences')).rows[0]!.due_on,'2026-12-05');
  await runAt('2027-01-02',s => s.materialize(a.group_id));
  assert.equal((await store.query('SELECT id FROM occurrences WHERE completed_at IS NULL')).rows.length,1);
});

test('weekday checkbox selection toggles in place and rejects an empty selection', async () => {
  await update(message(1200,'/new')); await update(message(1201,'Проверка'));
  await update(callback(1202,`owner:${a.id}`));
  assert.equal((await run(s => s.session('101')))?.step,'task_days');
  await update(callback(1203,'taskdaysdone'));
  assert.equal((await run(s => s.session('101')))?.step,'task_days');
  assert.equal((await store.query("SELECT payload FROM outbox WHERE dedupe_key='error:1203:0'")).rows[0]!.payload.show_alert,true);
  await update(callback(1204,'taskday:1'));
  await update(callback(1204,'taskday:1')); // Telegram retry must not toggle twice.
  assert.deepEqual((await run(s => s.session('101')))?.weekdays,[1]);
  const first = (await store.query("SELECT method,payload FROM outbox WHERE dedupe_key='update:1204:0'")).rows[0]!;
  assert.equal(first.method,'editMessageText');
  assert.equal(first.payload.reply_markup.inline_keyboard[0][0].text,'✅ Пн');
  assert.doesNotMatch(first.payload.text,/Шаг/);
  assert.deepEqual(first.payload.reply_markup.inline_keyboard.at(-1).map((b: { callback_data: string }) => b.callback_data),['taskback','cancel','taskdaysdone']);
  assert.equal((await store.query("SELECT id FROM outbox WHERE dedupe_key LIKE 'update:1204:%' AND method='sendMessage'")).rows.length,0);
  await update(callback(1205,'taskday:1'));
  assert.deepEqual((await run(s => s.session('101')))?.weekdays,[]);
  await update(callback(1206,'taskdaysall'));
  const all = (await store.query("SELECT payload FROM outbox WHERE dedupe_key='update:1206:0'")).rows[0]!.payload;
  assert.match(all.text,/Выбрано: Каждый день/);
  await update(callback(1207,'taskdaysdone'));
  const periods = (await store.query("SELECT payload FROM outbox WHERE dedupe_key='update:1207:0'")).rows[0]!.payload;
  assert.deepEqual(periods.reply_markup.inline_keyboard.slice(0,3).map((row: { callback_data: string }[]) => row[0]!.callback_data),['period:once','period:weekly','period:monthly']);
  assert.doesNotMatch(periods.text,/Шаг/);
  assert.deepEqual(periods.reply_markup.inline_keyboard.at(-1).map((b: { callback_data: string }) => b.callback_data),['taskback','cancel']);
  await update(callback(1208,'backdays'));
  assert.deepEqual((await run(s => s.session('101')))?.weekdays,[1,2,3,4,5,6,7]);
  await update(callback(1209,'taskdaysdone')); await update(callback(1210,'period:weekly'));
  assert.equal((await run(s => s.session('101')))?.step,'task_confirm');
  await update(callback(1213,'createtask'));
  const schedule = (await store.query('SELECT schedule FROM tasks')).rows[0]!.schedule;
  assert.equal(schedule.kind,'daily'); assert.equal(scheduleLabel(schedule),'Каждый день');
});

test('monthly recurrence supports multiple checked weekdays within the same month', () => {
  const monthly: Schedule = { kind: 'monthly_weekday',start: '2026-11-01',weekdays: [1,3,6],ordinal: 1 };
  assert.equal(firstDue(monthly),'2026-11-02');
  assert.equal(nextDue(monthly,'2026-11-02'),'2026-11-04');
  assert.equal(nextDue(monthly,'2026-11-04'),'2026-11-07');
  assert.equal(nextDue(monthly,'2026-11-07'),'2026-12-02');
  assert.equal(firstDue({ ...monthly,start: '2026-11-03' }),'2026-11-04');
  assert.match(scheduleLabel(monthly),/первые: Пн, Ср, Сб/);
  const all: Schedule = { ...monthly,weekdays: [1,2,3,4,5,6,7] };
  assert.equal(firstDue(all),'2026-11-01');
  assert.equal(nextDue(all,'2026-11-07'),'2026-12-01');
  assert.match(scheduleLabel(all),/каждый день, 1–7/);
  assert.equal(firstDue({ ...all,start: '2028-02-01',ordinal: -1 }),'2028-02-23');
  assert.equal(weekdaysLabel([7,3]),'Ср, Вс');
});

test('one-off tasks use the shared flow and automatically select the next chosen weekday', async () => {
  await update(callback(1220,'new')); await update(message(1221,'Разовая проверка'));
  await update(callback(1222,`owner:${b.id}`));
  assert.equal((await run(s => s.session('101')))?.step,'task_days');
  await update(callback(1226,'taskday:1'));
  await update(callback(1227,'taskdaysdone'));
  await update(callback(1228,'period:once'));
  assert.equal((await run(s => s.session('101')))?.step,'task_confirm');
  await update(callback(1225,'createtask'));
  const schedule = (await store.query('SELECT schedule FROM tasks')).rows[0]!.schedule;
  assert.equal(schedule.kind,'once');
  assert.equal(schedule.weekdays,undefined);
  assert.equal(firstDue(schedule),'2026-11-09');
  assert.equal((await store.query('SELECT id FROM occurrences')).rows.length,1);
});

test('automatic deadlines exclude today for once and never backfill recurring weekdays', async () => {
  let id = 1300;
  const atWednesday = (value: Update) => processUpdate(store,value,{ ...options,now: new Date('2026-11-11T16:00:00Z') });
  for (const [period,days,expected] of [
    ['once',[3],'2026-11-18'],['once',[1],'2026-11-16'],['once',[1,3,5],'2026-11-13'],
    ['weekly',[1],'2026-11-16'],['weekly',[3],'2026-11-11'],['weekly',[1,2,3,4,5,6,7],'2026-11-11'],
  ] as const) {
    await atWednesday(callback(id++,'new')); await atWednesday(message(id++,'Проверка срока'));
    await atWednesday(callback(id++,`owner:${b.id}`));
    for (const day of days) await atWednesday(callback(id++,`taskday:${day}`));
    await atWednesday(callback(id++,'taskdaysdone')); await atWednesday(callback(id++,`period:${period}`));
    const session = (await run(s => s.session('101')))!;
    assert.equal(session.step,'task_confirm');
    assert.equal(firstDue(session as unknown as Schedule),expected);
    const summary = (await store.query("SELECT payload FROM outbox WHERE method='sendMessage' ORDER BY id DESC LIMIT 1")).rows[0]!.payload;
    assert.deepEqual(summary.reply_markup.inline_keyboard,[[
      { text: 'Назад',callback_data: 'taskback' },{ text: 'Отмена',callback_data: 'cancel' },{ text: 'Создать',callback_data: 'createtask' },
    ]]);
    await atWednesday(callback(id++,'createtask'));
    const last = (await store.query('SELECT id FROM tasks ORDER BY id DESC LIMIT 1')).rows[0]!.id;
    const due = (await store.query('SELECT due_on::text FROM occurrences WHERE task_id=$1 ORDER BY due_on',[last])).rows;
    assert.equal(due[0]!.due_on,expected);
    assert.ok(due.every(r => r.due_on >= '2026-11-11'));
  }
});

test('wizard back navigation preserves choices and optional dates can be reset', async () => {
  let id = 1400;
  const cb = (data: string) => update(callback(id++,data));
  const step = async (expected: string) => assert.equal((await run(s => s.session('101')))?.step,expected);
  await cb('new'); await update(message(id++,'Название')); await cb('taskback'); await step('task_title');
  await update(message(id++,'Новое название')); await cb(`owner:${b.id}`); await cb('taskday:3');
  await cb('taskback'); await step('task_owner'); await cb(`owner:${b.id}`);
  assert.deepEqual((await run(s => s.session('101')))?.weekdays,[3]);
  await cb('taskdaysdone'); await cb('taskdate'); await step('task_date');
  await update(message(id++,'не дата')); await step('task_date');
  const error = (await store.query("SELECT payload FROM outbox WHERE dedupe_key=$1",[`error:${id-1}:0`])).rows[0]!.payload;
  assert.deepEqual(error.reply_markup.inline_keyboard[0].map((b: { callback_data: string }) => b.callback_data),['taskback','cancel']);
  await update(message(id++,'2026-12-20')); await step('task_period');
  await cb('period:once'); await step('task_confirm');
  assert.equal((await run(s => s.session('101')))?.start,'2026-12-20');
  await cb('taskback'); await cb('taskdate'); await cb('taskdateauto');
  await cb('period:once'); assert.equal((await run(s => s.session('101')))?.start,'2026-11-11');
  await cb('taskback'); await cb('period:monthly'); await step('task_ordinal');
  await cb('ordinal:1'); await step('task_confirm'); await cb('taskback'); await step('task_ordinal');
  await cb('taskback'); await step('task_period'); await cb('taskback'); await step('task_days');
  await cb('taskdaysdone'); await cb('taskreminders'); await cb('taskback'); await step('task_period');
  await cb('period:weekly'); await cb('cancel');
  assert.equal(await run(s => s.session('101')),undefined);
  assert.equal((await store.query('SELECT id FROM tasks')).rows.length,0);
});

test('a draft confirmed on a later day refreshes its automatic deadline before creation', async () => {
  const update = (value: Update) => processUpdate(store,value,{ ...options,now: new Date('2026-11-08T20:45:00Z') });
  await update(callback(1500,'new')); await update(message(1501,'Проверка полуночи'));
  await update(callback(1502,`owner:${b.id}`)); await update(callback(1503,'taskday:1'));
  await update(callback(1504,'taskdaysdone')); await update(callback(1505,'period:once'));
  assert.equal((await run(s => s.session('101')))?.start,'2026-11-09');
  const nextDay = { ...options,now: new Date('2026-11-08T21:05:00Z') };
  await processUpdate(store,callback(1506,'createtask'),nextDay);
  assert.equal((await store.query('SELECT id FROM tasks')).rows.length,0);
  assert.equal((await run(s => s.session('101')))?.start,'2026-11-16');
  await processUpdate(store,callback(1507,'createtask'),nextDay);
  assert.equal((await store.query('SELECT due_on::text FROM occurrences')).rows[0]!.due_on,'2026-11-16');
});

test('concurrent checkbox edits finish with the latest state and not-modified responses are harmless', async () => {
  await run(async s => {
    await s.enqueue('editMessageText',{ chat_id: '101',message_id: 77,text: 'Первое состояние' });
    await s.enqueue('editMessageText',{ chat_id: '101',message_id: 77,text: 'Последнее состояние' });
  });
  let release!: () => void,started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const active = new Promise<void>(resolve => { started = resolve; });
  const texts: unknown[] = [];
  const older = flushOutbox(store,async (_method,payload) => { texts.push(payload.text); started(); await gate; return {}; },'default',1);
  await active;
  await flushOutbox(store,async (_method,payload) => { texts.push(payload.text); return {}; },'default',1);
  assert.deepEqual(texts,['Первое состояние']);
  release(); await older;
  await flushOutbox(store,async (_method,payload) => { texts.push(String(payload.text)); throw new TelegramError(400,undefined,true); });
  assert.deepEqual(texts,['Первое состояние','Последнее состояние']);
  assert.equal((await store.query("SELECT id FROM outbox WHERE state<>'sent'")).rows.length,0);
});

test('group migration preserves existing memberships, assignments and private aliases', async () => {
  const legacy = new PGlite();
  try {
    await legacy.exec(await readFile(new URL('../migrations/001_init.sql', import.meta.url), 'utf8'));
    await legacy.exec(`INSERT INTO app_users (telegram_id,profile_name) VALUES (201,'Анна');
      INSERT INTO families (name) VALUES ('Команда');
      INSERT INTO members (family_id,telegram_id,role) VALUES (1,201,'admin');
      INSERT INTO aliases (viewer_id,target_id,name) VALUES (1,1,'Координатор');
      INSERT INTO tasks (family_id,title,owner_id,schedule,next_on) VALUES (1,'Отчёт',1,'{"kind":"once","start":"2026-11-08"}',NULL);
      INSERT INTO occurrences (task_id,family_id,due_on,original_owner_id,assignee_id) VALUES (1,1,'2026-11-08',1,1);`);
    const migration = await readFile(new URL('../migrations/002_groups.sql', import.meta.url), 'utf8');
    await legacy.exec(migration);
    await legacy.exec(migration);
    assert.equal((await legacy.query<{ name: string }>('SELECT name FROM task_groups')).rows[0]!.name,'Команда');
    assert.equal((await legacy.query<{ group_id: number }>('SELECT group_id FROM members')).rows[0]!.group_id,1);
    assert.equal((await legacy.query<{ title: string }>('SELECT group_id,title FROM tasks')).rows[0]!.title,'Отчёт');
    assert.equal((await legacy.query<{ assignee_id: number }>('SELECT group_id,assignee_id FROM occurrences')).rows[0]!.assignee_id,1);
    assert.equal((await legacy.query<{ name: string }>('SELECT name FROM aliases')).rows[0]!.name,'Координатор');
  } finally { await legacy.close(); }
});

test('aliases are private to the viewer and cannot cross groups', async () => {
  await run(s => s.alias(a, b.id, 'Мама'));
  assert.equal(await run(s => s.name(a, b.id)), 'Мама');
  assert.equal(await run(s => s.name(c, b.id)), 'Елена Иванова');
  await assert.rejects(run(s => s.alias(a, outsider.id, 'Чужой')), UserError);
  await run(s => s.resetAlias(a, b.id));
  assert.equal(await run(s => s.name(a, b.id)), 'Елена Иванова');
});

test('invitation rotation invalidates old code; admin role is not granted on join', async () => {
  const old = await run(s => s.invite(a));
  const fresh = await run(s => s.invite(a));
  await store.query("INSERT INTO app_users (telegram_id,profile_name) VALUES (105,'Новый')");
  await assert.rejects(run(s => s.join('105', old)), UserError);
  await run(s => s.join('105', fresh.toLowerCase()));
  assert.equal((await run(s => s.requireMember('105'))).role, 'member');
  await assert.rejects(run(s => s.invite(b)), UserError);
  await assert.rejects(run(s => s.createGroup('105','Вторая', ['101'])), UserError);
  await store.query("UPDATE task_groups SET invite_expires_at='2020-01-01' WHERE id=$1", [a.group_id]);
  await store.query("INSERT INTO app_users (telegram_id,profile_name) VALUES (106,'Поздний')");
  await assert.rejects(run(s => s.join('106', fresh)), UserError);
});

test('first helper wins, future repetitions retain original owner, former owner cannot complete', async () => {
  const t = await occurrence('daily');
  await run(s => s.alias(b, a.id, 'Сын'));
  const requestId = await run(s => s.requestHelp(a, t.id, [b.id,c.id]));
  const requestMessage = (await store.query("SELECT payload FROM outbox WHERE dedupe_key=$1", [`help:${requestId}:${b.id}`])).rows[0]!;
  assert.match(requestMessage.payload.text, /Сын просит/);
  await run(s => s.acceptHelp(b, requestId));
  await assert.rejects(run(s => s.acceptHelp(c, requestId)), /уже закрыта/);
  await assert.rejects(run(s => s.complete(a, t.id)), UserError);
  const transferred = await run(s => s.occurrence(b, t.id));
  assert.equal(transferred.assignee_id, b.id);
  assert.equal(transferred.original_owner_id, a.id);
  const future = (await run(s => s.tasks(a,a.id))).find(x => x.due_on === '2026-11-09');
  assert.equal(future?.assignee_id, a.id);
  await run(s => s.reminders());
  const reminders = (await store.query("SELECT payload FROM outbox WHERE dedupe_key LIKE 'reminder:%'")).rows;
  assert.deepEqual(reminders.map(r => String(r.payload.chat_id)), ['102']);
  await run(s => s.complete(b,t.id));
  assert.equal((await run(s => s.occurrence(b,t.id))).completed_by, b.id);
  await run(s => s.complete(b,t.id,true));
  assert.equal((await run(s => s.occurrence(b,t.id))).completed_at, null);
  const events = (await store.query('SELECT kind FROM events ORDER BY id')).rows.map(r => r.kind);
  assert.deepEqual(events, ['help_requested','transferred','completed','reopened']);
});

test('competing help acceptances result in exactly one transfer', async () => {
  const t = await occurrence();
  const requestId = await run(s => s.requestHelp(a,t.id,[b.id,c.id]));
  const results = await Promise.allSettled([run(s => s.acceptHelp(b,requestId)),run(s => s.acceptHelp(c,requestId))]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal((await store.query("SELECT id FROM events WHERE kind='transferred'")).rows.length, 1);
});

test('completion closes help, recipients and group authorization are enforced', async () => {
  const t = await occurrence();
  const requestId = await run(s => s.requestHelp(a,t.id,[b.id]));
  await assert.rejects(run(s => s.acceptHelp(c,requestId)), UserError);
  await assert.rejects(run(s => s.acceptHelp(outsider,requestId)), UserError);
  await assert.rejects(run(s => s.occurrence(outsider,t.id)), UserError);
  await assert.rejects(run(s => s.requestHelp(b,t.id,[c.id])), UserError);
  await run(s => s.complete(a,t.id));
  await assert.rejects(run(s => s.acceptHelp(b,requestId)), UserError);
  assert.equal((await store.query('SELECT state FROM help_requests WHERE id=$1',[requestId])).rows[0]!.state, 'cancelled');
});

test('recurrence materialization and reminders are idempotent', async () => {
  await occurrence('daily');
  await run(s => s.materialize(a.group_id)); await run(s => s.materialize(a.group_id));
  assert.equal((await store.query('SELECT id FROM occurrences')).rows.length, 8);
  await run(s => s.reminders()); await run(s => s.reminders());
  assert.equal((await store.query("SELECT id FROM outbox WHERE dedupe_key LIKE 'reminder:%'")).rows.length, 1);
});

test('a newly created task remains visible when its first deadline is far in the future', async () => {
  await run(s => s.createTask(a,'Годовой отчёт',b.id,{ kind: 'once',start: '2026-12-31' }));
  const tasks = await run(s => s.tasks(a,b.id));
  assert.equal(tasks.length,1);
  assert.equal(tasks[0]!.due_on,'2026-12-31');
});

test('group menu, personal rename, reset and duplicate Telegram updates', async () => {
  await update(message(10,'/group'));
  let payload = (await store.query("SELECT payload FROM outbox WHERE method='sendMessage' ORDER BY id DESC LIMIT 1")).rows[0]!.payload;
  assert.match(JSON.stringify(payload.reply_markup), /Елена Иванова/);
  await update(callback(11,`rename:${b.id}`));
  await update(message(12,'Мама'));
  await update(message(12,'Мама'));
  assert.equal(await run(s => s.name(a,b.id)), 'Мама');
  assert.equal((await store.query('SELECT id FROM outbox WHERE dedupe_key LIKE $1',['update:12:%'])).rows.length, 2);
  await update(message(13,'/group'));
  payload = (await store.query("SELECT payload FROM outbox WHERE method='sendMessage' ORDER BY id DESC LIMIT 1")).rows[0]!.payload;
  assert.match(JSON.stringify(payload.reply_markup), /Мама/);
  await update(callback(14,`resetname:${b.id}`));
  assert.equal(await run(s => s.name(a,b.id)), 'Елена Иванова');
});

test('interactive task creation survives updates and uses fixed assignment', async () => {
  await update(message(20,'/new'));
  await update(message(21,'Обновить документацию'));
  await update(callback(22,`owner:${b.id}`));
  await update(callback(23,'taskday:1'));
  await update(callback(231,'taskday:3'));
  await update(callback(232,'taskday:5'));
  await update(callback(233,'taskdaysdone'));
  await update(callback(235,'taskreminders'));
  await update(callback(250,'overdue:daily'));
  await update(callback(234,'period:weekly'));
  await update(callback(26,'createtask'));
  await update(callback(26,'createtask'));
  const tasks = (await store.query('SELECT * FROM tasks')).rows;
  assert.equal(tasks.length, 1); assert.equal(tasks[0]!.owner_id, b.id);
  const dates = (await store.query('SELECT due_on::text FROM occurrences ORDER BY due_on')).rows.map(r => r.due_on);
  assert.deepEqual(dates,['2026-11-09','2026-11-11','2026-11-13']);
  assert.equal(await run(s => s.session('101')), undefined);
});

test('invalid wizard input preserves state; forged callback cannot rename outsider', async () => {
  await update(message(30,'/new'));
  await update(message(31,'x'.repeat(161)));
  assert.equal((await run(s => s.session('101')))?.step, 'task_title');
  await update(callback(32,`rename:${outsider.id}`));
  assert.equal((await store.query('SELECT * FROM aliases')).rows.length, 0);
  assert.equal((await store.query("SELECT payload FROM outbox WHERE dedupe_key='error:32:0'")).rows[0]!.payload.show_alert,true);
});

test('outbox skips closed help and retries transient failures without undoing task state', async () => {
  const t = await occurrence();
  const requestId = await run(s => s.requestHelp(a,t.id,[b.id]));
  await run(s => s.cancelHelp(a,t.id));
  const sent: string[] = [];
  await flushOutbox(store,async (_method,payload) => { sent.push(String(payload.text)); return { message_id: 77 }; });
  assert.equal(sent.some(t => t.includes('просит взять')),false);
  assert.equal((await store.query('SELECT state FROM help_requests WHERE id=$1',[requestId])).rows[0]!.state,'cancelled');
  await run(s => s.send('101','retry me',undefined,'retry-case'));
  await flushOutbox(store,async () => { throw new TelegramError(500); });
  let job = (await store.query("SELECT * FROM outbox WHERE dedupe_key='retry-case'")).rows[0]!;
  assert.equal(job.state,'pending'); assert.equal(job.attempts,1);
  await store.query("UPDATE outbox SET available_at=now()-interval '1 second' WHERE dedupe_key='retry-case'");
  await flushOutbox(store,async () => ({ message_id: 99 }));
  job = (await store.query("SELECT * FROM outbox WHERE dedupe_key='retry-case'")).rows[0]!;
  assert.equal(job.state,'sent');
});

test('late help delivery has its button removed if task was accepted during send', async () => {
  const t = await occurrence();
  const requestId = await run(s => s.requestHelp(a,t.id,[b.id,c.id]));
  const methods: string[] = [];
  let accepted = false;
  await flushOutbox(store,async (method,payload) => {
    methods.push(method);
    if (String(payload.text).includes('просит взять') && !accepted) {
      accepted = true; await run(s => s.acceptHelp(b,requestId));
    }
    return { message_id: 78 };
  });
  assert.ok(methods.includes('editMessageReplyMarkup'));
});

test('HTTP endpoints reject missing secrets and wrong methods before database access', async () => {
  assert.equal(matchesSecret('abc','abc'),false);
  assert.equal(matchesSecret('x'.repeat(32),'x'.repeat(32)),true);
  assert.equal(matchesSecret('y'.repeat(32),'x'.repeat(32)),false);
  const oldToken = process.env.BOT_TOKEN, oldSecret = process.env.WEBHOOK_SECRET, oldConfigs = process.env.BOTS_JSON;
  process.env.BOT_TOKEN = options.token; process.env.WEBHOOK_SECRET = 'x'.repeat(32); delete process.env.BOTS_JSON;
  try { for (const [handler, method, expected] of [[webhook,'GET',405],[webhook,'POST',401],[cron,'GET',401],[cron,'POST',405]] as const) {
    let status = 0;
    const response = { setHeader() {}, status(code: number) { status = code; return this; }, end() {}, json() {} };
    await handler({ method, headers: {} } as VercelRequest,response as unknown as VercelResponse);
    assert.equal(status,expected);
  } } finally {
    for (const [name,value] of [['BOT_TOKEN',oldToken],['WEBHOOK_SECRET',oldSecret],['BOTS_JSON',oldConfigs]]) {
      if (value === undefined) delete process.env[name!]; else process.env[name!] = value;
    }
  }
});
