import { fail } from '@team-finder/domain';

export interface RateLimit {
  max: number;
  windowMs: number;
}

/**
 * Fixed-window in-memory limiter. One API instance on the free tier, so memory is the right store;
 * keys are session ids for authenticated calls and the client IP (via trustProxy) for sandbox creation.
 */
export function createLimiter({ max, windowMs }: RateLimit) {
  const windows = new Map<string, { count: number; resetAt: number }>();
  return {
    /** Throws RATE_LIMITED once `key` exceeds `max` hits in the current window. */
    hit(key: string, now: number = Date.now()): void {
      if (windows.size > 10_000) for (const [k, w] of windows) if (w.resetAt <= now) windows.delete(k);
      let w = windows.get(key);
      if (!w || w.resetAt <= now) {
        w = { count: 0, resetAt: now + windowMs };
        windows.set(key, w);
      }
      w.count++;
      if (w.count > max) fail('RATE_LIMITED', { retryAfterSeconds: Math.ceil((w.resetAt - now) / 1000) });
    },
  };
}
export type Limiter = ReturnType<typeof createLimiter>;
