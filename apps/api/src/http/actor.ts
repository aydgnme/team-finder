import { domainError, DomainException, fail, todayUtc } from '@team-finder/domain';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Database } from '../db/client.ts';
import { orgRepo } from '../db/org-repo.ts';
import { sessionStore, type ResolvedActor, type SessionStore } from '../db/sessions.ts';
import type { ServiceContext } from '../services/context.ts';

export const SESSION_COOKIE = 'tf_session';

declare module 'fastify' {
  interface FastifyRequest {
    /** Resolved from the server-side session by the resolveActor preHandler; null when anonymous. */
    actor: ResolvedActor | null;
  }
}

export interface RequestDeps {
  getDatabase: () => Database | undefined;
  now: () => Date;
  secureCookies: boolean;
}

export function requireDatabase(deps: RequestDeps): { database: Database; store: SessionStore } {
  const database = deps.getDatabase();
  if (!database) throw new DomainException(domainError('DB_UNAVAILABLE', {}));
  return { database, store: sessionStore(database) };
}

/** The one preHandler that turns the session cookie into `request.actor`. Routes only ever see actor. */
export function registerResolveActor(app: FastifyInstance, deps: RequestDeps) {
  app.decorateRequest('actor', null);
  app.addHook('preHandler', async (request) => {
    const id = request.cookies[SESSION_COOKIE];
    const database = deps.getDatabase();
    if (!id || !database) return;
    request.actor = await sessionStore(database).resolve(id, deps.now());
  });
}

/** ServiceContext for an authenticated request; 401 without a live session. */
export function contextFor(request: FastifyRequest, deps: RequestDeps): ServiceContext {
  const { database } = requireDatabase(deps);
  const actor = request.actor ?? fail('UNAUTHENTICATED', {});
  const now = deps.now();
  return {
    actor,
    now,
    today: todayUtc(now),
    repo: orgRepo(database, { orgId: actor.orgId, isDemo: actor.isDemo, expiresAt: actor.expiresAt }),
  };
}

export function setSessionCookie(reply: FastifyReply, deps: RequestDeps, id: string, expiresAt: Date) {
  reply.setCookie(SESSION_COOKIE, id, {
    path: '/api',
    httpOnly: true,
    sameSite: 'lax',
    secure: deps.secureCookies,
    expires: expiresAt,
  });
}

export const REAL_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Signs the browser in as `userId`: always a fresh session id (session fixation), and the session
 * the browser held before is deleted. Used by sign-up, join and login; the demo routes do the same.
 */
export async function issueSession(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: RequestDeps,
  store: SessionStore,
  input: { orgId: string; userId: string; isDemo: boolean; expiresAt: Date },
) {
  const now = deps.now();
  const previous = request.cookies[SESSION_COOKIE];
  if (previous) await store.delete(previous);
  const session = await store.create(input, now);
  setSessionCookie(reply, deps, session._id, session.expiresAt);
  const actor = await store.resolve(session._id, now);
  if (!actor) throw new Error('new session did not resolve');
  return actor;
}

export function clearSessionCookie(reply: FastifyReply, deps: RequestDeps) {
  reply.clearCookie(SESSION_COOKIE, { path: '/api', httpOnly: true, sameSite: 'lax', secure: deps.secureCookies });
}
