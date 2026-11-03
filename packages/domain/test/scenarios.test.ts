import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  addDays,
  buildTimeline,
  capacityOn,
  compareScenarios,
  evaluateScenario,
  formatDelay,
  inScrubRange,
  ONGOING_HORIZON_DAYS,
  overbookedDays,
  scenarioWindow,
  scrubRange,
  shiftProject,
  verdictSentence,
  type ScenarioMember,
  type ScenarioProject,
} from '../src/index.ts';

const TODAY = '2026-03-02';
const d = (n: number) => addDays(TODAY, n);

// The seeded Atlas, reduced to what the verdict needs.
const atlas: ScenarioProject = {
  startDate: d(7),
  deadline: d(91),
  techStack: ['node', 'ts', 'react', 'pg'],
  skillRequirements: [
    { skillId: 'node', minLevel: 3 },
    { skillId: 'aws', minLevel: 3 },
    { skillId: 'pw', minLevel: 2 },
  ],
  teamRoles: [
    { roleId: 'backend', count: 2 },
    { roleId: 'frontend', count: 2 },
    { roleId: 'qa', count: 1 },
  ],
};

const member = (over: Partial<ScenarioMember> & { userId: string; slotRoleId: string }): ScenarioMember => ({
  hoursPerDay: 8,
  skills: [],
  timeline: [],
  ...over,
});

const ana = member({
  userId: 'ana',
  slotRoleId: 'backend',
  skills: [
    { skillId: 'node', level: 4 },
    { skillId: 'ts', level: 4 },
    { skillId: 'pg', level: 3 },
  ],
});
const leo = member({
  userId: 'leo',
  slotRoleId: 'frontend',
  hoursPerDay: 6,
  skills: [
    { skillId: 'react', level: 4 },
    { skillId: 'ts', level: 3 },
  ],
});
// Kai: 6 h proposed on Atlas while 4 h active on ongoing Orion -> overbooked every day.
const kai = member({
  userId: 'kai',
  slotRoleId: 'qa',
  hoursPerDay: 6,
  skills: [{ skillId: 'pw', level: 4 }],
  timeline: buildTimeline([{ from: d(-90), to: null, hoursPerDay: 4, status: 'active' }]),
});
// Tom: 8 h on Borealis until 2 weeks into Atlas.
const tom = member({
  userId: 'tom',
  slotRoleId: 'backend',
  skills: [
    { skillId: 'node', level: 5 },
    { skillId: 'aws', level: 4 },
  ],
  timeline: buildTimeline([{ from: d(-150), to: d(21), hoursPerDay: 8, status: 'active' }]),
});
const current = [ana, leo, kai];

describe('scrub range', () => {
  it('spans start .. start + 6 weeks before the project starts', () => {
    expect(scrubRange(atlas, TODAY)).toEqual({ from: d(7), to: d(49) });
    expect(inScrubRange(atlas, d(49), TODAY)).toBe(true);
    expect(inScrubRange(atlas, d(50), TODAY)).toBe(false);
    expect(inScrubRange(atlas, d(6), TODAY)).toBe(false);
  });

  it('is closed once the project has started; the current start stays valid', () => {
    expect(scrubRange(atlas, d(7))).toBeNull();
    expect(inScrubRange(atlas, d(7), d(10))).toBe(true);
    expect(inScrubRange(atlas, d(8), d(10))).toBe(false);
  });

  it('keeps duration when shifting; ongoing projects stay open-ended', () => {
    expect(shiftProject(atlas, d(21))).toMatchObject({ startDate: d(21), deadline: d(105) });
    expect(shiftProject({ startDate: d(7), deadline: null }, d(21))).toEqual({ startDate: d(21), deadline: null });
    expect(scenarioWindow(atlas, d(21), TODAY)).toEqual({ from: d(21), to: d(105) });
    // Never judged in the past.
    expect(scenarioWindow({ startDate: d(-10), deadline: d(10) }, d(-10), TODAY)).toEqual({ from: TODAY, to: d(10) });
  });
});

