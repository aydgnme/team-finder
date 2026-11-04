import {
  buildTimeline,
  can,
  CAPACITY_CONSUMING_STATUSES,
  clampAssignment,
  withProposal,
  type DateEditConflict,
  fail,
  NON_TERMINAL_STATUSES,
  transitionProject,
  type UpdateProjectRequest,
  type CreateProjectRequest,
  type ProjectStatus,
  type ProjectSummary,
} from '@team-finder/domain';
import type { z } from 'zod';
import type { AssignmentDoc, ProjectDoc } from '../db/documents.ts';
import type { DbSession, OrgRepo } from '../db/org-repo.ts';
import { invalid } from './assignments.ts';
import { notify } from './notifications.ts';
import type { ServiceContext } from './context.ts';
import { touchReferences } from './references.ts';
import { approverOf, groupBy, loadProject, touchProject, unique } from './shared.ts';

// Project-01 and the project lifecycle (docs/plans/m3-organization-data.md, M3a).

const STATUS_ORDER: ProjectStatus[] = ['inProgress', 'starting', 'notStarted', 'closing', 'closed'];

function requireEditor({ actor }: ServiceContext, project: Pick<ProjectDoc, 'orgId' | 'pmId'>, action: string) {
  if (!can(actor, 'project.edit', { orgId: project.orgId, pmId: project.pmId })) fail('FORBIDDEN', { action });
}

export async function summaries(ctx: ServiceContext, projects: ProjectDoc[]): Promise<ProjectSummary[]> {
  const { repo, actor } = ctx;
  const ids = projects.map((p) => p._id);
  const [pms, open] = await Promise.all([
    repo.users.find({ _id: { $in: unique(projects.map((p) => p.pmId)) } }, { projection: { name: 1 } }),
    repo.assignments.find(
      { projectId: { $in: ids }, status: { $in: [...NON_TERMINAL_STATUSES] } },
      { projection: { projectId: 1 } },
    ),
  ]);
  const pmName = new Map(pms.map((u) => [u._id, u.name]));
  const filled = groupBy(open, (a) => a.projectId);
  return projects.map((p) => ({
    id: p._id,
    name: p.name,
    description: p.description,
    period: p.period,
    status: p.status,
    startDate: p.startDate,
    deadline: p.deadline,
    everActive: p.everActive,
    pm: { id: p.pmId, name: pmName.get(p.pmId) ?? 'Unknown' },
    techStack: p.techStack,
    teamRoles: p.teamRoles,
    skillRequirements: p.skillRequirements.map((r) => ({ skillId: r.skillId, minLevel: r.minLevel ?? 1 })),
    slots: { filled: filled.get(p._id)?.length ?? 0, total: p.teamRoles.reduce((n, r) => n + r.count, 0) },
    canEdit: can(actor, 'project.edit', { orgId: p.orgId, pmId: p.pmId }),
  }));
}

export async function listProjects(ctx: ServiceContext) {
  const { repo, actor } = ctx;
  if (!can(actor, 'project.view', { orgId: actor.orgId })) fail('FORBIDDEN', { action: 'view projects' });
  const projects = await repo.projects.find({});
  projects.sort(
    (a, b) =>
      STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) ||
      a.startDate.localeCompare(b.startDate) ||
      a.name.localeCompare(b.name),
  );
  return { projects: await summaries(ctx, projects), canCreate: can(actor, 'project.create', { orgId: actor.orgId }) };
}

async function summary(ctx: ServiceContext, projectId: string, session?: DbSession) {
  const p = await loadProject(ctx.repo, projectId, session);
  return (await summaries(ctx, [p]))[0]!;
}

/** Project-01: a project manager creates a project and becomes its PM. */
export async function createProject(ctx: ServiceContext, input: z.output<typeof CreateProjectRequest>) {
  const { repo, actor } = ctx;
  if (!can(actor, 'project.create', { orgId: actor.orgId })) fail('FORBIDDEN', { action: 'create projects' });
  const id = await repo.withTransaction(async (session) => {
    await touchReferences(repo, session, {
      teamRoleIds: input.teamRoles.map((r) => r.roleId),
      skillIds: [...input.techStack, ...input.skillRequirements.map((r) => r.skillId)],
    });
    const doc = await repo.projects.insertOne(
      {
        name: input.name,
        description: input.description,
        period: input.period,
        startDate: input.startDate,
        deadline: input.deadline,
        status: input.status,
        everActive: false,
        techStack: unique(input.techStack),
        teamRoles: input.teamRoles,
        skillRequirements: input.skillRequirements,
        pmId: actor.userId,
        version: 0,
      },
      { session },
    );
    return doc._id;
  });
  return summary(ctx, id);
}

