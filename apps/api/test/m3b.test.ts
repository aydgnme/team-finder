import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ApprovalsResponse,
  CandidatesResponse,
  DepartmentProjects,
  DomainError,
  NoApproverResponse,
  PersonProjects,
  ProjectDetails,
  ProjectsResponse,
} from '@team-finder/domain';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { Database } from '../src/db/client.ts';
import { call, startDemo, testApp, testDatabase, type Visitor } from './helpers.ts';

// M3b: date edits that clamp the team, deallocation (Project-04/05), views (Project-06..09) and the
// admin "no approver" list. Fixed clock (helpers.NOW = 2026-03-02). Atlas runs 2026-03-09 ..
// 2026-06-01 (Ana active 8 h; Leo and Kai proposed); Orion is ongoing and in progress (Kai 4 h, Mira
// 2 h active); Borealis ends 2026-03-23 (Tom 8 h). Pat is every project's PM, Dana manages Engineering.

let database: Database;
let app: FastifyInstance;
beforeAll(async () => {
  database = await testDatabase('m3b-test');
  app = testApp(database);
});
afterAll(() => database?.close());

const code = (res: LightMyRequestResponse) => DomainError.parse(res.json()).code;

/** An independent session for any user of the sandbox. */
async function sessionFor(v: Visitor, userId: string): Promise<Visitor> {
  const id = `t-${Math.random().toString(36).slice(2)}`;
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
  const users = await database.db
    .collection<{ _id: string; name: string; capacityVersion: number }>('users')
    .find({ orgId: pat.info.org.id })
    .toArray();
  const person = (first: string) => users.find((u) => u.name.startsWith(first))!._id;
  const as = (first: string) => sessionFor(pat, person(first));
  const projects = ProjectsResponse.parse((await call(app, pat, 'GET', '/api/projects')).json()).projects;
  const project = (name: string) => projects.find((p) => p.name === name)!;
  const rows = (projectId: string) =>
    database.db
      .collection<{
        userId: string;
        status: string;
        from: string;
        to: string | null;
        version: number;
        hoursPerDay: number;
      }>('assignments')
      .find({ projectId })
      .toArray();
  const row = async (projectId: string, first: string) =>
    (await rows(projectId)).find((a) => a.userId === person(first))!;
  const capacity = async (first: string) =>
    (await database.db.collection('users').findOne({ _id: person(first) as never }))!.capacityVersion as number;
  return { pat, person, as, project, rows, row, capacity };
}

describe('date edits clamp the team (design.md)', () => {
  it('moves everyone with a later start and a later deadline, and re-checks their hours', async () => {
    const { pat, project, rows, capacity } = await demo();
    const atlas = project('Atlas');
    const before = await capacity('Ana');
    const res = await call(app, pat, 'PATCH', `/api/projects/${atlas.id}`, {
      startDate: '2026-03-23',
      deadline: '2026-06-15',
    });
    expect(res.statusCode, res.body).toBe(200);
    for (const a of await rows(atlas.id)) expect([a.from, a.to]).toEqual(['2026-03-23', '2026-06-15']);
    expect(await capacity('Ana')).toBe(before + 1);
  });

  it('cuts every full-length allocation at an earlier deadline', async () => {
    const { pat, project, rows } = await demo();
    const atlas = project('Atlas');
    await call(app, pat, 'PATCH', `/api/projects/${atlas.id}`, { deadline: '2026-05-01' });
    for (const a of await rows(atlas.id)) expect([a.from, a.to]).toEqual(['2026-03-09', '2026-05-01']);
  });

  it('refuses dates that overbook someone or start their work after the deadline, naming them all', async () => {
    const { pat, project, person, rows, as } = await demo();
    const atlas = project('Atlas');
    const orion = project('Orion');
    // Ana starts 4 h on Orion the day Atlas currently ends: a later deadline would overbook her.
    await database.db.collection('assignments').insertOne({
      orgId: pat.info.org.id,
      userId: person('Ana'),
      projectId: orion.id,
      slotRoleId: orion.teamRoles[0]!.roleId,
      roleIds: [orion.teamRoles[0]!.roleId],
      hoursPerDay: 4,
      status: 'active',
      from: '2026-06-01',
      to: null,
      version: 0,
    });
    // Mira is proposed from April: a deadline in March would leave her nothing.
    const backend = atlas.teamRoles.find((r) => r.count === 2)!.roleId;
    const pm = await as('Pat');
    expect(
      (
        await call(app, pm, 'POST', '/api/assignments', {
          projectId: atlas.id,
          userId: person('Mira'),
          slotRoleId: backend,
          hoursPerDay: 2,
          from: '2026-04-01',
        })
      ).statusCode,
    ).toBe(201);
    const snapshot = JSON.stringify(await rows(atlas.id));

    const late = await call(app, pat, 'PATCH', `/api/projects/${atlas.id}`, { deadline: '2026-06-15' });
    expect(DomainError.parse(late.json())).toMatchObject({
      code: 'DATE_EDIT_CONFLICT',
      details: { conflicts: [{ name: 'Ana Silva', reason: 'overbooked', date: '2026-06-01' }] },
    });
    const early = await call(app, pat, 'PATCH', `/api/projects/${atlas.id}`, { deadline: '2026-03-25' });
    expect(DomainError.parse(early.json())).toMatchObject({
      code: 'DATE_EDIT_CONFLICT',
      details: { conflicts: [{ name: 'Mira Chen', reason: 'startsAfterDeadline', date: null }] },
    });
    expect(early.json().message).toBe('These dates do not work for Mira Chen (starts after the new deadline).');
    expect(JSON.stringify(await rows(atlas.id))).toBe(snapshot);
  });

  it('moves the start only before the project starts, never into the past; the deadline moves later', async () => {
    const { pat, project, row } = await demo();
    const orion = project('Orion');
    expect(code(await call(app, pat, 'PATCH', `/api/projects/${orion.id}`, { startDate: '2026-03-30' }))).toBe(
      'VALIDATION',
    );
    const atlas = project('Atlas');
    expect(code(await call(app, pat, 'PATCH', `/api/projects/${atlas.id}`, { startDate: '2026-03-01' }))).toBe(
      'VALIDATION',
    );
    // Borealis is under way: its deadline still moves, and Tom's allocation follows it.
    const borealis = project('Borealis');
    expect((await call(app, pat, 'PATCH', `/api/projects/${borealis.id}`, { deadline: '2026-03-30' })).statusCode).toBe(
      200,
    );
    expect((await row(borealis.id, 'Tom')).to).toBe('2026-03-30');
  });
});

