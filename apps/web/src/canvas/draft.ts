import {
  addDays,
  compareScenarios,
  withProposal,
  type BoardAssignment,
  type CandidateView,
  type Day,
  type Interval,
  type ProjectBoard,
  type ScenarioMember,
  type Verdict,
} from '@team-finder/domain';

// The draft (B) lives in React state only: lost on reload by design, guarded by beforeunload
// (docs/design.md, "E1 Scenarios"). A is always the current team at the current start.

export interface DraftAddition {
  candidate: CandidateView;
  slotRoleId: string;
  roleIds: string[];
  hoursPerDay: number;
}

export interface Draft {
  start: Day;
  additions: DraftAddition[];
}

export const isDirty = (board: ProjectBoard, draft: Draft | null): draft is Draft =>
  draft !== null && (draft.additions.length > 0 || draft.start !== board.project.startDate);

const memberOfAssignment = (a: BoardAssignment): ScenarioMember => ({
  userId: a.userId,
  slotRoleId: a.slotRoleId,
  hoursPerDay: a.hoursPerDay,
  skills: a.skills,
  timeline: a.timeline,
});

const memberOfAddition = (a: DraftAddition): ScenarioMember => ({
  userId: a.candidate.userId,
  slotRoleId: a.slotRoleId,
  hoursPerDay: a.hoursPerDay,
  skills: a.candidate.skills,
  timeline: a.candidate.timeline,
});

/** Same pure function the snapshot endpoint runs server-side, so the shared verdict matches. */
export function verdictFor(board: ProjectBoard, draft: Draft, today: Day): Verdict {
  const current = board.assignments.map(memberOfAssignment);
  return compareScenarios(
    board.project,
    { start: board.project.startDate, members: current },
    { start: draft.start, members: [...current, ...draft.additions.map(memberOfAddition)] },
    today,
  );
}

export const DRAFT_ID_PREFIX = 'draft-';

/** A draft addition shown in a slot, checked against the draft's window. */
export function draftAssignment(a: DraftAddition, window: Interval): BoardAssignment {
  const check = withProposal(a.candidate.timeline, a.hoursPerDay, window.from, window);
  return {
    id: `${DRAFT_ID_PREFIX}${a.candidate.userId}`,
    userId: a.candidate.userId,
    userName: a.candidate.name,
    slotRoleId: a.slotRoleId,
    roleIds: [a.slotRoleId, ...a.roleIds],
    status: 'proposed',
    hoursPerDay: a.hoursPerDay,
    from: window.from,
    to: window.to,
    version: 0,
    skills: a.candidate.skills,
    check: { fits: check.fits, worst: check.worst, maxHours: check.maxHours },
    timeline: a.candidate.timeline,
  };
}

/**
 * Board members move with the project when the draft changes the start; proposals are re-checked
 * against the moved window so a conflict line names the right date.
 */
export function shiftedAssignment(a: BoardAssignment, deltaDays: number, window: Interval): BoardAssignment {
  if (deltaDays === 0) return a;
  const from = addDays(a.from, deltaDays);
  const moved = { ...a, from, to: a.to === null ? null : addDays(a.to, deltaDays) };
  if (a.status !== 'proposed') return moved;
  const check = withProposal(a.timeline, a.hoursPerDay, from, window);
  return { ...moved, check: { fits: check.fits, worst: check.worst, maxHours: check.maxHours } };
}