async function openAssignments(repo: OrgRepo, projectId: string, session: DbSession) {
  return repo.assignments.find({ projectId, status: { $in: [...NON_TERMINAL_STATUSES] } }, { session });
}

/**
 * Edits by the project's PM. Team-role counts cannot drop below the people holding the role.
 * Date changes clamp the team's assignments and re-check everyone's hours (clampTeam).
 */
export async function updateProject(
  ctx: ServiceContext,
  projectId: string,
  input: z.output<typeof UpdateProjectRequest>,
) {
  const { repo } = ctx;
  await repo.withTransaction(async (session) => {
    const project = await loadProject(repo, projectId, session);
    requireEditor(ctx, project, 'edit this project');
    if (project.status === 'closed') invalid('status', 'a closed project is read-only');
    const open = await openAssignments(repo, project._id, session);

    const startDate = input.startDate ?? project.startDate;
    const deadline = input.deadline === undefined ? project.deadline : input.deadline;
    const datesChanged = startDate !== project.startDate || deadline !== project.deadline;
    if (datesChanged) {
      const ok = project.period === 'ongoing' ? deadline === null : deadline !== null && deadline > startDate;
      if (!ok) invalid('deadline', 'a fixed project needs a deadline after its start; an ongoing one has none');
      if (startDate !== project.startDate && (project.startDate <= ctx.today || startDate < ctx.today)) {
        invalid('startDate', 'the start can move only before the project starts, and not into the past');
      }
      await clampTeam(ctx, project, { startDate, deadline }, open, session);
    }

    if (input.teamRoles) {
      const holding = groupBy(open, (a) => a.slotRoleId);
      for (const [roleId, people] of holding) {
        const count: number = input.teamRoles.find((r) => r.roleId === roleId)?.count ?? 0;
        if (people.length > count) fail('SLOT_FULL', { roleId, count, slotRoleId: roleId });
      }
    }
    await touchReferences(repo, session, {
      teamRoleIds: input.teamRoles?.map((r) => r.roleId),
      skillIds:
        input.techStack || input.skillRequirements
          ? [...(input.techStack ?? []), ...(input.skillRequirements ?? []).map((r) => r.skillId)]
          : undefined,
    });
    await repo.projects.updateOne(
      { _id: project._id },
      {
        $set: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.techStack !== undefined ? { techStack: unique(input.techStack) } : {}),
          ...(input.teamRoles !== undefined ? { teamRoles: input.teamRoles } : {}),
          ...(input.skillRequirements !== undefined ? { skillRequirements: input.skillRequirements } : {}),
          startDate,
          deadline,
        },
      },
      { session },
    );
    await touchProject(repo, project._id, session);
  });
  return summary(ctx, projectId);
}

/**
 * Date edits clamp, never rewrite (design.md): every open assignment goes through clampAssignment().
 * Booked hours that move are re-checked for invariant 1 against the person's other work, and their
 * capacityVersion is bumped (a concurrent approval elsewhere conflicts and replays). Anyone who would
 * be overbooked, or whose work would start on or after the new deadline, fails the whole edit with
 * one DATE_EDIT_CONFLICT naming all of them.
 */
async function clampTeam(
  ctx: ServiceContext,
  project: ProjectDoc,
  next: { startDate: string; deadline: string | null },
  open: AssignmentDoc[],
  session: DbSession,
) {
  const { repo } = ctx;
  const moved = open
    .map((a) => ({ a, dates: clampAssignment(a, project, next) }))
    .filter(({ a, dates }) => dates.from !== a.from || dates.to !== a.to);
  if (moved.length === 0) return;

  const consuming = moved.filter(({ a }) => (CAPACITY_CONSUMING_STATUSES as readonly string[]).includes(a.status));
  const people = unique(moved.map(({ a }) => a.userId));
  const [users, elsewhere] = await Promise.all([
    repo.users.find({ _id: { $in: people } }, { projection: { name: 1 }, session }),
    repo.assignments.find(
      {
        userId: { $in: unique(consuming.map(({ a }) => a.userId)) },
        projectId: { $ne: project._id },
        status: { $in: [...CAPACITY_CONSUMING_STATUSES] },
      },
      { session },
    ),
  ]);
  const name = new Map(users.map((u) => [u._id, u.name]));
  const load = groupBy(elsewhere, (a) => a.userId);
  const conflicts: DateEditConflict[] = [];
  for (const { a, dates } of moved) {
    if (dates.to !== null && dates.to <= dates.from) {
      conflicts.push({
        userId: a.userId,
        name: name.get(a.userId) ?? 'Someone',
        reason: 'startsAfterDeadline',
        date: null,
      });
      continue;
    }
    if (!(CAPACITY_CONSUMING_STATUSES as readonly string[]).includes(a.status)) continue;
    const check = withProposal(buildTimeline(load.get(a.userId) ?? []), a.hoursPerDay, dates.from, dates);
    if (!check.fits) {
      conflicts.push({
        userId: a.userId,
        name: name.get(a.userId) ?? 'Someone',
        reason: 'overbooked',
        date: check.worst.date,
      });
    }
  }
  if (conflicts.length > 0) fail('DATE_EDIT_CONFLICT', { conflicts });

  for (const { a, dates } of moved) {
    const r = await repo.assignments.updateOne(
      { _id: a._id, version: a.version },
      { $set: dates, $inc: { version: 1 } },
      { session },
    );
    if (r.matchedCount !== 1) fail('CONFLICT_STALE', { resource: 'assignment', id: a._id });
  }
  if (consuming.length > 0) {
    await repo.users.updateMany(
      { _id: { $in: unique(consuming.map(({ a }) => a.userId)) } },
      { $inc: { capacityVersion: 1 } },
      { session },
    );
  }
}

