import { Bot, BotError, InlineKeyboard } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import type { Store } from './db.js';
import { Service, type Member, type Session } from './service.js';
import { firstDue, localDay, ordinalNames, scheduleLabel, validDay, weekdayNames, type Schedule } from './schedule.js';
import { UserError } from './security.js';

export interface BotOptions { token: string; adminIds: string[]; botInfo: UserFromGetMe; now?: Date }
const labels: Record<string, string> = { completed: '✅ Выполнено', reopened: '↩️ Снова открыто', transferred: '🤝 Передано', help_requested: '🙋 Запрошена помощь', help_cancelled: 'Просьба отменена' };
const keyboard = (rows: { text: string; callback_data: string }[][]) => ({ inline_keyboard: rows });
const button = (text: string, data: string) => ({ text, callback_data: data });
const cancelHint = '\n\nОтменить: /cancel';
function id(value: string | undefined) {
  if (!value || !/^[1-9]\d{0,9}$/.test(value)) throw new UserError('Некорректная кнопка. Открой меню заново: /start');
  return Number(value);
}
async function main(s: Service, uid: string) {
  const member = await s.member(uid);
  if (!member) {
    await s.send(uid, '📋 Трекер задач\nВведи код приглашения через /join КОД.\nАдминистратор бота может создать группу: /create Название\nТвой Telegram ID: /id');
    return;
  }
  const menu = new InlineKeyboard().text('📋 Мои задачи', 'mine').row().text('👥 Группа', 'group').row().text('📖 Журнал', 'history');
  if (member.role === 'admin') menu.row().text('➕ Создать задачу', 'new').row().text('🔑 Новый код приглашения', 'invite');
  await s.send(uid, 'Что хочешь сделать?', menu);
}
async function group(s: Service, viewer: Member) {
  const members = await s.members(viewer);
  await s.send(viewer.telegram_id, '👥 Участники группы\nВыбери участника, чтобы посмотреть задачи или изменить имя только для себя.',
    keyboard([...members.map(m => [button(`${m.name}${m.id === viewer.id ? ' (ты)' : ''}`, `member:${m.id}`)]), [button('← Меню', 'menu')]]));
}
async function memberCard(s: Service, viewer: Member, targetId: number) {
  const target = await s.target(viewer, targetId);
  await s.send(viewer.telegram_id, `${target.name}\n${target.role === 'admin' ? 'Администратор' : 'Участник'}\nНазвания участников настраиваются лично для тебя.`,
    keyboard([[button('📋 Задачи', `list:${targetId}:0`)], [button('✏️ Назвать для себя', `rename:${targetId}`)],
      [button('Вернуть имя Telegram', `resetname:${targetId}`)], [button('← Группа', 'group')]]));
}
async function taskList(s: Service, viewer: Member, owner: number, page = 0) {
  const target = await s.target(viewer, owner);
  const tasks = await s.tasks(viewer, owner, page);
  const today = await s.today(viewer);
  const rows = tasks.slice(0, 5).map(t => [button(`${t.due_on < today ? '⏰' : '📋'} ${t.title.slice(0, 45)} · ${t.due_on}`, `task:${t.id}`)]);
  const nav = [];
  if (page > 0) nav.push(button('← Назад', `list:${owner}:${page - 1}`));
  if (tasks.length > 5) nav.push(button('Дальше →', `list:${owner}:${page + 1}`));
  if (nav.length) rows.push(nav);
  rows.push([button('← Меню', 'menu')]);
  await s.send(viewer.telegram_id, `Задачи: ${target.name}\n${tasks.length ? 'Открытые задачи, ближайшие и просроченные:' : 'Открытых задач пока нет.'}`, keyboard(rows));
}
async function taskCard(s: Service, viewer: Member, occurrenceId: number) {
  const t = await s.occurrence(viewer, occurrenceId);
  const rows = [];
  if (t.assignee_id === viewer.id) {
    if (t.completed_at) rows.push([button('↩️ Отменить отметку', `undo:${t.id}`)]);
    else {
      rows.push([button('✅ Выполнено', `done:${t.id}`)]);
      rows.push([button('🙋 Попросить помощи', `help:${t.id}`)]);
      rows.push([button('Отменить просьбу о помощи', `cancelhelp:${t.id}`)]);
    }
  }
  rows.push([button('← Задачи исполнителя', `list:${t.assignee_id}:0`)]);
  await s.send(viewer.telegram_id, `📋 ${t.title}\nСрок: ${t.due_on} (до конца дня, Москва)\nИсполнитель: ${await s.name(viewer, t.assignee_id)}\n${scheduleLabel(t.schedule)}${t.schedule.overdue === 'weekends' ? '\nПри просрочке: напоминания по субботам и воскресеньям, одна открытая задача.' : ''}\n${t.completed_at ? '✅ Выполнено' : 'Ожидает выполнения'}`, keyboard(rows));
}
async function history(s: Service, viewer: Member) {
  const events = await s.history(viewer);
  const lines = [];
  for (const e of events) {
    const time = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', dateStyle: 'short', timeStyle: 'short' }).format(e.created_at);
    lines.push(`${labels[e.kind] ?? e.kind}: ${e.title}\n${await s.name(viewer, e.actor_id)} · ${time}`);
  }
  // Telegram has a 4096 character message limit; split at event boundaries.
  let text = '📖 Последние события за 7 дней (до 20 записей)\n';
  for (const line of lines) {
    if (text.length + line.length > 3500) { await s.send(viewer.telegram_id, text); text = ''; }
    text += `\n${line}\n`;
  }
  await s.send(viewer.telegram_id, lines.length ? text : 'За последние 7 дней событий пока нет.', keyboard([[button('← Меню', 'menu')]]));
}
async function helpPicker(s: Service, viewer: Member, session: Session) {
  const targets = (await s.members(viewer)).filter(m => m.id !== viewer.id);
  if (!targets.length) throw new UserError('Пока некому отправить просьбу. Пригласи других участников.');
  const selected = session.selected as number[];
  await s.send(viewer.telegram_id, 'Кого попросить? Отметь участников, затем нажми «Отправить».\nЗадача перейдёт первому согласившемуся.',
    keyboard([...targets.map(m => [button(`${selected.includes(m.id) ? '✅ ' : ''}${m.name}`, `pickhelp:${m.id}`)]),
      [button(`Отправить (${selected.length})`, 'sendhelp')], [button('Отмена', 'cancel')]]));
}
async function newTask(s: Service, viewer: Member) {
  s.admin(viewer);
  await s.saveSession(viewer.telegram_id, { step: 'task_title' });
  await s.send(viewer.telegram_id, `Как называется задача? До 160 символов.${cancelHint}`);
}
function requireStep(session: Session | undefined, step: string): asserts session is Session {
  if (session?.step !== step) throw new UserError('Эта кнопка устарела. Открой меню заново: /start');
}
async function textInput(s: Service, uid: string, text: string) {
  const session = await s.session(uid);
  if (!session) { await main(s, uid); return; }
  if (session.step === 'join') {
    await s.join(uid, text); await s.saveSession(uid); await s.send(uid, 'Ты присоединился к группе.'); await main(s, uid); return;
  }
  const viewer = await s.requireMember(uid);
  if (session.step === 'rename') {
    await s.alias(viewer, Number(session.target), text); await s.saveSession(uid);
    await s.send(uid, 'Имя сохранено только для тебя.'); await memberCard(s, viewer, Number(session.target)); return;
  }
  s.admin(viewer);
  if (session.step === 'task_title') {
    if (!text.trim() || text.length > 160) throw new UserError('Название должно содержать от 1 до 160 символов.');
    await s.saveSession(uid, { step: 'task_owner', title: text.trim() });
    await s.send(uid, 'Кому назначить задачу?', keyboard((await s.members(viewer)).map(m => [button(m.name, `owner:${m.id}`)])));
  } else if (session.step === 'task_date') {
    if (!validDay(text) || text < await s.today(viewer) || text > '2100-12-31') throw new UserError('Введи дату от сегодняшнего дня до 2100 года в формате ГГГГ-ММ-ДД.');
    const next = { ...session, start: text };
    if (session.kind === 'weekly') {
      await s.saveSession(uid, { ...next, step: 'task_weekdays' });
      await s.send(uid, `В какие дни недели? Числа через запятую: 1 — пн, …, 7 — вс. Например: 1,3,5.${cancelHint}`);
    } else await chooseOverdue(s, viewer, next);
  } else if (session.step === 'task_weekdays') {
    const weekdays = [...new Set(text.split(',').map(x => Number(x.trim())))];
    if (!/^[1-7](\s*,\s*[1-7])*$/.test(text) || weekdays.some(x => x < 1 || x > 7)) throw new UserError('Нужны номера дней от 1 до 7 через запятую. Например: 1,3,5.');
    await chooseOverdue(s, viewer, { ...session, weekdays });
  } else throw new UserError('Выбери вариант кнопкой или отмени действие: /cancel');
}
function sessionSchedule(session: Session): Schedule {
  return { kind: session.kind as Schedule['kind'], start: session.start as string,
    ...(session.weekdays ? { weekdays: session.weekdays as number[] } : {}),
    ...(session.weekday ? { weekday: Number(session.weekday), ordinal: Number(session.ordinal) } : {}),
    overdue: session.overdue as Schedule['overdue'] };
}
async function chooseOverdue(s: Service, viewer: Member, session: Session) {
  await s.saveSession(viewer.telegram_id, { ...session, step: 'task_overdue' });
  await s.send(viewer.telegram_id, 'Что делать, если задача просрочена?\n\nПо выходным: напоминать по субботам и воскресеньям до выполнения. Новые календарные сроки не создают копий открытой задачи.\n\nКаждый день: напоминать ежедневно, каждое повторение учитывается отдельно.',
    keyboard([[button('По выходным, без копий', 'overdue:weekends')], [button('Каждый день, отдельно', 'overdue:daily')], [button('Отмена', 'cancel')]]));
}
async function confirmTask(s: Service, viewer: Member, session: Session) {
  const schedule = sessionSchedule(session);
  await s.saveSession(viewer.telegram_id, { ...session, step: 'task_confirm' });
  await s.send(viewer.telegram_id, `Создать задачу?\n\n${session.title}\nИсполнитель: ${await s.name(viewer, Number(session.owner))}\n${scheduleLabel(schedule)}${schedule.weekdays ? ` (${schedule.weekdays.join(', ')})` : ''}\nПервый срок: ${firstDue(schedule)}\nСрок — до конца дня по Москве.${schedule.kind === 'monthly' ? '\nВ коротком месяце — последний день месяца.' : ''}\n${schedule.overdue === 'weekends' ? 'Просрочка: напоминания по выходным, одна задача до выполнения. После выполнения — ближайший будущий срок по календарю.' : 'Просрочка: ежедневные напоминания; повторения учитываются отдельно.'}`,
    keyboard([[button('Создать', 'createtask')], [button('Отмена', 'cancel')]]));
}

