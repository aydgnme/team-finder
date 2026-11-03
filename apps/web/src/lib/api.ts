import {
  AiDraftResponse,
  DepartmentProjects,
  NoApproverResponse,
  PersonProjects,
  ProjectDetails,
  DepartmentsResponse,
  ProjectsResponse,
  ProjectSummary,
  SkillsResponse,
  TransitionResponse,
  InviteInfo,
  MembersResponse,
  OrgSettings,
  TeamRoleView,
  TeamRolesResponse,
  AiStatus,
  ApprovalsResponse,
  AssignmentView,
  CandidatesResponse,
  DomainError,
  HealthResponse,
  ProjectBoard,
  ScenarioCommitResponse,
  SessionInfo,
  SnapshotCreated,
  SnapshotView,
  type AccessRole,
  type CreateProjectRequest,
  type Experience,
  type ProjectStatus,
  type UpdateProjectRequest,
  type AiSearchRequest,
  type JoinRequest,
  type LoginRequest,
  type SignUpRequest,
  type ProposeRequest,
  type ScenarioCommitRequest,
  type SnapshotRequest,
  type RankOptions,
} from '@team-finder/domain';
import { z } from 'zod';

/** A non-2xx API response, carrying the `{ code, message, details, hint }` envelope. */
export class ApiError extends Error {
  readonly error: DomainError;
  readonly status: number;
  constructor(error: DomainError, status: number) {
    super(error.message);
    this.name = 'ApiError';
    this.error = error;
    this.status = status;
  }
}

async function request<S extends z.ZodType>(
  schema: S,
  path: string,
  init: { method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; body?: unknown } = {},
): Promise<z.output<S>> {
  const method = init.method ?? 'GET';
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      // Every mutation is JSON (the API answers 415 otherwise), even when there is nothing to send.
      ...(method === 'GET'
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(init.body ?? {}) }),
    });
  } catch {
    throw new ApiError(
      { code: 'DB_UNAVAILABLE', message: 'Could not reach the server.', details: {}, hint: 'Check your connection.' },
      0,
    );
  }
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const parsed = DomainError.safeParse(json);
    throw new ApiError(
      parsed.success
        ? parsed.data
        : {
            code: res.status >= 500 ? 'DB_UNAVAILABLE' : 'INTERNAL',
            message: `Request failed (${res.status}).`,
            details: {},
            hint: 'The server may be waking up; retry in a few seconds.',
          },
      res.status,
    );
  }
  return schema.parse(json);
}

/** Mutations whose answer the UI only needs to have succeeded. */
const Ok = z.unknown();

export type CandidateOptions = Pick<
  RankOptions,
  'includePartial' | 'includeRollingOffWithinWeeks' | 'includeUnavailable' | 'includeNearMisses'
>;

