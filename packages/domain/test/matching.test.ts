import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  addDays,
  buildTimeline,
  classifyAvailability,
  coverage,
  evaluationWindow,
  projectTargets,
  rankCandidates,
  SCORE_WEIGHTS,
  scoreCandidate,
  type CandidateInput,
  type MatchProject,
} from '../src/index.ts';

const TODAY = '2026-03-02';
const d = (n: number) => addDays(TODAY, n);

const project: MatchProject = {
  startDate: d(7),
  deadline: d(97),
  techStack: ['node', 'ts', 'react'],
  skillRequirements: [{ skillId: 'node', minLevel: 3 }, { skillId: 'pw' }],
  teamRoles: [
    { roleId: 'backend', count: 2 },
    { roleId: 'qa', count: 1 },
  ],
};

const candidate = (over: Partial<CandidateInput> & { userId: string }): CandidateInput => ({
  name: over.userId,
  skills: [],
  assignments: [],
  pastProjects: [],
  hasApprover: true,
  ...over,
});

describe('evaluationWindow and targets', () => {
  it('starts at max(today, start) and ends at the deadline', () => {
    expect(evaluationWindow(project, TODAY)).toEqual({ from: d(7), to: d(97) });
    expect(evaluationWindow({ startDate: d(-30), deadline: null }, TODAY)).toEqual({ from: TODAY, to: null });
  });

  it('dedupes techStack and requirements, keeping minLevel', () => {
    expect(projectTargets(project)).toEqual([
      { skillId: 'node', minLevel: 3 },
      { skillId: 'ts' },
      { skillId: 'react' },
      { skillId: 'pw' },
    ]);
  });
});

describe('classifyAvailability', () => {
  const w = { from: d(7), to: d(97) };
  const t = (...xs: [number, number | null, number][]) =>
    buildTimeline(
      xs.map(([from, to, h]) => ({
        from: d(from),
        to: to === null ? null : d(to),
        hoursPerDay: h,
        status: 'active' as const,
      })),
    );

  it('is available with a free calendar', () => {
    expect(classifyAvailability([], w, 4)).toEqual({ kind: 'available', hoursLeft: 8 });
  });
  it('is partial with some hours left on every day', () => {
    expect(classifyAvailability(t([0, null, 2]), w, 4)).toEqual({ kind: 'partial', hoursLeft: 6 });
  });
  it('rolls off when a fixed assignment ends within N weeks', () => {
    expect(classifyAvailability(t([0, 21, 8]), w, 4)).toEqual({
      kind: 'rollingOff',
      availableFrom: d(21),
      weeksUntil: 2,
    });
    expect(classifyAvailability(t([0, 21, 8]), w, 1).kind).toBe('unavailable');
  });
  it('never rolls off an ongoing (open-ended) assignment', () => {
    expect(classifyAvailability(t([0, null, 8]), w, 6).kind).toBe('unavailable');
  });
  it('is unavailable when booked later inside the window even if free now', () => {
    expect(classifyAvailability(t([60, 70, 8]), w, 6).kind).toBe('unavailable');
  });
});

describe('scoreCandidate', () => {
  it('uses the 60/25/15 weights', () => {
    expect(SCORE_WEIGHTS).toEqual({ skillFit: 60, history: 25, availability: 15 });
    expect(SCORE_WEIGHTS.skillFit + SCORE_WEIGHTS.history + SCORE_WEIGHTS.availability).toBe(100);
  });

  it('scores a perfect, fully available candidate at 100 with a perfect past project', () => {
    const s = scoreCandidate(
      project,
      {
        skills: ['node', 'ts', 'react', 'pw'].map((skillId) => ({ skillId, level: 5, experience: '7y+' as const })),
        pastProjects: [
          { projectId: 'p0', name: 'Helios', techStack: ['node', 'ts', 'react'], roleIds: ['backend', 'qa'] },
        ],
      },
      { kind: 'available', hoursLeft: 8 },
    );
    expect(s.score).toBeCloseTo(100);
    expect(s.points).toEqual({ skillFit: 60, history: 25, availability: 15 });
  });

  it('computes skill fit as 80% level / 20% experience averaged over targets', () => {
    const s = scoreCandidate(
      project,
      { skills: [{ skillId: 'node', level: 4, experience: '2-4y' }], pastProjects: [] },
      { kind: 'unavailable', hoursLeft: 0 },
    );
    // node: 4/5*0.8 + 3/5*0.2 = 0.76; other three targets 0 -> mean 0.19
    expect(s.terms.skillFit).toBeCloseTo(0.19);
    expect(s.reasons.filter((r) => r.kind === 'missingSkill')).toHaveLength(3);
  });

  it('gates below minLevel and reports it', () => {
    const s = scoreCandidate(
      project,
      { skills: [{ skillId: 'node', level: 2, experience: '1-2y' }], pastProjects: [] },
      {
        kind: 'available',
        hoursLeft: 8,
      },
    );
    expect(s.belowMinLevel).toEqual([{ kind: 'belowMinLevel', skillId: 'node', level: 2, minLevel: 3 }]);
  });

  it('scores availability for rolling-off candidates by weeks until free', () => {
    const s = scoreCandidate(
      project,
      { skills: [], pastProjects: [] },
      { kind: 'rollingOff', availableFrom: d(28), weeksUntil: 3 },
    );
    expect(s.terms.availability).toBeCloseTo(0.5);
  });

  it('matches through a past project sharing tech and roles even without skills', () => {
    const s = scoreCandidate(
      project,
      { skills: [], pastProjects: [{ projectId: 'p', name: 'Old', techStack: ['node'], roleIds: ['qa'] }] },
      { kind: 'available', hoursLeft: 8 },
    );
    expect(s.matches).toBe(true);
    expect(s.terms.history).toBeGreaterThan(0);
  });

  it('stays within 0..100 for any input', () => {
    const skill = fc.record({
      skillId: fc.constantFrom('node', 'ts', 'react', 'pw', 'go'),
      level: fc.integer({ min: 1, max: 5 }),
      experience: fc.constantFrom('0-6m', '6-12m', '1-2y', '2-4y', '4-7y', '7y+' as const),
    });
    fc.assert(
      fc.property(fc.array(skill, { maxLength: 5 }), fc.integer({ min: 0, max: 8 }), (skills, hoursLeft) => {
        const s = scoreCandidate(
          project,
          { skills, pastProjects: [] },
          { kind: hoursLeft === 8 ? 'available' : 'partial', hoursLeft },
        );
        expect(s.score).toBeGreaterThanOrEqual(0);
        expect(s.score).toBeLessThanOrEqual(100 + 1e-9);
        expect(s.points.skillFit + s.points.history + s.points.availability).toBeCloseTo(s.score);
      }),
    );
  });
});

