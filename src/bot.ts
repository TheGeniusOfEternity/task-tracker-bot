import { Bot, BotError, InlineKeyboard } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import type { Store } from './db.js';
import { Service, type Member, type Session } from './service.js';
import { addDays, firstDue, ordinalPlural, scheduleLabel, validDay, weekdayShortNames, weekdaysLabel, type Schedule } from './schedule.js';
import { UserError } from './security.js';

export interface BotOptions { token: string; adminIds: string[]; botInfo: UserFromGetMe; now?: Date; botId?: string }
const labels: Record<string, string> = { completed: '✅ Выполнено', reopened: '↩️ Снова открыто', transferred: '🤝 Передано', help_requested: '🙋 Запрошена помощь', help_cancelled: 'Просьба отменена' };
const keyboard = (rows: { text: string; callback_data: string }[][]) => ({ inline_keyboard: rows });
const button = (text: string, data: string) => ({ text, callback_data: data });
const cancelHint = '\n\n«🏠 Меню» отменит текущее действие.';
function navigationKeyboard(member?: Member) {
  const result = new InlineKeyboard();
  if (member) {
    result.text('📋 Мои задачи','mine').row().text('👥 Группа','group').row().text('📖 Журнал','history');
    if (member.role === 'admin') result.row().text('➕ Создать задачу','new').row().text('🔗 Приглашение','invite').row().text('⚙️ Настройки','settings');
  } else result.text('🏠 Меню','menu');
  return result;
}
function id(value: string | undefined) {
  if (!value || !/^[1-9]\d{0,9}$/.test(value)) throw new UserError('Некорректная кнопка. Открой меню заново: /start');
  return Number(value);
}
async function main(s: Service, uid: string, notice?: string) {
  await s.enqueue('sendMessage',{ chat_id: uid,text: 'Открываю меню…',reply_markup: { remove_keyboard: true },__screen: true },`remove-reply-keyboard:${uid}`);
  const member = await s.member(uid);
  if (!member) {
    await s.screen(uid, '📋 Трекер задач\nОткрой ссылку-приглашение от администратора или введи /join КОД.\nАдминистратор бота может создать группу: /create Название\nТвой Telegram ID: /id',navigationKeyboard());
    return;
  }
  await s.screen(uid, `${notice ? `${notice}\n\n` : ''}Что хочешь сделать?`,navigationKeyboard(member));
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
    keyboard([...members.map(m => [button(`👤 ${m.name}${m.id === viewer.id ? ' (ты)' : ''}`, `member:${m.id}`)]), [button('🏠 Меню', 'menu')]]));
}
async function memberCard(s: Service, viewer: Member, targetId: number) {
  const target = await s.target(viewer, targetId);
  await s.screen(viewer.telegram_id, `${target.name}\n${target.role === 'admin' ? 'Администратор' : 'Участник'}\nНазвания участников настраиваются лично для тебя.`,
    keyboard([[button('📋 Задачи', `list:${targetId}:0`)], [button('✏️ Назвать для себя', `rename:${targetId}`)],
      [button('↩️ Вернуть имя Telegram', `resetname:${targetId}`)], [button('👥 Группа', 'group'),button('🏠 Меню','menu')]]));
}
async function settings(s: Service, viewer: Member, saved = false) {
  const group = await s.reminderSettings(viewer);
  const hour = String(group.reminder_hour).padStart(2,'0');
  await s.screen(viewer.telegram_id,`${saved ? 'Час рассылки сохранён.\n\n' : ''}⚙️ Настройки группы\n\nРассылка задач: ${hour}:00 (${group.timezone}).\nОдин раз в день. На бесплатном тарифе сообщение приходит в пределах выбранного часа. Если сегодня рассылка уже была, новое время действует со следующего дня.`,keyboard([
    [button('⏰ Час рассылки','reminderhours')],[button('🏠 Меню','menu')],
  ]));
}
async function reminderHours(s: Service, viewer: Member) {
  const group = await s.reminderSettings(viewer);
  const hours = Array.from({ length: 24 },(_,hour) => button(`${hour === group.reminder_hour ? '✅' : '🕐'} ${String(hour).padStart(2,'0')}:00`,`reminderhour:${hour}`));
  await s.screen(viewer.telegram_id,`Выбери час ежедневной рассылки для всей группы.\nЧасовой пояс: ${group.timezone}.`,keyboard([
    ...Array.from({ length: 6 },(_,row) => hours.slice(row*4,row*4+4)),[button('⬅️ Назад','settings'),button('🏠 Меню','menu')],
  ]));
}
function taskStatus(task: { due_on: string; completed_at: Date | null }, today: string) {
  if (task.completed_at) return { icon: '🟢',text: 'Выполнено' };
  if (task.due_on < today) return { icon: '🔴',text: 'Просрочено' };
  if (task.due_on === today) return { icon: '🟡',text: 'На сегодня' };
  return { icon: '🔵',text: 'Предстоит' };
}
async function taskList(s: Service, viewer: Member, owner: number, page = 0) {
  const target = await s.target(viewer, owner);
  const tasks = await s.tasks(viewer, owner, page);
  const today = await s.today(viewer);
  const rows = tasks.slice(0, 5).map(t => [button(`${taskStatus(t,today).icon} ${t.title.slice(0, 45)} · ${t.due_on}`, `task:${t.id}`)]);
  const nav = [];
  if (page > 0) nav.push(button('⬅️ Назад', `list:${owner}:${page - 1}`));
  if (tasks.length > 5) nav.push(button('➡️ Дальше', `list:${owner}:${page + 1}`));
  nav.push(button('🏠 Меню','menu'));
  rows.push(nav);
  await s.screen(viewer.telegram_id, `Задачи: ${target.name}${tasks.length ? '' : '\nОткрытых задач пока нет.'}`, keyboard(rows));
}
async function taskCard(s: Service, viewer: Member, occurrenceId: number) {
  const t = await s.occurrence(viewer, occurrenceId);
  const rows = [];
  if (t.assignee_id === viewer.id) {
    if (t.completed_at) rows.push([button('↩️ Отменить отметку', `undo:${t.id}`)]);
    else {
      rows.push([button('✅ Выполнено', `done:${t.id}`)]);
      rows.push([t.help_pending ? button('🚫 Отменить просьбу о помощи',`cancelhelp:${t.id}`) : button('🙋 Попросить помощи',`help:${t.id}`)]);
    }
  }
  if (viewer.role === 'admin') rows.push([button('🗑 Удалить задачу',`deletetask:${t.id}`)]);
  rows.push([button('⬅️ Назад', `list:${t.assignee_id}:0`),button('🏠 Меню','menu')]);
  const status = taskStatus(t,await s.today(viewer));
  await s.screen(viewer.telegram_id, `📋 ${t.title}\nСрок: ${t.due_on} (до конца дня, Москва)\nИсполнитель: ${await s.name(viewer, t.assignee_id)}\n${scheduleLabel(t.schedule)}${t.schedule.overdue === 'weekends' ? '\nПри просрочке: напоминания по субботам и воскресеньям, одна открытая задача.' : ''}\n${status.icon} ${status.text}`, keyboard(rows));
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
  if (currentPage > 0) nav.push(button('⬅️ Назад',`history:${currentPage - 1}`));
  if (events.length > (currentPage + 1) * 6) nav.push(button('➡️ Дальше',`history:${currentPage + 1}`));
  nav.push(button('🏠 Меню','menu'));
  await s.screen(viewer.telegram_id, lines.length ? `📖 События за 7 дней · страница ${currentPage + 1}\n\n${lines.join('\n\n')}` : 'За последние 7 дней событий пока нет.',
    keyboard([nav]));
}
async function helpPicker(s: Service, viewer: Member, session: Session) {
  const targets = (await s.members(viewer)).filter(m => m.id !== viewer.id);
  if (!targets.length) throw new UserError('Пока некому отправить просьбу. Пригласи других участников.');
  const selected = session.selected as number[];
  await s.screen(viewer.telegram_id, 'Кого попросить? Отметь участников, затем нажми «Отправить».\nЗадача перейдёт первому согласившемуся.',
    keyboard([...targets.map(m => [button(`${selected.includes(m.id) ? '✅ ' : '👤 '}${m.name}`, `pickhelp:${m.id}`)]),
      [button('❌ Отмена','cancel'),button(`📨 Отправить (${selected.length})`, 'sendhelp')]]));
}
const taskNavigation = (back = true) => [...(back ? [button('⬅️ Назад','taskback')] : []),button('❌ Отмена','cancel')];
async function titlePicker(s: Service, viewer: Member, session: Session) {
  await s.saveSession(viewer.telegram_id,{ ...session,step: 'task_title' });
  await s.screen(viewer.telegram_id,'Как называется задача? До 160 символов.',keyboard([taskNavigation(false)]));
}
async function ownerPicker(s: Service, viewer: Member, session: Session) {
  await s.saveSession(viewer.telegram_id,{ ...session,step: 'task_owner' });
  await s.screen(viewer.telegram_id,'Кому назначить задачу?',keyboard([
    ...(await s.members(viewer)).map(m => [button(`👤 ${m.name}`,`owner:${m.id}`)]),taskNavigation(),
  ]));
}
async function newTask(s: Service, viewer: Member) {
  s.admin(viewer);
  await titlePicker(s,viewer,{ step: 'task_title' });
}
async function daysPicker(s: Service, viewer: Member, session: Session, messageId?: number) {
  const selected = session.weekdays as number[];
  await s.saveSession(viewer.telegram_id,{ ...session,step: 'task_days' });
  const days = weekdayShortNames.map((name,index) => button(`${selected.includes(index + 1) ? '✅' : '⬜️'} ${name}`,`taskday:${index + 1}`));
  const text = `Отметь нужные дни и нажми «Готово».\nВыбрано: ${selected.length ? weekdaysLabel(selected) : 'пока ничего'}`;
  const markup = keyboard([days.slice(0,4),days.slice(4),[button(selected.length === 7 ? '☑️ Снять все' : '📅 Каждый день','taskdaysall')],[...taskNavigation(),button('✅ Готово','taskdaysdone')]]);
  if (messageId) await s.enqueue('editMessageText',{ chat_id: viewer.telegram_id,message_id: messageId,text,reply_markup: markup });
  else await s.screen(viewer.telegram_id,text,markup);
}
async function periodPicker(s: Service, viewer: Member, session: Session) {
  await s.saveSession(viewer.telegram_id,{ ...session,step: 'task_period' });
  await s.screen(viewer.telegram_id,`Как часто повторять?\n\nДни: ${weekdaysLabel(session.weekdays as number[])}`,keyboard([
    [button('1️⃣ Без повтора','period:once')],[button('🔁 Еженедельно','period:weekly')],[button('🗓 Ежемесячно','period:monthly')],
    taskNavigation(),
  ]));
}
async function ordinalPicker(s: Service, viewer: Member, session: Session) {
  await s.saveSession(viewer.telegram_id,{ ...session,step: 'task_ordinal' });
  await s.screen(viewer.telegram_id,`Ежемесячно · ${weekdaysLabel(session.weekdays as number[])}\n\nКакие по счёту выбранные дни месяца?`,keyboard([
    ...[1,2,3,4,-1].map(n => [button(`🗓 ${ordinalPlural[n]!.replace(/^./u,letter => letter.toUpperCase())}`,`ordinal:${n}`)]),taskNavigation(),
  ]));
}
async function taskBack(s: Service, viewer: Member, session: Session) {
  switch (session.step) {
    case 'task_owner': return titlePicker(s,viewer,session);
    case 'task_days': return ownerPicker(s,viewer,session);
    case 'task_period': return daysPicker(s,viewer,session);
    case 'task_date': return confirmTask(s,viewer,session);
    case 'task_ordinal': case 'task_overdue': return periodPicker(s,viewer,session);
    case 'task_confirm': return session.kind === 'monthly_weekday' ? ordinalPicker(s,viewer,session) : periodPicker(s,viewer,session);
    default: throw new UserError('Эта кнопка устарела.');
  }
}
async function askStart(s: Service, viewer: Member, session: Session) {
  await s.saveSession(viewer.telegram_id,{ ...session,step: 'task_date' });
  await s.screen(viewer.telegram_id,`Введи ${session.kind === 'once' ? 'срок' : 'дату начала расписания'} в формате ГГГГ-ММ-ДД. Например: ${await s.today(viewer)}.`,keyboard([[button('⬅️ Назад','taskback')]]));
}
async function invite(s: Service, admin: Member, username: string, created = false) {
  const code = await s.invite(admin);
  const url = `https://t.me/${username}?start=join_${code}`;
  await s.screen(admin.telegram_id, `${created ? 'Группа создана.' : 'Новая ссылка-приглашение готова.'}\n\n${url}\n\nПерешли ссылку участникам. Она откроет нужного бота — останется нажать «Запустить».\nСсылка действует 7 дней.${created ? '' : '\nПредыдущее приглашение больше не действует.'}`,
    new InlineKeyboard().url('🤝 Присоединиться',url).row().text('🏠 Меню','menu'));
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
    await ownerPicker(s,viewer,{ ...session,title: text.trim() });
  } else if (session.step === 'task_date') {
    if (!validDay(text) || text < await s.today(viewer) || text > '2100-12-31') throw new UserError('Введи дату от сегодняшнего дня до 2100 года в формате ГГГГ-ММ-ДД.');
    await confirmTask(s,viewer,{ ...session,manualStart: text });
  } else if (session.step === 'task_weekdays') {
    await daysPicker(s,viewer,{ ...session,weekdays: [] });
  } else throw new UserError('Выбери вариант кнопкой или отмени действие: /cancel');
}
function sessionSchedule(session: Session): Schedule {
  return { kind: session.kind as Schedule['kind'], start: session.start as string,
    ...(session.weekdays && session.kind !== 'once' ? { weekdays: session.weekdays as number[] } : {}),
    ...(session.kind === 'monthly_weekday' && session.weekday ? { weekday: Number(session.weekday) } : {}),
    ...(session.kind === 'monthly_weekday' && session.ordinal !== undefined ? { ordinal: Number(session.ordinal) } : {}),
    overdue: session.overdue as Schedule['overdue'] };
}
async function confirmTask(s: Service, viewer: Member, session: Session) {
  const today = await s.today(viewer);
  const start = session.manualStart as string | undefined ?? (session.kind === 'once'
    ? firstDue({ kind: 'weekly',start: addDays(today,1),weekdays: session.weekdays as number[] }) : today);
  session = { ...session,start,overdue: session.overdue ?? 'weekends' };
  const schedule = sessionSchedule(session);
  await s.saveSession(viewer.telegram_id, { ...session, step: 'task_confirm',calculatedOn: today });
  await s.screen(viewer.telegram_id, `Создать задачу?\n\n${session.title}\nИсполнитель: ${await s.name(viewer, Number(session.owner))}\n${scheduleLabel(schedule)}\nПервый срок: ${firstDue(schedule)}\nСрок — до конца дня по Москве.${schedule.kind === 'monthly' ? '\nВ коротком месяце — последний день месяца.' : ''}\n${schedule.overdue === 'weekends' ? 'Просрочка: напоминания по выходным, одна задача до выполнения. После выполнения — ближайший будущий срок по календарю.' : 'Просрочка: ежедневные напоминания; повторения учитываются отдельно.'}`,
    keyboard([[button('📅 Изменить дату','taskdate')],[...taskNavigation(),button('✅ Создать', 'createtask')]]));
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
    bot.command('once', async () => newTask(s,await s.requireMember(uid)));
    bot.command('invite', async ctx => invite(s,await s.requireMember(uid),ctx.me.username));
    bot.on('callback_query:data', async ctx => {
      const [action, arg, pageArg] = ctx.callbackQuery.data.split(':');
      if (action === 'menu' || action === 'cancel') { await s.saveSession(uid); await main(s, uid); }
      else {
        const viewer = await s.requireMember(uid);
        if (['group','member','mine','list','task','history','invite','settings','reminderhours'].includes(action ?? '')) await s.saveSession(uid);
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
        else if (action === 'newonce') await newTask(s,viewer);
        else if (action === 'invite') await invite(s,viewer,ctx.me.username);
        else if (action === 'settings') await settings(s,viewer);
        else if (action === 'reminderhours') await reminderHours(s,viewer);
        else if (action === 'reminderhour') {
          if (!/^(?:[0-9]|1[0-9]|2[0-3])$/.test(arg ?? '')) throw new UserError('Выбери час от 00 до 23.');
          await s.setReminderHour(viewer,Number(arg)); await s.saveSession(uid); await settings(s,viewer,true);
        }
        else if (action === 'deletetask') {
          s.admin(viewer); const task = await s.occurrence(viewer,id(arg));
          await s.saveSession(uid,{ step: 'delete_task',occurrence: task.id });
          await s.screen(uid,`Удалить задачу «${task.title}»?\n\nВсе её повторения исчезнут из списков, напоминания и просьбы о помощи прекратятся. Журнал выполнений сохранится.`,keyboard([
            [button('⬅️ Отмена',`task:${task.id}`),button('🗑 Удалить','confirmdelete')],
          ]));
        } else if (action === 'confirmdelete') {
          s.admin(viewer); const session = await s.session(uid); requireStep(session,'delete_task');
          const owner = await s.deleteTask(viewer,Number(session.occurrence));
          await s.saveSession(uid); await taskList(s,viewer,owner);
        } else if (action === 'done' || action === 'undo') { await s.complete(viewer, id(arg), action === 'undo'); await taskCard(s, viewer, id(arg)); }
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
          await s.saveSession(uid); await taskCard(s,viewer,Number(session.occurrence));
        } else if (action === 'accept') {
          const taskId = await s.acceptHelp(viewer, id(arg));
          await s.screen(uid, 'Задача теперь твоя. Напоминания тоже будут приходить тебе.'); await taskCard(s, viewer, taskId);
        } else if (action === 'cancelhelp') { await s.cancelHelp(viewer, id(arg)); await taskCard(s,viewer,id(arg)); }
        else if (action === 'owner') {
          s.admin(viewer); const session = await s.session(uid); requireStep(session, 'task_owner');
          const target = await s.target(viewer, id(arg));
          const next = { ...session,owner: target.id };
          await daysPicker(s,viewer,{ ...next,weekdays: session.weekdays ?? [] });
        } else if (action === 'taskday' || action === 'taskdaysall' || action === 'taskdaysdone') {
          s.admin(viewer); const session = await s.session(uid); requireStep(session,'task_days');
          let selected = session.weekdays as number[];
          if (action === 'taskdaysdone') {
            if (!selected.length) throw new UserError('Выбери хотя бы один день недели.');
            await periodPicker(s,viewer,session);
          } else {
            if (action === 'taskdaysall') selected = selected.length === 7 ? [] : [1,2,3,4,5,6,7];
            else { const day = id(arg); if (day > 7) throw new UserError('Выбери день от понедельника до воскресенья.'); selected = selected.includes(day) ? selected.filter(x => x !== day) : [...selected,day]; }
            await daysPicker(s,viewer,{ ...session,weekdays: selected.sort((a,b) => a - b) },ctx.callbackQuery.message?.message_id);
          }
        } else if (action === 'taskback') {
          s.admin(viewer); const session = await s.session(uid);
          if (!session?.step.startsWith('task_')) throw new UserError('Эта кнопка устарела.');
          await taskBack(s,viewer,session);
        } else if (action === 'taskdate') {
          s.admin(viewer); const session = await s.session(uid); requireStep(session,'task_confirm');
          await askStart(s,viewer,session);
        } else if (action === 'taskdateauto') {
          s.admin(viewer); const session = await s.session(uid); requireStep(session,'task_date');
          const next = { ...session }; delete next.manualStart; await periodPicker(s,viewer,next);
        } else if (action === 'backdays') {
          s.admin(viewer); const session = await s.session(uid); requireStep(session,'task_period'); await daysPicker(s,viewer,session);
        } else if (action === 'backperiod') {
          s.admin(viewer); const session = await s.session(uid); requireStep(session,'task_ordinal'); await periodPicker(s,viewer,session);
        } else if (action === 'period') {
          s.admin(viewer); const session = await s.session(uid); requireStep(session,'task_period');
          if (arg === 'once') await confirmTask(s,viewer,{ ...session,kind: 'once' });
          else if (arg === 'weekly') await confirmTask(s,viewer,{ ...session,kind: (session.weekdays as number[]).length === 7 ? 'daily' : 'weekly' });
          else if (arg === 'monthly') {
            await ordinalPicker(s,viewer,{ ...session,kind: 'monthly_weekday' });
          } else throw new UserError('Выбери «Без повтора», «Еженедельно» или «Ежемесячно».');
        } else if (action === 'kind') {
          s.admin(viewer); const session = await s.session(uid); requireStep(session, 'task_kind');
          await daysPicker(s,viewer,{ ...session,weekdays: [] });
        } else if (action === 'ordinal') {
          s.admin(viewer); const session = await s.session(uid); requireStep(session, 'task_ordinal');
          const ordinal = Number(arg);
          if (![1,2,3,4,-1].includes(ordinal)) throw new UserError('Выбери порядковый номер кнопкой.');
          if (session.weekdays) await confirmTask(s,viewer,{ ...session,ordinal });
          else await daysPicker(s,viewer,{ ...session,weekdays: [] });
        } else if (action === 'monthweekday') {
          s.admin(viewer); const session = await s.session(uid); requireStep(session, 'task_month_weekday');
          const weekday = id(arg);
          if (weekday > 7) throw new UserError('Выбери день недели кнопкой.');
          await confirmTask(s,viewer,{ ...session,weekday });
        } else if (action === 'overdue') {
          s.admin(viewer); const session = await s.session(uid); requireStep(session, 'task_overdue');
          if (arg !== 'daily' && arg !== 'weekends') throw new UserError('Выбери режим просрочки кнопкой.');
          await periodPicker(s, viewer, { ...session, overdue: arg });
        } else if (action === 'createtask') {
          s.admin(viewer); const session = await s.session(uid); requireStep(session, 'task_confirm');
          if (!session.manualStart && session.calculatedOn !== await s.today(viewer)) {
            await confirmTask(s,viewer,session);
          } else {
            if (session.manualStart && String(session.manualStart) < await s.today(viewer)) throw new UserError('Указанная дата уже прошла. Нажми «Изменить дату» и укажи новую дату.');
            await s.createTask(viewer, String(session.title), Number(session.owner), sessionSchedule(session));
            await s.saveSession(uid); await s.screen(uid, 'Задача создана. Исполнитель получит уведомление.'); await main(s, uid);
          }
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
      else {
        const session = await failed.session(uid);
        await failed.screen(uid,error.message,session?.step.startsWith('task_') ? keyboard([session.step === 'task_date' ? [button('⬅️ Назад','taskback')] : taskNavigation(session.step !== 'task_title')]) : navigationKeyboard(await failed.member(uid)));
      }
    }
  });
}
