export type Schedule = { kind: 'once' | 'daily' | 'weekly' | 'monthly'; start: string; weekdays?: number[] };
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
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(Number(schedule.start.slice(-2)), last), 12)).toISOString().slice(0, 10);
}
export function scheduleLabel(schedule: Schedule): string {
  return ({ once: 'Разовая', daily: 'Ежедневно', weekly: 'По дням недели', monthly: 'Ежемесячно' })[schedule.kind];
}
