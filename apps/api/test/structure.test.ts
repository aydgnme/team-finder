import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CandidatesResponse,
  DepartmentsResponse,
  DomainError,
  ProjectBoard,
  ProjectsResponse,
  ProjectSummary,
  SkillsResponse,
  TeamRolesResponse,
  TransitionResponse,
} from '@team-finder/domain';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { Database } from '../src/db/client.ts';
import { call, personaId, startDemo, switchTo, testApp, testDatabase, type Visitor } from './helpers.ts';

// M3a: projects and their lifecycle, departments, skills. Fixed clock (helpers.NOW = 2026-03-02).
// Seed: Pat is the PM of every project; Dana manages Engineering; Olivia is the org admin; Atlas
// starts 2026-03-09 (Ana active, Leo and Kai proposed); Orion is ongoing and in progress (Kai and
// Mira active since last year).

let database: Database;
let app: FastifyInstance;
beforeAll(async () => {
  database = await testDatabase('structure-test');
  app = testApp(database);
});
afterAll(() => database?.close());

const code = (res: LightMyRequestResponse) => DomainError.parse(res.json()).code;
const as = (v: Visitor, first: string) => switchTo(app, v, personaId(v, first));

/** A second, independent session for any user of a sandbox (switching personas replaces the first). */
async function sessionFor(v: Visitor, userId: string): Promise<Visitor> {
  const id = `test-${Math.random().toString(36).slice(2)}`;
  await database.db.collection('sessions').insertOne({
    _id: id as never,
    orgId: v.info.org.id,
    userId,
    isDemo: true,
    expiresAt: new Date(Date.now() + 3_600_000),
    createdAt: new Date(),
  });
  return { cookie: id, info: v.info };
}

async function demo() {
  const pat = await startDemo(app);
  const roles = TeamRolesResponse.parse((await call(app, pat, 'GET', '/api/team-roles')).json()).teamRoles;
  const role = (name: string) => roles.find((r) => r.name === name)!.id;
  const list = async (v: Visitor = pat) => ProjectsResponse.parse((await call(app, v, 'GET', '/api/projects')).json());
  const project = async (name: string) => (await list()).projects.find((p) => p.name === name)!;
  const users = await database.db
    .collection<{ _id: string; name: string; capacityVersion: number; departmentId: string | null }>('users')
    .find({ orgId: pat.info.org.id })
    .toArray();
  const person = (first: string) => users.find((u) => u.name.startsWith(first))!._id;
  return { pat, role, list, project, person };
}

const newProject = (over: Record<string, unknown> = {}) => ({
  name: `Nova ${Math.random().toString(36).slice(2, 7)}`,
  period: 'fixed',
  startDate: '2026-04-01',
  deadline: '2026-07-01',
  ...over,
});

