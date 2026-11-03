import { AccessRole, can, fail, type Member, type OrgSettings, type TeamRoleView } from '@team-finder/domain';
import { authStore, duplicateKeyOn } from '../db/auth.ts';
import type { Database } from '../db/client.ts';
import type { SessionStore } from '../db/sessions.ts';
import type { ServiceContext } from './context.ts';

// Org administration (Auth-02, Role-01, Role-02). Reads are open to everyone in the org; changes
// need `org.manage` (admins). Everything goes through orgRepo, so another org's ids are simply
// not found.

const ROLE_ORDER = AccessRole.options;

function requireAdmin({ actor }: ServiceContext, action: string) {
  if (!can(actor, 'org.manage', { orgId: actor.orgId })) fail('FORBIDDEN', { action });
}

export async function orgSettings(ctx: ServiceContext, store: SessionStore): Promise<OrgSettings> {
  requireAdmin(ctx, 'manage this organization');
  const org = await store.getOrg(ctx.actor.orgId);
  if (!org) fail('NOT_FOUND', { resource: 'organization' });
  return {
    id: org!._id,
    name: org!.name,
    hqAddress: org!.hqAddress ?? '',
    isDemo: org!.isDemo,
    inviteToken: org!.isDemo ? null : (org!.inviteToken ?? null),
  };
}

/** Auth-02: a new invite link; the old one stops working immediately. */
export async function regenerateInvite(ctx: ServiceContext, database: Database, store: SessionStore) {
  requireAdmin(ctx, 'manage invites');
  if (ctx.actor.isDemo) fail('FORBIDDEN', { action: 'invite people to a demo sandbox' });
  await authStore(database).regenerateInvite(ctx.actor.orgId);
  return orgSettings(ctx, store);
}

export async function listMembers({ repo, actor }: ServiceContext): Promise<Member[]> {
  if (!can(actor, 'org.view', { orgId: actor.orgId })) fail('FORBIDDEN', { action: 'view members' });
  const [users, departments] = await Promise.all([
    repo.users.find({}, { sort: { name: 1 } }),
    repo.departments.find({}),
  ]);
  const deptName = new Map(departments.map((d) => [d._id, d.name]));
  return users.map((u) => ({
    id: u._id,
    name: u.name,
    email: u.email,
    title: u.title,
    roles: u.accessRoles,
    departmentName: u.departmentId ? (deptName.get(u.departmentId) ?? null) : null,
  }));
}

/**
 * Role-01. `employee` is always kept. Runs in a transaction that also bumps the org's
 * rolesVersion: two admins demoting each other at the same moment both write that document, so
 * one replays, sees the other's change, and fails LAST_ADMIN instead of leaving no admin.
 */
export async function setRoles(ctx: ServiceContext, database: Database, userId: string, roles: AccessRole[]) {
  requireAdmin(ctx, 'change access roles');
  const { repo } = ctx;
  const next = ROLE_ORDER.filter((r) => r === 'employee' || roles.includes(r));
  return repo.withTransaction(async (session) => {
    await authStore(database).touchRoles(repo.orgId, session);
    const user = await repo.users.findOne({ _id: userId }, { session });
    if (!user) fail('NOT_FOUND', { resource: 'user', id: userId });
    // Approving needs the role, and nobody else approves for their department: dropping it while
    // they still manage one would strand that department's pending proposals.
    if (!next.includes('deptManager')) {
      const managed = await repo.departments.findOne({ managerId: userId }, { session });
      if (managed) {
        fail('VALIDATION', {
          issues: [
            { path: 'roles', message: `${user!.name} manages ${managed.name}; pick another manager there first` },
          ],
        });
      }
    }
    await repo.users.updateOne({ _id: userId }, { $set: { accessRoles: next } }, { session });
    const admins = await repo.users.countDocuments({ accessRoles: 'admin' }, { session });
    if (admins === 0) fail('LAST_ADMIN', {});
    return { id: userId, roles: next };
  });
}

async function teamRoleInUse({ repo }: ServiceContext, roleId: string): Promise<boolean> {
  const [projects, assignments] = await Promise.all([
    repo.projects.countDocuments({ 'teamRoles.roleId': roleId }),
    repo.assignments.countDocuments({ roleIds: roleId }),
  ]);
  return projects + assignments > 0;
}

export async function listTeamRoles(ctx: ServiceContext): Promise<TeamRoleView[]> {
  const { repo, actor } = ctx;
  if (!can(actor, 'org.view', { orgId: actor.orgId })) fail('FORBIDDEN', { action: 'view team roles' });
  const [roles, projects, assignments] = await Promise.all([
    repo.teamRoles.find({}, { sort: { name: 1 } }),
    repo.projects.find({}, { projection: { teamRoles: 1 } }),
    repo.assignments.find({}, { projection: { roleIds: 1 } }),
  ]);
  const used = new Set([
    ...projects.flatMap((p) => p.teamRoles.map((r) => r.roleId)),
    ...assignments.flatMap((a) => a.roleIds),
  ]);
  return roles.map((r) => ({ id: r._id, name: r.name, inUse: used.has(r._id) }));
}

const nameTaken = (name: string) => (error: unknown) => {
  if (duplicateKeyOn(error, 'org_name_unique_ci')) fail('NAME_TAKEN', { name });
  throw error;
};

export async function createTeamRole(ctx: ServiceContext, name: string): Promise<TeamRoleView> {
  requireAdmin(ctx, 'manage team roles');
  const doc = await ctx.repo.teamRoles.insertOne({ name }).catch(nameTaken(name));
  return { id: doc._id, name: doc.name, inUse: false };
}

export async function renameTeamRole(ctx: ServiceContext, id: string, name: string): Promise<TeamRoleView> {
  requireAdmin(ctx, 'manage team roles');
  const r = await ctx.repo.teamRoles.updateOne({ _id: id }, { $set: { name } }).catch(nameTaken(name));
  if (r.matchedCount === 0) fail('NOT_FOUND', { resource: 'team role', id });
  return { id, name, inUse: await teamRoleInUse(ctx, id) };
}

export async function deleteTeamRole(ctx: ServiceContext, id: string): Promise<{ id: string }> {
  requireAdmin(ctx, 'manage team roles');
  const { repo } = ctx;
  // In a transaction that writes the role: a project saved at the same moment touches the same
  // document (references.ts), so the role cannot vanish under it.
  return repo.withTransaction(async (session) => {
    const role = await repo.teamRoles.findOne({ _id: id }, { session });
    if (!role) fail('NOT_FOUND', { resource: 'team role', id });
    const [projects, assignments] = await Promise.all([
      repo.projects.countDocuments({ 'teamRoles.roleId': id }, { session }),
      repo.assignments.countDocuments({ roleIds: id }, { session }),
    ]);
    if (projects + assignments > 0) fail('IN_USE', { resource: 'team role' });
    await repo.teamRoles.deleteMany({ _id: id }, { session });
    return { id };
  });
}
