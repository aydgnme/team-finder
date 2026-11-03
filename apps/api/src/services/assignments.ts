import {
  can,
  CapacityError,
  CAPACITY_CONSUMING_STATUSES,
  containsDay,
  evaluationWindow,
  fail,
  isEmptyInterval,
  maxDay,
  NON_TERMINAL_STATUSES,
  ProposeRequest,
  type AssignmentStatus,
  type AssignmentView,
} from '@team-finder/domain';
import type { z } from 'zod';
import type { AssignmentDoc, ProjectDoc } from '../db/documents.ts';
import type { DbSession } from '../db/org-repo.ts';
import type { ServiceContext } from './context.ts';
import { notify } from './notifications.ts';
import {
  approvalWindow,
  approverOf,
  checkProposal,
  loadProject,
  overlapFilter,
  touchProject,
  unique,
} from './shared.ts';

export function toAssignmentView(a: AssignmentDoc): AssignmentView {
  return {
    id: a._id,
    projectId: a.projectId,
    userId: a.userId,
    slotRoleId: a.slotRoleId,
    roleIds: a.roleIds,
    status: a.status,
    hoursPerDay: a.hoursPerDay,
    from: a.from,
    to: a.to,
    version: a.version,
  };
}

export const invalid = (path: string, message: string): never => fail('VALIDATION', { issues: [{ path, message }] });

export interface ProposalInput {
  userId: string;
  slotRoleId: string;
  roleIds: readonly string[];
  hoursPerDay: number;
  from: string;
  comment: string;
}

/**
 * The checks and insert behind every new proposal (single propose and scenario commit). Must run
 * inside a transaction that ends with touchProject(); every read uses the session, so a scenario's
 * earlier inserts count toward the slot limit and the duplicate check. `slotRoleId` is attached to
 * every failure so a scenario commit can name the slot that failed.
 */
export async function insertProposal(
  ctx: ServiceContext,
  project: ProjectDoc,
  input: ProposalInput,
  session: DbSession,
): Promise<AssignmentDoc> {
  const { repo, actor, today, now } = ctx;
  const slot = project.teamRoles.find((r) => r.roleId === input.slotRoleId);
  if (!slot) invalid('slotRoleId', 'is not a role slot of this project');
  const slotRoleId = slot!.roleId;
  const roleIds = unique([slotRoleId, ...input.roleIds]);
  await repo.assertOwned('teamRoles', roleIds, { session });

  const user = await repo.users.findOne({ _id: input.userId }, { session });
  if (!user) fail('NOT_FOUND', { resource: 'user', id: input.userId, slotRoleId });

  const window = evaluationWindow(project, today);
  if (isEmptyInterval(window)) invalid('projectId', 'project has already ended');
  if (!containsDay(window, input.from)) {
    invalid('from', `must be inside the project window [${window.from}, ${window.to ?? 'open-ended'})`);
  }

  const approverId = await approverOf(repo, user, session);
  if (!approverId) fail('NO_APPROVER', { userId: user._id, slotRoleId });

  const existing = await repo.assignments.findOne(
    { userId: user._id, projectId: project._id, status: { $in: [...NON_TERMINAL_STATUSES] } },
    { session },
  );
  if (existing) {
    fail('DUPLICATE_ASSIGNMENT', { userId: user._id, projectId: project._id, assignmentId: existing._id, slotRoleId });
  }

  const taken = await repo.assignments.countDocuments(
    { projectId: project._id, slotRoleId, status: { $in: [...NON_TERMINAL_STATUSES] } },
    { session },
  );
  if (taken >= slot!.count) fail('SLOT_FULL', { roleId: slotRoleId, count: slot!.count, slotRoleId });

  const doc = await repo.assignments.insertOne(
    {
      userId: user._id,
      projectId: project._id,
      hoursPerDay: input.hoursPerDay,
      slotRoleId,
      roleIds,
      status: 'proposed',
      from: input.from,
      to: project.period === 'fixed' ? project.deadline : null,
      comments: input.comment,
      approverId: null,
      proposedBy: actor.userId,
      version: 0,
      createdAt: now,
    },
    { session },
  );
  await notify(ctx, session, [
    {
      userId: approverId,
      type: 'assignmentProposed',
      refId: doc._id,
      data: { personName: user.name, projectId: project._id, projectName: project.name },
    },
  ]);
  return doc;
}

/**
 * (none) -> proposed. Runs in a transaction that ends with touchProject(), so two concurrent
 * proposals for the same project conflict and the replay re-checks the slot limit and duplicates.
 * Proposals do not consume capacity; the approve transaction enforces invariant 1.
 */
export async function propose(ctx: ServiceContext, input: z.output<typeof ProposeRequest>): Promise<AssignmentView> {
  const { repo, actor } = ctx;
  return repo.withTransaction(async (session) => {
    const project = await loadProject(repo, input.projectId, session);
    if (!can(actor, 'project.staff', { orgId: project.orgId, pmId: project.pmId })) {
      fail('FORBIDDEN', { action: 'propose people for this project' });
    }
    const doc = await insertProposal(ctx, project, input, session);
    await touchProject(repo, project._id, session);
    return toAssignmentView(doc);
  });
}

