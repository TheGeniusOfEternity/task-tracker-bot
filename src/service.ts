import { randomBytes } from 'node:crypto';
import type { Database } from './db.js';
import { addDays, firstDue, localDay, nextDue, type Schedule } from './schedule.js';
import { hashCode, UserError } from './security.js';

export interface Member { id: number; group_id: number; telegram_id: string; role: 'admin' | 'member'; name: string }
export interface Occurrence {
  id: number; task_id: number; group_id: number; title: string; due_on: string;
  original_owner_id: number; assignee_id: number; completed_by: number | null; completed_at: Date | null;
}
export type Session = { step: string; [key: string]: unknown };
const dateColumns = `o.id, o.task_id, o.group_id, t.title, o.due_on::text, o.original_owner_id, o.assignee_id, o.completed_by, o.completed_at`;
export class Service {
  private sequence = 0;
  constructor(readonly db: Database, readonly key: string, readonly now = new Date()) {}
  async enqueue(method: string, payload: Record<string, unknown>, key?: string, helpId?: number, recipientId?: number) {
    await this.db.query(`INSERT INTO outbox (dedupe_key, method, payload, guard_help_id, recipient_id)
      VALUES ($1,$2,$3,$4,$5) ON CONFLICT (dedupe_key) DO NOTHING`,
      [key ?? `${this.key}:${this.sequence++}`, method, JSON.stringify(payload), helpId ?? null, recipientId ?? null]);
  }
  async send(chatId: string | number, text: string, keyboard?: unknown, key?: string) {
    await this.enqueue('sendMessage', { chat_id: chatId, text, ...(keyboard ? { reply_markup: keyboard } : {}) }, key);
  }
  async member(telegramId: string): Promise<Member | undefined> {
    return (await this.db.query<Member>(`SELECT m.*, u.profile_name AS name FROM members m JOIN app_users u USING (telegram_id) WHERE m.telegram_id=$1`, [telegramId])).rows[0];
  }
  async requireMember(telegramId: string) {
    const member = await this.member(telegramId);
    if (!member) throw new UserError('Сначала вступи в группу по коду приглашения. Отправь /join КОД.');
    return member;
  }
  async members(viewer: Member): Promise<Member[]> {
    return (await this.db.query<Member>(`SELECT m.*, coalesce(a.name,u.profile_name) AS name FROM members m
      JOIN app_users u USING (telegram_id) LEFT JOIN aliases a ON a.target_id=m.id AND a.viewer_id=$1
      WHERE m.group_id=$2 ORDER BY m.id`, [viewer.id, viewer.group_id])).rows;
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
    const group = (await this.db.query<{ id: number }>('INSERT INTO task_groups (name) VALUES ($1) RETURNING id', [name.trim()])).rows[0]!;
    await this.db.query(`INSERT INTO members (group_id,telegram_id,role) VALUES ($1,$2,'admin')`, [group.id, telegramId]);
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
    const group = (await this.db.query<{ id: number }>('SELECT id FROM task_groups WHERE invite_hash=$1 AND invite_expires_at>$2', [hashCode(code), this.now])).rows[0];
    if (!group) throw new UserError('Код не найден или истёк. Попроси администратора прислать новый.');
    await this.db.query(`INSERT INTO members (group_id,telegram_id,role) VALUES ($1,$2,'member')`, [group.id, telegramId]);
  }
  admin(member: Member) { if (member.role !== 'admin') throw new UserError('Это действие доступно администратору группы.'); }
  async session(telegramId: string): Promise<Session | undefined> {
    return (await this.db.query<{ data: Session }>('SELECT data FROM sessions WHERE telegram_id=$1 AND expires_at>$2', [telegramId, this.now])).rows[0]?.data;
  }
  async saveSession(telegramId: string, data?: Session) {
    if (!data) { await this.db.query('DELETE FROM sessions WHERE telegram_id=$1', [telegramId]); return; }
    await this.db.query(`INSERT INTO sessions (telegram_id,data,expires_at) VALUES ($1,$2,$3)
      ON CONFLICT (telegram_id) DO UPDATE SET data=excluded.data,expires_at=excluded.expires_at`,
      [telegramId, JSON.stringify(data), new Date(this.now.getTime() + 3600_000)]);
  }
  async today(member: Member) {
    const group = (await this.db.query<{ timezone: string }>('SELECT timezone FROM task_groups WHERE id=$1', [member.group_id])).rows[0]!;
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
    await this.db.query(`INSERT INTO occurrences (task_id,group_id,due_on,original_owner_id,assignee_id)
      VALUES ($1,$2,$3,$4,$4)`, [task.id, admin.group_id, first, ownerId]);
    await this.materialize(admin.group_id);
    const owner = await this.target(admin, ownerId);
    await this.send(owner.telegram_id, `📋 Тебе назначена задача: ${title.trim()}\nНачало: ${schedule.start}\nПосмотреть: /tasks`, undefined, `task-created:${task.id}`);
    return task.id;
  }
  async materialize(groupId: number) {
    const group = (await this.db.query<{ timezone: string }>('SELECT timezone FROM task_groups WHERE id=$1', [groupId])).rows[0]!;
    const through = addDays(localDay(this.now, group.timezone), 7);
    const tasks = (await this.db.query<{ id: number; owner_id: number; schedule: Schedule; next_on: string }>(
      `SELECT id,owner_id,schedule,next_on::text FROM tasks WHERE group_id=$1 AND active AND next_on<=$2 ORDER BY id FOR UPDATE`, [groupId, through])).rows;
    for (const task of tasks) {
      let day: string | null = task.next_on;
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
      WHERE o.group_id=$1 AND o.assignee_id=$2 AND o.completed_at IS NULL
      ORDER BY o.due_on,o.id LIMIT 6 OFFSET $3`, [viewer.group_id, ownerId, Math.max(0, Math.min(10000, page)) * 5])).rows;
  }
  async occurrence(viewer: Member, id: number, lock = false): Promise<Occurrence> {
    const occurrence = (await this.db.query<Occurrence>(`SELECT ${dateColumns} FROM occurrences o JOIN tasks t ON t.id=o.task_id
      WHERE o.id=$1 AND o.group_id=$2 ${lock ? 'FOR UPDATE OF o' : ''}`, [id, viewer.group_id])).rows[0];
    if (!occurrence) throw new UserError('Задача не найдена в твоей группе.');
    return occurrence;
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
    const request = (await this.db.query<{ occurrence_id: number; requester_id: number }>(`SELECT h.occurrence_id,h.requester_id FROM help_requests h
      JOIN help_recipients r ON r.request_id=h.id JOIN occurrences o ON o.id=h.occurrence_id
      WHERE h.id=$1 AND r.member_id=$2 AND o.group_id=$3`, [requestId, viewer.id, viewer.group_id])).rows[0];
    if (!request) throw new UserError('Эта просьба адресована другому участнику.');
    // Every operation locks the occurrence first. Competing accept/completion/cancel calls serialize here.
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
    return (await this.db.query<{ title: string; kind: string; actor_id: number; created_at: Date; due_on: string }>(`SELECT t.title,e.kind,e.actor_id,e.created_at,o.due_on::text FROM events e
      JOIN occurrences o ON o.id=e.occurrence_id JOIN tasks t ON t.id=o.task_id
      WHERE o.group_id=$1 AND e.created_at >= $2 ORDER BY e.id DESC LIMIT 20`, [viewer.group_id, new Date(this.now.getTime() - 7 * 86400_000)])).rows;
  }
  async reminders() {
    const groups = (await this.db.query<{ id: number; timezone: string }>('SELECT id,timezone FROM task_groups ORDER BY id')).rows;
    for (const group of groups) {
      await this.materialize(group.id);
      const day = localDay(this.now, group.timezone);
      const members = (await this.db.query<Member>(`SELECT m.*,u.profile_name AS name FROM members m JOIN app_users u USING (telegram_id) WHERE group_id=$1`, [group.id])).rows;
      for (const member of members) {
        const tasks = (await this.db.query<{ title: string; due_on: string }>(`SELECT t.title,o.due_on::text FROM occurrences o JOIN tasks t ON t.id=o.task_id
          WHERE o.assignee_id=$1 AND o.completed_at IS NULL AND o.due_on<=$2 ORDER BY o.due_on,o.id`, [member.id, day])).rows;
        if (tasks.length) await this.send(member.telegram_id, `📋 Твои невыполненные задачи (${tasks.length}):\n${tasks.slice(0,15).map(t => `• ${t.title} — ${t.due_on}`).join('\n')}\n\nОткрыть список: /tasks`, undefined, `reminder:${member.id}:${day}`);
      }
    }
  }
}
