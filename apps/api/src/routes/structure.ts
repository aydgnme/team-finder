import {
  CategoryRequest,
  CreateProjectRequest,
  DepartmentRequest,
  MemberRequest,
  SetManagerRequest,
  SetMySkillRequest,
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
}
