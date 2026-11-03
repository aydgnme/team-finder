import { z } from 'zod';

export const AccessRole = z.enum(['employee', 'admin', 'deptManager', 'projectManager']);
export type AccessRole = z.infer<typeof AccessRole>;

/** Who is calling; resolved from the server-side session by the API's `resolveActor` preHandler. */
export interface Actor {
  userId: string;
  orgId: string;
  roles: readonly AccessRole[];
  isDemo: boolean;
}

interface InOrg {
  orgId: string;
}

/** Action -> resource shape. Extend here, never with ad-hoc checks in routes (invariant 4). */
export interface PermissionResources {
  'project.view': InOrg;
  /** View candidates and propose people for a project. */
  'project.staff': InOrg & { pmId: string };
  /** `approverId` is resolved at decision time: the manager of the employee's current department. */
  'assignment.decide': InOrg & { approverId: string | null };
  'approvals.list': InOrg;
  'demo.switchPersona': InOrg & { isDemo: boolean };
  /** Share a draft as a read-only snapshot (and read one of a real org). */
  'snapshot.share': InOrg;
  /** Members list and team roles: anyone in the org. */
  'org.view': InOrg;
  /** Invite link, access roles, team roles (Role-01/02, Auth-02): org admins. */
  'org.manage': InOrg;
  /** Create, rename, delete departments and pick their managers (Department-01/02). */
  'department.manage': InOrg;
  /** Move people in and out of a department (Department-03): admins, or its manager. */
  'department.members': InOrg & { managerId: string | null };
  /** Create skill categories and skills (Skill-01). */
  'skill.create': InOrg;
  /** Edit, link or delete a skill: its author only. */
  'skill.edit': InOrg & { authorId: string | null };
  /** Create projects (Project-01). */
  'project.create': InOrg;
  /** Edit, change status of, or delete a project: its PM. */
  'project.edit': InOrg & { pmId: string };
  /** Self-assign skills (Skill-02): only your own. */
  'userSkill.edit': InOrg & { userId: string };
  /** Someone's current and past projects (Project-07): themselves, their manager, admins. */
  'person.viewProjects': InOrg & { userId: string; managerId: string | null };
  /** A department's projects (Project-08): its manager and admins. */
  'department.viewProjects': InOrg & { managerId: string | null };
}
export type Action = keyof PermissionResources;

const has = (actor: Actor, role: AccessRole) => actor.roles.includes(role);

const RULES: { [A in Action]: (actor: Actor, resource: PermissionResources[A]) => boolean } = {
  'project.view': () => true,
  'project.staff': (actor, project) => has(actor, 'projectManager') && project.pmId === actor.userId,
  'assignment.decide': (actor, a) =>
    has(actor, 'deptManager') && a.approverId !== null && a.approverId === actor.userId,
  'approvals.list': (actor) => has(actor, 'deptManager'),
  'demo.switchPersona': (actor, target) => actor.isDemo && target.isDemo,
  // Snapshots show who is allocated where: people who staff or approve, never plain employees.
  'snapshot.share': (actor) => has(actor, 'projectManager') || has(actor, 'deptManager') || has(actor, 'admin'),
  'org.view': () => true,
  'org.manage': (actor) => has(actor, 'admin'),
  'department.manage': (actor) => has(actor, 'admin'),
  'department.members': (actor, d) => has(actor, 'admin') || (d.managerId !== null && d.managerId === actor.userId),
  'skill.create': (actor) => has(actor, 'deptManager') || has(actor, 'admin'),
  'skill.edit': (actor, s) => s.authorId !== null && s.authorId === actor.userId,
  'project.create': (actor) => has(actor, 'projectManager'),
  'project.edit': (actor, p) => has(actor, 'projectManager') && p.pmId === actor.userId,
  'userSkill.edit': (actor, u) => u.userId === actor.userId,
  'person.viewProjects': (actor, p) =>
    p.userId === actor.userId || has(actor, 'admin') || (p.managerId !== null && p.managerId === actor.userId),
  'department.viewProjects': (actor, d) =>
    has(actor, 'admin') || (d.managerId !== null && d.managerId === actor.userId),
};

/** Pure permission check. Cross-org access is always denied, whatever the role. */
export function can<A extends Action>(actor: Actor, action: A, resource: PermissionResources[A]): boolean {
  if (resource.orgId !== actor.orgId) return false;
  return RULES[action](actor, resource);
}
