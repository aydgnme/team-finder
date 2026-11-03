import { z } from 'zod';
import { HOURS_PER_DAY } from './constants.ts';
import { Day } from './dates.ts';
import { Experience, SkillLevel } from './matching.ts';

// Organization data (docs/plans/m3-organization-data.md): projects and their lifecycle,
// departments, skills. Request and view shapes shared by the API and the web app.

export const ProjectStatus = z.enum(['notStarted', 'starting', 'inProgress', 'closing', 'closed']);
export type ProjectStatus = z.infer<typeof ProjectStatus>;

/** A project may only be created in one of these (SRS Project-01). */
export const INITIAL_STATUSES = ['notStarted', 'starting'] as const satisfies ProjectStatus[];
const ORDER = ProjectStatus.options;
/** Entering one of these marks the project as having been active: it can no longer be deleted. */
const ACTIVE_STATUSES: readonly ProjectStatus[] = ['inProgress', 'closing', 'closed'];

export type Transition = { ok: true; status: ProjectStatus; everActive: boolean } | { ok: false };

/**
 * The one place project status changes and `everActive` is set (design.md, data model). Forward
 * only along notStarted → starting → inProgress → closing → closed; skipping ahead is allowed,
 * going back or staying put is not; closed is final.
 */
export function transitionProject(
  project: { status: ProjectStatus; everActive: boolean },
  next: ProjectStatus,
): Transition {
  if (ORDER.indexOf(next) <= ORDER.indexOf(project.status)) return { ok: false };
  return { ok: true, status: next, everActive: project.everActive || ACTIVE_STATUSES.includes(next) };
}

/** Statuses a project can move to from `status`, in order. */
export function nextStatuses(status: ProjectStatus): ProjectStatus[] {
  return ORDER.slice(ORDER.indexOf(status) + 1);
}

const Id = z.string().min(1);
const Name = z.string().trim().min(2, 'Use at least 2 characters').max(100);
const TeamRoles = z
  .array(z.object({ roleId: Id, count: z.number().int().min(1).max(20) }))
  .max(20)
  .refine((rs) => new Set(rs.map((r) => r.roleId)).size === rs.length, 'Each team role can appear once');
const TechStack = z.array(Id).max(30);

const datesValid = (p: { period: 'fixed' | 'ongoing'; startDate: string; deadline: string | null }) =>
  p.period === 'ongoing' ? p.deadline === null : p.deadline !== null && p.deadline > p.startDate;
const DATES_MESSAGE = 'A fixed project needs a deadline after its start; an ongoing one has none';

export const CreateProjectRequest = z
  .object({
    name: Name,
    description: z.string().trim().max(2000).default(''),
    period: z.enum(['fixed', 'ongoing']),
    startDate: Day,
    deadline: Day.nullable(),
    status: z.enum(INITIAL_STATUSES).default('notStarted'),
    techStack: TechStack.default([]),
    teamRoles: TeamRoles.default([]),
  })
  .refine(datesValid, { message: DATES_MESSAGE, path: ['deadline'] });
export type CreateProjectRequest = z.input<typeof CreateProjectRequest>;

/** Everything optional; dates may only change while nobody is on the team (M3a; clamp in M3b). */
export const UpdateProjectRequest = z.object({
  name: Name.optional(),
  description: z.string().trim().max(2000).optional(),
  techStack: TechStack.optional(),
  teamRoles: TeamRoles.optional(),
  startDate: Day.optional(),
  deadline: Day.nullable().optional(),
});
export type UpdateProjectRequest = z.input<typeof UpdateProjectRequest>;

export const TransitionRequest = z.object({ status: ProjectStatus });

export const ProjectSummary = z.object({
  id: Id,
  name: z.string(),
  description: z.string(),
  period: z.enum(['fixed', 'ongoing']),
  status: ProjectStatus,
  startDate: Day,
  deadline: Day.nullable(),
  everActive: z.boolean(),
  pm: z.object({ id: Id, name: z.string() }),
  techStack: z.array(Id),
  teamRoles: z.array(z.object({ roleId: Id, count: z.number() })),
  /** People holding a slot (proposed, active or deallocation proposed) vs total slots. */
  slots: z.object({ filled: z.number(), total: z.number() }),
  canEdit: z.boolean(),
});
export type ProjectSummary = z.infer<typeof ProjectSummary>;
export const ProjectsResponse = z.object({ projects: z.array(ProjectSummary), canCreate: z.boolean() });

export const CloseReport = z.object({ ended: z.number(), rejected: z.number() });
export const TransitionResponse = z.object({ project: ProjectSummary, closed: CloseReport.nullable() });

// ---- departments (Department-01..03) ----

const PersonRef = z.object({ id: Id, name: z.string(), title: z.string() });
export const DepartmentView = z.object({
  id: Id,
  name: z.string(),
  manager: PersonRef.nullable(),
  members: z.array(PersonRef),
  canManageMembers: z.boolean(),
});
export type DepartmentView = z.infer<typeof DepartmentView>;
export const DepartmentsResponse = z.object({
  departments: z.array(DepartmentView),
  unassigned: z.array(PersonRef),
  /** People who can be picked as a manager: hold deptManager and manage no other department. */
  managerCandidates: z.array(PersonRef),
  canManage: z.boolean(),
});
export type DepartmentsResponse = z.infer<typeof DepartmentsResponse>;
export const DepartmentRequest = z.object({ name: Name });
export const SetManagerRequest = z.object({ managerId: Id.nullable() });
export const MemberRequest = z.object({ userId: Id });

// ---- skills (Skill-01/02) ----

export const CategoryView = z.object({ id: Id, name: z.string(), inUse: z.boolean() });
export const SkillView = z.object({
  id: Id,
  name: z.string(),
  description: z.string(),
  categoryId: Id,
  author: z.object({ id: Id, name: z.string() }).nullable(),
  departmentIds: z.array(Id),
  inUse: z.boolean(),
  canEdit: z.boolean(),
});
export type SkillView = z.infer<typeof SkillView>;
export const MySkill = z.object({ skillId: Id, level: SkillLevel, experience: Experience, validated: z.boolean() });
export type MySkill = z.infer<typeof MySkill>;
export const SkillsResponse = z.object({
  categories: z.array(CategoryView),
  skills: z.array(SkillView),
  mine: z.array(MySkill),
  canCreate: z.boolean(),
});
export type SkillsResponse = z.infer<typeof SkillsResponse>;
export const CategoryRequest = z.object({ name: Name });
export const SkillRequest = z.object({
  name: Name,
  description: z.string().trim().max(1000).default(''),
  categoryId: Id,
  departmentIds: z.array(Id).max(50).default([]),
});
export const SetMySkillRequest = z.object({ level: SkillLevel, experience: Experience });

/** Hours are bounded by the day, whatever a request says (shared with M3b deallocation). */
export const MAX_HOURS = HOURS_PER_DAY;
