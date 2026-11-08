import { randomBytes } from 'node:crypto';
import type { Database } from './db.js';
import { addDays, firstDue, localDay, nextDue, shouldRemind, type Schedule } from './schedule.js';
import { hashCode, UserError } from './security.js';

export interface Member { id: number; group_id: number; bot_id: string; telegram_id: string; role: 'admin' | 'member'; name: string }
export interface Occurrence {
  id: number; task_id: number; group_id: number; title: string; due_on: string;
  original_owner_id: number; assignee_id: number; completed_by: number | null; completed_at: Date | null; schedule: Schedule; help_pending: boolean;
}
export type Session = { step: string; [key: string]: unknown };
const dateColumns = `o.id, o.task_id, o.group_id, t.title, o.due_on::text, o.original_owner_id, o.assignee_id, o.completed_by, o.completed_at, t.schedule,
  EXISTS(SELECT 1 FROM help_requests h WHERE h.occurrence_id=o.id AND h.state='pending') AS help_pending`;
export class Service {
  private sequence = 0;
  constructor(readonly db: Database, readonly key: string, readonly now = new Date(), readonly botId = 'default', readonly previousMessageId?: number) {}
  private assertMember(member: Member) {
    if (member.bot_id !== this.botId) throw new UserError('Этот участник относится к другому боту.');
  }
  async enqueue(method: string, payload: Record<string, unknown>, key?: string, helpId?: number, recipientId?: number) {
    await this.db.query(`INSERT INTO outbox (dedupe_key, method, payload, guard_help_id, recipient_id,bot_id)
      VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (bot_id,dedupe_key) DO NOTHING`,
      [key ?? `${this.key}:${this.sequence++}`, method, JSON.stringify(payload), helpId ?? null, recipientId ?? null,this.botId]);
  }
  async send(chatId: string | number, text: string, keyboard?: unknown, key?: string) {
    await this.enqueue('sendMessage', { chat_id: chatId, text, ...(keyboard ? { reply_markup: keyboard } : {}) }, key);
  }
  async screen(chatId: string | number, text: string, keyboard?: unknown) {
    await this.enqueue('sendMessage', { chat_id: chatId,text,__screen: true,
      ...(this.previousMessageId ? { __previous_message_id: this.previousMessageId } : {}),
      reply_markup: keyboard ?? { inline_keyboard: [[{ text: '🏠 Меню',callback_data: 'menu' }]] } });
  }
  async member(telegramId: string): Promise<Member | undefined> {
    return (await this.db.query<Member>(`SELECT m.*, u.profile_name AS name FROM members m JOIN app_users u USING (bot_id,telegram_id) WHERE m.telegram_id=$1 AND m.bot_id=$2`, [telegramId,this.botId])).rows[0];
  }
  async requireMember(telegramId: string) {
    const member = await this.member(telegramId);
    if (!member) throw new UserError('Сначала вступи в группу по коду приглашения. Отправь /join КОД.');
    return member;
  }
  async members(viewer: Member): Promise<Member[]> {
    this.assertMember(viewer);
    return (await this.db.query<Member>(`SELECT m.*, coalesce(a.name,u.profile_name) AS name FROM members m
      JOIN app_users u USING (bot_id,telegram_id) LEFT JOIN aliases a ON a.target_id=m.id AND a.viewer_id=$1
      WHERE m.group_id=$2 AND m.bot_id=$3 ORDER BY m.id`, [viewer.id, viewer.group_id,this.botId])).rows;
  }
  async target(viewer: Member, id: number) {
    const member = (await this.members(viewer)).find(m => m.id === id);
    if (!member) throw new UserError('Участник не найден в твоей группе.');
    return member;
  }
  async name(viewer: Member, targetId: number) { return (await this.target(viewer, targetId)).name; }
  async alias(viewer: Member, targetId: number, name: string) {
    await this.target(viewer, targetId);
    if (name.trim().length < 1 || name.trim().length > 64) throw new UserError('Имя должно содержать от 1 до 64 символов.');
    await this.db.query(`INSERT INTO aliases (viewer_id,target_id,name) VALUES ($1,$2,$3)
      ON CONFLICT (viewer_id,target_id) DO UPDATE SET name=excluded.name`, [viewer.id, targetId, name.trim()]);
  }
  async resetAlias(viewer: Member, targetId: number) {
    await this.target(viewer, targetId);
    await this.db.query('DELETE FROM aliases WHERE viewer_id=$1 AND target_id=$2', [viewer.id, targetId]);
  }
  async createGroup(telegramId: string, name: string, allowedIds: string[]) {
    if (!allowedIds.includes(telegramId)) throw new UserError('Создание группы доступно администратору бота. Для вступления используй код приглашения.');
    if (await this.member(telegramId)) throw new UserError('Ты уже состоишь в группе.');
    if (!name.trim() || name.trim().length > 80) throw new UserError('Название группы: от 1 до 80 символов.');
    const group = (await this.db.query<{ id: number }>('INSERT INTO task_groups (name,bot_id) VALUES ($1,$2) RETURNING id', [name.trim(),this.botId])).rows[0]!;
    await this.db.query(`INSERT INTO members (group_id,telegram_id,role,bot_id) VALUES ($1,$2,'admin',$3)`, [group.id, telegramId,this.botId]);
    return this.requireMember(telegramId);
  }
  async invite(admin: Member) {
    this.admin(admin);
    const code = randomBytes(10).toString('hex').toUpperCase();
    await this.db.query(`UPDATE task_groups SET invite_hash=$1, invite_expires_at=$2 WHERE id=$3`,
      [hashCode(code), new Date(this.now.getTime() + 7 * 86400_000), admin.group_id]);
    return code;
  }
  async join(telegramId: string, code: string) {
    if (await this.member(telegramId)) throw new UserError('Ты уже состоишь в группе.');
    const group = (await this.db.query<{ id: number }>('SELECT id FROM task_groups WHERE invite_hash=$1 AND invite_expires_at>$2 AND bot_id=$3', [hashCode(code), this.now,this.botId])).rows[0];
    if (!group) throw new UserError('Код не найден или истёк. Попроси администратора прислать новый.');
    await this.db.query(`INSERT INTO members (group_id,telegram_id,role,bot_id) VALUES ($1,$2,'member',$3)`, [group.id, telegramId,this.botId]);
  }
  admin(member: Member) { this.assertMember(member); if (member.role !== 'admin') throw new UserError('Это действие доступно администратору группы.'); }
  async reminderSettings(admin: Member) {
    this.admin(admin);
    const group = (await this.db.query<{ reminder_hour: number; timezone: string }>('SELECT reminder_hour,timezone FROM task_groups WHERE id=$1 AND bot_id=$2',[admin.group_id,this.botId])).rows[0];
    if (!group) throw new UserError('Группа не найдена у этого бота.');
    return group;
  }
  async setReminderHour(admin: Member, hour: number) {
    this.admin(admin);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new UserError('Выбери час от 00 до 23.');
    await this.db.query('UPDATE task_groups SET reminder_hour=$1 WHERE id=$2 AND bot_id=$3',[hour,admin.group_id,this.botId]);
  }
  async session(telegramId: string): Promise<Session | undefined> {
    return (await this.db.query<{ data: Session }>('SELECT data FROM sessions WHERE telegram_id=$1 AND expires_at>$2 AND bot_id=$3', [telegramId, this.now,this.botId])).rows[0]?.data;
  }
  async saveSession(telegramId: string, data?: Session) {
    if (!data) { await this.db.query('DELETE FROM sessions WHERE telegram_id=$1 AND bot_id=$2', [telegramId,this.botId]); return; }
    await this.db.query(`INSERT INTO sessions (telegram_id,data,expires_at,bot_id) VALUES ($1,$2,$3,$4)
      ON CONFLICT (bot_id,telegram_id) DO UPDATE SET data=excluded.data,expires_at=excluded.expires_at`,
      [telegramId, JSON.stringify(data), new Date(this.now.getTime() + 3600_000),this.botId]);
  }
  async today(member: Member) {
    this.assertMember(member);
    const group = (await this.db.query<{ timezone: string }>('SELECT timezone FROM task_groups WHERE id=$1 AND bot_id=$2', [member.group_id,this.botId])).rows[0];
    if (!group) throw new UserError('Группа не найдена у этого бота.');
    return localDay(this.now, group.timezone);
  }
  async createTask(admin: Member, title: string, ownerId: number, schedule: Schedule) {
    this.admin(admin);
    await this.target(admin, ownerId);
    if (!title.trim() || title.trim().length > 160) throw new UserError('Название задачи: от 1 до 160 символов.');
    const first = firstDue(schedule);
    const task = (await this.db.query<{ id: number }>(`INSERT INTO tasks (group_id,title,owner_id,schedule,next_on)
      VALUES ($1,$2,$3,$4,$5) RETURNING id`, [admin.group_id, title.trim(), ownerId, JSON.stringify(schedule), nextDue(schedule, first)])).rows[0]!;
    // Always expose the first occurrence, even when its date is beyond the rolling horizon.
    await this.db.query(`INSERT INTO occurrences (task_id,group_id,due_on,original_owner_id,assignee_id,coalesced)
      VALUES ($1,$2,$3,$4,$4,$5)`, [task.id, admin.group_id, first, ownerId, schedule.overdue === 'weekends']);
    await this.materialize(admin.group_id);
    const owner = await this.target(admin, ownerId);
    await this.send(owner.telegram_id, `📋 Тебе назначена задача: ${title.trim()}\nНачало: ${schedule.start}\nПосмотреть: /tasks`, undefined, `task-created:${task.id}`);
    return task.id;
  }
  async materialize(groupId: number) {
    const group = (await this.db.query<{ timezone: string }>('SELECT timezone FROM task_groups WHERE id=$1 AND bot_id=$2', [groupId,this.botId])).rows[0];
    if (!group) throw new UserError('Группа не найдена у этого бота.');
    const today = localDay(this.now, group.timezone);
    const through = addDays(today, 7);
    const tasks = (await this.db.query<{ id: number; owner_id: number; schedule: Schedule; next_on: string }>(
      `SELECT id,owner_id,schedule,next_on::text FROM tasks WHERE group_id=$1 AND active AND next_on<=$2 ORDER BY id FOR UPDATE`, [groupId, through])).rows;
    for (const task of tasks) {
      let day: string | null = task.next_on;
      if (task.schedule.overdue === 'weekends') {
        let pending = (await this.db.query('SELECT id FROM occurrences WHERE task_id=$1 AND completed_at IS NULL', [task.id])).rows.length > 0;
        // Only due cycles can open. Missed cycles advance the calendar, never duplicate the pending task.
        for (let i = 0; day && day <= today && i < 500; i++) {
          if (!pending) {
            await this.db.query(`INSERT INTO occurrences (task_id,group_id,due_on,original_owner_id,assignee_id,coalesced)
              VALUES ($1,$2,$3,$4,$4,true) ON CONFLICT DO NOTHING`, [task.id, groupId, day, task.owner_id]);
            pending = true;
          }
          day = nextDue(task.schedule, day);
        }
        await this.db.query('UPDATE tasks SET next_on=$1 WHERE id=$2', [day, task.id]);
        continue;
      }
      for (let i = 0; day && day <= through && i < 500; i++) {
        await this.db.query(`INSERT INTO occurrences (task_id,group_id,due_on,original_owner_id,assignee_id)
          VALUES ($1,$2,$3,$4,$4) ON CONFLICT (task_id,due_on) DO NOTHING`, [task.id, groupId, day, task.owner_id]);
        day = nextDue(task.schedule, day);
      }
      await this.db.query('UPDATE tasks SET next_on=$1 WHERE id=$2', [day, task.id]);
    }
  }
  async tasks(viewer: Member, ownerId: number, page = 0) {
    await this.target(viewer, ownerId);
    await this.materialize(viewer.group_id);
    return (await this.db.query<Occurrence>(`SELECT ${dateColumns} FROM occurrences o JOIN tasks t ON t.id=o.task_id
      WHERE o.group_id=$1 AND o.assignee_id=$2 AND o.completed_at IS NULL AND t.active
      ORDER BY o.due_on,o.id LIMIT 6 OFFSET $3`, [viewer.group_id, ownerId, Math.max(0, Math.min(10000, page)) * 5])).rows;
  }
  async occurrence(viewer: Member, id: number, lock = false): Promise<Occurrence> {
    this.assertMember(viewer);
    if (lock) {
      // Match materialize's lock order: template first, occurrence second.
      await this.db.query(`SELECT t.id FROM tasks t JOIN occurrences o ON o.task_id=t.id
        WHERE o.id=$1 AND o.group_id=$2 AND t.active AND o.group_id IN (SELECT id FROM task_groups WHERE bot_id=$3) FOR UPDATE OF t`, [id, viewer.group_id,this.botId]);
    }
    const occurrence = (await this.db.query<Occurrence>(`SELECT ${dateColumns} FROM occurrences o JOIN tasks t ON t.id=o.task_id
      WHERE o.id=$1 AND o.group_id=$2 AND t.active AND o.group_id IN (SELECT id FROM task_groups WHERE bot_id=$3) ${lock ? 'FOR UPDATE OF o' : ''}`, [id, viewer.group_id,this.botId])).rows[0];
    if (!occurrence) throw new UserError('Задача не найдена в твоей группе.');
    return occurrence;
  }
  async deleteTask(admin: Member, occurrenceId: number) {
    this.admin(admin);
    const task = await this.occurrence(admin,occurrenceId,true);
    await this.db.query('UPDATE tasks SET active=false,next_on=NULL WHERE id=$1',[task.task_id]);
    const occurrences = (await this.db.query<{ id: number }>('SELECT id FROM occurrences WHERE task_id=$1 ORDER BY id FOR UPDATE',[task.task_id])).rows;
    for (const occurrence of occurrences) await this.closeHelp(occurrence.id);
    return task.assignee_id;
  }
  async event(id: number, actor: number, kind: string, details: Record<string, unknown> = {}) {
    await this.db.query('INSERT INTO events (occurrence_id,actor_id,kind,details) VALUES ($1,$2,$3,$4)', [id, actor, kind, JSON.stringify(details)]);
  }
  async closeHelp(occurrenceId: number) {
    const requests = (await this.db.query<{ id: number }>(`UPDATE help_requests SET state='cancelled' WHERE occurrence_id=$1 AND state='pending' RETURNING id`, [occurrenceId])).rows;
    for (const r of requests) await this.removeHelpButtons(r.id);
  }
  async removeHelpButtons(requestId: number) {
    const recipients = (await this.db.query<{ telegram_id: string; message_id: string }>(`SELECT m.telegram_id,hr.message_id FROM help_recipients hr
      JOIN members m ON m.id=hr.member_id WHERE hr.request_id=$1 AND hr.message_id IS NOT NULL`, [requestId])).rows;
    for (const r of recipients) await this.enqueue('editMessageReplyMarkup', { chat_id: r.telegram_id, message_id: Number(r.message_id), reply_markup: { inline_keyboard: [] } });
  }
  async complete(viewer: Member, id: number, undo = false) {
    const task = await this.occurrence(viewer, id, true);
    if (task.assignee_id !== viewer.id) throw new UserError('Отметить выполнение может текущий исполнитель.');
    if (undo ? !task.completed_at : !!task.completed_at) throw new UserError(undo ? 'Задача уже открыта.' : 'Задача уже выполнена.');
    if (undo && task.completed_by !== viewer.id) throw new UserError('Отменить можно только свою отметку.');
    if (task.schedule.overdue === 'weekends') {
      if (undo) {
        const pending = await this.db.query('SELECT id FROM occurrences WHERE task_id=$1 AND id<>$2 AND completed_at IS NULL', [task.task_id, id]);
        if (pending.rows.length) throw new UserError('Нельзя отменить отметку: уже начался следующий цикл задачи.');
      } else {
        // A late completion covers all calendar dates up to completion, including cycles not yet materialized.
        const today = await this.today(viewer);
        const through = today > task.due_on ? today : task.due_on;
        let day = nextDue(task.schedule, task.due_on);
        while (day && day <= through) day = nextDue(task.schedule, day);
        await this.db.query('UPDATE tasks SET next_on=$1 WHERE id=$2', [day, task.task_id]);
      }
    }
    await this.db.query('UPDATE occurrences SET completed_by=$1, completed_at=$2 WHERE id=$3', [undo ? null : viewer.id, undo ? null : this.now, id]);
    await this.closeHelp(id);
    await this.event(id, viewer.id, undo ? 'reopened' : 'completed');
  }
  async requestHelp(viewer: Member, id: number, targetIds: number[]) {
    const task = await this.occurrence(viewer, id, true);
    if (task.completed_at || task.assignee_id !== viewer.id) throw new UserError('Попросить помощи можно только со своей невыполненной задачей.');
    const recipients = [...new Set(targetIds)];
    if (!recipients.length || recipients.includes(viewer.id)) throw new UserError('Выбери хотя бы одного другого участника.');
    const targets = await Promise.all(recipients.map(target => this.target(viewer, target)));
    if ((await this.db.query("SELECT id FROM help_requests WHERE occurrence_id=$1 AND state='pending'", [id])).rows.length) throw new UserError('Просьба по этой задаче уже отправлена.');
    const request = (await this.db.query<{ id: number }>('INSERT INTO help_requests (occurrence_id,requester_id) VALUES ($1,$2) RETURNING id', [id, viewer.id])).rows[0]!;
    for (const target of targets) {
      await this.db.query('INSERT INTO help_recipients (request_id,member_id) VALUES ($1,$2)', [request.id, target.id]);
      await this.enqueue('sendMessage', { chat_id: target.telegram_id,
        text: `🙋 ${await this.name(target, viewer.id)} просит взять задачу:\n${task.title}\nСрок: ${task.due_on}\nЗадача перейдёт первому согласившемуся.`,
        reply_markup: { inline_keyboard: [[{ text: '🤝 Возьму задачу', callback_data: `accept:${request.id}` }]] } },
        `help:${request.id}:${target.id}`, request.id, target.id);
    }
    await this.event(id, viewer.id, 'help_requested', { recipients });
    return request.id;
  }
  async acceptHelp(viewer: Member, requestId: number) {
    this.assertMember(viewer);
    const request = (await this.db.query<{ occurrence_id: number; requester_id: number }>(`SELECT h.occurrence_id,h.requester_id FROM help_requests h
      JOIN help_recipients r ON r.request_id=h.id JOIN occurrences o ON o.id=h.occurrence_id
      WHERE h.id=$1 AND r.member_id=$2 AND o.group_id=$3`, [requestId, viewer.id, viewer.group_id])).rows[0];
    if (!request) throw new UserError('Эта просьба адресована другому участнику.');
    // Template and occurrence locks serialize competing accept/completion/cancel calls.
    const task = await this.occurrence(viewer, request.occurrence_id, true);
    const won = (await this.db.query(`UPDATE help_requests SET state='accepted',accepted_by=$1 WHERE id=$2 AND state='pending' RETURNING id`, [viewer.id, requestId])).rows.length;
    if (!won || task.completed_at || task.assignee_id !== request.requester_id) throw new UserError('Просьба уже закрыта: задачу забрали, отменили или выполнили.');
    await this.db.query('UPDATE occurrences SET assignee_id=$1 WHERE id=$2', [viewer.id, task.id]);
    await this.event(task.id, viewer.id, 'transferred', { from: request.requester_id, to: viewer.id });
    await this.removeHelpButtons(requestId);
    const requester = await this.target(viewer, request.requester_id);
    await this.send(requester.telegram_id, `🤝 ${await this.name(requester, viewer.id)} взял(а) задачу «${task.title}». Напоминания теперь получает новый исполнитель.`);
    for (const target of (await this.db.query<{ member_id: number }>('SELECT member_id FROM help_recipients WHERE request_id=$1 AND member_id<>$2', [requestId, viewer.id])).rows) {
      const other = await this.target(viewer, target.member_id);
      await this.send(other.telegram_id, `Просьба по задаче «${task.title}» закрыта. Её взял(а) ${await this.name(other, viewer.id)}.`);
    }
    return task.id;
  }
  async cancelHelp(viewer: Member, id: number) {
    const task = await this.occurrence(viewer, id, true);
    if (task.assignee_id !== viewer.id) throw new UserError('Отменить просьбу может текущий исполнитель.');
    await this.closeHelp(id);
    await this.event(id, viewer.id, 'help_cancelled');
  }
  async history(viewer: Member) {
    this.assertMember(viewer);
    return (await this.db.query<{ title: string; kind: string; actor_id: number; created_at: Date; due_on: string }>(`SELECT t.title,e.kind,e.actor_id,e.created_at,o.due_on::text FROM events e
      JOIN occurrences o ON o.id=e.occurrence_id JOIN tasks t ON t.id=o.task_id
      WHERE o.group_id=$1 AND e.created_at >= $2 AND o.group_id IN (SELECT id FROM task_groups WHERE bot_id=$3) ORDER BY e.id DESC LIMIT 20`, [viewer.group_id, new Date(this.now.getTime() - 7 * 86400_000),this.botId])).rows;
  }
  async reminderText(member: Member, day: string) {
    this.assertMember(member);
    const tasks = (await this.db.query<{ title: string; due_on: string; schedule: Schedule }>(`SELECT t.title,o.due_on::text,t.schedule FROM occurrences o JOIN tasks t ON t.id=o.task_id
      WHERE o.assignee_id=$1 AND o.group_id=$2 AND t.active AND o.completed_at IS NULL AND o.due_on<=$3 ORDER BY o.due_on,o.id`,[member.id,member.group_id,day])).rows
      .filter(task => shouldRemind(task.schedule,task.due_on,day));
    return tasks.length ? `📋 Твои невыполненные задачи (${tasks.length}):\n${tasks.slice(0,15).map(t => `• ${t.title} — ${t.due_on}`).join('\n')}\n\nОткрыть список: /tasks` : undefined;
  }
  async reminders() {
    const groups = (await this.db.query<{ id: number; timezone: string; reminder_hour: number }>('SELECT id,timezone,reminder_hour FROM task_groups WHERE bot_id=$1 ORDER BY id',[this.botId])).rows;
    for (const group of groups) {
      const day = localDay(this.now,group.timezone);
      const hour = Number(new Intl.DateTimeFormat('en-GB',{ timeZone: group.timezone,hour: '2-digit',hourCycle: 'h23' }).format(this.now));
      if (hour < group.reminder_hour) continue;
      // Atomically claim today's group mailing; concurrent runs and time edits cannot duplicate it.
      const claimed = await this.db.query(`UPDATE task_groups SET last_reminder_on=$1 WHERE id=$2 AND bot_id=$3
        AND reminder_hour<=$4 AND (last_reminder_on IS NULL OR last_reminder_on<$1) RETURNING id`,[day,group.id,this.botId,hour]);
      if (!claimed.rows.length) continue;
      await this.materialize(group.id);
      const members = (await this.db.query<Member>(`SELECT m.*,u.profile_name AS name FROM members m JOIN app_users u USING (bot_id,telegram_id) WHERE group_id=$1 AND m.bot_id=$2`, [group.id,this.botId])).rows;
      for (const member of members) {
        const text = await this.reminderText(member,day);
        if (text) await this.send(member.telegram_id,text,undefined,`reminder:${member.id}:${day}`);
      }
    }
  }
}
