import { z } from 'zod';

/**
 * One error envelope `{ code, message, details, hint }` for every non-2xx API response
 * (docs/design.md, Phase 3.5 DX #5). `details` is typed per code, so clients can render exact reasons.
 */
const envelope = <C extends string, D extends z.ZodType>(code: C, details: D) =>
  z.object({ code: z.literal(code), message: z.string(), details, hint: z.string() });

const none = z.object({}).strict();

export const DomainError = z.discriminatedUnion('code', [
  envelope('VALIDATION', z.object({ issues: z.array(z.object({ path: z.string(), message: z.string() })) })),
  envelope('UNAUTHENTICATED', none),
  envelope('FORBIDDEN', z.object({ action: z.string().optional() })),
  envelope('NOT_FOUND', z.object({ resource: z.string().optional(), id: z.string().optional() })),
  envelope('CONFLICT_STALE', z.object({ resource: z.string(), id: z.string(), status: z.string().optional() })),
  envelope('DUPLICATE_ASSIGNMENT', z.object({ userId: z.string(), projectId: z.string(), assignmentId: z.string() })),
  envelope('SLOT_FULL', z.object({ roleId: z.string(), count: z.number() })),
  envelope('NO_APPROVER', z.object({ userId: z.string() })),
  envelope(
    'CAPACITY_EXCEEDED',
    z.object({ userId: z.string(), date: z.string(), used: z.number(), requested: z.number(), maxHours: z.number() }),
  ),
  envelope('UNSUPPORTED_MEDIA_TYPE', z.object({ contentType: z.string().optional() })),
  envelope('DB_UNAVAILABLE', none),
  envelope('AI_UNAVAILABLE', none),
  envelope('RATE_LIMITED', z.object({ retryAfterSeconds: z.number() })),
  envelope('INTERNAL', z.object({ requestId: z.string().optional() })),
]);
export type DomainError = z.infer<typeof DomainError>;
export type ErrorCode = DomainError['code'];
export type ErrorDetails<C extends ErrorCode> = Extract<DomainError, { code: C }>['details'];

export const HTTP_STATUS: Record<ErrorCode, number> = {
  VALIDATION: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT_STALE: 409,
  DUPLICATE_ASSIGNMENT: 409,
  SLOT_FULL: 409,
  NO_APPROVER: 409,
  CAPACITY_EXCEEDED: 409,
  UNSUPPORTED_MEDIA_TYPE: 415,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  DB_UNAVAILABLE: 503,
  AI_UNAVAILABLE: 503,
};

type Texts<C extends ErrorCode> = (details: ErrorDetails<C>) => { message: string; hint: string };

const TEXTS: { [C in ErrorCode]: Texts<C> } = {
  VALIDATION: (d) => ({
    message: `Invalid request: ${d.issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join('; ')}`,
    hint: 'Fix the listed fields and send the request again.',
  }),
  UNAUTHENTICATED: () => ({
    message: 'No active session.',
    hint: 'Start a demo with POST /api/demo/sessions.',
  }),
  FORBIDDEN: (d) => ({
    message: d.action ? `You are not allowed to ${d.action}.` : 'You are not allowed to do that.',
    hint: 'Switch to a persona with the right role.',
  }),
  NOT_FOUND: (d) => ({
    message: d.resource ? `${d.resource} not found.` : 'Not found.',
    hint: 'Check the id; it may belong to another organization or have expired.',
  }),
  CONFLICT_STALE: (d) => ({
    message: d.status ? `This ${d.resource} was already ${d.status}.` : `This ${d.resource} changed in the meantime.`,
    hint: 'Refresh to see the current state.',
  }),
  DUPLICATE_ASSIGNMENT: () => ({
    message: 'This person is already on the project.',
    hint: 'A person holds at most one open assignment per project.',
  }),
  SLOT_FULL: (d) => ({
    message: `All ${d.count} slot${d.count === 1 ? '' : 's'} for this role are taken.`,
    hint: 'Pick another role or free a slot first.',
  }),
  NO_APPROVER: () => ({
    message: 'This person has no approver.',
    hint: 'Assign them to a department that has a manager first.',
  }),
  CAPACITY_EXCEEDED: (d) => ({
    message: `Would exceed 8 h/day on ${d.date}: ${d.used} h already booked, ${d.requested} h requested.`,
    hint:
      d.maxHours > 0
        ? `The most you can request from ${d.date} is ${d.maxHours} h/day.`
        : `No hours are free on ${d.date}; pick a later start date.`,
  }),
  UNSUPPORTED_MEDIA_TYPE: () => ({
    message: 'Mutations must be sent as application/json.',
    hint: "Set 'content-type: application/json' and send a JSON body (use {} when there is nothing to send).",
  }),
  DB_UNAVAILABLE: () => ({
    message: 'The database is not reachable right now.',
    hint: 'Retry in a few seconds. Locally, run "pnpm dev:local" for an in-memory replica set.',
  }),
  AI_UNAVAILABLE: () => ({
    message: 'The AI assistant is unavailable.',
    hint: 'Manual staffing still works.',
  }),
  RATE_LIMITED: (d) => ({
    message: 'Too many requests.',
    hint: `Retry in ${d.retryAfterSeconds} s.`,
  }),
  INTERNAL: () => ({
    message: 'Something went wrong on our side.',
    hint: 'Retry; if it keeps failing, the error was logged.',
  }),
};

export function domainError<C extends ErrorCode>(code: C, details: ErrorDetails<C>): Extract<DomainError, { code: C }> {
  const texts = (TEXTS[code] as Texts<C>)(details);
  return { code, details, ...texts } as Extract<DomainError, { code: C }>;
}

/** Throwable wrapper; the API error handler maps it to `HTTP_STATUS[code]` and the envelope. */
export class DomainException extends Error {
  readonly error: DomainError;
  constructor(error: DomainError) {
    super(error.message);
    this.name = 'DomainException';
    this.error = error;
  }
  get status(): number {
    return HTTP_STATUS[this.error.code];
  }
}

/** Non-transient error thrown inside the approve transaction when the recheck fails (invariant 2). */
export class CapacityError extends DomainException {
  constructor(details: ErrorDetails<'CAPACITY_EXCEEDED'>) {
    super(domainError('CAPACITY_EXCEEDED', details));
    this.name = 'CapacityError';
  }
}

export function fail<C extends ErrorCode>(code: C, details: ErrorDetails<C>): never {
  throw new DomainException(domainError(code, details));
}

export function validationError(error: z.ZodError): DomainError {
  return domainError('VALIDATION', {
    issues: error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })),
  });
}
