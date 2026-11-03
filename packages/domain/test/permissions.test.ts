import { describe, expect, it } from 'vitest';
import { can, type Actor } from '../src/index.ts';

const actor = (roles: Actor['roles'], over: Partial<Actor> = {}): Actor => ({
  userId: 'me',
  orgId: 'o1',
  roles,
  isDemo: true,
  ...over,
});
const pm = actor(['employee', 'projectManager']);
const dm = actor(['employee', 'deptManager']);
const emp = actor(['employee']);
const admin = actor(['employee', 'admin']);

describe('can()', () => {
  it.each([
    // action, actor, resource, expected
    ['project.view', emp, { orgId: 'o1' }, true],
    ['project.view', emp, { orgId: 'o2' }, false],
    ['project.staff', pm, { orgId: 'o1', pmId: 'me' }, true],
    ['project.staff', pm, { orgId: 'o1', pmId: 'someone-else' }, false],
    ['project.staff', pm, { orgId: 'o2', pmId: 'me' }, false],
    ['project.staff', dm, { orgId: 'o1', pmId: 'me' }, false],
    ['project.staff', admin, { orgId: 'o1', pmId: 'me' }, false],
    ['assignment.decide', dm, { orgId: 'o1', approverId: 'me' }, true],
    ['assignment.decide', dm, { orgId: 'o1', approverId: 'other-manager' }, false],
    ['assignment.decide', dm, { orgId: 'o1', approverId: null }, false],
    ['assignment.decide', pm, { orgId: 'o1', approverId: 'me' }, false],
    ['assignment.decide', dm, { orgId: 'o2', approverId: 'me' }, false],
    ['approvals.list', dm, { orgId: 'o1' }, true],
    ['approvals.list', pm, { orgId: 'o1' }, false],
    ['demo.switchPersona', emp, { orgId: 'o1', isDemo: true }, true],
    ['demo.switchPersona', actor(['employee'], { isDemo: false }), { orgId: 'o1', isDemo: true }, false],
    ['demo.switchPersona', emp, { orgId: 'o2', isDemo: true }, false],
    ['org.view', emp, { orgId: 'o1' }, true],
    ['org.view', admin, { orgId: 'o2' }, false],
    ['org.manage', admin, { orgId: 'o1' }, true],
    ['org.manage', admin, { orgId: 'o2' }, false],
    ['org.manage', pm, { orgId: 'o1' }, false],
    ['org.manage', dm, { orgId: 'o1' }, false],
    ['org.manage', emp, { orgId: 'o1' }, false],
  ] as const)('%s for %o on %o -> %s', (action, who, resource, expected) => {
    expect(can(who, action, resource as never)).toBe(expected);
  });
});
