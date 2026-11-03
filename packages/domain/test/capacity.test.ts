import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  addDays,
  buildTimeline,
  capacityOn,
  containsDay,
  loadSummary,
  minHoursLeft,
  overlaps,
  withProposal,
  type AssignmentStatus,
  type CapacityAssignment,
  type Interval,
} from '../src/index.ts';

const BASE = '2026-01-05';
const d = (n: number) => addDays(BASE, n);

const a = (
  from: number,
  to: number | null,
  hoursPerDay: number,
  status: AssignmentStatus = 'active',
): CapacityAssignment => ({
  from: d(from),
  to: to === null ? null : d(to),
  hoursPerDay,
  status,
});

describe('overlaps (half-open, open-ended)', () => {
  it.each([
    ['touching intervals do not overlap', { from: d(0), to: d(5) }, { from: d(5), to: d(9) }, false],
    ['one shared day overlaps', { from: d(0), to: d(6) }, { from: d(5), to: d(9) }, true],
    ['open-ended overlaps anything later', { from: d(0), to: null }, { from: d(100), to: d(101) }, true],
    ['open-ended starting after the end does not', { from: d(10), to: null }, { from: d(0), to: d(10) }, false],
    ['two open-ended always overlap', { from: d(0), to: null }, { from: d(50), to: null }, true],
    ['empty interval never overlaps', { from: d(3), to: d(3) }, { from: d(0), to: d(10) }, false],
  ])('%s', (_name, x, y, expected) => {
    expect(overlaps(x, y)).toBe(expected);
    expect(overlaps(y, x)).toBe(expected);
  });
});

describe('buildTimeline', () => {
  it('counts active and deallocationProposed as used, proposed as pending, ignores terminal statuses', () => {
    const t = buildTimeline([
      a(0, 10, 4, 'active'),
      a(5, 15, 2, 'deallocationProposed'),
      a(0, 20, 3, 'proposed'),
      a(0, 20, 8, 'rejected'),
      a(0, 20, 8, 'past'),
    ]);
    expect(t).toEqual([
      { from: d(0), to: d(5), used: 4, pending: 3 },
      { from: d(5), to: d(10), used: 6, pending: 3 },
      { from: d(10), to: d(15), used: 2, pending: 3 },
      { from: d(15), to: d(20), used: 0, pending: 3 },
    ]);
  });

  it('merges adjacent equal segments and keeps open-ended tails', () => {
    expect(buildTimeline([a(0, 5, 4), a(5, null, 4)])).toEqual([{ from: d(0), to: null, used: 4, pending: 0 }]);
  });

  it('is empty for no load', () => {
    expect(buildTimeline([])).toEqual([]);
    expect(capacityOn([], d(3))).toEqual({ used: 0, pending: 0 });
  });
});

describe('withProposal', () => {
  const timeline = buildTimeline([a(0, 10, 6), a(10, 20, 2)]);
  const window: Interval = { from: d(0), to: d(30) };

  it('rejects a proposal that overbooks and names the first worst day', () => {
    expect(withProposal(timeline, 4, d(0), window)).toMatchObject({
      fits: false,
      worst: { date: d(0), used: 6 },
      maxHours: 2,
    });
  });

  it('accepts once the heavy assignment has ended', () => {
    expect(withProposal(timeline, 6, d(10), window)).toMatchObject({ fits: true, worst: { date: d(10), used: 2 } });
  });

  it('clamps the start to the window', () => {
    expect(withProposal(timeline, 4, d(-30), { from: d(12), to: d(30) }).effectiveFrom).toBe(d(12));
  });

  it('checks open-ended windows exactly (ongoing projects)', () => {
    const t = buildTimeline([a(200, null, 5)]);
    expect(withProposal(t, 4, d(0), { from: d(0), to: null })).toMatchObject({
      fits: false,
      worst: { date: d(200), used: 5 },
    });
    expect(withProposal(t, 4, d(0), { from: d(0), to: d(200) }).fits).toBe(true);
  });

  it('flags pending conflicts without failing the committed check', () => {
    const t = buildTimeline([a(0, 10, 4), a(0, 10, 4, 'proposed')]);
    expect(withProposal(t, 2, d(0), window)).toMatchObject({ fits: true, pendingConflict: true });
  });

  it('summarizes peak load for the capacity bar', () => {
    expect(loadSummary(buildTimeline([a(0, 10, 2), a(0, 10, 3, 'proposed')]), window)).toEqual({ used: 2, pending: 3 });
    expect(minHoursLeft(timeline, window)).toBe(2);
  });
});