export const api = {
  health: () => request(HealthResponse, '/api/health'),
  session: () => request(SessionInfo, '/api/session'),
  startDemo: () => request(SessionInfo, '/api/demo/sessions', { method: 'POST' }),
  switchPersona: (userId: string) =>
    request(SessionInfo, '/api/demo/sessions/switch', { method: 'POST', body: { userId } }),
  board: (projectId: string) => request(ProjectBoard, `/api/projects/${encodeURIComponent(projectId)}`),
  /** `start`: rank as if the project started then (the scrubber). */
  candidates: (projectId: string, o: CandidateOptions, start?: string) => {
    const q = new URLSearchParams({
      ...(start ? { start } : {}),
      includePartial: String(o.includePartial),
      includeUnavailable: String(o.includeUnavailable),
      includeNearMisses: String(o.includeNearMisses),
      ...(o.includeRollingOffWithinWeeks === null
        ? {}
        : { includeRollingOffWithinWeeks: String(o.includeRollingOffWithinWeeks) }),
    });
    return request(CandidatesResponse, `/api/projects/${encodeURIComponent(projectId)}/candidates?${q}`);
  },
  propose: (body: ProposeRequest) => request(AssignmentView, '/api/assignments', { method: 'POST', body }),
  approve: (id: string, version: number) =>
    request(AssignmentView, `/api/assignments/${encodeURIComponent(id)}/approve`, {
      method: 'POST',
      body: { version },
    }),
  reject: (id: string, version: number) =>
    request(AssignmentView, `/api/assignments/${encodeURIComponent(id)}/reject`, { method: 'POST', body: { version } }),
  approvals: () => request(ApprovalsResponse, '/api/approvals'),
  commitScenario: (projectId: string, body: ScenarioCommitRequest) =>
    request(ScenarioCommitResponse, `/api/projects/${encodeURIComponent(projectId)}/scenarios/commit`, {
      method: 'POST',
      body,
    }),
  createSnapshot: (body: SnapshotRequest) => request(SnapshotCreated, '/api/snapshots', { method: 'POST', body }),
  snapshot: (id: string) => request(SnapshotView, `/api/snapshots/${encodeURIComponent(id)}`),
  signUp: (body: SignUpRequest) => request(SessionInfo, '/api/auth/signup', { method: 'POST', body }),
  login: (body: LoginRequest) => request(SessionInfo, '/api/auth/login', { method: 'POST', body }),
  logout: () => request(z.object({ ok: z.boolean() }), '/api/auth/logout', { method: 'POST' }),
  invite: (token: string) => request(InviteInfo, '/api/invites/lookup', { method: 'POST', body: { token } }),
  join: (body: JoinRequest) => request(SessionInfo, '/api/invites/join', { method: 'POST', body }),
  org: () => request(OrgSettings, '/api/org'),
  regenerateInvite: () => request(OrgSettings, '/api/org/invite', { method: 'POST' }),
  members: () => request(MembersResponse, '/api/org/members'),
  setRoles: (userId: string, roles: AccessRole[]) =>
    request(
      z.object({ id: z.string(), roles: z.array(z.string()) }),
      `/api/org/members/${encodeURIComponent(userId)}/roles`,
      {
        method: 'PUT',
        body: { roles },
      },
    ),
  teamRoles: () => request(TeamRolesResponse, '/api/team-roles'),
  createTeamRole: (name: string) => request(TeamRoleView, '/api/team-roles', { method: 'POST', body: { name } }),
  renameTeamRole: (id: string, name: string) =>
    request(TeamRoleView, `/api/team-roles/${encodeURIComponent(id)}`, { method: 'PATCH', body: { name } }),
  deleteTeamRole: (id: string) =>
    request(z.object({ id: z.string() }), `/api/team-roles/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  projects: () => request(ProjectsResponse, '/api/projects'),
  createProject: (body: CreateProjectRequest) => request(ProjectSummary, '/api/projects', { method: 'POST', body }),
  updateProject: (id: string, body: UpdateProjectRequest) =>
    request(ProjectSummary, `/api/projects/${encodeURIComponent(id)}`, { method: 'PATCH', body }),
  setProjectStatus: (id: string, status: ProjectStatus) =>
    request(TransitionResponse, `/api/projects/${encodeURIComponent(id)}/status`, { method: 'POST', body: { status } }),
  deleteProject: (id: string) => request(Ok, `/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  departments: () => request(DepartmentsResponse, '/api/departments'),
  createDepartment: (name: string) => request(Ok, '/api/departments', { method: 'POST', body: { name } }),
  renameDepartment: (id: string, name: string) =>
    request(Ok, `/api/departments/${encodeURIComponent(id)}`, { method: 'PATCH', body: { name } }),
  deleteDepartment: (id: string) => request(Ok, `/api/departments/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  setManager: (id: string, managerId: string | null) =>
    request(Ok, `/api/departments/${encodeURIComponent(id)}/manager`, { method: 'PUT', body: { managerId } }),
  addMember: (id: string, userId: string) =>
    request(Ok, `/api/departments/${encodeURIComponent(id)}/members`, { method: 'POST', body: { userId } }),
  removeMember: (id: string, userId: string) =>
    request(Ok, `/api/departments/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`, {
      method: 'DELETE',
    }),
  skills: () => request(SkillsResponse, '/api/skills'),
  createCategory: (name: string) => request(Ok, '/api/skill-categories', { method: 'POST', body: { name } }),
  deleteCategory: (id: string) => request(Ok, `/api/skill-categories/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  createSkill: (body: { name: string; description: string; categoryId: string; departmentIds: string[] }) =>
    request(Ok, '/api/skills', { method: 'POST', body }),
  updateSkill: (id: string, body: { name: string; description: string; categoryId: string; departmentIds: string[] }) =>
    request(Ok, `/api/skills/${encodeURIComponent(id)}`, { method: 'PUT', body }),
  deleteSkill: (id: string) => request(Ok, `/api/skills/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  setMySkill: (skillId: string, level: number, experience: Experience) =>
    request(Ok, `/api/me/skills/${encodeURIComponent(skillId)}`, { method: 'PUT', body: { level, experience } }),
  removeMySkill: (skillId: string) =>
    request(Ok, `/api/me/skills/${encodeURIComponent(skillId)}`, { method: 'DELETE' }),
  projectDetails: (id: string) => request(ProjectDetails, `/api/projects/${encodeURIComponent(id)}/details`),
  personProjects: (id: string) => request(PersonProjects, `/api/people/${encodeURIComponent(id)}/projects`),
  departmentProjects: (id: string, status?: string) =>
    request(
      DepartmentProjects,
      `/api/departments/${encodeURIComponent(id)}/projects${status ? `?status=${encodeURIComponent(status)}` : ''}`,
    ),
  noApprover: () => request(NoApproverResponse, '/api/org/no-approver'),
  deallocate: (assignmentId: string, version: number, reason: string) =>
    request(AssignmentView, `/api/assignments/${encodeURIComponent(assignmentId)}/deallocate`, {
      method: 'POST',
      body: { version, reason },
    }),
  aiStatus: () => request(AiStatus, '/api/ai/status'),
  aiSearch: (body: AiSearchRequest) => request(AiDraftResponse, '/api/ai/search', { method: 'POST', body }),
};

/** The one place errors become user-facing text: message plus hint. */
export function toErrorMessage(error: unknown): string {
  if (error instanceof ApiError) return `${error.error.message} ${error.error.hint}`;
  if (error instanceof Error) return error.message;
  return 'Something went wrong.';
}

export function errorCode(error: unknown): DomainError['code'] | null {
  return error instanceof ApiError ? error.error.code : null;
}
