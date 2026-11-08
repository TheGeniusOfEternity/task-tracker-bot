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
import { addDays, firstDue, localDay, nextDue, validDay } from '../src/schedule.js';
import webhook from '../api/webhook.js';
import cron from '../api/cron.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { Update } from 'grammy/types';

const now = new Date('2026-11-08T16:00:00Z');
const options = { token: '123456:fake-test-token', adminIds: ['101'], now,
  botInfo: { id: 123456, is_bot: true as const, first_name: 'Test', username: 'test_bot', can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false, allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false } };
let pg: PGlite | undefined;
let pool: pgDriver.Pool | undefined;
let store: Store;
let a: Member, b: Member, c: Member, outsider: Member;
let sequence = 0;
const run = <T>(fn: (s: Service) => Promise<T>) => store.transaction(db => fn(new Service(db, `test:${sequence++}`, now)));
function adapter(db: { query: PGlite['query'] }): Database {
  return { async query<T extends QueryResultRow>(sql: string, values?: unknown[]) { return { rows: (await db.query(sql, values)).rows as T[] }; } };
}
before(async () => {
  const sql = await readFile(new URL('../migrations/001_init.sql', import.meta.url), 'utf8');
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
  await store.query('TRUNCATE app_users,families,processed_updates RESTART IDENTITY CASCADE');
  await run(async s => {
    for (const [uid, name] of [['101','Максим'],['102','Елена Иванова'],['103','Алексей'],['104','Чужой']]) {
      await s.db.query('INSERT INTO app_users (telegram_id,profile_name) VALUES ($1,$2)', [uid,name]);
    }
    a = await s.createFamily('101', 'Дом', ['101']);
    const code = await s.invite(a);
    await s.join('102', code); await s.join('103', code);
    b = await s.requireMember('102'); c = await s.requireMember('103');
    outsider = await s.createFamily('104', 'Другая семья', ['104']);
  });
});
after(async () => { await pg?.close(); await pool?.end(); });

async function occurrence(kind: 'once' | 'daily' = 'once') {
  await run(s => s.createTask(a, 'Убрать кухню', a.id, { kind, start: '2026-11-08' }));
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

test('aliases are private to the viewer and cannot cross families', async () => {
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
  await assert.rejects(run(s => s.createFamily('105','Вторая', ['101'])), UserError);
  await store.query("UPDATE families SET invite_expires_at='2020-01-01' WHERE id=$1", [a.family_id]);
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

test('completion closes help, recipients and family authorization are enforced', async () => {
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
  await run(s => s.materialize(a.family_id)); await run(s => s.materialize(a.family_id));
  assert.equal((await store.query('SELECT id FROM occurrences')).rows.length, 8);
  await run(s => s.reminders()); await run(s => s.reminders());
  assert.equal((await store.query("SELECT id FROM outbox WHERE dedupe_key LIKE 'reminder:%'")).rows.length, 1);
});

test('a newly created task remains visible when its first deadline is far in the future', async () => {
  await run(s => s.createTask(a,'Новогодняя уборка',b.id,{ kind: 'once',start: '2026-12-31' }));
  const tasks = await run(s => s.tasks(a,b.id));
  assert.equal(tasks.length,1);
  assert.equal(tasks[0]!.due_on,'2026-12-31');
});

test('family menu, personal rename, reset and duplicate Telegram updates', async () => {
  await update(message(10,'/family'));
  let payload = (await store.query("SELECT payload FROM outbox WHERE method='sendMessage' ORDER BY id DESC LIMIT 1")).rows[0]!.payload;
  assert.match(JSON.stringify(payload.reply_markup), /Елена Иванова/);
  await update(callback(11,`rename:${b.id}`));
  await update(message(12,'Мама'));
  await update(message(12,'Мама'));
  assert.equal(await run(s => s.name(a,b.id)), 'Мама');
  assert.equal((await store.query('SELECT id FROM outbox WHERE dedupe_key LIKE $1',['update:12:%'])).rows.length, 2);
  await update(message(13,'/family'));
  payload = (await store.query("SELECT payload FROM outbox WHERE method='sendMessage' ORDER BY id DESC LIMIT 1")).rows[0]!.payload;
  assert.match(JSON.stringify(payload.reply_markup), /Мама/);
  await update(callback(14,`resetname:${b.id}`));
  assert.equal(await run(s => s.name(a,b.id)), 'Елена Иванова');
});

test('interactive task creation survives updates and uses fixed assignment', async () => {
  await update(message(20,'/new'));
  await update(message(21,'Помыть пол'));
  await update(callback(22,`owner:${b.id}`));
  await update(callback(23,'kind:weekly'));
  await update(message(24,'2026-11-08'));
  await update(message(25,'1,3,5'));
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
  for (const [handler, method, expected] of [[webhook,'GET',405],[webhook,'POST',401],[cron,'GET',401],[cron,'POST',405]] as const) {
    let status = 0;
    const response = { setHeader() {}, status(code: number) { status = code; return this; }, end() {}, json() {} };
    await handler({ method, headers: {} } as VercelRequest,response as unknown as VercelResponse);
    assert.equal(status,expected);
  }
});