export async function processUpdate(store: Store, update: Update, options: BotOptions) {
  const from = update.message?.from ?? update.callback_query?.from;
  const chat = update.message?.chat ?? update.callback_query?.message?.chat;
  if (!from || chat?.type !== 'private') return;
  const uid = String(from.id);
  await store.transaction(async db => {
    // The upsert also locks this user's row, serializing their persistent wizard across serverless instances.
    await db.query(`INSERT INTO app_users (telegram_id,profile_name) VALUES ($1,$2)
      ON CONFLICT (telegram_id) DO UPDATE SET profile_name=excluded.profile_name`, [uid, [from.first_name, from.last_name].filter(Boolean).join(' ').slice(0, 128)]);
    const fresh = await db.query('INSERT INTO processed_updates (update_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING update_id', [update.update_id]);
    if (!fresh.rows.length) return;
    await db.query('SAVEPOINT bot_action');
    const s = new Service(db, `update:${update.update_id}`, options.now);
    const bot = new Bot(options.token, { botInfo: options.botInfo });
    bot.command('id', async () => { await s.send(uid, `Твой Telegram ID: ${uid}`); });
    bot.command('start', async ctx => {
      await s.saveSession(uid);
      if (ctx.match.startsWith('join_')) { await s.join(uid, ctx.match.slice(5)); await s.send(uid, 'Ты присоединился к группе.'); }
      await main(s, uid);
    });
    bot.command('create', async ctx => {
      const viewer = await s.createGroup(uid, ctx.match, options.adminIds);
      const code = await s.invite(viewer);
      await s.send(uid, `Группа создана. Код приглашения на 7 дней:\n${code}\n\nУчастнику нужно открыть этого бота и отправить /join ${code}`);
      await main(s, uid);
    });
    bot.command('join', async ctx => {
      if (ctx.match) { await s.join(uid, ctx.match); await s.saveSession(uid); await main(s, uid); }
      else { await s.saveSession(uid, { step: 'join' }); await s.send(uid, `Введи код приглашения.${cancelHint}`); }
    });
    bot.command('cancel', async () => { await s.saveSession(uid); await s.send(uid, 'Действие отменено.'); await main(s, uid); });
    bot.command('group', async () => group(s, await s.requireMember(uid)));
    bot.command(['tasks', 'today'], async () => { const m = await s.requireMember(uid); await taskList(s, m, m.id); });
    bot.command('history', async () => history(s, await s.requireMember(uid)));
    bot.command('new', async () => newTask(s, await s.requireMember(uid)));
    bot.command('invite', async () => { const code = await s.invite(await s.requireMember(uid)); await s.send(uid, `Новый код на 7 дней: ${code}\nПредыдущий код больше не действует.\nУчастникам: /join ${code}`); });
    bot.on('callback_query:data', async ctx => {
      const [action, arg, pageArg] = ctx.callbackQuery.data.split(':');
      if (action === 'menu' || action === 'cancel') { await s.saveSession(uid); await main(s, uid); }
      else {
        const viewer = await s.requireMember(uid);
        if (action === 'group') await group(s, viewer);
        else if (action === 'member') await memberCard(s, viewer, id(arg));
        else if (action === 'rename') {
          const target = await s.target(viewer, id(arg));
          await s.saveSession(uid, { step: 'rename', target: target.id });
          await s.send(uid, `Как называть «${target.name}» для тебя? Введи удобное имя.${cancelHint}`);
        } else if (action === 'resetname') { await s.resetAlias(viewer, id(arg)); await memberCard(s, viewer, id(arg)); }
        else if (action === 'mine') await taskList(s, viewer, viewer.id);
        else if (action === 'list') await taskList(s, viewer, id(arg), /^\d{1,5}$/.test(pageArg ?? '') ? Number(pageArg) : 0);
        else if (action === 'task') await taskCard(s, viewer, id(arg));
        else if (action === 'history') await history(s, viewer);
        else if (action === 'new') await newTask(s, viewer);
        else if (action === 'invite') { const code = await s.invite(viewer); await s.send(uid, `Новый код на 7 дней: ${code}\nПредыдущий код больше не действует.\nУчастникам: /join ${code}`); }
        else if (action === 'done' || action === 'undo') { await s.complete(viewer, id(arg), action === 'undo'); await taskCard(s, viewer, id(arg)); }
        else if (action === 'help') {
          const task = await s.occurrence(viewer, id(arg));
          if (task.assignee_id !== viewer.id || task.completed_at) throw new UserError('Попросить помощи можно только со своей невыполненной задачей.');
          const session = { step: 'help_pick', occurrence: task.id, selected: [] as number[] };
          await s.saveSession(uid, session); await helpPicker(s, viewer, session);
        } else if (action === 'pickhelp') {
          const session = await s.session(uid); requireStep(session, 'help_pick');
          const target = await s.target(viewer, id(arg));
          if (target.id === viewer.id) throw new UserError('Выбери другого участника.');
          const selected = session.selected as number[];
          session.selected = selected.includes(target.id) ? selected.filter(x => x !== target.id) : [...selected, target.id];
          await s.saveSession(uid, session); await helpPicker(s, viewer, session);
        } else if (action === 'sendhelp') {
          const session = await s.session(uid); requireStep(session, 'help_pick');
          await s.requestHelp(viewer, Number(session.occurrence), session.selected as number[]);
          await s.saveSession(uid); await s.send(uid, 'Просьба отправлена. До принятия задача остаётся у тебя.');
        } else if (action === 'accept') {
          const taskId = await s.acceptHelp(viewer, id(arg));
          await s.send(uid, 'Задача теперь твоя. Напоминания тоже будут приходить тебе.'); await taskCard(s, viewer, taskId);
        } else if (action === 'cancelhelp') { await s.cancelHelp(viewer, id(arg)); await s.send(uid, 'Просьба закрыта. Задача остаётся у тебя.'); }
        else if (action === 'owner') {
          s.admin(viewer); const session = await s.session(uid); requireStep(session, 'task_owner');
          const target = await s.target(viewer, id(arg));
          await s.saveSession(uid, { ...session, step: 'task_kind', owner: target.id });
          await s.send(uid, 'Как часто повторяется задача?', keyboard([
            [button('Один раз', 'kind:once'), button('Ежедневно', 'kind:daily')],
            [button('По дням недели', 'kind:weekly'), button('Ежемесячно', 'kind:monthly')],
            [button('День недели в месяце', 'kind:monthly_weekday')],
          ]));
        } else if (action === 'kind') {
          s.admin(viewer); const session = await s.session(uid); requireStep(session, 'task_kind');
          if (!['once', 'daily', 'weekly', 'monthly', 'monthly_weekday'].includes(arg ?? '')) throw new UserError('Выбери расписание заново.');
          if (arg === 'monthly_weekday') {
            await s.saveSession(uid, { ...session, step: 'task_ordinal', kind: arg });
            await s.send(uid, 'Какой по счёту день недели в месяце?', keyboard([1,2,3,4,-1].map(n => [button(ordinalNames[n]!, `ordinal:${n}`)])));
          } else {
            await s.saveSession(uid, { ...session, step: 'task_date', kind: arg });
            await s.send(uid, `Введи ${arg === 'once' ? 'срок' : 'дату начала'} в формате ГГГГ-ММ-ДД.\nСегодня: ${localDay(options.now)}.${cancelHint}`);
          }
        } else if (action === 'ordinal') {
          s.admin(viewer); const session = await s.session(uid); requireStep(session, 'task_ordinal');
          const ordinal = Number(arg);
          if (![1,2,3,4,-1].includes(ordinal)) throw new UserError('Выбери порядковый номер кнопкой.');
          await s.saveSession(uid, { ...session, step: 'task_month_weekday', ordinal });
          await s.send(uid, 'Какой день недели?', keyboard(weekdayNames.map((name,i) => [button(name, `monthweekday:${i + 1}`)])));
        } else if (action === 'monthweekday') {
          s.admin(viewer); const session = await s.session(uid); requireStep(session, 'task_month_weekday');
          const weekday = id(arg);
          if (weekday > 7) throw new UserError('Выбери день недели кнопкой.');
          await s.saveSession(uid, { ...session, step: 'task_date', weekday });
          await s.send(uid, `С какой даты действует расписание? Формат: ГГГГ-ММ-ДД.\nСегодня: ${localDay(options.now)}.${cancelHint}`);
        } else if (action === 'overdue') {
          s.admin(viewer); const session = await s.session(uid); requireStep(session, 'task_overdue');
          if (arg !== 'daily' && arg !== 'weekends') throw new UserError('Выбери режим просрочки кнопкой.');
          await confirmTask(s, viewer, { ...session, overdue: arg });
        } else if (action === 'createtask') {
          s.admin(viewer); const session = await s.session(uid); requireStep(session, 'task_confirm');
          await s.createTask(viewer, String(session.title), Number(session.owner), sessionSchedule(session));
          await s.saveSession(uid); await s.send(uid, 'Задача создана. Исполнитель получит уведомление.'); await main(s, uid);
        } else throw new UserError('Кнопка устарела. Открой меню: /start');
      }
      await s.enqueue('answerCallbackQuery', { callback_query_id: ctx.callbackQuery.id });
    });
    bot.on('message:text', async ctx => textInput(s, uid, ctx.message.text.trim()));
    try { await bot.handleUpdate(update); }
    catch (caught) {
      const error = caught instanceof BotError ? caught.error : caught;
      if (!(error instanceof UserError)) throw error;
      await db.query('ROLLBACK TO SAVEPOINT bot_action');
      const failed = new Service(db, `error:${update.update_id}`, options.now);
      if (update.callback_query) await failed.enqueue('answerCallbackQuery', { callback_query_id: update.callback_query.id, text: error.message.slice(0, 200), show_alert: true });
      else await failed.send(uid, error.message);
    }
  });
}
