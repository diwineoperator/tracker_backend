import { describe, expect, it } from 'vitest';
import { computeDurationSeconds, eachLocalDate, isValidLocalDate, localDayRangeToUtc, toLocalDate } from '../src/utils/time';

describe('computeDurationSeconds', () => {
  it('is endedAt - startedAt: 12:00 → 12:30 is 30 minutes', () => {
    expect(computeDurationSeconds(new Date('2026-09-21T06:30:00Z'), new Date('2026-09-21T07:00:00Z'))).toBe(1800);
  });

  it('floors partial seconds and never goes negative', () => {
    expect(computeDurationSeconds(new Date('2026-09-21T06:30:00.000Z'), new Date('2026-09-21T06:30:01.999Z'))).toBe(1);
    expect(computeDurationSeconds(new Date('2026-09-21T06:30:05Z'), new Date('2026-09-21T06:30:00Z'))).toBe(0);
  });
});

describe('timezone handling', () => {
  it('buckets an instant into the local calendar day', () => {
    // 20:00 UTC on the 21st is already 01:30 on the 22nd in IST.
    expect(toLocalDate(new Date('2026-09-21T20:00:00Z'), 'Asia/Kolkata')).toBe('2026-09-22');
    expect(toLocalDate(new Date('2026-09-21T20:00:00Z'), 'UTC')).toBe('2026-09-21');
  });

  it('maps local days to a half-open UTC range', () => {
    const { start, end } = localDayRangeToUtc('2026-09-21', '2026-09-21', 'Asia/Kolkata');
    expect(start.toISOString()).toBe('2026-09-20T18:30:00.000Z');
    expect(end.toISOString()).toBe('2026-09-21T18:30:00.000Z');
  });

  it('is DST-safe: a spring-forward day is 23 hours long', () => {
    const { start, end } = localDayRangeToUtc('2026-03-08', '2026-03-08', 'America/New_York');
    expect((end.getTime() - start.getTime()) / 3_600_000).toBe(23);
  });

  it('lists every date in a range', () => {
    expect(eachLocalDate('2026-09-19', '2026-09-21')).toEqual(['2026-09-19', '2026-09-20', '2026-09-21']);
  });
});

describe('isValidLocalDate', () => {
  it('accepts real calendar dates, including a leap day', () => {
    for (const d of ['2026-09-22', '2024-02-29', '2026-12-31', '2026-01-01']) expect(isValidLocalDate(d), d).toBe(true);
  });

  it('rejects impossible dates that Date.parse would silently roll over, and malformed strings', () => {
    for (const d of ['2026-02-30', '2026-02-29', '2026-04-31', '2026-13-01', '2026-00-10', '2026-09-00', '2026-9-2', '22-09-2026', '', 'nope']) {
      expect(isValidLocalDate(d), d).toBe(false);
    }
  });
});