describe('overbookedDays', () => {
  const busy = buildTimeline([{ from: d(0), to: d(14), hoursPerDay: 8, status: 'active' }]);

  it.each([
    ['fully inside', busy, 8, { from: d(0), to: d(30) }, 14],
    ['clipped at window start', busy, 1, { from: d(10), to: d(30) }, 4],
    [
      'fits exactly',
      buildTimeline([{ from: d(0), to: d(14), hoursPerDay: 4, status: 'active' }]),
      4,
      { from: d(0), to: d(30) },
      0,
    ],
    [
      'pending load does not count',
      buildTimeline([{ from: d(0), to: d(14), hoursPerDay: 8, status: 'proposed' }]),
      8,
      { from: d(0), to: d(30) },
      0,
    ],
    [
      'open-ended load over an open window uses the horizon',
      buildTimeline([{ from: d(-5), to: null, hoursPerDay: 4, status: 'active' }]),
      6,
      { from: d(0), to: null },
      ONGOING_HORIZON_DAYS,
    ],
    ['empty window', busy, 8, { from: d(5), to: d(5) }, 0],
  ] as const)('%s', (_name, timeline, hours, window, expected) => {
    expect(overbookedDays(timeline, hours, window)).toBe(expected);
  });

  it('matches a day-by-day count (property)', () => {
    const assignment = fc.record({
      from: fc.integer({ min: -20, max: 40 }),
      len: fc.integer({ min: 1, max: 40 }),
      hours: fc.integer({ min: 1, max: 8 }),
      status: fc.constantFrom('active' as const, 'proposed' as const, 'deallocationProposed' as const),
    });
    fc.assert(
      fc.property(
        fc.array(assignment, { maxLength: 5 }),
        fc.integer({ min: 1, max: 8 }),
        fc.integer({ min: -10, max: 30 }),
        fc.integer({ min: 0, max: 50 }),
        (as, hours, wFrom, wLen) => {
          const timeline = buildTimeline(
            as.map((a) => ({ from: d(a.from), to: d(a.from + a.len), hoursPerDay: a.hours, status: a.status })),
          );
          let expected = 0;
          for (let i = wFrom; i < wFrom + wLen; i++) if (capacityOn(timeline, d(i)).used + hours > 8) expected++;
          expect(overbookedDays(timeline, hours, { from: d(wFrom), to: d(wFrom + wLen) })).toBe(expected);
        },
      ),
    );
  });
});

describe('evaluateScenario', () => {
  it('scores the seeded current team: 5 of 6 skills, Kai overbooked every day, 2 slots open', () => {
    expect(evaluateScenario(atlas, { start: atlas.startDate, members: current }, TODAY)).toEqual({
      start: d(7),
      coverage: 5 / 6,
      missingSkillIds: ['aws'],
      overbookedPersonDays: 84,
      slotsOpen: 2,
    });
  });

  it('counts extra members beyond a slot count without negative open slots', () => {
    const m = evaluateScenario(atlas, { start: atlas.startDate, members: [ana, tom, { ...ana, userId: 'x' }] }, TODAY);
    expect(m.slotsOpen).toBe(3);
  });
});

describe('compareScenarios', () => {
  const a = { start: atlas.startDate, members: current };

  it.each([
    [
      'same team, same start',
      d(7),
      [],
      0,
      0,
      'Draft vs current: same start → coverage 83%, +0 overbooked days, 2 slots open',
    ],
    [
      'Tom now: covers AWS but overbooks 14 days',
      d(7),
      [tom],
      0,
      14,
      'Draft vs current: same start → coverage 83% → 100%, +14 overbooked days, 1 slot open',
    ],
    [
      'Tom, start +2 wk: no new overbooking',
      d(21),
      [tom],
      14,
      0,
      'Draft vs current: start +2 wk → coverage 83% → 100%, +0 overbooked days, 1 slot open',
    ],
    [
      'Tom, start +10 d: 4 days left',
      d(17),
      [tom],
      10,
      4,
      'Draft vs current: start +1 wk 3 d → coverage 83% → 100%, +4 overbooked days, 1 slot open',
    ],
  ] as const)('%s', (_name, start, extra, delay, delta, sentence) => {
    const v = compareScenarios(atlas, a, { start, members: [...current, ...extra] }, TODAY);
    expect(v.startDelayDays).toBe(delay);
    expect(v.overbookedDelta).toBe(delta);
    expect(verdictSentence(v)).toBe(sentence);
  });

  it('reports fewer overbooked days as a negative change', () => {
    const v = compareScenarios(atlas, a, { start: d(7), members: [ana, leo] }, TODAY);
    expect(v.overbookedDelta).toBe(-84);
    expect(verdictSentence(v)).toContain('−84 overbooked days');
  });

  it('says when every slot is filled', () => {
    const full = [...current, tom, { ...leo, userId: 'noor' }];
    expect(verdictSentence(compareScenarios(atlas, a, { start: d(21), members: full }, TODAY))).toMatch(
      /all slots filled$/,
    );
  });
});

describe('formatDelay', () => {
  it.each([
    [0, 'same start'],
    [7, 'start +1 wk'],
    [3, 'start +3 d'],
    [16, 'start +2 wk 2 d'],
    [-7, 'start −1 wk'],
  ])('%i days', (days, text) => expect(formatDelay(days)).toBe(text));
});