describe('deallocation (Project-04/05)', () => {
  it('the PM asks, the manager agrees: the work ends today and the hours are free', async () => {
    const { pat, project, row, as, capacity } = await demo();
    const orion = project('Orion');
    const mira = await row(orion.id, 'Mira');
    const assignmentId = String((mira as unknown as { _id: string })._id);
    const res = await call(app, pat, 'POST', `/api/assignments/${assignmentId}/deallocate`, {
      version: mira.version,
      reason: 'Moving to Atlas',
    });
    expect(res.json()).toMatchObject({ status: 'deallocationProposed' });

    const dana = await as('Dana');
    const item = ApprovalsResponse.parse((await call(app, dana, 'GET', '/api/approvals')).json()).items.find(
      (i) => i.assignmentId === assignmentId,
    )!;
    expect(item).toMatchObject({
      kind: 'deallocation',
      reason: 'Moving to Atlas',
      check: null,
      user: { name: 'Mira Chen' },
    });

    const before = await capacity('Mira');
    expect(
      (await call(app, dana, 'POST', `/api/assignments/${assignmentId}/approve`, { version: item.version })).json(),
    ).toMatchObject({
      status: 'past',
      to: '2026-03-02',
    });
    expect(await capacity('Mira')).toBe(before + 1);

    // Mira's 2 h are gone: for Atlas she is now fully available.
    const atlas = project('Atlas');
    const c = CandidatesResponse.parse((await call(app, pat, 'GET', `/api/projects/${atlas.id}/candidates`)).json());
    expect(c.candidates.find((x) => x.name === 'Mira Chen')!.availability).toEqual({ kind: 'available', hoursLeft: 8 });
  });

  it('the manager can say no: the assignment is active again', async () => {
    const { pat, project, row, as } = await demo();
    const orion = project('Orion');
    const kai = await row(orion.id, 'Kai');
    const id = String((kai as unknown as { _id: string })._id);
    await call(app, pat, 'POST', `/api/assignments/${id}/deallocate`, { version: kai.version, reason: 'Budget cut' });
    const dana = await as('Dana');
    const res = await call(app, dana, 'POST', `/api/assignments/${id}/reject`, { version: kai.version + 1 });
    expect(res.json()).toMatchObject({ status: 'active' });
    expect(await row(orion.id, 'Kai')).toMatchObject({ status: 'active', deallocationReason: null });
  });

  it('only the PM asks, only for active work, and only on the latest version', async () => {
    const { pat, project, row, as } = await demo();
    const orion = project('Orion');
    const kai = await row(orion.id, 'Kai');
    const id = String((kai as unknown as { _id: string })._id);
    const dana = await as('Dana');
    expect(
      (await call(app, dana, 'POST', `/api/assignments/${id}/deallocate`, { version: kai.version, reason: 'Not mine' }))
        .statusCode,
    ).toBe(403);
    expect(
      code(
        await call(app, pat, 'POST', `/api/assignments/${id}/deallocate`, {
          version: kai.version + 5,
          reason: 'Old view',
        }),
      ),
    ).toBe('CONFLICT_STALE');
    expect(
      (await call(app, pat, 'POST', `/api/assignments/${id}/deallocate`, { version: kai.version, reason: 'x' }))
        .statusCode,
    ).toBe(400);
    const atlas = project('Atlas');
    const leo = await row(atlas.id, 'Leo');
    const leoId = String((leo as unknown as { _id: string })._id);
    expect(
      code(
        await call(app, pat, 'POST', `/api/assignments/${leoId}/deallocate`, {
          version: leo.version,
          reason: 'Not started',
        }),
      ),
    ).toBe('VALIDATION');
  });
});

