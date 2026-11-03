import { AiSearchRequest, fail, type AiStatus } from '@team-finder/domain';
import type { FastifyInstance } from 'fastify';
import type { DraftProvider } from '../ai/provider.ts';
import { contextFor, type RequestDeps } from '../http/actor.ts';
import type { Limiter } from '../http/rate-limit.ts';
import { parse } from '../http/validate.ts';
import { draftTeam } from '../services/ai.ts';

/**
 * AI-01 routes. Model calls cost money, so two limits apply, both counted only when the model is
 * actually called: per session (RATE_LIMITED, with retry-after) and a process-wide daily cap
 * (AI_UNAVAILABLE: the cap is a budget, not the caller's fault).
 */
export function aiRoutes(
  app: FastifyInstance,
  deps: RequestDeps,
  ai: { provider: DraftProvider | null; perSession: Limiter; daily: Limiter },
) {
  app.get('/api/ai/status', async (): Promise<AiStatus> => ({
    enabled: ai.provider !== null,
    provider: ai.provider?.name ?? null,
  }));

  app.post('/api/ai/search', async (request) => {
    const ctx = contextFor(request, deps);
    const provider = ai.provider ?? fail('AI_UNAVAILABLE', { reason: 'set LLM_API_KEY on the server to enable it' });
    const input = parse(AiSearchRequest, request.body);
    const started = Date.now();
    const result = await draftTeam(ctx, provider, input, () => {
      ai.perSession.hit(`session:${ctx.actor.sessionId}`);
      try {
        ai.daily.hit('global');
      } catch {
        fail('AI_UNAVAILABLE', { reason: 'the daily limit for AI drafts is reached' });
      }
    });
    request.log.info(
      {
        provider: result.provider,
        ms: Date.now() - started,
        picks: result.items.length,
        dropped: result.dropped,
        orgId: ctx.actor.orgId,
      },
      'ai_draft',
    );
    return result;
  });
}