/**
 * Closing ends the team in the same transaction: assignments already started become `past` on
 * the close day (or keep their earlier end); ones that have not started, and open proposals, are rejected (never `to < from`).
 * Everyone whose committed hours changed gets capacityVersion bumped, so a concurrent approval for
 * the same person conflicts and replays.
 */
async function closeTeam(ctx: ServiceContext, project: ProjectDoc, session: DbSession) {
  const { repo, today, now } = ctx;
  const open: AssignmentDoc[] = await openAssignments(repo, project._id, session);
  let ended = 0;
  let rejected = 0;
  const touched = new Set<string>();
  for (const a of open) {
    const consuming = (CAPACITY_CONSUMING_STATUSES as readonly string[]).includes(a.status);
    const started = consuming && a.from <= today;
    // Ends today, or when it already ended: closing never extends a record of past work.
    const to = a.to !== null && a.to < today ? a.to : today;
    const set = started ? { status: 'past' as const, to } : { status: 'rejected' as const, decidedAt: now };
    await repo.assignments.updateOne(
      { _id: a._id, version: a.version },
      { $set: set, $inc: { version: 1 } },
      { session },
    );
    if (consuming) touched.add(a.userId);
    if (started) ended++;
    else rejected++;
  }
  if (touched.size > 0) {
    await repo.users.updateMany({ _id: { $in: [...touched] } }, { $inc: { capacityVersion: 1 } }, { session });
  }
  return { ended, rejected };
}

export async function changeStatus(ctx: ServiceContext, projectId: string, next: ProjectStatus) {
  const { repo } = ctx;
  const closed = await repo.withTransaction(async (session) => {
    const project = await loadProject(repo, projectId, session);
    requireEditor(ctx, project, 'change the status of this project');
    const t = transitionProject(project, next);
    if (!t.ok) fail('TRANSITION_NOT_ALLOWED', { from: project.status, to: next });
    const report = next === 'closed' ? await closeTeam(ctx, project, session) : null;
    await repo.projects.updateOne(
      { _id: project._id },
      { $set: { status: next, everActive: t.ok && t.everActive } },
      { session },
    );
    await touchProject(repo, project._id, session);
    return report;
  });
  return { project: await summary(ctx, projectId), closed };
}

/** Only never-active projects can be deleted; their assignments go with them. */
export async function deleteProject(ctx: ServiceContext, projectId: string) {
  const { repo } = ctx;
  await repo.withTransaction(async (session) => {
    const project = await loadProject(repo, projectId, session);
    requireEditor(ctx, project, 'delete this project');
    if (project.everActive) fail('NOT_DELETABLE', { reason: 'the project has been in progress' });
    const holding = await repo.assignments.find(
      { projectId: project._id, status: { $in: [...CAPACITY_CONSUMING_STATUSES] } },
      { session },
    );
    if (holding.length > 0) {
      // Their hours are freed: same conflict boundary as any capacity change.
      await repo.users.updateMany(
        { _id: { $in: unique(holding.map((a) => a.userId)) } },
        { $inc: { capacityVersion: 1 } },
        { session },
      );
    }
    // projectDeleted: once per department manager whose people were on it (any status).
    const all = await repo.assignments.find({ projectId: project._id }, { session, projection: { userId: 1 } });
    const people = await repo.users.find(
      { _id: { $in: unique(all.map((a) => a.userId)) } },
      { session, projection: { departmentId: 1 } },
    );
    const approvers = unique(
      (await Promise.all(people.map((u) => approverOf(repo, u, session)))).filter((id): id is string => id !== null),
    );
    await notify(
      ctx,
      session,
      approvers.map((userId) => ({
        userId,
        type: 'projectDeleted' as const,
        refId: project._id,
        data: { projectName: project.name },
      })),
    );
    await repo.assignments.deleteMany({ projectId: project._id }, { session });
    await repo.projects.deleteMany({ _id: project._id }, { session });
  });
  return { id: projectId };
}
