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
    ['department.manage', admin, { orgId: 'o1' }, true],
    ['department.manage', dm, { orgId: 'o1' }, false],
    ['department.members', admin, { orgId: 'o1', managerId: null }, true],
    ['department.members', dm, { orgId: 'o1', managerId: 'me' }, true],
    ['department.members', dm, { orgId: 'o1', managerId: 'other' }, false],
    ['department.members', dm, { orgId: 'o1', managerId: null }, false],
    ['department.members', dm, { orgId: 'o2', managerId: 'me' }, false],
    ['skill.create', dm, { orgId: 'o1' }, true],
    ['skill.create', admin, { orgId: 'o1' }, true],
    ['skill.create', pm, { orgId: 'o1' }, false],
    ['skill.create', emp, { orgId: 'o1' }, false],
    ['skill.edit', emp, { orgId: 'o1', authorId: 'me' }, true],
    ['skill.edit', admin, { orgId: 'o1', authorId: 'other' }, false],
    ['skill.edit', dm, { orgId: 'o1', authorId: null }, false],
    ['project.create', pm, { orgId: 'o1' }, true],
    ['project.create', admin, { orgId: 'o1' }, false],
    ['project.create', pm, { orgId: 'o2' }, false],
    ['project.edit', pm, { orgId: 'o1', pmId: 'me' }, true],
    ['project.edit', pm, { orgId: 'o1', pmId: 'other' }, false],
    ['project.edit', admin, { orgId: 'o1', pmId: 'me' }, false],
    ['userSkill.edit', emp, { orgId: 'o1', userId: 'me' }, true],
    ['userSkill.edit', admin, { orgId: 'o1', userId: 'other' }, false],
  ] as const)('%s for %o on %o -> %s', (action, who, resource, expected) => {
    expect(can(who, action, resource as never)).toBe(expected);
  });
});
