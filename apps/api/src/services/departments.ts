import { can, fail, type DepartmentsResponse } from '@team-finder/domain';
import { duplicateKeyOn } from '../db/auth.ts';
import type { DepartmentDoc, UserDoc } from '../db/documents.ts';
import { invalid } from './assignments.ts';
import type { ServiceContext } from './context.ts';

// Department-01..03 (docs/plans/m3-organization-data.md, M3a). Approvers are resolved at decision
// time from a person's current department, so every move here re-routes pending approvals; a move
// writes the user document, so it conflicts with a concurrent approval of that person.

const ref = (u: Pick<UserDoc, '_id' | 'name' | 'title'>) => ({ id: u._id, name: u.name, title: u.title });

function requireManage({ actor }: ServiceContext) {
  if (!can(actor, 'department.manage', { orgId: actor.orgId })) fail('FORBIDDEN', { action: 'manage departments' });
}

async function loadDepartment({ repo }: ServiceContext, id: string): Promise<DepartmentDoc> {
  return (await repo.departments.findOne({ _id: id })) ?? fail('NOT_FOUND', { resource: 'department', id });
}

const nameTaken = (name: string) => (error: unknown) => {
  if (duplicateKeyOn(error, 'org_name_unique_ci')) fail('NAME_TAKEN', { name });
  throw error;
};

export async function listDepartments(ctx: ServiceContext): Promise<DepartmentsResponse> {
  const { repo, actor } = ctx;
  if (!can(actor, 'org.view', { orgId: actor.orgId })) fail('FORBIDDEN', { action: 'view departments' });
  const [departments, users] = await Promise.all([
    repo.departments.find({}, { sort: { name: 1 } }),
    repo.users.find({}, { sort: { name: 1 }, projection: { name: 1, title: 1, departmentId: 1, accessRoles: 1 } }),
  ]);
  const byId = new Map(users.map((u) => [u._id, u]));
  const managing = new Set(departments.map((d) => d.managerId).filter((m): m is string => m !== null));
  return {
    canManage: can(actor, 'department.manage', { orgId: actor.orgId }),
    departments: departments.map((d) => {
      const manager = d.managerId ? byId.get(d.managerId) : undefined;
      return {
        id: d._id,
        name: d.name,
        manager: manager ? ref(manager) : null,
        members: users.filter((u) => u.departmentId === d._id).map(ref),
        canManageMembers: can(actor, 'department.members', { orgId: actor.orgId, managerId: d.managerId }),
      };
    }),
    unassigned: users.filter((u) => !u.departmentId).map(ref),
    managerCandidates: users.filter((u) => u.accessRoles.includes('deptManager') && !managing.has(u._id)).map(ref),
  };
}

export async function createDepartment(ctx: ServiceContext, name: string) {
  requireManage(ctx);
  const doc = await ctx.repo.departments.insertOne({ name, managerId: null }).catch(nameTaken(name));
  return { id: doc._id, name };
}

export async function renameDepartment(ctx: ServiceContext, id: string, name: string) {
  requireManage(ctx);
  await loadDepartment(ctx, id);
  await ctx.repo.departments.updateOne({ _id: id }, { $set: { name } }).catch(nameTaken(name));
  return { id, name };
}

/** Refused while people are in it: removing them first makes the re-routing explicit. */
export async function deleteDepartment(ctx: ServiceContext, id: string) {
  requireManage(ctx);
  const { repo } = ctx;
  return repo.withTransaction(async (session) => {
    const dept = await repo.departments.findOne({ _id: id }, { session });
    if (!dept) fail('NOT_FOUND', { resource: 'department', id });
    if ((await repo.users.countDocuments({ departmentId: id }, { session })) > 0) {
      fail('IN_USE', { resource: 'department' });
    }
    await repo.departments.deleteMany({ _id: id }, { session });
    return { id };
  });
}

/** Department-02: the manager must hold deptManager; one department per manager (unique index). */
export async function setManager(ctx: ServiceContext, id: string, managerId: string | null) {
  requireManage(ctx);
  const { repo } = ctx;
  await loadDepartment(ctx, id);
  if (managerId) {
    const user = await repo.users.findOne({ _id: managerId });
    if (!user) fail('NOT_FOUND', { resource: 'user', id: managerId });
    if (!user!.accessRoles.includes('deptManager'))
      invalid('managerId', 'give this person the Department manager role first');
  }
  await repo.departments.updateOne({ _id: id }, { $set: { managerId } }).catch((error: unknown) => {
    if (duplicateKeyOn(error, 'org_manager_unique'))
      invalid('managerId', 'this person already manages another department');
    throw error;
  });
  return { id, managerId };
}

/**
 * Department-03. Admins move anyone; a department's manager takes people from the unassigned list
 * and lets members go.
 */
export async function addMember(ctx: ServiceContext, id: string, userId: string) {
  const { repo, actor } = ctx;
  const dept = await loadDepartment(ctx, id);
  if (!can(actor, 'department.members', { orgId: actor.orgId, managerId: dept.managerId })) {
    fail('FORBIDDEN', { action: 'add people to this department' });
  }
  const user = await repo.users.findOne({ _id: userId });
  if (!user) fail('NOT_FOUND', { resource: 'user', id: userId });
  const isAdmin = can(actor, 'department.manage', { orgId: actor.orgId });
  if (user!.departmentId && user!.departmentId !== id && !isAdmin) {
    invalid('userId', 'this person belongs to another department; ask an admin to move them');
  }
  await repo.users.updateOne({ _id: userId }, { $set: { departmentId: id } });
  return { id, userId };
}

export async function removeMember(ctx: ServiceContext, id: string, userId: string) {
  const { repo, actor } = ctx;
  const dept = await loadDepartment(ctx, id);
  if (!can(actor, 'department.members', { orgId: actor.orgId, managerId: dept.managerId })) {
    fail('FORBIDDEN', { action: 'remove people from this department' });
  }
  const r = await repo.users.updateOne({ _id: userId, departmentId: id }, { $set: { departmentId: null } });
  if (r.matchedCount === 0) fail('NOT_FOUND', { resource: 'member', id: userId });
  return { id, userId };
}
