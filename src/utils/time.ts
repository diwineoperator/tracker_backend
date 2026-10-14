import { DateTime } from 'luxon';

/** duration = endedAt - startedAt, in whole seconds (never negative). */
export function computeDurationSeconds(startedAt: Date, endedAt: Date): number {
  return Math.max(0, Math.floor((endedAt.getTime() - startedAt.getTime()) / 1000));
}

/** Calendar date (YYYY-MM-DD) of an instant in the given IANA timezone. */
export function toLocalDate(instant: Date, timezone: string): string {
  return DateTime.fromJSDate(instant, { zone: timezone }).toISODate() as string;
}

/**
 * Half-open UTC range [start, end) covering the local calendar days
 * from..to (inclusive, YYYY-MM-DD) in `timezone`. DST-safe: a local day may be
 * 23 or 25 hours long.
 */
export function localDayRangeToUtc(
  from: string,
  to: string,
  timezone: string,
): { start: Date; end: Date } {
  const start = DateTime.fromISO(from, { zone: timezone }).startOf('day');
  const end = DateTime.fromISO(to, { zone: timezone }).plus({ days: 1 }).startOf('day');
  return { start: start.toJSDate(), end: end.toJSDate() };
}

/** Every local date from..to inclusive, e.g. for zero-filling daily summaries. */
export function eachLocalDate(from: string, to: string): string[] {
  const days: string[] = [];
  let cursor = DateTime.fromISO(from, { zone: 'utc' });
  const last = DateTime.fromISO(to, { zone: 'utc' });
  while (cursor <= last) {
    days.push(cursor.toISODate() as string);
    cursor = cursor.plus({ days: 1 });
  }
  return days;
}

/**
 * True only for a REAL calendar date in YYYY-MM-DD form. Date.parse alone isn't
 * enough: V8 happily accepts "2026-02-30" and rolls it over to March 2, which would
 * silently store or query the wrong day. Round-tripping through UTC catches that.
 */
export function isValidLocalDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

export function addLocalDays(date: string, days: number): string {
  return DateTime.fromISO(date, { zone: 'utc' }).plus({ days }).toISODate() as string;
}

export function daysBetween(from: string, to: string): number {
  return DateTime.fromISO(to, { zone: 'utc' }).diff(DateTime.fromISO(from, { zone: 'utc' }), 'days').days;
}
