import {
  addDays,
  buildTimeline,
  can,
  CapacityError,
  compareScenarios,
  consumesCapacity,
  daysBetween,
  fail,
  inScrubRange,
  maxDay,
  NON_TERMINAL_STATUSES,
  overlaps,
  projectTargets,
  shiftProject,
  withProposal,
  type ScenarioAddition,
  type ScenarioCommitRequest,
  type ScenarioCommitResponse,
  type ScenarioMember,
  type SnapshotView,
  type Verdict,
} from '@team-finder/domain';
import type { z } from 'zod';
import type { AssignmentDoc, ProjectDoc } from '../db/documents.ts';
import type { DbSession, OrgRepo } from '../db/org-repo.ts';
import { insertProposal, invalid, toAssignmentView } from './assignments.ts';
import type { ServiceContext } from './context.ts';
import { groupBy, loadProject, touchProject, unique } from './shared.ts';

type Addition = z.output<typeof ScenarioAddition>;

function checkStart(project: ProjectDoc, start: string, today: string) {
  if (!inScrubRange(project, start, today)) {
    invalid('start', 'must be within 6 weeks after the start of a project that has not started');
  }
}

/** Draft-level checks that need no reads: size and the same person twice. */
function checkDraft(project: ProjectDoc, additions: readonly Addition[]) {
  const slots = project.teamRoles.reduce((n, r) => n + r.count, 0);
  if (additions.length > slots) invalid('additions', `the project has ${slots} role slots`);
  const seen = new Set<string>();
  for (const a of additions) {
    if (seen.has(a.userId)) {
      fail('DUPLICATE_ASSIGNMENT', { userId: a.userId, projectId: project._id, slotRoleId: a.slotRoleId });
    }
    seen.add(a.userId);
  }
}

/**
 * Moves a not-yet-started project to `start` (keeping its duration) together with every open
 * assignment on it. Active ones are re-checked for invariant 1 over their new range, and their
 * people get capacityVersion bumped: a concurrent approval elsewhere for the same person writes the
 * same user document, so one of the two transactions conflicts and replays (as in approve()).
 */
async function moveProject(
  repo: OrgRepo,
  project: ProjectDoc,
  start: string,
  session: DbSession,
): Promise<{ project: ProjectDoc; moved: number }> {
  const delta = daysBetween(project.startDate, start);
  const shifted = shiftProject(project, start);
  await repo.projects.updateOne(
    { _id: project._id },
    { $set: { startDate: shifted.startDate, deadline: shifted.deadline } },
    { session },
  );
  const team = await repo.assignments.find(
    { projectId: project._id, status: { $in: [...NON_TERMINAL_STATUSES] } },
    { session },
  );
  const active = team.filter((a) => consumesCapacity(a.status));
  const elsewhere = active.length
    ? await repo.assignments.find(
        {
          userId: { $in: unique(active.map((a) => a.userId)) },
          projectId: { $ne: project._id },
          status: { $in: ['active', 'deallocationProposed'] },
        },
        { session },
      )
    : [];
  const loadByUser = groupBy(elsewhere, (a) => a.userId);

  for (const a of team) {
    const from = addDays(a.from, delta);
    const to = a.to === null ? null : addDays(a.to, delta);
    if (consumesCapacity(a.status)) {
      const range = { from, to };
      const others = (loadByUser.get(a.userId) ?? []).filter((o) => overlaps(o, range));
      const check = withProposal(buildTimeline(others), a.hoursPerDay, from, range);
      if (!check.fits) {
        throw new CapacityError({
          userId: a.userId,
          date: check.worst.date,
          used: check.worst.used,
          requested: a.hoursPerDay,
          maxHours: check.maxHours,
          slotRoleId: a.slotRoleId,
        });
      }
      await repo.users.updateOne({ _id: a.userId }, { $inc: { capacityVersion: 1 } }, { session });
    }
    const r = await repo.assignments.updateOne(
      { _id: a._id, version: a.version },
      { $set: { from, to }, $inc: { version: 1 } },
      { session },
    );
    if (r.matchedCount !== 1) fail('CONFLICT_STALE', { resource: 'assignment', id: a._id });
  }
  return { project: shifted, moved: team.length };
}

/**
 * POST /api/projects/:id/scenarios/commit. One transaction, all-or-nothing: move the project if the
 * draft changed its start, then insert every proposal through the same checks as a single propose
 * (session reads, so earlier inserts count toward slot limits), then touchProject() once. Any
 * failure rolls everything back and names the slot (`details.slotRoleId`).
 */
