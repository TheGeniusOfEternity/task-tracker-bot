import { Bot, BotError, InlineKeyboard, Keyboard } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import type { Store } from './db.js';
import { Service, type Member, type Session } from './service.js';
import { firstDue, localDay, ordinalNames, scheduleLabel, validDay, weekdayNames, type Schedule } from './schedule.js';
import { UserError } from './security.js';

export interface BotOptions { token: string; adminIds: string[]; botInfo: UserFromGetMe; now?: Date; botId?: string }
const labels: Record<string, string> = { completed: '✅ Выполнено', reopened: '↩️ Снова открыто', transferred: '🤝 Передано', help_requested: '🙋 Запрошена помощь', help_cancelled: 'Просьба отменена' };
const keyboard = (rows: { text: string; callback_data: string }[][]) => ({ inline_keyboard: rows });
const button = (text: string, data: string) => ({ text, callback_data: data });
const cancelHint = '\n\nОтменить: /cancel';
const navigation = { menu: '🏠 Меню',tasks: '📋 Мои задачи',group: '👥 Группа',history: '📖 Журнал',create: '➕ Создать задачу',invite: '🔗 Приглашение',cancel: '✖️ Отмена' } as const;
function navigationKeyboard(member?: Member) {
  const result = new Keyboard();
  if (member) {
    result.text(navigation.tasks).text(navigation.group).row().text(navigation.history).text(navigation.menu);
    if (member.role === 'admin') result.row().text(navigation.create).text(navigation.invite);
    result.row().text(navigation.cancel);
  } else result.text(navigation.menu);
  return result.persistent().resized();
}
function id(value: string | undefined) {
  if (!value || !/^[1-9]\d{0,9}$/.test(value)) throw new UserError('Некорректная кнопка. Открой меню заново: /start');
  return Number(value);
}
async function main(s: Service, uid: string, notice?: string) {
  const member = await s.member(uid);
  if (!member) {
    await s.screen(uid, '📋 Трекер задач\nОткрой ссылку-приглашение от администратора или введи /join КОД.\nАдминистратор бота может создать группу: /create Название\nТвой Telegram ID: /id',navigationKeyboard());
    return;
  }
  await s.screen(uid, `${notice ? `${notice}\n\n` : ''}Выбери раздел на клавиатуре под полем ввода.`,navigationKeyboard(member));
}
async function joinAndOpenMenu(s: Service, uid: string, code: string) {
  await s.saveSession(uid);
  if (await s.member(uid)) { await main(s,uid,'Ты уже состоишь в группе.'); return; }
  await s.join(uid,code);
  await main(s,uid,'Ты присоединился к группе.');
}
async function group(s: Service, viewer: Member) {
  const members = await s.members(viewer);
  await s.screen(viewer.telegram_id, '👥 Участники группы\nВыбери участника, чтобы посмотреть задачи или изменить имя только для себя.',
    keyboard([...members.map(m => [button(`${m.name}${m.id === viewer.id ? ' (ты)' : ''}`, `member:${m.id}`)]), [button('← Меню', 'menu')]]));
}
async function memberCard(s: Service, viewer: Member, targetId: number) {
  const target = await s.target(viewer, targetId);
  await s.screen(viewer.telegram_id, `${target.name}\n${target.role === 'admin' ? 'Администратор' : 'Участник'}\nНазвания участников настраиваются лично для тебя.`,
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
  await s.screen(viewer.telegram_id, `Задачи: ${target.name}\n${tasks.length ? 'Открытые задачи, ближайшие и просроченные:' : 'Открытых задач пока нет.'}`, keyboard(rows));
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
  await s.screen(viewer.telegram_id, `📋 ${t.title}\nСрок: ${t.due_on} (до конца дня, Москва)\nИсполнитель: ${await s.name(viewer, t.assignee_id)}\n${scheduleLabel(t.schedule)}${t.schedule.overdue === 'weekends' ? '\nПри просрочке: напоминания по субботам и воскресеньям, одна открытая задача.' : ''}\n${t.completed_at ? '✅ Выполнено' : 'Ожидает выполнения'}`, keyboard(rows));
}
async function history(s: Service, viewer: Member, page = 0) {
  const events = await s.history(viewer);
  const currentPage = Math.max(0,Math.min(page,Math.max(0,Math.ceil(events.length / 6) - 1)));
  const lines = [];
  for (const e of events.slice(currentPage * 6,currentPage * 6 + 6)) {
    const time = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', dateStyle: 'short', timeStyle: 'short' }).format(e.created_at);
    lines.push(`${labels[e.kind] ?? e.kind}: ${e.title}\n${await s.name(viewer, e.actor_id)} · ${time}`);
  }
  const nav = [];
  if (currentPage > 0) nav.push(button('← Назад',`history:${currentPage - 1}`));
  if (events.length > (currentPage + 1) * 6) nav.push(button('Дальше →',`history:${currentPage + 1}`));
  await s.screen(viewer.telegram_id, lines.length ? `📖 События за 7 дней · страница ${currentPage + 1}\n\n${lines.join('\n\n')}` : 'За последние 7 дней событий пока нет.',
    keyboard([...(nav.length ? [nav] : []),[button('← Меню', 'menu')]]));
}
async function helpPicker(s: Service, viewer: Member, session: Session) {
  const targets = (await s.members(viewer)).filter(m => m.id !== viewer.id);
  if (!targets.length) throw new UserError('Пока некому отправить просьбу. Пригласи других участников.');
  const selected = session.selected as number[];
  await s.screen(viewer.telegram_id, 'Кого попросить? Отметь участников, затем нажми «Отправить».\nЗадача перейдёт первому согласившемуся.',
    keyboard([...targets.map(m => [button(`${selected.includes(m.id) ? '✅ ' : ''}${m.name}`, `pickhelp:${m.id}`)]),
      [button(`Отправить (${selected.length})`, 'sendhelp')], [button('Отмена', 'cancel')]]));
}
async function newTask(s: Service, viewer: Member) {
  s.admin(viewer);
  await s.saveSession(viewer.telegram_id, { step: 'task_title' });
  await s.screen(viewer.telegram_id, `Как называется задача? До 160 символов.${cancelHint}`);
}
async function invite(s: Service, admin: Member, username: string, created = false) {
  const code = await s.invite(admin);
  const url = `https://t.me/${username}?start=join_${code}`;
  await s.screen(admin.telegram_id, `${created ? 'Группа создана.' : 'Новая ссылка-приглашение готова.'}\n\n${url}\n\nПерешли ссылку участникам. Она откроет нужного бота — останется нажать «Запустить».\nСсылка действует 7 дней.${created ? '' : '\nПредыдущее приглашение больше не действует.'}`,
    new InlineKeyboard().url('Присоединиться',url).row().text('← Меню','menu'));
}
function requireStep(session: Session | undefined, step: string): asserts session is Session {
  if (session?.step !== step) throw new UserError('Эта кнопка устарела. Открой меню заново: /start');
}
async function textInput(s: Service, uid: string, text: string) {
  const session = await s.session(uid);
  if (!session) { await main(s, uid); return; }
  if (session.step === 'join') {
    await joinAndOpenMenu(s,uid,text); return;
  }
  const viewer = await s.requireMember(uid);
  if (session.step === 'rename') {
    await s.alias(viewer, Number(session.target), text); await s.saveSession(uid);
    await s.screen(uid, 'Имя сохранено только для тебя.'); await memberCard(s, viewer, Number(session.target)); return;
  }
  s.admin(viewer);
  if (session.step === 'task_title') {
    if (!text.trim() || text.length > 160) throw new UserError('Название должно содержать от 1 до 160 символов.');
    await s.saveSession(uid, { step: 'task_owner', title: text.trim() });
    await s.screen(uid, 'Кому назначить задачу?', keyboard((await s.members(viewer)).map(m => [button(m.name, `owner:${m.id}`)])));
  } else if (session.step === 'task_date') {
    if (!validDay(text) || text < await s.today(viewer) || text > '2100-12-31') throw new UserError('Введи дату от сегодняшнего дня до 2100 года в формате ГГГГ-ММ-ДД.');
    const next = { ...session, start: text };
    if (session.kind === 'weekly') {
      await s.saveSession(uid, { ...next, step: 'task_weekdays' });
      await s.screen(uid, `В какие дни недели? Числа через запятую: 1 — пн, …, 7 — вс. Например: 1,3,5.${cancelHint}`);
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
  await s.screen(viewer.telegram_id, 'Что делать, если задача просрочена?\n\nПо выходным: напоминать по субботам и воскресеньям до выполнения. Новые календарные сроки не создают копий открытой задачи.\n\nКаждый день: напоминать ежедневно, каждое повторение учитывается отдельно.',
    keyboard([[button('По выходным, без копий', 'overdue:weekends')], [button('Каждый день, отдельно', 'overdue:daily')], [button('Отмена', 'cancel')]]));
}
async function confirmTask(s: Service, viewer: Member, session: Session) {
  const schedule = sessionSchedule(session);
  await s.saveSession(viewer.telegram_id, { ...session, step: 'task_confirm' });
  await s.screen(viewer.telegram_id, `Создать задачу?\n\n${session.title}\nИсполнитель: ${await s.name(viewer, Number(session.owner))}\n${scheduleLabel(schedule)}${schedule.weekdays ? ` (${schedule.weekdays.join(', ')})` : ''}\nПервый срок: ${firstDue(schedule)}\nСрок — до конца дня по Москве.${schedule.kind === 'monthly' ? '\nВ коротком месяце — последний день месяца.' : ''}\n${schedule.overdue === 'weekends' ? 'Просрочка: напоминания по выходным, одна задача до выполнения. После выполнения — ближайший будущий срок по календарю.' : 'Просрочка: ежедневные напоминания; повторения учитываются отдельно.'}`,
    keyboard([[button('Создать', 'createtask')], [button('Отмена', 'cancel')]]));
}

export async function processUpdate(store: Store, update: Update, options: BotOptions) {
  const from = update.message?.from ?? update.callback_query?.from;
  const chat = update.message?.chat ?? update.callback_query?.message?.chat;
  if (!from || chat?.type !== 'private') return;
  const uid = String(from.id);
  const botId = options.botId ?? 'default';
  await store.transaction(async db => {
    // The upsert also locks this user's row, serializing their persistent wizard across serverless instances.
    await db.query(`INSERT INTO app_users (telegram_id,profile_name,bot_id) VALUES ($1,$2,$3)
      ON CONFLICT (bot_id,telegram_id) DO UPDATE SET profile_name=excluded.profile_name`, [uid, [from.first_name, from.last_name].filter(Boolean).join(' ').slice(0, 128),botId]);
    const fresh = await db.query('INSERT INTO processed_updates (update_id,bot_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING update_id', [update.update_id,botId]);
    if (!fresh.rows.length) return;
    await db.query('SAVEPOINT bot_action');
    const previousMessageId = update.callback_query?.data?.startsWith('accept:') ? undefined : update.callback_query?.message?.message_id;
    const s = new Service(db, `update:${update.update_id}`, options.now,botId,previousMessageId);
    const bot = new Bot(options.token, { botInfo: options.botInfo });
    bot.command('id', async () => { await s.screen(uid, `Твой Telegram ID: ${uid}`); });
    bot.command('start', async ctx => {
      await s.saveSession(uid);
      if (ctx.match.startsWith('join_')) await joinAndOpenMenu(s,uid,ctx.match.slice(5));
      else await main(s, uid);
    });
    bot.command('create', async ctx => {
      const viewer = await s.createGroup(uid, ctx.match, options.adminIds);
      await invite(s,viewer,ctx.me.username,true);
    });
    bot.command('join', async ctx => {
      if (ctx.match || await s.member(uid)) await joinAndOpenMenu(s,uid,ctx.match);
      else { await s.saveSession(uid, { step: 'join' }); await s.screen(uid, `Введи код приглашения.${cancelHint}`); }
    });
    bot.command('cancel', async () => { await s.saveSession(uid); await s.screen(uid, 'Действие отменено.'); await main(s, uid); });
    bot.command('group', async () => group(s, await s.requireMember(uid)));
    bot.command(['tasks', 'today'], async () => { const m = await s.requireMember(uid); await taskList(s, m, m.id); });
    bot.command('history', async () => history(s, await s.requireMember(uid)));
    bot.command('new', async () => newTask(s, await s.requireMember(uid)));
    bot.command('invite', async ctx => invite(s,await s.requireMember(uid),ctx.me.username));
    bot.hears(Object.values(navigation),async ctx => {
      await s.saveSession(uid);
      const text = ctx.message?.text;
      if (text === navigation.menu || text === navigation.cancel) {
        await main(s,uid,text === navigation.cancel ? 'Действие отменено.' : undefined);
        return;
      }
      const viewer = await s.requireMember(uid);
      if (text === navigation.tasks) await taskList(s,viewer,viewer.id);
      else if (text === navigation.group) await group(s,viewer);
      else if (text === navigation.history) await history(s,viewer);
      else if (text === navigation.create) await newTask(s,viewer);
      else if (text === navigation.invite) await invite(s,viewer,ctx.me.username);
    });
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
          await s.screen(uid, `Как называть «${target.name}» для тебя? Введи удобное имя.${cancelHint}`);
        } else if (action === 'resetname') { await s.resetAlias(viewer, id(arg)); await memberCard(s, viewer, id(arg)); }
        else if (action === 'mine') await taskList(s, viewer, viewer.id);
        else if (action === 'list') await taskList(s, viewer, id(arg), /^\d{1,5}$/.test(pageArg ?? '') ? Number(pageArg) : 0);
        else if (action === 'task') await taskCard(s, viewer, id(arg));
        else if (action === 'history') await history(s, viewer,/^\d$/.test(arg ?? '') ? Number(arg) : 0);
        else if (action === 'new') await newTask(s, viewer);
        else if (action === 'invite') await invite(s,viewer,ctx.me.username);
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
          await s.saveSession(uid); await s.screen(uid, 'Просьба отправлена. До принятия задача остаётся у тебя.');
        } else if (action === 'accept') {
          const taskId = await s.acceptHelp(viewer, id(arg));
          await s.screen(uid, 'Задача теперь твоя. Напоминания тоже будут приходить тебе.'); await taskCard(s, viewer, taskId);
        } else if (action === 'cancelhelp') { await s.cancelHelp(viewer, id(arg)); await s.screen(uid, 'Просьба закрыта. Задача остаётся у тебя.'); }
        else if (action === 'owner') {
          s.admin(viewer); const session = await s.session(uid); requireStep(session, 'task_owner');
          const target = await s.target(viewer, id(arg));
          await s.saveSession(uid, { ...session, step: 'task_kind', owner: target.id });
          await s.screen(uid, 'Как часто повторяется задача?', keyboard([
            [button('Один раз', 'kind:once'), button('Ежедневно', 'kind:daily')],
            [button('По дням недели', 'kind:weekly'), button('Ежемесячно', 'kind:monthly')],
            [button('День недели в месяце', 'kind:monthly_weekday')],
          ]));
        } else if (action === 'kind') {
          s.admin(viewer); const session = await s.session(uid); requireStep(session, 'task_kind');
          if (!['once', 'daily', 'weekly', 'monthly', 'monthly_weekday'].includes(arg ?? '')) throw new UserError('Выбери расписание заново.');
          if (arg === 'monthly_weekday') {
            await s.saveSession(uid, { ...session, step: 'task_ordinal', kind: arg });
            await s.screen(uid, 'Какой по счёту день недели в месяце?', keyboard([1,2,3,4,-1].map(n => [button(ordinalNames[n]!, `ordinal:${n}`)])));
          } else {
            await s.saveSession(uid, { ...session, step: 'task_date', kind: arg });
            await s.screen(uid, `Введи ${arg === 'once' ? 'срок' : 'дату начала'} в формате ГГГГ-ММ-ДД.\nСегодня: ${localDay(options.now)}.${cancelHint}`);
          }
        } else if (action === 'ordinal') {
          s.admin(viewer); const session = await s.session(uid); requireStep(session, 'task_ordinal');
          const ordinal = Number(arg);
          if (![1,2,3,4,-1].includes(ordinal)) throw new UserError('Выбери порядковый номер кнопкой.');
          await s.saveSession(uid, { ...session, step: 'task_month_weekday', ordinal });
          await s.screen(uid, 'Какой день недели?', keyboard(weekdayNames.map((name,i) => [button(name, `monthweekday:${i + 1}`)])));
        } else if (action === 'monthweekday') {
          s.admin(viewer); const session = await s.session(uid); requireStep(session, 'task_month_weekday');
          const weekday = id(arg);
          if (weekday > 7) throw new UserError('Выбери день недели кнопкой.');
          await s.saveSession(uid, { ...session, step: 'task_date', weekday });
          await s.screen(uid, `С какой даты действует расписание? Формат: ГГГГ-ММ-ДД.\nСегодня: ${localDay(options.now)}.${cancelHint}`);
        } else if (action === 'overdue') {
          s.admin(viewer); const session = await s.session(uid); requireStep(session, 'task_overdue');
          if (arg !== 'daily' && arg !== 'weekends') throw new UserError('Выбери режим просрочки кнопкой.');
          await confirmTask(s, viewer, { ...session, overdue: arg });
        } else if (action === 'createtask') {
          s.admin(viewer); const session = await s.session(uid); requireStep(session, 'task_confirm');
          await s.createTask(viewer, String(session.title), Number(session.owner), sessionSchedule(session));
          await s.saveSession(uid); await s.screen(uid, 'Задача создана. Исполнитель получит уведомление.'); await main(s, uid);
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
      const failed = new Service(db, `error:${update.update_id}`, options.now,botId);
      if (update.callback_query) await failed.enqueue('answerCallbackQuery', { callback_query_id: update.callback_query.id, text: error.message.slice(0, 200), show_alert: true });
      else await failed.screen(uid, error.message,navigationKeyboard(await failed.member(uid)));
    }
  });
}
