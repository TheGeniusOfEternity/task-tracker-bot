export type Schedule = {
  kind: 'once' | 'daily' | 'weekly' | 'monthly' | 'monthly_weekday'; start: string;
  weekdays?: number[]; weekday?: number; ordinal?: number; overdue?: 'daily' | 'weekends';
};
export const weekdayNames = ['понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'];
export const ordinalNames: Record<number, string> = { 1: '1-й', 2: '2-й', 3: '3-й', 4: '4-й', [-1]: 'последний' };
function monthlyWeekday(schedule: Schedule, year: number, month: number): string {
  const { weekday, ordinal } = schedule;
  if (!weekday || weekday < 1 || weekday > 7 || ![1,2,3,4,-1].includes(ordinal ?? 0)) throw new Error('Invalid monthly weekday rule');
  const first = new Date(Date.UTC(year, month, 1, 12));
  const offset = (weekday % 7 - first.getUTCDay() + 7) % 7;
  let day = 1 + offset + ((ordinal ?? 1) - 1) * 7;
  if (ordinal === -1) {
    const last = new Date(Date.UTC(year, month + 1, 0, 12));
    day = last.getUTCDate() - (last.getUTCDay() - weekday % 7 + 7) % 7;
  }
  return new Date(Date.UTC(year, month, day, 12)).toISOString().slice(0,10);
}
export function localDay(now = new Date(), timezone = 'Europe/Moscow'): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
export function validDay(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T12:00:00Z`))
    && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
}
export function addDays(day: string, amount: number): string {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}
export function firstDue(schedule: Schedule): string {
  if (schedule.kind === 'monthly_weekday') {
    const date = new Date(`${schedule.start}T12:00:00Z`);
    const candidate = monthlyWeekday(schedule, date.getUTCFullYear(), date.getUTCMonth());
    return candidate >= schedule.start ? candidate : monthlyWeekday(schedule, date.getUTCFullYear(), date.getUTCMonth() + 1);
  }
  if (schedule.kind !== 'weekly') return schedule.start;
  for (let i = 0; i < 7; i++) {
    const day = addDays(schedule.start, i);
    if (schedule.weekdays?.includes(new Date(`${day}T12:00:00Z`).getUTCDay() || 7)) return day;
  }
  throw new Error('Choose at least one weekday');
}
export function nextDue(schedule: Schedule, current: string): string | null {
  if (schedule.kind === 'once') return null;
  if (schedule.kind === 'daily') return addDays(current, 1);
  if (schedule.kind === 'weekly') return firstDue({ ...schedule, start: addDays(current, 1) });
  const date = new Date(`${current}T12:00:00Z`);
  const year = date.getUTCFullYear(), month = date.getUTCMonth() + 1;
  if (schedule.kind === 'monthly_weekday') return monthlyWeekday(schedule, year, month);
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(Number(schedule.start.slice(-2)), last), 12)).toISOString().slice(0, 10);
}
export function scheduleLabel(schedule: Schedule): string {
  if (schedule.kind === 'monthly_weekday') {
    const weekday = schedule.weekday ?? 1;
    const gender = [3,5,6].includes(weekday) ? 'f' : weekday === 7 ? 'n' : 'm';
    const ordinal = schedule.ordinal === -1 ? ({ f: 'последняя', n: 'последнее', m: 'последний' })[gender]
      : `${schedule.ordinal ?? 1}-${gender === 'f' ? 'я' : gender === 'n' ? 'е' : 'й'}`;
    return `Каждый месяц: ${ordinal} ${weekdayNames[weekday - 1]}`;
  }
  return ({ once: 'Разовая', daily: 'Ежедневно', weekly: 'По дням недели', monthly: 'Ежемесячно' })[schedule.kind];
}
export function shouldRemind(schedule: Schedule, due: string, day: string): boolean {
  if (day < due) return false;
  if (day === due || schedule.overdue !== 'weekends') return true;
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
  return weekday === 0 || weekday === 6;
}