export async function commitScenario(
  ctx: ServiceContext,
  projectId: string,
  input: z.output<typeof ScenarioCommitRequest>,
): Promise<ScenarioCommitResponse> {
  const { repo, actor, today } = ctx;
  return repo.withTransaction(async (session) => {
    let project = await loadProject(repo, projectId, session);
    if (!can(actor, 'project.staff', { orgId: project.orgId, pmId: project.pmId })) {
      fail('FORBIDDEN', { action: 'staff this project' });
    }
    checkStart(project, input.start, today);
    checkDraft(project, input.additions);
    if (input.additions.length === 0 && input.start === project.startDate) {
      invalid('additions', 'the draft changes nothing');
    }

    let moved = 0;
    if (input.start !== project.startDate)
      ({ project, moved } = await moveProject(repo, project, input.start, session));

    const from = maxDay(today, project.startDate);
    const created: AssignmentDoc[] = [];
    for (const a of input.additions) {
      created.push(await insertProposal(ctx, project, { ...a, from, comment: input.comment }, session));
    }
    await touchProject(repo, project._id, session);
    return {
      project: { startDate: project.startDate, deadline: project.deadline },
      created: created.map(toAssignmentView),
      moved,
    };
  });
}

export interface RebuiltScenarios {
  project: ProjectDoc;
  verdict: Verdict;
  slots: SnapshotView['slots'];
  missingSkills: string[];
}

/**
 * Rebuilds A (current team, current start) and B (A + additions at `start`) from the database and
 * judges them. The client only ever sends the draft; names, skills, timelines and the verdict all
 * come from here, so a snapshot cannot carry forged content.
 */
export async function rebuildScenarios(
  ctx: ServiceContext,
  projectId: string,
  start: string,
  additions: readonly Addition[],
): Promise<RebuiltScenarios> {
  const { repo, today } = ctx;
  const project = await loadProject(repo, projectId);
  checkStart(project, start, today);
  checkDraft(project, additions);
  for (const a of additions) {
    if (!project.teamRoles.some((r) => r.roleId === a.slotRoleId)) {
      invalid('additions.slotRoleId', 'is not a role slot of this project');
    }
  }

  const team = await repo.assignments.find(
    { projectId: project._id, status: { $in: [...NON_TERMINAL_STATUSES] } },
    { sort: { createdAt: 1 } },
  );
  for (const a of additions) {
    if (team.some((t) => t.userId === a.userId)) {
      fail('DUPLICATE_ASSIGNMENT', { userId: a.userId, projectId: project._id, slotRoleId: a.slotRoleId });
    }
  }
  const userIds = unique([...team.map((a) => a.userId), ...additions.map((a) => a.userId)]);
  await repo.assertOwned('users', userIds);
  const targetIds = projectTargets(project).map((t) => t.skillId);

  const [users, userSkills, load, roles, skills] = await Promise.all([
    repo.users.find({ _id: { $in: userIds } }, { projection: { name: 1 } }),
    repo.userSkills.find({ userId: { $in: userIds }, skillId: { $in: targetIds }, validated: true }),
    repo.assignments.find({
      userId: { $in: userIds },
      projectId: { $ne: project._id },
      status: { $in: [...NON_TERMINAL_STATUSES] },
    }),
    repo.teamRoles.find({ _id: { $in: project.teamRoles.map((r) => r.roleId) } }),
    repo.skills.find({ _id: { $in: targetIds } }),
  ]);
  const name = new Map(users.map((u) => [u._id, u.name]));
  const skillsByUser = groupBy(userSkills, (s) => s.userId);
  const loadByUser = groupBy(load, (a) => a.userId);
  const asMember = (userId: string, slotRoleId: string, hoursPerDay: number): ScenarioMember => ({
    userId,
    slotRoleId,
    hoursPerDay,
    skills: (skillsByUser.get(userId) ?? []).map((s) => ({ skillId: s.skillId, level: s.level })),
    timeline: buildTimeline(loadByUser.get(userId) ?? []),
  });

  const current = team.map((a) => asMember(a.userId, a.slotRoleId, a.hoursPerDay));
  const draft = additions.map((a) => asMember(a.userId, a.slotRoleId, a.hoursPerDay));
  const verdict = compareScenarios(
    project,
    { start: project.startDate, members: current },
    { start, members: [...current, ...draft] },
    today,
  );
  const roleName = new Map(roles.map((r) => [r._id, r.name]));
  const skillName = new Map(skills.map((s) => [s._id, s.name]));
  return {
    project,
    verdict,
    missingSkills: verdict.b.missingSkillIds.map((id) => skillName.get(id) ?? 'skill'),
    slots: project.teamRoles.map((r) => ({
      roleName: roleName.get(r.roleId) ?? 'Role',
      count: r.count,
      members: [
        ...team
          .filter((a) => a.slotRoleId === r.roleId)
          .map((a) => ({
            name: name.get(a.userId) ?? 'Unknown',
            hoursPerDay: a.hoursPerDay,
            status: a.status === 'proposed' ? ('proposed' as const) : ('active' as const),
          })),
        ...additions
          .filter((a) => a.slotRoleId === r.roleId)
          .map((a) => ({
            name: name.get(a.userId) ?? 'Unknown',
            hoursPerDay: a.hoursPerDay,
            status: 'draft' as const,
          })),
      ],
    })),
  };
}
