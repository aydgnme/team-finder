import {
  can,
  fail,
  ProjectStatus,
  type DepartmentProjects,
  type PersonProjects,
  type ProjectDetails,
  type TeamMember,
} from '@team-finder/domain';
import type { AssignmentDoc } from '../db/documents.ts';
import type { ServiceContext } from './context.ts';
import { summaries } from './projects.ts';
import { approverOf, groupBy, loadProject, unique } from './shared.ts';

// Project-06..09 views and the admin "no approver" list (docs/plans/m3-organization-data.md, M3b).

/** Project-06/09: details and the team as proposed, active and past. Anyone in the org. */
export async function projectDetails(ctx: ServiceContext, projectId: string): Promise<ProjectDetails> {
  const { repo, actor } = ctx;
  const project = await loadProject(repo, projectId);
  if (!can(actor, 'project.view', { orgId: project.orgId })) fail('FORBIDDEN', { action: 'view this project' });
  const team = await repo.assignments.find(
    { projectId: project._id, status: { $ne: 'rejected' } },
    { sort: { from: 1, createdAt: 1 } },
  );
  const [summary, users, roles, skills] = await Promise.all([
    summaries(ctx, [project]),
    repo.users.find({ _id: { $in: unique(team.map((a) => a.userId)) } }, { projection: { name: 1 } }),
    repo.teamRoles.find({
      _id: { $in: unique([...project.teamRoles.map((r) => r.roleId), ...team.map((a) => a.slotRoleId)]) },
    }),
    repo.skills.find({ _id: { $in: project.techStack } }),
  ]);
  const name = new Map(users.map((u) => [u._id, u.name]));
  const roleName = new Map(roles.map((r) => [r._id, r.name]));
  const member = (a: AssignmentDoc): TeamMember => ({
    assignmentId: a._id,
    version: a.version,
    userId: a.userId,
    name: name.get(a.userId) ?? 'Unknown',
    slotRoleId: a.slotRoleId,
    roleName: roleName.get(a.slotRoleId) ?? 'Role',
    hoursPerDay: a.hoursPerDay,
    from: a.from,
    to: a.to,
    status: a.status,
    deallocationReason: a.deallocationReason ?? null,
  });
  return {
    project: summary[0]!,
    techStack: skills.map((s) => ({ id: s._id, name: s.name })),
    roles: project.teamRoles.map((r) => ({ id: r.roleId, name: roleName.get(r.roleId) ?? 'Role', count: r.count })),
    team: {
      proposed: team.filter((a) => a.status === 'proposed').map(member),
      active: team.filter((a) => a.status === 'active' || a.status === 'deallocationProposed').map(member),
      past: team.filter((a) => a.status === 'past').map(member),
    },
  };
}

/** Project-07: someone's current and past projects. Themselves, their department manager, admins. */
export async function personProjects(ctx: ServiceContext, userId: string): Promise<PersonProjects> {
  const { repo, actor } = ctx;
  const user = await repo.users.findOne({ _id: userId });
  if (!user) fail('NOT_FOUND', { resource: 'person', id: userId });
  const managerId = await approverOf(repo, user!);
  if (!can(actor, 'person.viewProjects', { orgId: actor.orgId, userId: user!._id, managerId })) {
    fail('FORBIDDEN', { action: "view this person's projects" });
  }
  const [assignments, dept] = await Promise.all([
    repo.assignments.find({ userId: user!._id, status: { $ne: 'rejected' } }, { sort: { from: -1 } }),
    user!.departmentId ? repo.departments.findOne({ _id: user!.departmentId }) : Promise.resolve(null),
  ]);
  const [projects, roles] = await Promise.all([
    repo.projects.find({ _id: { $in: unique(assignments.map((a) => a.projectId)) } }),
    repo.teamRoles.find({ _id: { $in: unique(assignments.map((a) => a.slotRoleId)) } }),
  ]);
  const projectById = new Map(projects.map((p) => [p._id, p]));
  const roleName = new Map(roles.map((r) => [r._id, r.name]));
  const rows = assignments.flatMap((a) => {
    const p = projectById.get(a.projectId);
    if (!p || a.status === 'rejected') return [];
    return [
      {
        projectId: p._id,
        projectName: p.name,
        projectStatus: p.status,
        roleName: roleName.get(a.slotRoleId) ?? 'Role',
        hoursPerDay: a.hoursPerDay,
        from: a.from,
        to: a.to,
        status: a.status,
      },
    ];
  });
  return {
    person: { id: user!._id, name: user!.name, title: user!.title, departmentName: dept?.name ?? null },
    current: rows.filter((r) => r.status !== 'past'),
    past: rows.filter((r) => r.status === 'past'),
  };
}