describe('views (Project-06..09)', () => {
  it('shows a project with its team as proposed, active and past', async () => {
    const { pat, project, as } = await demo();
    const atlas = project('Atlas');
    const kai = await as('Kai');
    const d = ProjectDetails.parse((await call(app, kai, 'GET', `/api/projects/${atlas.id}/details`)).json());
    expect(d.project).toMatchObject({ name: 'Atlas', canEdit: false });
    expect(d.techStack.map((s) => s.name)).toEqual(expect.arrayContaining(['Node.js', 'React']));
    expect(d.team.proposed.map((m) => m.name)).toEqual(['Leo Martin', 'Kai Nakamura']);
    expect(d.team.active.map((m) => [m.name, m.roleName])).toEqual([['Ana Silva', 'Backend Developer']]);
    expect(d.team.past).toEqual([]);
    void pat;
  });

  it("shows someone's projects to them, their manager and admins only", async () => {
    const { person, as } = await demo();
    const url = `/api/people/${person('Ana')}/projects`;
    const ana = await as('Ana');
    const p = PersonProjects.parse((await call(app, ana, 'GET', url)).json());
    expect(p.person).toMatchObject({ name: 'Ana Silva', departmentName: 'Engineering' });
    expect(p.current.map((r) => [r.projectName, r.status])).toEqual([['Atlas', 'active']]);
    expect(p.past.map((r) => r.projectName)).toEqual(['Helios']);
    for (const [first, status] of [
      ['Dana', 200],
      ['Olivia', 200],
      ['Kai', 403],
      ['Pat', 403],
    ] as const) {
      expect((await call(app, await as(first), 'GET', url)).statusCode, first).toBe(status);
    }
  });

  it("shows a department's projects to its manager, filtered by status", async () => {
    const { pat, as } = await demo();
    const dana = await as('Dana');
    const depts = (await call(app, dana, 'GET', '/api/departments')).json() as {
      departments: { id: string; name: string }[];
    };
    const eng = depts.departments.find((d) => d.name === 'Engineering')!;
    const design = depts.departments.find((d) => d.name === 'Design')!;
    const all = DepartmentProjects.parse((await call(app, dana, 'GET', `/api/departments/${eng.id}/projects`)).json());
    expect(all.projects.map((p) => p.name)).toEqual(['Atlas', 'Borealis', 'Cobalt', 'Helios', 'Orion']);
    expect(all.projects.find((p) => p.name === 'Atlas')!.members.map((m) => m.name)).toEqual([
      'Ana Silva',
      'Leo Martin',
      'Kai Nakamura',
    ]);
    const running = DepartmentProjects.parse(
      (await call(app, dana, 'GET', `/api/departments/${eng.id}/projects?status=inProgress`)).json(),
    );
    expect(running.projects.map((p) => p.name)).toEqual(['Cobalt', 'Orion']);
    expect((await call(app, dana, 'GET', `/api/departments/${eng.id}/projects?status=whatever`)).statusCode).toBe(400);
    expect((await call(app, dana, 'GET', `/api/departments/${design.id}/projects`)).statusCode).toBe(403);
    expect((await call(app, pat, 'GET', `/api/departments/${eng.id}/projects`)).statusCode).toBe(403);
  });

  it('lists pending items nobody can decide, for admins', async () => {
    const { pat, person, as } = await demo();
    const dana = await as('Dana');
    const depts = (await call(app, dana, 'GET', '/api/departments')).json() as {
      departments: { id: string; name: string }[];
    };
    const eng = depts.departments.find((d) => d.name === 'Engineering')!;
    const olivia = await as('Olivia');
    expect(NoApproverResponse.parse((await call(app, olivia, 'GET', '/api/org/no-approver')).json()).items).toEqual([]);
    await call(app, dana, 'DELETE', `/api/departments/${eng.id}/members/${person('Kai')}`, {});
    const items = NoApproverResponse.parse((await call(app, olivia, 'GET', '/api/org/no-approver')).json()).items;
    expect(items).toEqual([
      expect.objectContaining({
        kind: 'proposal',
        user: { id: person('Kai'), name: 'Kai Nakamura' },
        project: expect.objectContaining({ name: 'Atlas' }),
      }),
    ]);
    expect((await call(app, pat, 'GET', '/api/org/no-approver')).statusCode).toBe(403);
  });
});
