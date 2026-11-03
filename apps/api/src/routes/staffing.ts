import { CandidatesQuery, DecisionRequest, ProposeRequest } from '@team-finder/domain';
import type { FastifyInstance } from 'fastify';
import { contextFor, type RequestDeps } from '../http/actor.ts';
import type { Limiter } from '../http/rate-limit.ts';
import { parse } from '../http/validate.ts';
import { listApprovals } from '../services/approvals.ts';
import { approve, propose, reject } from '../services/assignments.ts';
import { projectBoard } from '../services/board.ts';
import { listCandidates } from '../services/candidates.ts';

type IdParams = { Params: { id: string } };

export function staffingRoutes(app: FastifyInstance, deps: RequestDeps, limits: { mutations: Limiter }) {
  app.get<IdParams>('/api/projects/:id', async (request) => projectBoard(contextFor(request, deps), request.params.id));

  app.get<IdParams>('/api/projects/:id/candidates', async (request) => {
    const q = parse(CandidatesQuery, request.query);
    return listCandidates(
      contextFor(request, deps),
      request.params.id,
      {
        ...(q.includePartial === undefined ? {} : { includePartial: q.includePartial }),
        ...(q.includeUnavailable === undefined ? {} : { includeUnavailable: q.includeUnavailable }),
        ...(q.includeNearMisses === undefined ? {} : { includeNearMisses: q.includeNearMisses }),
        ...(q.includeRollingOffWithinWeeks === undefined
          ? {}
          : { includeRollingOffWithinWeeks: q.includeRollingOffWithinWeeks }),
      },
      q.start,
    );
  });

  app.post('/api/assignments', async (request, reply) => {
    const ctx = contextFor(request, deps);
    limits.mutations.hit(`session:${ctx.actor.sessionId}`);
    const view = await propose(ctx, parse(ProposeRequest, request.body));
    reply.status(201);
    return view;
  });

  app.post<IdParams>('/api/assignments/:id/approve', async (request) => {
    const ctx = contextFor(request, deps);
    limits.mutations.hit(`session:${ctx.actor.sessionId}`);
    return approve(ctx, request.params.id, parse(DecisionRequest, request.body).version);
  });

  app.post<IdParams>('/api/assignments/:id/reject', async (request) => {
    const ctx = contextFor(request, deps);
    limits.mutations.hit(`session:${ctx.actor.sessionId}`);
    return reject(ctx, request.params.id, parse(DecisionRequest, request.body).version);
  });

  app.get('/api/approvals', async (request) => listApprovals(contextFor(request, deps)));
}
