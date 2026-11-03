import { z } from 'zod';

/**
 * All assignment and project dates are UTC calendar days ("YYYY-MM-DD"); "today" is the UTC date
 * on both client and server (docs/design.md, Data model). ISO day strings sort lexicographically,
 * which is what MongoDB range queries rely on.
 */
export const Day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a YYYY-MM-DD date')
  // "2026-02-30" matches the pattern but is not a day; Date would silently roll it to March 2.
  .refine((d) => {
    const t = Date.parse(`${d}T00:00:00Z`);
    return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === d;
  }, 'Not a calendar date');
export type Day = string;

/** Half-open interval `[from, to)`; `to: null` means open-ended (ongoing project). */
export interface Interval {
  from: Day;
  to: Day | null;
}

const MS_PER_DAY = 86_400_000;

export function dayToNumber(day: Day): number {
  return Math.floor(Date.parse(`${day}T00:00:00Z`) / MS_PER_DAY);
}

export function numberToDay(n: number): Day {
  return new Date(n * MS_PER_DAY).toISOString().slice(0, 10);
}

export function addDays(day: Day, days: number): Day {
  return numberToDay(dayToNumber(day) + days);
}

export function daysBetween(from: Day, to: Day): number {
  return dayToNumber(to) - dayToNumber(from);
}

export function todayUtc(now: Date = new Date()): Day {
  return now.toISOString().slice(0, 10);
}

export function maxDay(a: Day, b: Day): Day {
  return a >= b ? a : b;
}

/** `null` is +infinity. */
export function minEnd(a: Day | null, b: Day | null): Day | null {
  if (a === null) return b;
  if (b === null) return a;
  return a <= b ? a : b;
}

export function isEmptyInterval(i: Interval): boolean {
  return i.to !== null && i.to <= i.from;
}

/** The one overlap helper (invariant 5): half-open intervals, `null` end is open. */
export function overlaps(a: Interval, b: Interval): boolean {
  if (isEmptyInterval(a) || isEmptyInterval(b)) return false;
  const aStartsBeforeBEnds = b.to === null || a.from < b.to;
  const bStartsBeforeAEnds = a.to === null || b.from < a.to;
  return aStartsBeforeBEnds && bStartsBeforeAEnds;
}

export function containsDay(i: Interval, day: Day): boolean {
  return day >= i.from && (i.to === null || day < i.to);
}
