import { can, CAPACITY_CONSUMING_STATUSES, fail, type ApprovalsResponse } from '@team-finder/domain';
import type { ServiceContext } from './context.ts';
import { checkProposal, groupBy, unique } from './shared.ts';

/**
 * Pending proposals for people in the departments the caller manages *now*. The approver is never
 * stored, so moving an employee re-routes their pending items and the old manager loses access.
 */
export async function listApprovals({ repo, actor, today }: ServiceContext): Promise<ApprovalsResponse> {
  if (!can(actor, 'approvals.list', { orgId: repo.orgId })) fail('FORBIDDEN', { action: 'view approvals' });
  const depts = await repo.departments.find({ managerId: actor.userId });
  if (depts.length === 0) return { items: [] };
  const users = await repo.users.find({ departmentId: { $in: depts.map((d) => d._id) } });
  const pending = await repo.assignments.find(
    { userId: { $in: users.map((u) => u._id) }, status: 'proposed' },
    { sort: { createdAt: 1, _id: 1 } },
  );
  if (pending.length === 0) return { items: [] };

  const pendingUsers = unique(pending.map((a) => a.userId));
  const [projects, roles, load] = await Promise.all([
    repo.projects.find({ _id: { $in: unique(pending.map((a) => a.projectId)) } }),
    repo.teamRoles.find({ _id: { $in: unique(pending.map((a) => a.slotRoleId)) } }),
    repo.assignments.find({ userId: { $in: pendingUsers }, status: { $in: [...CAPACITY_CONSUMING_STATUSES] } }),
  ]);
  const projectById = new Map(projects.map((p) => [p._id, p]));
  const roleName = new Map(roles.map((r) => [r._id, r.name]));
  const userName = new Map(users.map((u) => [u._id, u.name]));
  const loadByUser = groupBy(load, (a) => a.userId);

  return {
    items: pending.flatMap((a) => {
      const project = projectById.get(a.projectId);
      if (!project) return [];
      const { fits, worst, maxHours } = checkProposal(a, project, loadByUser.get(a.userId) ?? [], today);
      return [
        {
          assignmentId: a._id,
          version: a.version,
          user: { id: a.userId, name: userName.get(a.userId) ?? 'Unknown' },
          project: { id: project._id, name: project.name },
          slotRole: { id: a.slotRoleId, name: roleName.get(a.slotRoleId) ?? 'Role' },
          hoursPerDay: a.hoursPerDay,
          from: a.from,
          to: a.to,
          comment: a.comments,
          check: { fits, worst, maxHours },
        },
      ];
    }),
  };
}
