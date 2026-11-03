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
};

/** Pure permission check. Cross-org access is always denied, whatever the role. */
export function can<A extends Action>(actor: Actor, action: A, resource: PermissionResources[A]): boolean {
  if (resource.orgId !== actor.orgId) return false;
  return RULES[action](actor, resource);
}
