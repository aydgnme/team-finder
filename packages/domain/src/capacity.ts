import { z } from 'zod';
import { HOURS_PER_DAY } from './constants.ts';
import { Day, isEmptyInterval, maxDay, overlaps, type Interval } from './dates.ts';

export const AssignmentStatus = z.enum(['proposed', 'active', 'rejected', 'deallocationProposed', 'past']);
export type AssignmentStatus = z.infer<typeof AssignmentStatus>;

/** Statuses that hold hours (the person still works there until a deallocation is approved). */
export const CAPACITY_CONSUMING_STATUSES = ['active', 'deallocationProposed'] as const satisfies AssignmentStatus[];
/** Statuses that occupy a role slot and block a second assignment of the same person to a project. */
export const NON_TERMINAL_STATUSES = [
  'proposed',
  'active',
  'deallocationProposed',
] as const satisfies AssignmentStatus[];

export function consumesCapacity(status: AssignmentStatus): boolean {
  return (CAPACITY_CONSUMING_STATUSES as readonly string[]).includes(status);
}

export interface CapacityAssignment {
  from: Day;
  to: Day | null;
  hoursPerDay: number;
  status: AssignmentStatus;
}

export const CapacitySegment = z.object({
  from: Day,
  to: Day.nullable(),
  used: z.number(),
  pending: z.number(),
});
export type CapacitySegment = z.infer<typeof CapacitySegment>;

/**
 * Sorted, non-overlapping, merged segments `[from, to)` with non-zero load. Days not covered by any
 * segment have `used = pending = 0`. Finitely many breakpoints, so minima over open-ended windows
 * are exact.
 */
export const CapacityTimeline = z.array(CapacitySegment);
export type CapacityTimeline = CapacitySegment[];

/** Builds the one capacity representation used by ranking, the canvas preview and approval. */
export function buildTimeline(assignments: readonly CapacityAssignment[]): CapacityTimeline {
  const deltas = new Map<Day, { used: number; pending: number }>();
  const bump = (day: Day, used: number, pending: number) => {
    const d = deltas.get(day) ?? { used: 0, pending: 0 };
    d.used += used;
    d.pending += pending;
    deltas.set(day, d);
  };

  for (const a of assignments) {
    if (isEmptyInterval(a)) continue;
    const used = consumesCapacity(a.status) ? a.hoursPerDay : 0;
    const pending = a.status === 'proposed' ? a.hoursPerDay : 0;
    if (used === 0 && pending === 0) continue;
    bump(a.from, used, pending);
    if (a.to !== null) bump(a.to, -used, -pending);
  }

  const days = [...deltas.keys()].sort();
  const segments: CapacityTimeline = [];
  let used = 0;
  let pending = 0;
  days.forEach((day, i) => {
    const d = deltas.get(day)!;
    used += d.used;
    pending += d.pending;
    if (used === 0 && pending === 0) return;
    const to = days[i + 1] ?? null;
    const last = segments.at(-1);
    if (last && last.to === day && last.used === used && last.pending === pending) {
      last.to = to;
    } else {
      segments.push({ from: day, to, used, pending });
    }
  });
  return segments;
}

export function capacityOn(timeline: CapacityTimeline, day: Day): { used: number; pending: number } {
  const seg = timeline.find((s) => day >= s.from && (s.to === null || day < s.to));
  return seg ? { used: seg.used, pending: seg.pending } : { used: 0, pending: 0 };
}

export interface LoadPoint {
  date: Day;
  used: number;
}

/** Highest `used` over the window and the first date it occurs. */
export function peakUsed(timeline: CapacityTimeline, window: Interval): LoadPoint {
  let worst: LoadPoint = { date: window.from, used: 0 };
  if (isEmptyInterval(window)) return worst;
  for (const s of timeline) {
    if (!overlaps(s, window)) continue;
    if (s.used > worst.used) worst = { date: maxDay(s.from, window.from), used: s.used };
  }
  return worst;
}

/** Highest `used + pending` over the window. */
export function peakLoad(timeline: CapacityTimeline, window: Interval): number {
  let peak = 0;
  if (isEmptyInterval(window)) return peak;
  for (const s of timeline) if (overlaps(s, window)) peak = Math.max(peak, s.used + s.pending);
  return peak;
}

/** Minimum hours left per day over the window (0..8). */
export function minHoursLeft(timeline: CapacityTimeline, window: Interval): number {
  return Math.max(0, HOURS_PER_DAY - peakUsed(timeline, window).used);
}

export interface ProposalCheck {
  /** `used + hours <= 8` on every day of the effective range. */
  fits: boolean;
  /** Day with the highest committed load inside the effective range (earliest one). */
  worst: LoadPoint;
  /** Most hours/day that could still be requested from `effectiveFrom`. */
  maxHours: number;
  /** Committed + pending + this proposal exceeds 8 somewhere (the canvas draws a warning). */
  pendingConflict: boolean;
  effectiveFrom: Day;
}

/**
 * Would adding `hours`/day from `from` until the window end overbook the person? The effective range
 * is `[max(from, window.from), window.to)`. Used by the drag preview, the approvals inbox and the
 * approve transaction (invariant 1).
 */
export function withProposal(timeline: CapacityTimeline, hours: number, from: Day, window: Interval): ProposalCheck {
  const range: Interval = { from: maxDay(from, window.from), to: window.to };
  const worst = peakUsed(timeline, range);
  const maxHours = Math.max(0, HOURS_PER_DAY - worst.used);
  return {
    fits: worst.used + hours <= HOURS_PER_DAY,
    worst,
    maxHours,
    pendingConflict: peakLoad(timeline, range) + hours > HOURS_PER_DAY,
    effectiveFrom: range.from,
  };
}

/** Peak committed and pending load over a window, for the 8-segment capacity bar. */
export function loadSummary(timeline: CapacityTimeline, window: Interval): { used: number; pending: number } {
  const used = peakUsed(timeline, window).used;
  return { used, pending: Math.max(0, peakLoad(timeline, window) - used) };
}
