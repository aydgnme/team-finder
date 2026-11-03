import { z } from 'zod';
import { AssignmentStatus, CapacityTimeline } from './capacity.ts';
import { HOURS_PER_DAY } from './constants.ts';
import { Day } from './dates.ts';
import { Availability, ExclusionReason, Reason, ROLLING_OFF_WEEKS, ScoreTerms } from './matching.ts';
import { ProjectStatus } from './projects.ts';
import { Verdict } from './scenarios.ts';
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
  /** Committed and pending load on other projects (scenario verdict, overbooking while scrubbing). */
  timeline: CapacityTimeline,
});
export type BoardAssignment = z.infer<typeof BoardAssignment>;

export const ProjectBoard = z.object({
  project: z.object({
    id: Id,
    name: z.string(),
    description: z.string(),
    period: z.enum(['fixed', 'ongoing']),
    status: ProjectStatus,
    startDate: Day,
    deadline: Day.nullable(),
    pmId: Id,
    techStack: z.array(Id),
    skillRequirements: z.array(z.object({ skillId: Id, minLevel: z.number().optional() })),
    teamRoles: z.array(z.object({ roleId: Id, count: z.number() })),
  }),
  window: Interval,
  /** Allowed starts for the scrubber (inclusive), `null` once the project has started. */
  scrub: Interval.nullable(),
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
  /** Rank as if the project started on this day (the scrubber); must be inside the scrub range. */
  start: Day.optional(),
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
  /** A proposal to add someone, or a PM's request to end their assignment (Project-05). */
  kind: z.enum(['proposal', 'deallocation']),
  assignmentId: Id,
  version: z.number(),
  user: z.object({ id: Id, name: z.string() }),
  project: z.object({ id: Id, name: z.string() }),
  slotRole: z.object({ id: Id, name: z.string() }),
  hoursPerDay: z.number(),
  from: Day,
  to: Day.nullable(),
  comment: z.string(),
  /** Deallocations: the PM's reason. */
  reason: z.string().nullable(),
  /** Proposals only: would approving fit invariant 1 now? */
  check: ProposalCheckView.nullable(),
});
export type ApprovalItem = z.infer<typeof ApprovalItem>;

export const ApprovalsResponse = z.object({ items: z.array(ApprovalItem) });
export type ApprovalsResponse = z.infer<typeof ApprovalsResponse>;

/** One person a draft adds to the team. */
export const ScenarioAddition = z.object({
  userId: Id,
  slotRoleId: Id,
  roleIds: z.array(Id).max(10).default([]),
  hoursPerDay: z.number().int().min(1).max(HOURS_PER_DAY),
});
export type ScenarioAddition = z.input<typeof ScenarioAddition>;

const Additions = z.array(ScenarioAddition).max(50);

/** POST /api/projects/:id/scenarios/commit: all proposals in one transaction, all-or-nothing. */
export const ScenarioCommitRequest = z.object({
  start: Day,
  additions: Additions,
  comment: z.string().max(500).default(''),
});
export type ScenarioCommitRequest = z.input<typeof ScenarioCommitRequest>;

export const ScenarioCommitResponse = z.object({
  project: z.object({ startDate: Day, deadline: Day.nullable() }),
  created: z.array(AssignmentView),
  /** Existing team assignments moved with the project. */
  moved: z.number(),
});
export type ScenarioCommitResponse = z.infer<typeof ScenarioCommitResponse>;

/** POST /api/snapshots: the client sends only the draft; the server rebuilds everything else. */
export const SnapshotRequest = z.object({ projectId: Id, start: Day, additions: Additions });
export type SnapshotRequest = z.input<typeof SnapshotRequest>;

export const SnapshotCreated = z.object({ id: Id, expiresAt: z.string() });

export const SnapshotView = z.object({
  id: Id,
  createdAt: z.string(),
  expiresAt: z.string(),
  orgName: z.string(),
  isDemo: z.boolean(),
  project: z.object({ name: z.string(), startDate: Day, deadline: Day.nullable() }),
  slots: z.array(
    z.object({
      roleName: z.string(),
      count: z.number(),
      members: z.array(
        z.object({ name: z.string(), hoursPerDay: z.number(), status: z.enum(['active', 'proposed', 'draft']) }),
      ),
    }),
  ),
  missingSkills: z.array(z.string()),
  verdict: Verdict,
  sentence: z.string(),
});
export type SnapshotView = z.infer<typeof SnapshotView>;
