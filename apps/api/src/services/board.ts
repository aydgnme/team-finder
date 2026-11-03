import {
  can,
  CAPACITY_CONSUMING_STATUSES,
  evaluationWindow,
  fail,
  NON_TERMINAL_STATUSES,
  projectTargets,
  type ProjectBoard,
} from '@team-finder/domain';
import type { ServiceContext } from './context.ts';
import { checkProposal, groupBy, loadProject, unique } from './shared.ts';

/** Everything the canvas needs besides candidates: project, names, current team, proposal checks. */
export async function projectBoard({ repo, actor, today }: ServiceContext, projectId: string): Promise<ProjectBoard> {
  const project = await loadProject(repo, projectId);
  if (!can(actor, 'project.view', { orgId: project.orgId })) fail('FORBIDDEN', { action: 'view this project' });
  const targetIds = projectTargets(project).map((t) => t.skillId);

  const [skills, roles, team] = await Promise.all([
    repo.skills.find({ _id: { $in: targetIds } }),
    repo.teamRoles.find({}, { sort: { name: 1 } }),
    repo.assignments.find(
      { projectId: project._id, status: { $in: [...NON_TERMINAL_STATUSES] } },
      { sort: { createdAt: 1 } },
    ),
  ]);
  const userIds = unique(team.map((a) => a.userId));
  const [users, userSkills, load] = await Promise.all([
    repo.users.find({ _id: { $in: userIds } }),
    repo.userSkills.find({ userId: { $in: userIds }, skillId: { $in: targetIds }, validated: true }),
    repo.assignments.find({
      userId: { $in: userIds },
      projectId: { $ne: project._id },
      status: { $in: [...CAPACITY_CONSUMING_STATUSES] },
    }),
  ]);
  const names = new Map(users.map((u) => [u._id, u.name]));
  const skillsByUser = groupBy(userSkills, (s) => s.userId);
  const loadByUser = groupBy(load, (a) => a.userId);

  return {
    project: {
      id: project._id,
      name: project.name,
      description: project.description,
      period: project.period,
      status: project.status,
      startDate: project.startDate,
      deadline: project.deadline,
      pmId: project.pmId,
      techStack: project.techStack,
      skillRequirements: project.skillRequirements,
      teamRoles: project.teamRoles,
    },
    window: evaluationWindow(project, today),
    skills: skills.map((s) => ({ id: s._id, name: s.name })),
    roles: roles.map((r) => ({ id: r._id, name: r.name })),
    canStaff: can(actor, 'project.staff', { orgId: project.orgId, pmId: project.pmId }),
    assignments: team.map((a) => {
      let check = null;
      if (a.status === 'proposed') {
        const { fits, worst, maxHours } = checkProposal(a, project, loadByUser.get(a.userId) ?? [], today);
        check = { fits, worst, maxHours };
      }
      return {
        id: a._id,
        userId: a.userId,
        userName: names.get(a.userId) ?? 'Unknown',
        slotRoleId: a.slotRoleId,
        roleIds: a.roleIds,
        status: a.status,
        hoursPerDay: a.hoursPerDay,
        from: a.from,
        to: a.to,
        version: a.version,
        skills: (skillsByUser.get(a.userId) ?? []).map((s) => ({ skillId: s.skillId, level: s.level })),
        check,
      };
    }),
  };
}