describe('projects (Project-01)', () => {
  it('lists projects with their PM and filled slots, in-progress first', async () => {
    const { list } = await demo();
    const r = await list();
    expect(r.canCreate).toBe(true);
    expect(r.projects.map((p) => p.name)).toEqual(['Cobalt', 'Orion', 'Atlas', 'Borealis', 'Helios']);
    expect(r.projects.find((p) => p.name === 'Atlas')).toMatchObject({
      status: 'starting',
      pm: { name: 'Pat Reyes' },
      slots: { filled: 3, total: 5 },
      canEdit: true,
    });
  });

  it('lets a project manager create a project and become its PM; others may not', async () => {
    const { pat, role } = await demo();
    const res = await call(
      app,
      pat,
      'POST',
      '/api/projects',
      newProject({ teamRoles: [{ roleId: role('QA Engineer'), count: 2 }] }),
    );
    expect(res.statusCode, res.body).toBe(201);
    expect(ProjectSummary.parse(res.json())).toMatchObject({
      status: 'notStarted',
      everActive: false,
      pm: { name: 'Pat Reyes' },
      slots: { filled: 0, total: 2 },
    });

    const olivia = await as(pat, 'Olivia');
    expect((await call(app, olivia, 'POST', '/api/projects', newProject())).statusCode).toBe(403);
  });

  it.each([
    ['an unknown team role', { teamRoles: [{ roleId: 'nope', count: 1 }] }, 404],
    ['an unknown skill', { techStack: ['nope'] }, 404],
    ['a deadline before the start', { deadline: '2026-03-01' }, 400],
    ['an in-progress start', { status: 'inProgress' }, 400],
  ])('refuses %s', async (_n, over, status) => {
    const { pat } = await demo();
    expect((await call(app, pat, 'POST', '/api/projects', newProject(over))).statusCode).toBe(status);
  });

  it('lets only the PM edit; dates clamp the team (M3b); counts never drop below holders', async () => {
    const { pat, project, role } = await demo();
    const atlas = await project('Atlas');
    expect((await call(app, pat, 'PATCH', `/api/projects/${atlas.id}`, { name: 'Atlas Portal' })).json()).toMatchObject(
      { name: 'Atlas Portal' },
    );

    const dana = await as(pat, 'Dana');
    expect((await call(app, dana, 'PATCH', `/api/projects/${atlas.id}`, { name: 'Mine now' })).statusCode).toBe(403);
    const pat2 = await as(dana, 'Pat');

    const moved = await call(app, pat2, 'PATCH', `/api/projects/${atlas.id}`, { startDate: '2026-03-16' });
    // Since M3b the team moves with the project (clamp, detailed in m3b.test.ts).
    expect(moved.statusCode, moved.body).toBe(200);
    expect(moved.json()).toMatchObject({ startDate: '2026-03-16' });

    const shrink = await call(app, pat2, 'PATCH', `/api/projects/${atlas.id}`, {
      teamRoles: [
        { roleId: role('Frontend Developer'), count: 2 },
        { roleId: role('QA Engineer'), count: 1 },
      ],
    });
    expect(DomainError.parse(shrink.json())).toMatchObject({
      code: 'SLOT_FULL',
      details: { roleId: role('Backend Developer') },
    });

    // A project without a team can move its dates.
    const fresh = ProjectSummary.parse((await call(app, pat2, 'POST', '/api/projects', newProject())).json());
    const res = await call(app, pat2, 'PATCH', `/api/projects/${fresh.id}`, {
      startDate: '2026-05-01',
      deadline: '2026-08-01',
    });
    expect(res.json()).toMatchObject({ startDate: '2026-05-01', deadline: '2026-08-01' });
  });

  it('moves status forward only, and marks the project as having been active', async () => {
    const { pat } = await demo();
    const p = ProjectSummary.parse((await call(app, pat, 'POST', '/api/projects', newProject())).json());
    const go = (status: string) => call(app, pat, 'POST', `/api/projects/${p.id}/status`, { status });
    expect(TransitionResponse.parse((await go('starting')).json()).project).toMatchObject({
      status: 'starting',
      everActive: false,
    });
    expect(TransitionResponse.parse((await go('inProgress')).json()).project).toMatchObject({
      status: 'inProgress',
      everActive: true,
    });
    expect(DomainError.parse((await go('starting')).json())).toMatchObject({
      code: 'TRANSITION_NOT_ALLOWED',
      details: { from: 'inProgress', to: 'starting' },
    });
    expect(code(await call(app, pat, 'DELETE', `/api/projects/${p.id}`, {}))).toBe('NOT_DELETABLE');
  });

  it('closing ends started assignments on the close day and frees the people', async () => {
    const { pat, project, person } = await demo();
    const orion = await project('Orion');
    const before = await database.db.collection('users').findOne({ _id: person('Kai') as never });
    const res = await call(app, pat, 'POST', `/api/projects/${orion.id}/status`, { status: 'closed' });
    expect(TransitionResponse.parse(res.json())).toMatchObject({
      project: { status: 'closed' },
      closed: { ended: 2, rejected: 0 },
    });
    const rows = await database.db.collection('assignments').find({ projectId: orion.id }).toArray();
    expect(rows.map((a) => [a.status, a.to])).toEqual([
      ['past', '2026-03-02'],
      ['past', '2026-03-02'],
    ]);
    const after = await database.db.collection('users').findOne({ _id: person('Kai') as never });
    expect(after!.capacityVersion).toBe(before!.capacityVersion + 1);

    // Kai's 4 h on Orion are gone, so Atlas now sees him as fully available.
    const atlas = await project('Atlas');
    const c = CandidatesResponse.parse(
      (
        await call(app, pat, 'GET', `/api/projects/${atlas.id}/candidates?includePartial=true&includeUnavailable=true`)
      ).json(),
    );
    expect(c.excluded.onProject).toBe(3);
    const board = ProjectBoard.parse((await call(app, pat, 'GET', `/api/projects/${atlas.id}`)).json());
    expect(board.assignments.find((a) => a.userName === 'Kai Nakamura')!.check).toMatchObject({ fits: true });
    expect(code(await call(app, pat, 'PATCH', `/api/projects/${orion.id}`, { name: 'Again' }))).toBe('VALIDATION');
  });

  it('closing never extends an assignment that already ended', async () => {
    const { pat, project } = await demo();
    const orion = await project('Orion');
    // Mira's Orion work stopped on 2026-02-01, but the record is still active (nobody closed it).
    await database.db
      .collection('assignments')
      .updateOne({ projectId: orion.id, hoursPerDay: 2 }, { $set: { to: '2026-02-01' } });
    await call(app, pat, 'POST', `/api/projects/${orion.id}/status`, { status: 'closed' });
    const mira = await database.db.collection('assignments').findOne({ projectId: orion.id, hoursPerDay: 2 });
    expect(mira).toMatchObject({ status: 'past', to: '2026-02-01' });
  });

  it('closing before anyone started rejects the whole team', async () => {
    const { pat, project } = await demo();
    const atlas = await project('Atlas');
    const res = await call(app, pat, 'POST', `/api/projects/${atlas.id}/status`, { status: 'closed' });
    expect(TransitionResponse.parse(res.json()).closed).toEqual({ ended: 0, rejected: 3 });
    const statuses = await database.db.collection('assignments').distinct('status', { projectId: atlas.id });
    expect(statuses).toEqual(['rejected']);
  });

  it('deletes a never-active project together with its assignments', async () => {
    const { pat, project } = await demo();
    const atlas = await project('Atlas');
    expect((await call(app, pat, 'DELETE', `/api/projects/${atlas.id}`, {})).statusCode).toBe(200);
    expect(await database.db.collection('assignments').countDocuments({ projectId: atlas.id })).toBe(0);
    expect(await database.db.collection('projects').countDocuments({ _id: atlas.id as never })).toBe(0);
  });

  it('never lets a team role be deleted while a project starts using it', async () => {
    for (let round = 0; round < 5; round++) {
      const { pat, person } = await demo();
      const admin = await sessionFor(pat, person('Olivia'));
      const role = (await call(app, admin, 'POST', '/api/team-roles', { name: `Role ${round}` })).json().id as string;
      const pat2 = pat;
      const [del, create] = await Promise.all([
        call(app, admin, 'DELETE', `/api/team-roles/${role}`, {}),
        call(app, pat2, 'POST', '/api/projects', newProject({ teamRoles: [{ roleId: role, count: 1 }] })),
      ]);
      const roleExists = (await database.db.collection('teamRoles').countDocuments({ _id: role as never })) === 1;
      const projectUsesIt =
        (await database.db
          .collection('projects')
          .countDocuments({ orgId: pat.info.org.id, 'teamRoles.roleId': role })) === 1;
      expect([del.statusCode, create.statusCode].sort()).toEqual(projectUsesIt ? [201, 409] : [200, 404]);
      expect(projectUsesIt ? roleExists : true).toBe(true);
    }
  });
});