/** Project-08: projects that have this department's members, optionally by status. */
export async function departmentProjects(
  ctx: ServiceContext,
  departmentId: string,
  status: string | undefined,
): Promise<DepartmentProjects> {
  const { repo, actor } = ctx;
  const dept = await repo.departments.findOne({ _id: departmentId });
  if (!dept) fail('NOT_FOUND', { resource: 'department', id: departmentId });
  if (!can(actor, 'department.viewProjects', { orgId: actor.orgId, managerId: dept!.managerId })) {
    fail('FORBIDDEN', { action: "view this department's projects" });
  }
  const parsed = status === undefined ? undefined : ProjectStatus.safeParse(status);
  if (parsed && !parsed.success)
    fail('VALIDATION', { issues: [{ path: 'status', message: 'unknown project status' }] });
  const members = await repo.users.find({ departmentId: dept!._id }, { projection: { name: 1 } });
  const assignments = await repo.assignments.find({
    userId: { $in: members.map((m) => m._id) },
    status: { $ne: 'rejected' },
  });
  const projects = await repo.projects.find({
    _id: { $in: unique(assignments.map((a) => a.projectId)) },
    ...(parsed?.success ? { status: parsed.data } : {}),
  });
  const memberName = new Map(members.map((m) => [m._id, m.name]));
  const byProject = groupBy(assignments, (a) => a.projectId);
  const summary = await summaries(ctx, projects);
  return {
    department: { id: dept!._id, name: dept!.name },
    projects: summary
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((p) => ({
        ...p,
        members: unique((byProject.get(p.id) ?? []).map((a) => a.userId)).map((id) => ({
          id,
          name: memberName.get(id) ?? 'Unknown',
        })),
      })),
  };
}

/**
 * Pending items nobody can decide: the person has no department, or their department has no
 * manager. Admins see them here and fix the department (approvers are never stored, design.md).
 */
export async function noApproverItems(ctx: ServiceContext) {
  const { repo, actor } = ctx;
  if (!can(actor, 'org.manage', { orgId: actor.orgId })) fail('FORBIDDEN', { action: 'view stranded approvals' });
  const pending = await repo.assignments.find({ status: { $in: ['proposed', 'deallocationProposed'] } });
  if (pending.length === 0) return { items: [] };
  const [users, departments, projects] = await Promise.all([
    repo.users.find(
      { _id: { $in: unique(pending.map((a) => a.userId)) } },
      { projection: { name: 1, departmentId: 1 } },
    ),
    repo.departments.find({}),
    repo.projects.find({ _id: { $in: unique(pending.map((a) => a.projectId)) } }, { projection: { name: 1 } }),
  ]);
  const managed = new Set(departments.filter((d) => d.managerId).map((d) => d._id));
  const user = new Map(users.map((u) => [u._id, u]));
  const projectName = new Map(projects.map((p) => [p._id, p.name]));
  return {
    items: pending
      .filter((a) => {
        const dept = user.get(a.userId)?.departmentId;
        return !dept || !managed.has(dept);
      })
      .map((a) => ({
        assignmentId: a._id,
        kind: a.status === 'proposed' ? ('proposal' as const) : ('deallocation' as const),
        user: { id: a.userId, name: user.get(a.userId)?.name ?? 'Unknown' },
        project: { id: a.projectId, name: projectName.get(a.projectId) ?? 'Project' },
      })),
  };
}
