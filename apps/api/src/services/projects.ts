import {
  can,
  CAPACITY_CONSUMING_STATUSES,
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
import type { ServiceContext } from './context.ts';
import { touchReferences } from './references.ts';
import { groupBy, loadProject, touchProject, unique } from './shared.ts';

// Project-01 and the project lifecycle (docs/plans/m3-organization-data.md, M3a).

const STATUS_ORDER: ProjectStatus[] = ['inProgress', 'starting', 'notStarted', 'closing', 'closed'];

function requireEditor({ actor }: ServiceContext, project: Pick<ProjectDoc, 'orgId' | 'pmId'>, action: string) {
  if (!can(actor, 'project.edit', { orgId: project.orgId, pmId: project.pmId })) fail('FORBIDDEN', { action });
}

async function summaries(ctx: ServiceContext, projects: ProjectDoc[]): Promise<ProjectSummary[]> {
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
      skillIds: input.techStack,
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
        skillRequirements: [],
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
 * Dates move only while nobody is on the team: moving them under a team needs the clamp and
 * recheck rule, which ships with M3b.
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
      if (open.length > 0) {
        invalid('startDate', 'dates can change only while nobody is proposed or assigned to the project');
      }
      const ok = project.period === 'ongoing' ? deadline === null : deadline !== null && deadline > startDate;
      if (!ok) invalid('deadline', 'a fixed project needs a deadline after its start; an ongoing one has none');
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
      skillIds: input.techStack,
    });
    await repo.projects.updateOne(
      { _id: project._id },
      {
        $set: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.techStack !== undefined ? { techStack: unique(input.techStack) } : {}),
          ...(input.teamRoles !== undefined ? { teamRoles: input.teamRoles } : {}),
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
 * Closing ends the team in the same transaction: assignments already started become `past` on
 * the close day; ones that have not started, and open proposals, are rejected (never `to < from`).
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
    const set = started ? { status: 'past' as const, to: today } : { status: 'rejected' as const, decidedAt: now };
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
    await repo.assignments.deleteMany({ projectId: project._id }, { session });
    await repo.projects.deleteMany({ _id: project._id }, { session });
  });
  return { id: projectId };
}
