import { ScenarioCommitRequest, SnapshotRequest } from '@team-finder/domain';
import type { FastifyInstance } from 'fastify';
import { contextFor, requireDatabase, type RequestDeps } from '../http/actor.ts';
import type { Limiter } from '../http/rate-limit.ts';
import { parse } from '../http/validate.ts';
import { commitScenario } from '../services/scenarios.ts';
import { createSnapshot, getSnapshot } from '../services/snapshots.ts';

type IdParams = { Params: { id: string } };

/** Snapshot bodies are small drafts; anything bigger is not a draft (design.md, eng #6). */
export const SNAPSHOT_BODY_LIMIT = 64 * 1024;

export function scenarioRoutes(app: FastifyInstance, deps: RequestDeps, limits: { mutations: Limiter }) {
  app.post<IdParams>('/api/projects/:id/scenarios/commit', async (request) => {
    const ctx = contextFor(request, deps);
    limits.mutations.hit(`session:${ctx.actor.sessionId}`);
    return commitScenario(ctx, request.params.id, parse(ScenarioCommitRequest, request.body));
  });

  app.post('/api/snapshots', { bodyLimit: SNAPSHOT_BODY_LIMIT }, async (request, reply) => {
    const ctx = contextFor(request, deps);
    limits.mutations.hit(`session:${ctx.actor.sessionId}`);
    const { database, store } = requireDatabase(deps);
    const org = await store.getOrg(ctx.actor.orgId);
    const created = await createSnapshot(ctx, database, org?.name ?? '', parse(SnapshotRequest, request.body));
    reply.status(201);
    return created;
  });

  // Anonymous access is allowed here: getSnapshot() decides (demo public, real orgs gated).
  app.get<IdParams>('/api/snapshots/:id', async (request) => {
    const { database } = requireDatabase(deps);
    return getSnapshot(database, request.actor, request.params.id, deps.now());
  });
}
