export const DAY_MS = 86400000;

export function dayKey(d: Date | string | number = new Date()): string {
  const x = new Date(d);
  const y = x.getFullYear();
  const m = String(x.getMonth() + 1).padStart(2, '0');
  const dd = String(x.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

export function fromKey(k: string): Date {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(k: string, n: number): string {
  const d = fromKey(k);
  d.setDate(d.getDate() + n);
  return dayKey(d);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((fromKey(b).getTime() - fromKey(a).getTime()) / DAY_MS);
}

/** Fraction of the day elapsed for a timestamp (0..1). */
export function dayFraction(d: Date = new Date()): number {
  return (d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()) / 86400;
}

const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const MONTHS_FULL = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const WD = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
export const WEEKDAYS_MON = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

export function fmtDay(k: string | Date, withYear = false): string {
  const d = typeof k === 'string' ? (k.length === 10 ? fromKey(k) : new Date(k)) : k;
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${withYear ? ' ' + d.getFullYear() : ''}`;
}
export function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  return `${fmtDay(d, true)}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
export function fmtWeekday(k: string): string {
  return WD[fromKey(k).getDay()];
}
export function monthName(k: string): string {
  const d = fromKey(k);
  return `${MONTHS_FULL[d.getMonth()]} ${d.getFullYear()}`;
}
/** Monday-based weekday index 0..6 */
export function weekdayMon(k: string): number {
  return (fromKey(k).getDay() + 6) % 7;
}
export function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}
