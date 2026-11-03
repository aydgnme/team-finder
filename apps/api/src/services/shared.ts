import {
  buildTimeline,
  fail,
  maxDay,
  withProposal,
  type CapacityAssignment,
  type Interval,
  type ProposalCheckView,
} from '@team-finder/domain';
import type { AssignmentDoc, ProjectDoc, UserDoc } from '../db/documents.ts';
import type { DbSession, OrgRepo } from '../db/org-repo.ts';

export const unique = <T>(xs: Iterable<T>): T[] => [...new Set(xs)];

export function groupBy<T, K>(xs: readonly T[], key: (x: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const x of xs) {
    const k = key(x);
    const list = m.get(k);
    if (list) list.push(x);
    else m.set(k, [x]);
  }
  return m;
}

export async function loadProject(repo: OrgRepo, projectId: string, session?: DbSession): Promise<ProjectDoc> {
  return (
    (await repo.projects.findOne({ _id: projectId }, { session })) ??
    fail('NOT_FOUND', { resource: 'project', id: projectId })
  );
}

/**
 * Who may decide on this person's assignments: the manager of their *current* department, resolved
 * at decision time and never stored, so moving someone re-routes their pending items.
 */
export async function approverOf(
  repo: OrgRepo,
  user: Pick<UserDoc, 'departmentId'>,
  session?: DbSession,
): Promise<string | null> {
  if (!user.departmentId) return null;
  const dept = await repo.departments.findOne({ _id: user.departmentId }, { session });
  return dept?.managerId ?? null;
}

/** Project conflict boundary: every assignment-changing transaction writes the project document. */
export async function touchProject(repo: OrgRepo, projectId: string, session: DbSession): Promise<void> {
  await repo.projects.updateOne({ _id: projectId }, { $inc: { version: 1 } }, { session });
}

/** Mongo filter for documents whose `[from, to)` overlaps the interval. */
export function overlapFilter(window: Interval) {
  return {
    $and: [
      window.to === null ? {} : { from: { $lt: window.to } },
      { $or: [{ to: null }, { to: { $gt: window.from } }] },
    ],
  };
}

/**
 * Window an approval is checked over: from the proposal's `from` (bumped to today when already past)
 * to the project deadline (open-ended for ongoing projects).
 */
export function approvalWindow(
  a: Pick<AssignmentDoc, 'from'>,
  project: Pick<ProjectDoc, 'deadline'>,
  today: string,
): Interval {
  return { from: maxDay(a.from, today), to: project.deadline };
}

/** Invariant 1 for one proposal against the person's other capacity-consuming assignments. */
export function checkProposal(
  a: Pick<AssignmentDoc, 'from' | 'hoursPerDay'>,
  project: Pick<ProjectDoc, 'deadline'>,
  others: readonly CapacityAssignment[],
  today: string,
): ProposalCheckView & { window: Interval } {
  const window = approvalWindow(a, project, today);
  const r = withProposal(buildTimeline(others), a.hoursPerDay, window.from, window);
  return { fits: r.fits, worst: r.worst, maxHours: r.maxHours, window };
}