describe('departments (Department-01..03)', () => {
  const depts = async (v: Visitor) => DepartmentsResponse.parse((await call(app, v, 'GET', '/api/departments')).json());

  it('shows departments, managers, members and the unassigned list', async () => {
    const { pat } = await demo();
    const r = await depts(pat);
    expect(r.canManage).toBe(false);
    expect(r.departments.map((d) => [d.name, d.manager?.name ?? null, d.members.length])).toEqual([
      ['Design', null, 1],
      ['Engineering', 'Dana Okafor', 8],
    ]);
    expect(r.unassigned.map((u) => u.name)).toEqual(['Olivia Grant', 'Pat Reyes']);
    expect(r.managerCandidates).toEqual([]);
  });

  it('lets admins manage departments and managers; one department per manager', async () => {
    const { pat, person } = await demo();
    const olivia = await as(pat, 'Olivia');
    const design = (await depts(olivia)).departments.find((d) => d.name === 'Design')!;
    expect(
      code(await call(app, olivia, 'PUT', `/api/departments/${design.id}/manager`, { managerId: person('Dana') })),
    ).toBe('VALIDATION');
    const notManager = await call(app, olivia, 'PUT', `/api/departments/${design.id}/manager`, {
      managerId: person('Pat'),
    });
    expect(notManager.json().message).toContain('Department manager role first');

    await call(app, olivia, 'PUT', `/api/org/members/${person('Noor')}/roles`, { roles: ['deptManager'] });
    expect(
      (await call(app, olivia, 'PUT', `/api/departments/${design.id}/manager`, { managerId: person('Noor') }))
        .statusCode,
    ).toBe(200);
    expect((await depts(olivia)).departments.find((d) => d.name === 'Design')!.manager!.name).toBe('Noor Haddad');

    const created = await call(app, olivia, 'POST', '/api/departments', { name: 'Data' });
    expect(created.statusCode).toBe(201);
    expect(code(await call(app, olivia, 'POST', '/api/departments', { name: 'data' }))).toBe('NAME_TAKEN');
    expect(code(await call(app, olivia, 'DELETE', `/api/departments/${design.id}`, {}))).toBe('IN_USE');
    expect((await call(app, olivia, 'DELETE', `/api/departments/${created.json().id}`, {})).statusCode).toBe(200);

    const dana = await as(olivia, 'Dana');
    expect((await call(app, dana, 'POST', '/api/departments', { name: 'Ops' })).statusCode).toBe(403);
  });

  it('keeps the Department manager role while someone still manages a department', async () => {
    const { pat, person } = await demo();
    const olivia = await as(pat, 'Olivia');
    const res = await call(app, olivia, 'PUT', `/api/org/members/${person('Dana')}/roles`, { roles: [] });
    expect(code(res)).toBe('VALIDATION');
    expect(res.json().message).toContain('manages Engineering');
    const eng = (await depts(olivia)).departments.find((d) => d.name === 'Engineering')!;
    await call(app, olivia, 'PUT', `/api/departments/${eng.id}/manager`, { managerId: null });
    expect((await call(app, olivia, 'PUT', `/api/org/members/${person('Dana')}/roles`, { roles: [] })).statusCode).toBe(
      200,
    );
  });

  it('lets a manager take unassigned people and let members go, re-routing approvals', async () => {
    const { pat, person, project } = await demo();
    const dana = await as(pat, 'Dana');
    const eng = (await depts(dana)).departments.find((d) => d.name === 'Engineering')!;
    const design = (await depts(dana)).departments.find((d) => d.name === 'Design')!;
    expect(eng.canManageMembers).toBe(true);
    expect(design.canManageMembers).toBe(false);

    expect(
      (await call(app, dana, 'POST', `/api/departments/${eng.id}/members`, { userId: person('Pat') })).statusCode,
    ).toBe(200);
    const fromOther = await call(app, dana, 'POST', `/api/departments/${eng.id}/members`, { userId: person('Noor') });
    expect(fromOther.json().message).toContain('another department');
    expect(
      (await call(app, dana, 'POST', `/api/departments/${design.id}/members`, { userId: person('Olivia') })).statusCode,
    ).toBe(403);

    // Kai's pending Atlas proposal leaves Dana's inbox when Kai leaves her department.
    const inbox = async () =>
      ((await call(app, dana, 'GET', '/api/approvals')).json() as { items: { user: { name: string } }[] }).items;
    expect((await inbox()).map((i) => i.user.name)).toContain('Kai Nakamura');
    expect(
      (await call(app, dana, 'DELETE', `/api/departments/${eng.id}/members/${person('Kai')}`, {})).statusCode,
    ).toBe(200);
    expect((await inbox()).map((i) => i.user.name)).not.toContain('Kai Nakamura');
    void project;

    // An admin can move someone straight from one department to another.
    const olivia = await as(dana, 'Olivia');
    expect(
      (await call(app, olivia, 'POST', `/api/departments/${eng.id}/members`, { userId: person('Noor') })).statusCode,
    ).toBe(200);
  });
});