const DECIDED_WORD: Partial<Record<AssignmentStatus, string>> = {
  active: 'approved',
  rejected: 'rejected',
  past: 'closed',
  deallocationProposed: 'approved',
};

/**
 * Loads a pending decision (a proposal, or a requested deallocation) and checks the caller is the
 * person's approver *now* and that the client saw the latest version.
 */
async function loadDecision(ctx: ServiceContext, assignmentId: string, version: number, session: DbSession) {
  const { repo, actor } = ctx;
  const a = await repo.assignments.findOne({ _id: assignmentId }, { session });
  if (!a) fail('NOT_FOUND', { resource: 'proposal', id: assignmentId });
  const user = await repo.users.findOne({ _id: a.userId }, { session });
  const approverId = user ? await approverOf(repo, user, session) : null;
  if (!can(actor, 'assignment.decide', { orgId: repo.orgId, approverId })) {
    fail('FORBIDDEN', { action: 'decide on this proposal' });
  }
  if (a.status !== 'proposed' && a.status !== 'deallocationProposed') {
    const status = DECIDED_WORD[a.status];
    fail('CONFLICT_STALE', { resource: 'proposal', id: a._id, ...(status ? { status } : {}) });
  }
  if (a.version !== version) fail('CONFLICT_STALE', { resource: 'proposal', id: a._id });
  return a;
}

/** proposalDecided goes to whoever asked: the proposer, or the project's PM for a deallocation. */
async function notifyDecided(
  ctx: ServiceContext,
  session: DbSession,
  a: AssignmentDoc,
  decision: 'approved' | 'rejected',
): Promise<void> {
  const kind = a.status === 'deallocationProposed' ? 'deallocation' : 'proposal';
  const [user, project] = await Promise.all([
    ctx.repo.users.findOne({ _id: a.userId }, { session, projection: { name: 1 } }),
    ctx.repo.projects.findOne({ _id: a.projectId }, { session, projection: { name: 1, pmId: 1 } }),
  ]);
  await notify(ctx, session, [
    {
      userId: kind === 'deallocation' ? (project?.pmId ?? null) : a.proposedBy,
      type: 'proposalDecided',
      refId: a._id,
      data: {
        personName: user?.name ?? 'someone',
        projectId: a.projectId,
        projectName: project?.name ?? 'a project',
        decision,
        kind,
      },
    },
  ]);
}

/**
 * deallocationProposed -> past (Project-05): the work ends today (or at its earlier end), the hours
 * are freed, and the person's capacityVersion is bumped like any capacity change.
 */
async function approveDeallocation(ctx: ServiceContext, a: AssignmentDoc, session: DbSession): Promise<AssignmentView> {
  const { repo, actor, today, now } = ctx;
  const to = a.to !== null && a.to < today ? a.to : maxDay(today, a.from);
  const updated = await repo.assignments.updateOne(
    { _id: a._id, status: 'deallocationProposed', version: a.version },
    { $set: { status: 'past', to, approverId: actor.userId, decidedAt: now }, $inc: { version: 1 } },
    { session },
  );
  if (updated.matchedCount !== 1) fail('CONFLICT_STALE', { resource: 'proposal', id: a._id });
  await repo.users.updateOne({ _id: a.userId }, { $inc: { capacityVersion: 1 } }, { session });
  await touchProject(repo, a.projectId, session);
  await notifyDecided(ctx, session, a, 'approved');
  return toAssignmentView({ ...a, status: 'past', to, version: a.version + 1 });
}

/** deallocationProposed -> active: the manager keeps the person on the project. */
async function rejectDeallocation(ctx: ServiceContext, a: AssignmentDoc, session: DbSession): Promise<AssignmentView> {
  const { repo, actor, now } = ctx;
  const updated = await repo.assignments.updateOne(
    { _id: a._id, status: 'deallocationProposed', version: a.version },
    {
      $set: { status: 'active', deallocationReason: null, approverId: actor.userId, decidedAt: now },
      $inc: { version: 1 },
    },
    { session },
  );
  if (updated.matchedCount !== 1) fail('CONFLICT_STALE', { resource: 'proposal', id: a._id });
  await touchProject(repo, a.projectId, session);
  await notifyDecided(ctx, session, a, 'rejected');
  return toAssignmentView({ ...a, status: 'active', version: a.version + 1 });
}

/**
 * active -> deallocationProposed (Project-04): the project's PM asks to end someone's work, with a
 * reason. Hours stay booked until the department manager agrees.
 */
