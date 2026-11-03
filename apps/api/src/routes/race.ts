import { fail } from '@team-finder/domain';
import type { FastifyInstance } from 'fastify';
import { contextFor, requireDatabase, type RequestDeps } from '../http/actor.ts';
import type { Limiter } from '../http/rate-limit.ts';
import { runRace } from '../services/race.ts';

/**
 * POST /api/demo/race: "Watch the race" (M2.5). Demo sessions only, one run at a time per session,
 * rate-limited; off entirely when DEMO_ROUTES_ENABLED=false.
 */
export function raceRoutes(app: FastifyInstance, deps: RequestDeps, opts: { enabled: boolean; perSession: Limiter }) {
  const running = new Set<string>();

  app.post('/api/demo/race', async (request) => {
    if (!opts.enabled) fail('NOT_FOUND', { resource: 'route POST /api/demo/race' });
    const ctx = contextFor(request, deps);
    if (!ctx.actor.isDemo) fail('DEMO_ONLY', {});
    const key = ctx.actor.sessionId;
    if (running.has(key)) fail('RACE_IN_PROGRESS', {});
    opts.perSession.hit(`race:${key}`);
    running.add(key);
    try {
      const { database, store } = requireDatabase(deps);
      const result = await runRace(database, store, deps.now());
      request.log.info({ replays: result.replays, winner: result.winner, ms: result.totalMs }, 'race_run');
      return result;
    } catch (error) {
      const code = (error as { error?: { code?: string } }).error?.code;
      if (code === 'INVARIANT_BROKEN') request.log.error({ err: error }, 'race_invariant_broken');
      throw error;
    } finally {
      running.delete(key);
    }
  });
}
