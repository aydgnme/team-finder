import { z } from 'zod';
import { AssignmentStatus, CapacityTimeline } from './capacity.ts';
import { HOURS_PER_DAY } from './constants.ts';
import { Day } from './dates.ts';
import { Availability, ExclusionReason, Reason, ROLLING_OFF_WEEKS, ScoreTerms } from './matching.ts';
import { AccessRole } from './permissions.ts';

// Request and response shapes shared by apps/api (validation) and apps/web (parsing).

const Id = z.string().min(1);
const Interval = z.object({ from: Day, to: Day.nullable() });

export const Persona = z.object({
  id: Id,
  name: z.string(),
  title: z.string(),
  roles: z.array(AccessRole),
});
export type Persona = z.infer<typeof Persona>;

export const SessionInfo = z.object({
  user: Persona,
  org: z.object({ id: Id, name: z.string(), isDemo: z.boolean(), expiresAt: z.string().nullable() }),
  /** Project the demo lands on (Atlas). */
  landingProjectId: Id.nullable(),
  /** Demo role switcher; empty outside demo orgs. */
  personas: z.array(Persona),
});
export type SessionInfo = z.infer<typeof SessionInfo>;

export const SwitchPersonaRequest = z.object({ userId: Id });

export const ProposalCheckView = z.object({
  fits: z.boolean(),
  worst: z.object({ date: Day, used: z.number() }),
  maxHours: z.number(),
});
export type ProposalCheckView = z.infer<typeof ProposalCheckView>;

export const TargetSkill = z.object({ skillId: Id, level: z.number() });

export const BoardAssignment = z.object({
  id: Id,
  userId: Id,
  userName: z.string(),
  slotRoleId: Id,
  roleIds: z.array(Id),
  status: AssignmentStatus,
  hoursPerDay: z.number(),
  from: Day,
  to: Day.nullable(),
  version: z.number(),
  /** The person's levels on this project's target skills (for the coverage meter). */
  skills: z.array(TargetSkill),
  /** For proposals: would approving it now fit invariant 1? `null` for active ones. */
  check: ProposalCheckView.nullable(),
});
export type BoardAssignment = z.infer<typeof BoardAssignment>;

export const ProjectBoard = z.object({
  project: z.object({
    id: Id,
    name: z.string(),
    description: z.string(),
    period: z.enum(['fixed', 'ongoing']),
    status: z.enum(['notStarted', 'starting', 'inProgress', 'closing', 'closed']),
    startDate: Day,
    deadline: Day.nullable(),
    pmId: Id,
    techStack: z.array(Id),
    skillRequirements: z.array(z.object({ skillId: Id, minLevel: z.number().optional() })),
    teamRoles: z.array(z.object({ roleId: Id, count: z.number() })),
  }),
  window: Interval,
  skills: z.array(z.object({ id: Id, name: z.string() })),
  roles: z.array(z.object({ id: Id, name: z.string() })),
  assignments: z.array(BoardAssignment),
  canStaff: z.boolean(),
});
export type ProjectBoard = z.infer<typeof ProjectBoard>;

const flag = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true')
  .optional();

/** Query string of GET /api/projects/:id/candidates. */
export const CandidatesQuery = z.object({
  includePartial: flag,
  includeUnavailable: flag,
  includeNearMisses: flag,
  includeRollingOffWithinWeeks: z.coerce
    .number()
    .int()
    .min(ROLLING_OFF_WEEKS.min)
    .max(ROLLING_OFF_WEEKS.max)
    .optional(),
});

export const CandidateView = z.object({
  userId: Id,
  name: z.string(),
  title: z.string(),
  score: z.number(),
  terms: ScoreTerms,
  points: ScoreTerms,
  availability: Availability,
  timeline: CapacityTimeline,
  reasons: z.array(Reason),
  nearMiss: z.boolean(),
  hasApprover: z.boolean(),
  skills: z.array(TargetSkill),
});
export type CandidateView = z.infer<typeof CandidateView>;

export const CandidatesResponse = z.object({
  window: Interval,
  candidates: z.array(CandidateView),
  excluded: z.record(ExclusionReason, z.number()),
});
export type CandidatesResponse = z.infer<typeof CandidatesResponse>;

export const ProposeRequest = z.object({
  projectId: Id,
  userId: Id,
  slotRoleId: Id,
  /** Extra informational roles on the team; the slot role is always included. */
  roleIds: z.array(Id).max(10).default([]),
  hoursPerDay: z.number().int().min(1).max(HOURS_PER_DAY),
  from: Day,
  comment: z.string().max(500).default(''),
});
export type ProposeRequest = z.input<typeof ProposeRequest>;

export const AssignmentView = z.object({
  id: Id,
  projectId: Id,
  userId: Id,
  slotRoleId: Id,
  roleIds: z.array(Id),
  status: AssignmentStatus,
  hoursPerDay: z.number(),
  from: Day,
  to: Day.nullable(),
  version: z.number(),
});
export type AssignmentView = z.infer<typeof AssignmentView>;

export const DecisionRequest = z.object({ version: z.number().int().min(0) });

export const ApprovalItem = z.object({
  assignmentId: Id,
  version: z.number(),
  user: z.object({ id: Id, name: z.string() }),
  project: z.object({ id: Id, name: z.string() }),
  slotRole: z.object({ id: Id, name: z.string() }),
  hoursPerDay: z.number(),
  from: Day,
  to: Day.nullable(),
  comment: z.string(),
  check: ProposalCheckView,
});
export type ApprovalItem = z.infer<typeof ApprovalItem>;

export const ApprovalsResponse = z.object({ items: z.array(ApprovalItem) });
export type ApprovalsResponse = z.infer<typeof ApprovalsResponse>;
