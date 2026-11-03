import {
  fail,
  InviteLookupRequest,
  JoinRequest,
  LoginRequest,
  SignUpRequest,
  type InviteInfo,
} from '@team-finder/domain';
import type { FastifyInstance } from 'fastify';
import { burnVerify, hashPassword, verifyPassword } from '../auth/passwords.ts';
import { authStore, duplicateKeyOn } from '../db/auth.ts';
import { orgRepo } from '../db/org-repo.ts';
import {
  clearSessionCookie,
  issueSession,
  REAL_SESSION_TTL_MS,
  requireDatabase,
  SESSION_COOKIE,
  type RequestDeps,
} from '../http/actor.ts';
import type { Limiter } from '../http/rate-limit.ts';
import { parse } from '../http/validate.ts';
import { sessionInfo } from '../services/demo.ts';

/**
 * Auth-01..03. Every route here works without a session. Login failures are one generic error;
 * passwords never reach a log line (Fastify logs no bodies). Sign-up, join and login rotate the
 * session id.
 */
export function authRoutes(app: FastifyInstance, deps: RequestDeps, limits: { perClient: Limiter; perEmail: Limiter }) {
  const hit = (ip: string) => limits.perClient.hit(`auth:${ip}`);
  const emailTaken = (error: unknown) => {
    if (duplicateKeyOn(error, 'login_email_unique')) fail('EMAIL_TAKEN', {});
    throw error;
  };

  app.post('/api/auth/signup', async (request, reply) => {
    hit(request.ip);
    const { database, store } = requireDatabase(deps);
    const input = parse(SignUpRequest, request.body);
    const passwordHash = await hashPassword(input.password);
    const { orgId, userId } = await authStore(database)
      .createOrgWithAdmin({ ...input, passwordHash }, deps.now())
      .catch(emailTaken);
    const now = deps.now();
    const actor = await issueSession(request, reply, deps, store, {
      orgId,
      userId,
      isDemo: false,
      expiresAt: new Date(now.getTime() + REAL_SESSION_TTL_MS),
    });
    reply.status(201);
    return sessionInfo(orgRepo(database, actor), store, actor);
  });

  app.post('/api/auth/login', async (request, reply) => {
    hit(request.ip);
    const { database, store } = requireDatabase(deps);
    const input = parse(LoginRequest, request.body);
    limits.perEmail.hit(`login:${input.email}`);
    const user = await authStore(database).findLoginUser(input.email);
    const ok = user ? await verifyPassword(input.password, user.passwordHash) : await burnVerify(input.password);
    if (!user || !ok) fail('INVALID_CREDENTIALS', {});
    const org = await store.getOrg(user!.orgId);
    if (!org || org.isDemo) fail('INVALID_CREDENTIALS', {});
    const actor = await issueSession(request, reply, deps, store, {
      orgId: org!._id,
      userId: user!._id,
      isDemo: false,
      expiresAt: new Date(deps.now().getTime() + REAL_SESSION_TTL_MS),
    });
    return sessionInfo(orgRepo(database, actor), store, actor);
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const id = request.cookies[SESSION_COOKIE];
    const database = deps.getDatabase();
    if (id && database) await requireDatabase(deps).store.delete(id);
    clearSessionCookie(reply, deps);
    return { ok: true };
  });

  // POST, with the token in the body: the secret never appears in a URL or a log line.
  app.post('/api/invites/lookup', async (request): Promise<InviteInfo> => {
    hit(request.ip);
    const { database } = requireDatabase(deps);
    const { token } = parse(InviteLookupRequest, request.body);
    const org = await authStore(database).findOrgByInvite(token);
    if (!org) fail('NOT_FOUND', { resource: 'invite' });
    return { orgName: org!.name };
  });

  app.post('/api/invites/join', async (request, reply) => {
    hit(request.ip);
    const { database, store } = requireDatabase(deps);
    const input = parse(JoinRequest, request.body);
    const auth = authStore(database);
    const org = await auth.findOrgByInvite(input.token);
    if (!org) fail('NOT_FOUND', { resource: 'invite' });
    const passwordHash = await hashPassword(input.password);
    const userId = await auth.addMember(org!._id, { ...input, passwordHash }).catch(emailTaken);
    const actor = await issueSession(request, reply, deps, store, {
      orgId: org!._id,
      userId,
      isDemo: false,
      expiresAt: new Date(deps.now().getTime() + REAL_SESSION_TTL_MS),
    });
    reply.status(201);
    return sessionInfo(orgRepo(database, actor), store, actor);
  });
}
