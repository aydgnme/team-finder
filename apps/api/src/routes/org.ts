import { SetRolesRequest, TeamRoleRequest } from '@team-finder/domain';
import type { FastifyInstance } from 'fastify';
import { contextFor, requireDatabase, type RequestDeps } from '../http/actor.ts';
import type { Limiter } from '../http/rate-limit.ts';
import { parse } from '../http/validate.ts';
import {
  createTeamRole,
  deleteTeamRole,
  listMembers,
  listTeamRoles,
  orgSettings,
  regenerateInvite,
  renameTeamRole,
  setRoles,
} from '../services/org.ts';

type IdParams = { Params: { id: string } };

export function orgRoutes(app: FastifyInstance, deps: RequestDeps, limits: { mutations: Limiter }) {
  const mutating = (request: Parameters<typeof contextFor>[0]) => {
    const ctx = contextFor(request, deps);
    limits.mutations.hit(`session:${ctx.actor.sessionId}`);
    return ctx;
  };

  app.get('/api/org', async (request) => orgSettings(contextFor(request, deps), requireDatabase(deps).store));

  app.post('/api/org/invite', async (request) => {
    const { database, store } = requireDatabase(deps);
    return regenerateInvite(mutating(request), database, store);
  });

  app.get('/api/org/members', async (request) => ({ members: await listMembers(contextFor(request, deps)) }));

  app.put<IdParams>('/api/org/members/:id/roles', async (request) => {
    const ctx = mutating(request);
    return setRoles(ctx, requireDatabase(deps).database, request.params.id, parse(SetRolesRequest, request.body).roles);
  });

  app.get('/api/team-roles', async (request) => ({ teamRoles: await listTeamRoles(contextFor(request, deps)) }));

  app.post('/api/team-roles', async (request, reply) => {
    const role = await createTeamRole(mutating(request), parse(TeamRoleRequest, request.body).name);
    reply.status(201);
    return role;
  });

  app.patch<IdParams>('/api/team-roles/:id', async (request) =>
    renameTeamRole(mutating(request), request.params.id, parse(TeamRoleRequest, request.body).name),
  );

  app.delete<IdParams>('/api/team-roles/:id', async (request) => deleteTeamRole(mutating(request), request.params.id));
}
