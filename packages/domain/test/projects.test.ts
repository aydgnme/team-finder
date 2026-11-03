import { describe, expect, it } from 'vitest';
import {
  clampAssignment,
  CreateProjectRequest,
  nextStatuses,
  transitionProject,
  type ProjectStatus,
} from '../src/index.ts';

describe('transitionProject', () => {
  it.each([
    ['notStarted', 'starting', true, false],
    ['notStarted', 'inProgress', true, true],
    ['starting', 'inProgress', true, true],
    ['inProgress', 'closing', true, true],
    ['closing', 'closed', true, true],
    ['notStarted', 'closed', true, true],
    ['starting', 'starting', false, false],
    ['inProgress', 'starting', false, false],
    ['closed', 'closing', false, false],
  ] as [ProjectStatus, ProjectStatus, boolean, boolean][])(
    '%s -> %s: allowed %s, everActive %s',
    (from, to, ok, active) => {
      const r = transitionProject({ status: from, everActive: false }, to);
      expect(r.ok).toBe(ok);
      if (r.ok) expect(r.everActive).toBe(active);
    },
  );

  it('never clears everActive', () => {
    expect(transitionProject({ status: 'inProgress', everActive: true }, 'closing')).toEqual({
      ok: true,
      status: 'closing',
      everActive: true,
    });
  });

  it('lists the reachable statuses in order; closed is final', () => {
    expect(nextStatuses('starting')).toEqual(['inProgress', 'closing', 'closed']);
    expect(nextStatuses('closed')).toEqual([]);
  });
});

describe('CreateProjectRequest', () => {
  const base = { name: 'Atlas', period: 'fixed', startDate: '2026-03-09', deadline: '2026-06-01' } as const;
  it.each([
    ['a fixed project with a later deadline', base, true],
    ['a fixed project without a deadline', { ...base, deadline: null }, false],
    ['a deadline before the start', { ...base, deadline: '2026-03-01' }, false],
    ['an ongoing project with a deadline', { ...base, period: 'ongoing' }, false],
    ['an ongoing project without one', { ...base, period: 'ongoing', deadline: null }, true],
    ['created already in progress', { ...base, status: 'inProgress' }, false],
    [
      'the same team role twice',
      {
        ...base,
        teamRoles: [
          { roleId: 'r', count: 1 },
          { roleId: 'r', count: 2 },
        ],
      },
      false,
    ],
  ])('%s', (_n, input, ok) => {
    expect(CreateProjectRequest.safeParse(input).success).toBe(ok);
  });
});

describe('clampAssignment (date edits clamp, never rewrite)', () => {
  const before = { startDate: '2026-03-09', deadline: '2026-06-01' };
  it.each([
    [
      'start later: from moves up, full-length end follows',
      { from: '2026-03-09', to: '2026-06-01' },
      { startDate: '2026-03-23', deadline: '2026-06-15' },
      { from: '2026-03-23', to: '2026-06-15' },
    ],
    [
      'a late joiner keeps their own start',
      { from: '2026-04-01', to: '2026-06-01' },
      { startDate: '2026-03-23', deadline: '2026-06-15' },
      { from: '2026-04-01', to: '2026-06-15' },
    ],
    [
      'start earlier: nobody is pulled earlier',
      { from: '2026-03-09', to: '2026-06-01' },
      { startDate: '2026-03-02', deadline: '2026-06-01' },
      { from: '2026-03-09', to: '2026-06-01' },
    ],
    [
      'a shorter allocation keeps its end',
      { from: '2026-03-09', to: '2026-04-15' },
      { startDate: '2026-03-09', deadline: '2026-07-01' },
      { from: '2026-03-09', to: '2026-04-15' },
    ],
    [
      'a shorter allocation is cut by an earlier deadline',
      { from: '2026-03-09', to: '2026-04-15' },
      { startDate: '2026-03-09', deadline: '2026-04-01' },
      { from: '2026-03-09', to: '2026-04-01' },
    ],
    [
      'an ongoing assignment stays open-ended',
      { from: '2026-03-09', to: null },
      { startDate: '2026-03-09', deadline: null },
      { from: '2026-03-09', to: null },
    ],
  ] as const)('%s', (_n, a, after, expected) => {
    const b = after.deadline === null ? { startDate: '2026-03-09', deadline: null } : before;
    expect(clampAssignment(a, b, after)).toEqual(expected);
  });

  it('can produce an empty window when the work starts after the new deadline (callers refuse it)', () => {
    const r = clampAssignment({ from: '2026-05-01', to: '2026-06-01' }, before, {
      startDate: '2026-03-09',
      deadline: '2026-04-01',
    });
    expect(r).toEqual({ from: '2026-05-01', to: '2026-04-01' });
  });
});