// ---- properties -------------------------------------------------------------------------------

const statusArb = fc.constantFrom<AssignmentStatus>('proposed', 'active', 'rejected', 'deallocationProposed', 'past');
const assignmentArb = fc
  .record({
    from: fc.integer({ min: 0, max: 60 }),
    len: fc.option(fc.integer({ min: 0, max: 40 }), { nil: null }),
    hours: fc.integer({ min: 1, max: 8 }),
    status: statusArb,
  })
  .map(({ from, len, hours, status }) => a(from, len === null ? null : from + len, hours, status));
const assignmentsArb = fc.array(assignmentArb, { maxLength: 8 });

/** Brute force over days: what the timeline must agree with. */
function bruteLoad(assignments: CapacityAssignment[], day: string) {
  let used = 0;
  let pending = 0;
  for (const x of assignments) {
    if (!containsDay(x, day)) continue;
    if (x.status === 'active' || x.status === 'deallocationProposed') used += x.hoursPerDay;
    if (x.status === 'proposed') pending += x.hoursPerDay;
  }
  return { used, pending };
}

// Every breakpoint lies in [0, 100], so checking days -5..110 covers every distinct value.
const DAYS = Array.from({ length: 116 }, (_, i) => d(i - 5));

describe('CapacityTimeline properties', () => {
  it('agrees with a day-by-day brute force', () => {
    fc.assert(
      fc.property(assignmentsArb, (as) => {
        const t = buildTimeline(as);
        for (const day of DAYS) expect(capacityOn(t, day)).toEqual(bruteLoad(as, day));
      }),
    );
  });

  it('is sorted, non-overlapping, non-zero and maximally merged', () => {
    fc.assert(
      fc.property(assignmentsArb, (as) => {
        const t = buildTimeline(as);
        t.forEach((s, i) => {
          expect(s.used + s.pending).toBeGreaterThan(0);
          expect(s.to === null || s.from < s.to).toBe(true);
          const next = t[i + 1];
          if (next) {
            expect(s.to).not.toBeNull();
            expect(s.to! <= next.from).toBe(true);
            if (s.to === next.from) expect([s.used, s.pending]).not.toEqual([next.used, next.pending]);
          }
        });
      }),
    );
  });

  it('is independent of input order', () => {
    fc.assert(
      fc.property(assignmentsArb, (as) => {
        expect(buildTimeline([...as].reverse())).toEqual(buildTimeline(as));
      }),
    );
  });

  it('withProposal.fits <=> no day in range exceeds 8 by brute force', () => {
    fc.assert(
      fc.property(
        assignmentsArb,
        fc.integer({ min: 1, max: 8 }),
        fc.integer({ min: 0, max: 80 }),
        fc.option(fc.integer({ min: 1, max: 60 }), { nil: null }),
        (as, hours, from, len) => {
          const window: Interval = { from: d(from), to: len === null ? null : d(from + len) };
          const r = withProposal(buildTimeline(as), hours, d(from), window);
          const inRange = DAYS.filter((day) => containsDay(window, day));
          const peak = Math.max(0, ...inRange.map((day) => bruteLoad(as, day).used));
          expect(r.fits).toBe(peak + hours <= 8);
          expect(r.worst.used).toBe(peak);
          expect(r.maxHours).toBe(Math.max(0, 8 - peak));
        },
      ),
    );
  });

  it('overlaps <=> the intervals share a day', () => {
    const intervalArb = fc
      .record({ from: fc.integer({ min: 0, max: 60 }), len: fc.option(fc.integer({ min: 0, max: 40 }), { nil: null }) })
      .map(({ from, len }): Interval => ({ from: d(from), to: len === null ? null : d(from + len) }));
    fc.assert(
      fc.property(intervalArb, intervalArb, (x, y) => {
        const shared = DAYS.some((day) => containsDay(x, day) && containsDay(y, day));
        expect(overlaps(x, y)).toBe(shared);
      }),
    );
  });
});
