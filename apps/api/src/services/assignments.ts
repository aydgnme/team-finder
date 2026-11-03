import {
  can,
  CapacityError,
  CAPACITY_CONSUMING_STATUSES,
  containsDay,
  evaluationWindow,
  fail,
  isEmptyInterval,
  NON_TERMINAL_STATUSES,
  ProposeRequest,
  type AssignmentStatus,
  type AssignmentView,
} from '@team-finder/domain';
import type { z } from 'zod';
import type { AssignmentDoc, ProjectDoc } from '../db/documents.ts';
import type { DbSession } from '../db/org-repo.ts';
import type { ServiceContext } from './context.ts';
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

  if (!(await approverOf(repo, user, session))) fail('NO_APPROVER', { userId: user._id, slotRoleId });

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

  return repo.assignments.insertOne(
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

/** Loads a proposal and checks the caller is its approver *now* and that the client saw the latest version. */
async function loadDecision(ctx: ServiceContext, assignmentId: string, version: number, session: DbSession) {
  const { repo, actor } = ctx;
  const a = await repo.assignments.findOne({ _id: assignmentId }, { session });
  if (!a) fail('NOT_FOUND', { resource: 'proposal', id: assignmentId });
  const user = await repo.users.findOne({ _id: a.userId }, { session });
  const approverId = user ? await approverOf(repo, user, session) : null;
  if (!can(actor, 'assignment.decide', { orgId: repo.orgId, approverId })) {
    fail('FORBIDDEN', { action: 'decide on this proposal' });
  }
  if (a.status !== 'proposed') {
    const status = DECIDED_WORD[a.status];
    fail('CONFLICT_STALE', { resource: 'proposal', id: a._id, ...(status ? { status } : {}) });
  }
  if (a.version !== version) fail('CONFLICT_STALE', { resource: 'proposal', id: a._id });
  return a;
}

/**
 * proposed -> active (invariant 2). Inside one transaction: read the person's capacity-consuming
 * assignments, re-check invariant 1 with withProposal(buildTimeline(...)), update with a version
 * check, bump users.capacityVersion and touchProject(). Two approvals of *different* proposals for
 * the same person both write the user document, so one hits a write conflict; the driver replays it,
 * the replay sees the other approval and throws CapacityError (409 CAPACITY_EXCEEDED).
 */
export async function approve(ctx: ServiceContext, assignmentId: string, version: number): Promise<AssignmentView> {
  const { repo, actor, today, now } = ctx;
  return repo.withTransaction(async (session) => {
    const a = await loadDecision(ctx, assignmentId, version, session);
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

    const from = check.window.from;
    const updated = await repo.assignments.updateOne(
      { _id: a._id, status: 'proposed', version: a.version },
      { $set: { status: 'active', from, to, approverId: actor.userId, decidedAt: now }, $inc: { version: 1 } },
      { session },
    );
    if (updated.matchedCount !== 1) fail('CONFLICT_STALE', { resource: 'proposal', id: a._id });
    await repo.users.updateOne({ _id: a.userId }, { $inc: { capacityVersion: 1 } }, { session });
    await touchProject(repo, a.projectId, session);
    return toAssignmentView({ ...a, status: 'active', from, to, approverId: actor.userId, version: a.version + 1 });
  });
}

/** proposed -> rejected. */
export async function reject(ctx: ServiceContext, assignmentId: string, version: number): Promise<AssignmentView> {
  const { repo, actor, now } = ctx;
  return repo.withTransaction(async (session) => {
    const a = await loadDecision(ctx, assignmentId, version, session);
    const updated = await repo.assignments.updateOne(
      { _id: a._id, status: 'proposed', version: a.version },
      { $set: { status: 'rejected', approverId: actor.userId, decidedAt: now }, $inc: { version: 1 } },
      { session },
    );
    if (updated.matchedCount !== 1) fail('CONFLICT_STALE', { resource: 'proposal', id: a._id });
    await touchProject(repo, a.projectId, session);
    return toAssignmentView({ ...a, status: 'rejected', approverId: actor.userId, version: a.version + 1 });
  });
}
