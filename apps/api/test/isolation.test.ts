import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MembersResponse, ProjectBoard, SessionInfo, TeamRolesResponse } from '@team-finder/domain';
import type { FastifyInstance } from 'fastify';
import { fakeProvider } from '../src/ai/fake.ts';
import type { Database } from '../src/db/client.ts';
import { TENANT_COLLECTIONS } from '../src/db/documents.ts';
import { call, personaId, sessionCookie, startDemo, switchTo, testApp, testDatabase, type Visitor } from './helpers.ts';

// Invariant 3 (tenant isolation), M2 cross-org suite: two real orgs and two demo sandboxes. Every
// route that takes an id is called by a member of another org with the victim's ids. Each call
// must be refused (403/404) and the victim's documents must be byte-for-byte unchanged afterwards.

let database: Database;
let app: FastifyInstance;
beforeAll(async () => {
  database = await testDatabase('isolation-test');
  app = testApp(database, { aiProvider: fakeProvider });
});
afterAll(() => database?.close());

const PASSWORD = 'correct horse battery';
let seq = 0;

async function realOrg(name: string): Promise<Visitor> {
  const res = await call(app, null, 'POST', '/api/auth/signup', {
    orgName: name,
    name: `${name} Admin`,
    email: `admin.${++seq}.${Date.now()}@${name.toLowerCase().replace(/\W/g, '')}.example`,
    password: PASSWORD,
  });
  expect(res.statusCode, res.body).toBe(201);
  return { cookie: sessionCookie(res), info: SessionInfo.parse(res.json()) };
}

