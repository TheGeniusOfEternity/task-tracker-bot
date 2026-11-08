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
import { addDays, firstDue, localDay, nextDue, shouldRemind, validDay, type Schedule } from '../src/schedule.js';
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
const runAt = <T>(day: string, fn: (s: Service) => Promise<T>) => store.transaction(db => fn(new Service(db, `day:${sequence++}`, new Date(`${day}T16:00:00Z`))));
const firstSaturday: Schedule = { kind: 'monthly_weekday', start: '2026-11-01', ordinal: 1, weekday: 6, overdue: 'weekends' };
function adapter(db: { query: PGlite['query'] }): Database {
  return { async query<T extends QueryResultRow>(sql: string, values?: unknown[]) { return { rows: (await db.query(sql, values)).rows as T[] }; } };
}
before(async () => {
  const sql = await readFile(new URL('../migrations/001_init.sql', import.meta.url), 'utf8')
    + '\n' + await readFile(new URL('../migrations/002_groups.sql', import.meta.url), 'utf8')
    + '\n' + await readFile(new URL('../migrations/003_coalesced_occurrences.sql', import.meta.url), 'utf8');
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
  await update(callback(103,'kind:monthly_weekday'));
  await update(callback(104,'ordinal:1'));
  await update(callback(105,'monthweekday:6'));
  await update(message(106,'2026-11-08'));
  await update(callback(107,'overdue:weekends'));
  await update(callback(108,'createtask'));
  const task = (await store.query('SELECT schedule FROM tasks')).rows[0]!;
  assert.deepEqual(task.schedule,{ kind: 'monthly_weekday',start: '2026-11-08',ordinal: 1,weekday: 6,overdue: 'weekends' });
  assert.equal((await store.query('SELECT due_on::text FROM occurrences')).rows[0]!.due_on,'2026-12-05');
  await runAt('2027-01-02',s => s.materialize(a.group_id));
  assert.equal((await store.query('SELECT id FROM occurrences WHERE completed_at IS NULL')).rows.length,1);
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
  await update(callback(23,'kind:weekly'));
  await update(message(24,'2026-11-08'));
  await update(message(25,'1,3,5'));
  await update(callback(250,'overdue:daily'));
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
