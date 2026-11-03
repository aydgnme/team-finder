import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { HealthResponse } from '@team-finder/domain';

export interface AppOptions {
  /** Returns whether the database answers; omitted when no database is configured. */
  pingDb?: () => Promise<boolean>;
  /** Mark cookies Secure (production, behind HTTPS). */
  secureCookies: boolean;
  logger?: boolean;
}

/** Cookie used by /api/health to prove the browser sends first-party cookies back through the /api proxy. */
export const PROBE_COOKIE = 'tf_probe';

export function buildApp(options: AppOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });
  app.register(cookie);

  app.get('/api/health', async (request, reply) => {
    const cookieRoundTrip = request.cookies[PROBE_COOKIE] === '1';
    reply.setCookie(PROBE_COOKIE, '1', {
      path: '/api',
      httpOnly: true,
      sameSite: 'lax',
      secure: options.secureCookies,
    });
    const db = options.pingDb ? ((await options.pingDb()) ? 'up' : 'down') : 'not_configured';
    return HealthResponse.parse({ status: 'ok', db, cookieRoundTrip });
  });

  return app;
}