/** A fingerprint of every document an org owns (all tenant collections plus the org itself). */
async function fingerprint(orgId: string): Promise<string> {
  const parts: unknown[] = [await database.db.collection('orgs').findOne({ _id: orgId as never })];
  for (const c of TENANT_COLLECTIONS) {
    parts.push(await database.db.collection(c).find({ orgId }).sort({ _id: 1 }).toArray());
  }
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

interface Victim {
  orgId: string;
  projectId: string;
  assignmentIds: string[];
  userId: string;
  teamRoleId: string;
  departmentId: string;
  skillId: string;
  categoryId: string;
}

async function firstId(collection: string, orgId: string): Promise<string> {
  return String((await database.db.collection(collection).findOne({ orgId }))!._id);
}

async function demoVictim(): Promise<{ pm: Visitor; victim: Victim }> {
  const pm = await startDemo(app);
  const board = ProjectBoard.parse((await call(app, pm, 'GET', `/api/projects/${pm.info.landingProjectId}`)).json());
  return {
    pm,
    victim: {
      orgId: pm.info.org.id,
      projectId: board.project.id,
      assignmentIds: board.assignments.map((a) => a.id),
      userId: board.assignments[0]!.userId,
      teamRoleId: board.project.teamRoles[0]!.roleId,
      departmentId: await firstId('departments', pm.info.org.id),
      skillId: await firstId('skills', pm.info.org.id),
      categoryId: await firstId('skillCategories', pm.info.org.id),
    },
  };
}

async function realVictim(): Promise<{ admin: Visitor; victim: Victim }> {
  const admin = await realOrg('Victim Corp');
  const role = await call(app, admin, 'POST', '/api/team-roles', { name: 'Architect' });
  // The admin also becomes a PM and a department manager so the org owns one of everything.
  await call(app, admin, 'PUT', `/api/org/members/${admin.info.user.id}/roles`, {
    roles: ['admin', 'projectManager', 'deptManager'],
  });
  const dept = await call(app, admin, 'POST', '/api/departments', { name: 'Platform' });
  const category = await call(app, admin, 'POST', '/api/skill-categories', { name: 'Cloud' });
  const skill = await call(app, admin, 'POST', '/api/skills', { name: 'AWS', categoryId: category.json().id });
  const project = await call(app, admin, 'POST', '/api/projects', {
    name: 'Secret Project',
    period: 'fixed',
    startDate: '2026-04-01',
    deadline: '2026-06-01',
    teamRoles: [{ roleId: role.json().id, count: 1 }],
  });
  expect(project.statusCode, project.body).toBe(201);
  return {
    admin,
    victim: {
      orgId: admin.info.org.id,
      projectId: project.json().id,
      assignmentIds: [],
      userId: admin.info.user.id,
      teamRoleId: role.json().id,
      departmentId: dept.json().id,
      skillId: skill.json().id,
      categoryId: category.json().id,
    },
  };
}

function attacks(v: Victim): [string, 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', string, unknown?][] {
  const project = v.projectId;
  return [
    ['read a project board', 'GET', `/api/projects/${project}`],
    ['rank candidates', 'GET', `/api/projects/${project}/candidates`],
    [
      'propose someone',
      'POST',
      '/api/assignments',
      { projectId: project, userId: v.userId, slotRoleId: v.teamRoleId, hoursPerDay: 4, from: '2026-03-09' },
    ],
    ...v.assignmentIds.flatMap((id): [string, 'POST', string, unknown][] => [
      [`approve ${id}`, 'POST', `/api/assignments/${id}/approve`, { version: 0 }],
      [`reject ${id}`, 'POST', `/api/assignments/${id}/reject`, { version: 0 }],
    ]),
    ['commit a scenario', 'POST', `/api/projects/${project}/scenarios/commit`, { start: '2026-03-16', additions: [] }],
    ['share a snapshot', 'POST', '/api/snapshots', { projectId: project, start: '2026-03-16', additions: [] }],
    ['draft with AI', 'POST', '/api/ai/search', { projectId: project, text: 'a backend dev' }],
    ['change roles', 'PUT', `/api/org/members/${v.userId}/roles`, { roles: ['admin'] }],
    ['rename a team role', 'PATCH', `/api/team-roles/${v.teamRoleId}`, { name: 'Pwned' }],
    ['delete a team role', 'DELETE', `/api/team-roles/${v.teamRoleId}`, {}],
    ['edit a project', 'PATCH', `/api/projects/${project}`, { name: 'Pwned' }],
    ['close a project', 'POST', `/api/projects/${project}/status`, { status: 'closed' }],
    ['delete a project', 'DELETE', `/api/projects/${project}`, {}],
    ['rename a department', 'PATCH', `/api/departments/${v.departmentId}`, { name: 'Pwned' }],
    ['delete a department', 'DELETE', `/api/departments/${v.departmentId}`, {}],
    ['set a manager', 'PUT', `/api/departments/${v.departmentId}/manager`, { managerId: null }],
    ['add to a department', 'POST', `/api/departments/${v.departmentId}/members`, { userId: v.userId }],
    ['remove from a department', 'DELETE', `/api/departments/${v.departmentId}/members/${v.userId}`, {}],
    ['rename a category', 'PATCH', `/api/skill-categories/${v.categoryId}`, { name: 'Pwned' }],
    ['delete a category', 'DELETE', `/api/skill-categories/${v.categoryId}`, {}],
    ['edit a skill', 'PUT', `/api/skills/${v.skillId}`, { name: 'Pwned', categoryId: v.categoryId }],
    ['delete a skill', 'DELETE', `/api/skills/${v.skillId}`, {}],
    ['claim a skill', 'PUT', `/api/me/skills/${v.skillId}`, { level: 5, experience: '7y+' }],
  ];
}

async function expectIsolated(attacker: Visitor, victim: Victim) {
  const before = await fingerprint(victim.orgId);
  for (const [name, method, url, body] of attacks(victim)) {
    const res = await call(app, attacker, method, url, body);
    expect([403, 404], `${name}: ${res.statusCode} ${res.body}`).toContain(res.statusCode);
  }
  // Reads scoped to the caller never include the victim's data.
  const members = MembersResponse.parse((await call(app, attacker, 'GET', '/api/org/members')).json()).members;
  expect(members.some((m) => m.id === victim.userId)).toBe(false);
  const roles = TeamRolesResponse.parse((await call(app, attacker, 'GET', '/api/team-roles')).json()).teamRoles;
  expect(roles.some((r) => r.id === victim.teamRoleId)).toBe(false);
  const approvals = (await call(app, attacker, 'GET', '/api/approvals')).json() as {
    items?: { assignmentId: string }[];
  };
  expect((approvals.items ?? []).some((i) => victim.assignmentIds.includes(i.assignmentId))).toBe(false);
  expect(await fingerprint(victim.orgId)).toBe(before);
}

describe('tenant isolation across orgs (invariant 3)', () => {
  it('a real org admin cannot touch a demo sandbox', async () => {
    const { victim } = await demoVictim();
    await expectIsolated(await realOrg('Attacker Ltd'), victim);
  });

  it('a demo persona of every role cannot touch another sandbox', async () => {
    const { victim } = await demoVictim();
    let attacker = await startDemo(app);
    for (const first of ['Pat', 'Dana', 'Olivia']) {
      // Each switch rotates the session, so chain from the previous persona.
      attacker = await switchTo(app, attacker, personaId(attacker, first));
      await expectIsolated(attacker, victim);
    }
  });

  it('a demo persona cannot touch a real org', async () => {
    const { victim } = await realVictim();
    const demo = await startDemo(app);
    await expectIsolated(await switchTo(app, demo, personaId(demo, 'Olivia')), victim);
  });

  it('one real org cannot touch another', async () => {
    const { victim } = await realVictim();
    await expectIsolated(await realOrg('Rival Inc'), victim);
  });

  it('cannot switch into a persona of another org', async () => {
    const { victim } = await demoVictim();
    const other = await startDemo(app);
    const res = await call(app, other, 'POST', '/api/demo/sessions/switch', { userId: victim.userId });
    expect(res.statusCode).toBe(404);
  });
});
