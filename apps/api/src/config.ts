import type { RateLimits } from './app.ts';

export interface Config {
  port: number;
  mongodbUri: string | undefined;
  mongodbDb: string;
  production: boolean;
  trustProxy: boolean | number | string;
  rateLimits: Partial<RateLimits>;
}

/**
 * TRUST_PROXY: "true", a hop count (e.g. "2" for SPA host rewrite + platform load balancer) or a
 * comma-separated list of proxy addresses/CIDRs. Default: trust nobody, so request.ip is the socket.
 */
export function parseTrustProxy(value: string | undefined): boolean | number | string {
  if (!value) return false;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const demoPerMinute = Number(env.DEMO_SESSIONS_PER_MINUTE);
  return {
    port: Number(env.PORT ?? 3000),
    mongodbUri: env.MONGODB_URI || undefined,
    mongodbDb: env.MONGODB_DB ?? 'team-finder',
    production: env.NODE_ENV === 'production',
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    rateLimits:
      demoPerMinute > 0
        ? {
            demoPerClient: { max: demoPerMinute, windowMs: 60_000 },
            demoGlobal: { max: demoPerMinute * 3, windowMs: 60_000 },
          }
        : {},
  };
}
