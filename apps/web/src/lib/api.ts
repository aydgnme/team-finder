import {
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
  type ProposeRequest,
  type ScenarioCommitRequest,
  type SnapshotRequest,
  type RankOptions,
} from '@team-finder/domain';
import type { z } from 'zod';

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
  init: { method?: 'GET' | 'POST'; body?: unknown } = {},
): Promise<z.output<S>> {
  const method = init.method ?? 'GET';
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      // Every mutation is JSON (the API answers 415 otherwise), even when there is nothing to send.
      ...(method === 'POST'
        ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(init.body ?? {}) }
        : {}),
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
