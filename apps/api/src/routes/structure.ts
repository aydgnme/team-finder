import {
  AcceptUpgradeRequest,
  AddEndorsementRequest,
  CategoryRequest,
  DeallocateRequest,
  CreateProjectRequest,
  DepartmentRequest,
  MemberRequest,
  SetManagerRequest,
  SetMySkillRequest,
  SkillClaimDecision,
  SkillRequest,
  TransitionRequest,
  UpdateProjectRequest,
} from '@team-finder/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { contextFor, type RequestDeps } from '../http/actor.ts';
import type { Limiter } from '../http/rate-limit.ts';
import { parse } from '../http/validate.ts';
import * as departments from '../services/departments.ts';
import * as projects from '../services/projects.ts';
import * as skills from '../services/skills.ts';
import * as upgrades from '../services/upgrades.ts';
import * as views from '../services/views.ts';
import { proposeDeallocation } from '../services/assignments.ts';

type IdParams = { Params: { id: string } };
type MemberParams = { Params: { id: string; userId: string } };
type SkillParams = { Params: { skillId: string } };

/** Organization data (M3a): projects, departments, skills. Services enforce every permission. */
export function structureRoutes(app: FastifyInstance, deps: RequestDeps, limits: { mutations: Limiter }) {
  const mutating = (request: FastifyRequest) => {
    const ctx = contextFor(request, deps);
    limits.mutations.hit(`session:${ctx.actor.sessionId}`);
    return ctx;
  };
  const created = <T>(reply: { status: (n: number) => unknown }, value: T) => {
    reply.status(201);
    return value;
  };

  // ---- projects (Project-01) ----
  app.get('/api/projects', async (request) => projects.listProjects(contextFor(request, deps)));
  app.post('/api/projects', async (request, reply) =>
    created(reply, await projects.createProject(mutating(request), parse(CreateProjectRequest, request.body))),
  );
  app.patch<IdParams>('/api/projects/:id', async (request) =>
    projects.updateProject(mutating(request), request.params.id, parse(UpdateProjectRequest, request.body)),
  );
  app.post<IdParams>('/api/projects/:id/status', async (request) =>
    projects.changeStatus(mutating(request), request.params.id, parse(TransitionRequest, request.body).status),
  );
  app.delete<IdParams>('/api/projects/:id', async (request) =>
    projects.deleteProject(mutating(request), request.params.id),
  );

  // ---- views (Project-06..09) and deallocation (Project-04) ----
  app.get<IdParams>('/api/projects/:id/details', async (request) =>
    views.projectDetails(contextFor(request, deps), request.params.id),
  );
  app.get<IdParams>('/api/people/:id/projects', async (request) =>
    views.personProjects(contextFor(request, deps), request.params.id),
  );
  app.get<IdParams & { Querystring: { status?: string } }>('/api/departments/:id/projects', async (request) =>
    views.departmentProjects(contextFor(request, deps), request.params.id, request.query.status),
  );
  app.get<IdParams>('/api/departments/:id/stats', async (request) =>
    views.departmentStats(contextFor(request, deps), request.params.id),
  );
  app.get('/api/org/no-approver', async (request) => views.noApproverItems(contextFor(request, deps)));
  app.post<IdParams>('/api/skills/claims/:id/validate', async (request) =>
    skills.decideClaim(
      mutating(request),
      request.params.id,
      parse(SkillClaimDecision, request.body).version,
      'validated',
    ),
  );
  app.post<IdParams>('/api/skills/claims/:id/reject', async (request) =>
    skills.decideClaim(
      mutating(request),
      request.params.id,
      parse(SkillClaimDecision, request.body).version,
      'rejected',
    ),
  );
  app.post<IdParams>('/api/assignments/:id/deallocate', async (request) => {
    const { version, reason } = parse(DeallocateRequest, request.body);
    return proposeDeallocation(mutating(request), request.params.id, version, reason);
  });

  // ---- departments (Department-01..03) ----
  app.get('/api/departments', async (request) => departments.listDepartments(contextFor(request, deps)));
  app.post('/api/departments', async (request, reply) =>
    created(reply, await departments.createDepartment(mutating(request), parse(DepartmentRequest, request.body).name)),
  );
  app.patch<IdParams>('/api/departments/:id', async (request) =>
    departments.renameDepartment(mutating(request), request.params.id, parse(DepartmentRequest, request.body).name),
  );
  app.delete<IdParams>('/api/departments/:id', async (request) =>
    departments.deleteDepartment(mutating(request), request.params.id),
  );
  app.put<IdParams>('/api/departments/:id/manager', async (request) =>
    departments.setManager(mutating(request), request.params.id, parse(SetManagerRequest, request.body).managerId),
  );
  app.post<IdParams>('/api/departments/:id/members', async (request) =>
    departments.addMember(mutating(request), request.params.id, parse(MemberRequest, request.body).userId),
  );
  app.delete<MemberParams>('/api/departments/:id/members/:userId', async (request) =>
    departments.removeMember(mutating(request), request.params.id, request.params.userId),
  );

  // ---- skills (Skill-01/02) ----
  app.get('/api/skills', async (request) => skills.listSkills(contextFor(request, deps)));
  app.post('/api/skill-categories', async (request, reply) =>
    created(reply, await skills.createCategory(mutating(request), parse(CategoryRequest, request.body).name)),
  );
  app.patch<IdParams>('/api/skill-categories/:id', async (request) =>
    skills.renameCategory(mutating(request), request.params.id, parse(CategoryRequest, request.body).name),
  );
  app.delete<IdParams>('/api/skill-categories/:id', async (request) =>
    skills.deleteCategory(mutating(request), request.params.id),
  );
  app.post('/api/skills', async (request, reply) =>
    created(reply, await skills.createSkill(mutating(request), parse(SkillRequest, request.body))),
  );
  app.put<IdParams>('/api/skills/:id', async (request) =>
    skills.updateSkill(mutating(request), request.params.id, parse(SkillRequest, request.body)),
  );
  app.delete<IdParams>('/api/skills/:id', async (request) => skills.deleteSkill(mutating(request), request.params.id));
  app.put<SkillParams>('/api/me/skills/:skillId', async (request) => {
    const { level, experience } = parse(SetMySkillRequest, request.body);
    return skills.setMySkill(mutating(request), request.params.skillId, level, experience);
  });
  app.delete<SkillParams>('/api/me/skills/:skillId', async (request) =>
    skills.removeMySkill(mutating(request), request.params.skillId),
  );

  // ---- endorsements (Skill-03) and upgrade proposals (Project-11) ----
  app.post<SkillParams>('/api/me/skills/:skillId/endorsements', async (request, reply) =>
    created(
      reply,
      await skills.addEndorsement(
        mutating(request),
        request.params.skillId,
        parse(AddEndorsementRequest, request.body),
      ),
    ),
  );
  app.delete<{ Params: { skillId: string; id: string } }>('/api/me/skills/:skillId/endorsements/:id', async (request) =>
    skills.removeEndorsement(mutating(request), request.params.skillId, request.params.id),
  );
  app.get('/api/me/upgrade-proposals', async (request) => upgrades.listMyProposals(contextFor(request, deps)));
  app.post<IdParams>('/api/me/upgrade-proposals/:id/accept', async (request) =>
    upgrades.decideProposal(mutating(request), request.params.id, {
      accept: parse(AcceptUpgradeRequest, request.body),
    }),
  );
  app.post<IdParams>('/api/me/upgrade-proposals/:id/dismiss', async (request) =>
    upgrades.decideProposal(mutating(request), request.params.id, { dismiss: true }),
  );
}
