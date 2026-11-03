import type { RateLimits } from './app.ts';

export interface Config {
  port: number;
  mongodbUri: string | undefined;
  mongodbDb: string;
  production: boolean;
  trustProxy: boolean | number | string;
  rateLimits: Partial<RateLimits>;
  /** AI-01: "anthropic" when LLM_API_KEY is set, "fake" when LLM_PROVIDER=fake, otherwise off. */
  ai: { provider: 'anthropic'; apiKey: string; model: string | undefined } | { provider: 'fake' } | { provider: 'off' };
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
  const aiDailyCap = Number(env.LLM_DAILY_CAP);
  const ai: Config['ai'] =
    env.LLM_PROVIDER === 'fake'
      ? { provider: 'fake' }
      : env.LLM_API_KEY
        ? { provider: 'anthropic', apiKey: env.LLM_API_KEY, model: env.LLM_MODEL || undefined }
        : { provider: 'off' };
  return {
    port: Number(env.PORT ?? 3000),
    mongodbUri: env.MONGODB_URI || undefined,
    mongodbDb: env.MONGODB_DB ?? 'team-finder',
    production: env.NODE_ENV === 'production',
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    rateLimits: {
      ...(demoPerMinute > 0
        ? {
            demoPerClient: { max: demoPerMinute, windowMs: 60_000 },
            demoGlobal: { max: demoPerMinute * 3, windowMs: 60_000 },
          }
        : {}),
      ...(aiDailyCap > 0 ? { aiDaily: { max: aiDailyCap, windowMs: 24 * 60 * 60_000 } } : {}),
    },
    ai,
  };
}
