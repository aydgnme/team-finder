import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { fail, HealthResponse } from '@team-finder/domain';
import type { Database } from './db/client.ts';
import { registerResolveActor, type RequestDeps } from './http/actor.ts';
import { registerErrorHandling } from './http/errors.ts';
import { createLimiter, type RateLimit } from './http/rate-limit.ts';
import { demoRoutes } from './routes/demo.ts';
import { staffingRoutes } from './routes/staffing.ts';

export interface RateLimits {
  /** Sandbox creation per client IP. */
  demoPerClient: RateLimit;
  /** Sandbox creation across all clients (protects the free database tier). */
  demoGlobal: RateLimit;
  /** Mutations per session. */
  mutationsPerSession: RateLimit;
}

export const DEFAULT_RATE_LIMITS: RateLimits = {
  demoPerClient: { max: 10, windowMs: 60_000 },
  demoGlobal: { max: 30, windowMs: 60_000 },
  mutationsPerSession: { max: 60, windowMs: 60_000 },
};

export interface AppOptions {
  /** Current database connection; omitted when no database is configured, undefined while connecting. */
  getDatabase?: () => Database | undefined;
  /** Returns whether the database answers; defaults to pinging getDatabase(). */
  pingDb?: () => Promise<boolean>;
  /** Mark cookies Secure (production, behind HTTPS). */
  secureCookies: boolean;
  logger?: boolean;
  /** Fastify trustProxy: which proxy hops may set x-forwarded-for (request.ip feeds rate limits). */
  trustProxy?: boolean | number | string;
  now?: () => Date;
  rateLimits?: Partial<RateLimits>;
}

/** Cookie used by /api/health to prove the browser sends first-party cookies back through the /api proxy. */
export const PROBE_COOKIE = 'tf_probe';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function buildApp(options: AppOptions): FastifyInstance {
  // Cast: the union type confuses Fastify's http/http2 overloads; every variant is valid at runtime.
  const app = Fastify({ logger: options.logger ?? false, trustProxy: (options.trustProxy ?? false) as boolean });
  app.register(cookie);
  registerErrorHandling(app);

  // CSRF: SameSite=Lax plus JSON-only mutations. Fastify would otherwise parse text/plain, which an
  // HTML form can send cross-site without a preflight.
  app.addHook('onRequest', async (request) => {
    if (SAFE_METHODS.has(request.method)) return;
    const type = request.headers['content-type'] ?? '';
    if (!/^application\/json\s*(;|$)/i.test(type)) fail('UNSUPPORTED_MEDIA_TYPE', type ? { contentType: type } : {});
  });

  const deps: RequestDeps = {
    getDatabase: options.getDatabase ?? (() => undefined),
    now: options.now ?? (() => new Date()),
    secureCookies: options.secureCookies,
  };
  registerResolveActor(app, deps);

  const pingDb =
    options.pingDb ??
    (options.getDatabase
      ? async () => {
          const database = options.getDatabase?.();
          return database ? database.ping() : false;
        }
      : undefined);

  app.get('/api/health', async (request, reply) => {
    const cookieRoundTrip = request.cookies[PROBE_COOKIE] === '1';
    reply.setCookie(PROBE_COOKIE, '1', {
      path: '/api',
      httpOnly: true,
      sameSite: 'lax',
      secure: options.secureCookies,
    });
    const db = pingDb ? ((await pingDb()) ? 'up' : 'down') : 'not_configured';
    return HealthResponse.parse({ status: 'ok', db, cookieRoundTrip });
  });

  const rl = { ...DEFAULT_RATE_LIMITS, ...options.rateLimits };
  const mutations = createLimiter(rl.mutationsPerSession);
  demoRoutes(app, deps, {
    perClient: createLimiter(rl.demoPerClient),
    global: createLimiter(rl.demoGlobal),
    mutations,
  });
  staffingRoutes(app, deps, { mutations });

  return app;
}