describe('skills (Skill-01/02)', () => {
  const skills = async (v: Visitor) => SkillsResponse.parse((await call(app, v, 'GET', '/api/skills')).json());

  it('lets managers create skills, only authors change them, and refuses deleting what is used', async () => {
    const { pat } = await demo();
    const dana = await as(pat, 'Dana');
    const r = await skills(dana);
    expect(r.canCreate).toBe(true);
    expect(r.categories.map((c) => c.name)).toContain('Cloud');
    const cloud = r.categories.find((c) => c.name === 'Cloud')!;
    expect(r.skills.find((s) => s.name === 'AWS')).toMatchObject({ author: null, canEdit: false, inUse: true });

    const created = await call(app, dana, 'POST', '/api/skills', {
      name: 'Kubernetes',
      categoryId: cloud.id,
      description: 'Containers at scale',
    });
    expect(created.statusCode).toBe(201);
    const k8s = created.json().id as string;
    expect(code(await call(app, dana, 'POST', '/api/skills', { name: 'kubernetes', categoryId: cloud.id }))).toBe(
      'NAME_TAKEN',
    );
    expect(code(await call(app, dana, 'DELETE', `/api/skill-categories/${cloud.id}`, {}))).toBe('IN_USE');

    const olivia = await as(dana, 'Olivia');
    expect(
      (await call(app, olivia, 'PUT', `/api/skills/${k8s}`, { name: 'K8s', categoryId: cloud.id })).statusCode,
    ).toBe(403);
    const pat2 = await as(olivia, 'Pat');
    expect((await call(app, pat2, 'POST', '/api/skills', { name: 'Terraform', categoryId: cloud.id })).statusCode).toBe(
      403,
    );

    // Ana adds it to her skills: now it is in use and its author cannot delete it.
    const ana = await as(pat2, 'Ana');
    expect((await call(app, ana, 'PUT', `/api/me/skills/${k8s}`, { level: 3, experience: '1-2y' })).json()).toEqual({
      skillId: k8s,
      level: 3,
      experience: '1-2y',
      validated: true,
    });
    const dana2 = await as(ana, 'Dana');
    expect(code(await call(app, dana2, 'DELETE', `/api/skills/${k8s}`, {}))).toBe('IN_USE');
    expect(
      (await call(app, dana2, 'PUT', `/api/skills/${k8s}`, { name: 'K8s', categoryId: cloud.id })).statusCode,
    ).toBe(200);
  });

  it('lets everyone keep their own skills, which feed the matching engine', async () => {
    const { pat, project, person } = await demo();
    const jo = await sessionFor(pat, person('Jo'));
    const r = await skills(jo);
    const aws = r.skills.find((s) => s.name === 'AWS')!;
    expect(r.mine.map((m) => m.skillId)).not.toContain(aws.id);
    await call(app, jo, 'PUT', `/api/me/skills/${aws.id}`, { level: 4, experience: '2-4y' });
    await call(app, jo, 'PUT', `/api/me/skills/${aws.id}`, { level: 5, experience: '4-7y' });
    expect((await skills(jo)).mine.find((m) => m.skillId === aws.id)).toMatchObject({ level: 5, experience: '4-7y' });

    const atlas = await project('Atlas');
    const c = CandidatesResponse.parse((await call(app, jo, 'GET', `/api/projects/${atlas.id}/candidates`)).json());
    expect(c.candidates.find((x) => x.name === 'Jo Park')!.skills).toContainEqual({ skillId: aws.id, level: 5 });

    expect((await call(app, jo, 'DELETE', `/api/me/skills/${aws.id}`, {})).statusCode).toBe(200);
    expect((await call(app, jo, 'DELETE', `/api/me/skills/${aws.id}`, {})).statusCode).toBe(404);
    expect((await call(app, jo, 'PUT', '/api/me/skills/nope', { level: 2, experience: '0-6m' })).statusCode).toBe(404);
  });
});