describe('rankCandidates', () => {
  const strong = [{ skillId: 'node', level: 5, experience: '7y+' as const }];
  const busy = (to: number | null) => [
    {
      from: d(0),
      to: to === null ? null : d(to),
      hoursPerDay: 8,
      status: 'active' as const,
      projectId: 'b',
      projectName: 'Borealis',
    },
  ];
  const candidates: CandidateInput[] = [
    candidate({ userId: 'u1', name: 'Zoe', skills: strong }),
    candidate({ userId: 'u2', name: 'Ann', skills: strong }),
    candidate({ userId: 'u3', name: 'Tom', skills: strong, assignments: busy(21) }),
    candidate({ userId: 'u4', name: 'Ines', skills: strong, assignments: busy(null) }),
    candidate({ userId: 'u5', name: 'Nob', skills: [{ skillId: 'go', level: 5, experience: '7y+' }] }),
    candidate({ userId: 'u6', name: 'Low', skills: [{ skillId: 'node', level: 1, experience: '0-6m' }] }),
    candidate({ userId: 'u7', name: 'Mira', skills: strong, assignments: [{ ...busy(null)[0]!, hoursPerDay: 2 }] }),
    candidate({ userId: 'u8', name: 'Ana', skills: strong, onProject: true }),
  ];

  it('defaults to fully available only and counts every exclusion by its first failing filter', () => {
    const r = rankCandidates({ project, today: TODAY, candidates });
    expect(r.candidates.map((c) => c.name)).toEqual(['Ann', 'Zoe']); // tie broken by name
    expect(r.excluded).toEqual({
      onProject: 1,
      noSkillMatch: 1,
      belowMinLevel: 1,
      partial: 1,
      rollingOff: 1,
      unavailable: 1,
    });
  });

  it('includes partial, rolling-off, unavailable and near-misses when asked', () => {
    const r = rankCandidates({
      project,
      today: TODAY,
      candidates,
      options: {
        includePartial: true,
        includeRollingOffWithinWeeks: 4,
        includeUnavailable: true,
        includeNearMisses: true,
      },
    });
    const byName = Object.fromEntries(r.candidates.map((c) => [c.name, c]));
    expect(Object.keys(byName).sort()).toEqual(['Ann', 'Ines', 'Low', 'Mira', 'Tom', 'Zoe']);
    expect(byName.Tom!.availability).toEqual({ kind: 'rollingOff', availableFrom: d(21), weeksUntil: 2 });
    expect(byName.Tom!.reasons).toContainEqual({
      kind: 'rollsOff',
      date: d(21),
      projectId: 'b',
      projectName: 'Borealis',
    });
    expect(byName.Low!.nearMiss).toBe(true);
    expect(byName.Ines!.availability.kind).toBe('unavailable');
    // Same skills: availability decides the order.
    expect(r.candidates.slice(0, 4).map((c) => c.name)).toEqual(['Ann', 'Zoe', 'Mira', 'Tom']);
  });

  it('marks candidates without an approver', () => {
    const r = rankCandidates({
      project,
      today: TODAY,
      candidates: [candidate({ userId: 'x', skills: strong, hasApprover: false })],
    });
    expect(r.candidates[0]!.reasons).toContainEqual({ kind: 'noApprover' });
  });

  it('is deterministic under input permutations', () => {
    fc.assert(
      fc.property(fc.shuffledSubarray(candidates, { minLength: candidates.length }), (shuffled) => {
        const opts = { includePartial: true, includeRollingOffWithinWeeks: 6, includeUnavailable: true };
        const a = rankCandidates({ project, today: TODAY, candidates: shuffled, options: opts });
        const b = rankCandidates({ project, today: TODAY, candidates, options: opts });
        expect(a.candidates.map((c) => c.userId)).toEqual(b.candidates.map((c) => c.userId));
      }),
    );
  });
});

describe('coverage', () => {
  it('counts targets met at their minLevel', () => {
    const targets = projectTargets(project);
    expect(
      coverage(targets, [
        {
          skills: [
            { skillId: 'node', level: 2 },
            { skillId: 'ts', level: 1 },
          ],
        },
      ]),
    ).toEqual({
      covered: ['ts'],
      missing: ['node', 'react', 'pw'],
      ratio: 0.25,
    });
    expect(coverage([], []).ratio).toBe(1);
  });
});
