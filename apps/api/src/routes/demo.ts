import { can, fail, SwitchPersonaRequest } from '@team-finder/domain';
import type { FastifyInstance } from 'fastify';
import { orgRepo } from '../db/org-repo.ts';
import { contextFor, requireDatabase, setSessionCookie, SESSION_COOKIE, type RequestDeps } from '../http/actor.ts';
import type { Limiter } from '../http/rate-limit.ts';
import { parse } from '../http/validate.ts';
import { createSandbox, sessionInfo } from '../services/demo.ts';

export function demoRoutes(
  app: FastifyInstance,
  deps: RequestDeps,
  limits: { perClient: Limiter; global: Limiter; mutations: Limiter },
) {
  app.get('/api/session', async (request) => {
    const ctx = contextFor(request, deps);
    return sessionInfo(ctx.repo, requireDatabase(deps).store, ctx.actor);
  });

  /** "Try the demo": a fresh sandbox org cloned from the Atlas seed, signed in as its project manager. */
  app.post('/api/demo/sessions', async (request, reply) => {
    const { database, store } = requireDatabase(deps);
    limits.perClient.hit(`ip:${request.ip}`);
    limits.global.hit('global');
    const now = deps.now();
    const sandbox = await createSandbox(database, store, now);
    const previous = request.cookies[SESSION_COOKIE];
    if (previous) await store.delete(previous);
    const session = await store.create(
      { orgId: sandbox.orgId, userId: sandbox.pmUserId, isDemo: true, expiresAt: sandbox.expiresAt },
      now,
    );
    setSessionCookie(reply, deps, session._id, session.expiresAt);
    const actor = await store.resolve(session._id, now);
    if (!actor) throw new Error('sandbox session did not resolve');
    reply.status(201);
    return sessionInfo(orgRepo(database, actor), store, actor);
  });

  /** Role switcher: impersonate another persona of the same demo org. Always issues a new session id. */
  app.post('/api/demo/sessions/switch', async (request, reply) => {
    const ctx = contextFor(request, deps);
    limits.mutations.hit(`session:${ctx.actor.sessionId}`);
    const { store } = requireDatabase(deps);
    const { userId } = parse(SwitchPersonaRequest, request.body);
    const target = await ctx.repo.users.findOne({ _id: userId });
    if (!target) fail('NOT_FOUND', { resource: 'user', id: userId });
    const org = await store.getOrg(ctx.actor.orgId);
    if (!org || !can(ctx.actor, 'demo.switchPersona', { orgId: org._id, isDemo: org.isDemo })) {
      fail('FORBIDDEN', { action: 'switch personas outside a demo' });
    }
    const expiresAt = org.expiresAt ?? new Date(ctx.now.getTime() + 24 * 3600 * 1000);
    const session = await store.create({ orgId: org._id, userId: target._id, isDemo: true, expiresAt }, ctx.now);
    await store.delete(ctx.actor.sessionId);
    setSessionCookie(reply, deps, session._id, expiresAt);
    const actor = await store.resolve(session._id, ctx.now);
    if (!actor) throw new Error('switched session did not resolve');
    return sessionInfo(ctx.repo, store, actor);
  });
}