export async function proposeDeallocation(ctx: ServiceContext, assignmentId: string, version: number, reason: string) {
  const { repo, actor } = ctx;
  return repo.withTransaction(async (session) => {
    const a = await repo.assignments.findOne({ _id: assignmentId }, { session });
    if (!a) fail('NOT_FOUND', { resource: 'assignment', id: assignmentId });
    const project = await loadProject(repo, a!.projectId, session);
    if (!can(actor, 'project.staff', { orgId: project.orgId, pmId: project.pmId })) {
      fail('FORBIDDEN', { action: 'end assignments on this project' });
    }
    if (a!.status !== 'active') invalid('status', 'only active assignments can be ended');
    if (a!.version !== version) fail('CONFLICT_STALE', { resource: 'assignment', id: a!._id });
    await repo.assignments.updateOne(
      { _id: a!._id, status: 'active', version },
      { $set: { status: 'deallocationProposed', deallocationReason: reason }, $inc: { version: 1 } },
      { session },
    );
    await touchProject(repo, project._id, session);
    const user = await repo.users.findOne({ _id: a!.userId }, { session });
    await notify(ctx, session, [
      {
        userId: user ? await approverOf(repo, user, session) : null,
        type: 'deallocationProposed',
        refId: a!._id,
        data: { personName: user?.name ?? 'someone', projectId: project._id, projectName: project.name },
      },
    ]);
    return toAssignmentView({ ...a!, status: 'deallocationProposed', version: version + 1 });
  });
}

/**
 * proposed -> active (invariant 2). Inside one transaction: read the person's capacity-consuming
 * assignments, re-check invariant 1 with withProposal(buildTimeline(...)), update with a version
 * check, bump users.capacityVersion and touchProject(). Two approvals of *different* proposals for
 * the same person both write the user document, so one hits a write conflict; the driver replays it,
 * the replay sees the other approval and throws CapacityError (409 CAPACITY_EXCEEDED).
 */
export interface ApproveOptions {
  /**
   * Called on every transaction attempt after capacity was read and checked, right before the first
   * write. Only the "Watch the race" demo passes it (to hold both approvals at a barrier); production
   * passes nothing, so the demo proves this exact code path.
   */
  afterRead?: () => Promise<void>;
}

export async function approve(
  ctx: ServiceContext,
  assignmentId: string,
  version: number,
  options: ApproveOptions = {},
): Promise<AssignmentView> {
  const { repo, actor, today, now } = ctx;
  return repo.withTransaction(async (session) => {
    const a = await loadDecision(ctx, assignmentId, version, session);
    if (a.status === 'deallocationProposed') return approveDeallocation(ctx, a, session);
    const project = await loadProject(repo, a.projectId, session);
    const to = project.period === 'fixed' ? project.deadline : null;
    const others = await repo.assignments.find(
      {
        userId: a.userId,
        _id: { $ne: a._id },
        status: { $in: [...CAPACITY_CONSUMING_STATUSES] },
        ...overlapFilter(approvalWindow(a, project, today)),
      },
      { session },
    );
    const check = checkProposal(a, project, others, today);
    if (isEmptyInterval(check.window)) invalid('assignmentId', 'the project has already ended');
    if (!check.fits) {
      throw new CapacityError({
        userId: a.userId,
        date: check.worst.date,
        used: check.worst.used,
        requested: a.hoursPerDay,
        maxHours: check.maxHours,
      });
    }
    await options.afterRead?.();

    const from = check.window.from;
    const updated = await repo.assignments.updateOne(
      { _id: a._id, status: 'proposed', version: a.version },
      { $set: { status: 'active', from, to, approverId: actor.userId, decidedAt: now }, $inc: { version: 1 } },
      { session },
    );
    if (updated.matchedCount !== 1) fail('CONFLICT_STALE', { resource: 'proposal', id: a._id });
    await repo.users.updateOne({ _id: a.userId }, { $inc: { capacityVersion: 1 } }, { session });
    await touchProject(repo, a.projectId, session);
    await notifyDecided(ctx, session, a, 'approved');
    return toAssignmentView({ ...a, status: 'active', from, to, approverId: actor.userId, version: a.version + 1 });
  });
}

/** proposed -> rejected. */
export async function reject(ctx: ServiceContext, assignmentId: string, version: number): Promise<AssignmentView> {
  const { repo, actor, now } = ctx;
  return repo.withTransaction(async (session) => {
    const a = await loadDecision(ctx, assignmentId, version, session);
    if (a.status === 'deallocationProposed') return rejectDeallocation(ctx, a, session);
    const updated = await repo.assignments.updateOne(
      { _id: a._id, status: 'proposed', version: a.version },
      { $set: { status: 'rejected', approverId: actor.userId, decidedAt: now }, $inc: { version: 1 } },
      { session },
    );
    if (updated.matchedCount !== 1) fail('CONFLICT_STALE', { resource: 'proposal', id: a._id });
    await touchProject(repo, a.projectId, session);
    await notifyDecided(ctx, session, a, 'rejected');
    return toAssignmentView({ ...a, status: 'rejected', approverId: actor.userId, version: a.version + 1 });
  });
}
