const DAY = 86_400_000;
export const MAX_DAYS = 366;

export type Period = { from: string; to: string };

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const validDay = (s: string | null): s is string =>
  !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) && isoDay(new Date(s)) === s;

/** Last `days` days including today (UTC days, like the report on the server). */
export function lastDays(days: number, today: Date): Period {
  return { from: isoDay(new Date(today.getTime() - (days - 1) * DAY)), to: isoDay(today) };
}

/** Period from the URL; missing / broken values fall back to the last 30 days. */
export function periodFromParams(
  sp: { get(n: string): string | null },
  today: Date,
): { period: Period; valid: boolean } {
  const from = sp.get('from');
  const to = sp.get('to');
  if (!validDay(from) || !validDay(to))
    return { period: lastDays(30, today), valid: from === null && to === null };
  const span = (Date.parse(to) - Date.parse(from)) / DAY;
  if (span < 0 || span >= MAX_DAYS) return { period: lastDays(30, today), valid: false };
  return { period: { from, to }, valid: true };
}
