import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CandidatesResponse,
  DomainError,
  ProjectBoard,
  ScenarioCommitResponse,
  SnapshotCreated,
  SnapshotView,
} from '@team-finder/domain';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../src/db/client.ts';
import { NOW, call, personaId, startDemo, switchTo, testApp, testDatabase, type Visitor } from './helpers.ts';

// M1.5 staffing decisions: scrubbed candidates, atomic scenario commit, share snapshots.
// Fixed clock (helpers.NOW = 2026-03-02): Atlas runs 2026-03-09 .. 2026-06-01, Borealis (Tom, 8 h)
// ends 2026-03-23, i.e. two weeks into Atlas.

let database: Database;
let app: FastifyInstance;
beforeAll(async () => {
  database = await testDatabase('scenarios-test');
  app = testApp(database);
});
afterAll(() => database?.close());

const ALL = 'includePartial=true&includeRollingOffWithinWeeks=6&includeUnavailable=true&includeNearMisses=true';

async function setup() {
  const v = await startDemo(app);
  const atlas = v.info.landingProjectId!;
  const b = ProjectBoard.parse((await call(app, v, 'GET', `/api/projects/${atlas}`)).json());
  const role = (name: string) => b.roles.find((r) => r.name === name)!.id;
  const users = await database.db
    .collection<{ _id: string; name: string; capacityVersion: number }>('users')
    .find({ orgId: v.info.org.id })
    .toArray();
  const person = (first: string) => users.find((u) => u.name.startsWith(first))!._id;
  return {
    v,
    atlas,
    board: b,
    backend: role('Backend Developer'),
    frontend: role('Frontend Developer'),
    qa: role('QA Engineer'),
    person,
  };
}

const commit = (v: Visitor, projectId: string, body: Record<string, unknown>) =>
  call(app, v, 'POST', `/api/projects/${projectId}/scenarios/commit`, body);

const project = (orgId: string, name = 'Atlas') =>
  database.db
    .collection<{ startDate: string; deadline: string | null; version: number }>('projects')
    .findOne({ orgId, name });
const atlasAssignments = async (orgId: string, projectId: string) =>
  database.db
    .collection<{ userId: string; status: string; from: string; to: string | null; version: number }>('assignments')
    .find({ orgId, projectId })
    .toArray();

describe('scrubbing (board + candidates)', () => {
  it('exposes the scrub range and each member’s load on other projects', async () => {
    const { board, person } = await setup();
    expect(board.scrub).toEqual({ from: '2026-03-09', to: '2026-04-20' });
    const kai = board.assignments.find((a) => a.userId === person('Kai'))!;
    expect(kai.timeline).toEqual([{ from: '2025-12-02', to: null, used: 4, pending: 0 }]);
  });

  it('re-ranks as if the project started later: Tom goes from rolling off to available', async () => {
    const { v, atlas, person } = await setup();
    const get = async (q: string) =>
      CandidatesResponse.parse((await call(app, v, 'GET', `/api/projects/${atlas}/candidates?${q}`)).json());
    const now = await get(ALL);
    const later = await get(`${ALL}&start=2026-03-23`);
    const tom = (r: typeof now) => r.candidates.find((c) => c.userId === person('Tom'))!;
    expect(tom(now).availability).toMatchObject({ kind: 'rollingOff', availableFrom: '2026-03-23' });
    expect(later.window).toEqual({ from: '2026-03-23', to: '2026-06-15' });
    expect(tom(later).availability).toEqual({ kind: 'available', hoursLeft: 8 });
    // The timeline covers the whole scrub range, so the client can re-classify without a refetch.
    expect(tom(now).timeline).toEqual(tom(later).timeline);
  });

  it.each(['2026-03-08', '2026-04-21', 'tomorrow'])('rejects start=%s', async (start) => {
    const { v, atlas } = await setup();
    const res = await call(app, v, 'GET', `/api/projects/${atlas}/candidates?start=${start}`);
    expect(res.statusCode).toBe(400);
    expect(DomainError.parse(res.json()).code).toBe('VALIDATION');
  });
});

describe('POST /api/projects/:id/scenarios/commit', () => {
  it('moves the project with its team, then proposes the draft, in one transaction', async () => {
    const { v, atlas, backend, person } = await setup();
    const before = await project(v.info.org.id);
    const res = await commit(v, atlas, {
      start: '2026-03-23',
      additions: [{ userId: person('Tom'), slotRoleId: backend, hoursPerDay: 8 }],
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = ScenarioCommitResponse.parse(res.json());
    expect(body.project).toEqual({ startDate: '2026-03-23', deadline: '2026-06-15' });
    expect(body.moved).toBe(3);
    expect(body.created).toEqual([
      expect.objectContaining({ userId: person('Tom'), status: 'proposed', from: '2026-03-23', to: '2026-06-15' }),
    ]);

    const after = await project(v.info.org.id);
    expect(after!.version).toBe(before!.version + 1);
    const rows = await atlasAssignments(v.info.org.id, atlas);
    for (const a of rows) expect([a.from, a.to]).toEqual(['2026-03-23', '2026-06-15']);
    // Ana's active hours moved: her capacity changed, so her capacityVersion is bumped.
    const ana = await database.db.collection('users').findOne({ _id: person('Ana') as never });
    expect(ana!.capacityVersion).toBe(1);
  });

  it('proposes without moving when the start is unchanged', async () => {
    const { v, atlas, board, backend, person } = await setup();
    const res = await commit(v, atlas, {
      start: board.project.startDate,
      additions: [{ userId: person('Mira'), slotRoleId: backend, hoursPerDay: 6 }],
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(ScenarioCommitResponse.parse(res.json())).toMatchObject({ moved: 0, project: { startDate: '2026-03-09' } });
  });

  it('rolls everything back when a later proposal fails, and names the slot', async () => {
    const { v, atlas, backend, person } = await setup();
    // Backend has 2 slots and Ana holds one: Tom fits, Mira does not. The start move must be undone too.
    const res = await commit(v, atlas, {
      start: '2026-03-23',
      additions: [
        { userId: person('Tom'), slotRoleId: backend, hoursPerDay: 8 },
        { userId: person('Mira'), slotRoleId: backend, hoursPerDay: 6 },
      ],
    });
    expect(res.statusCode).toBe(409);
    expect(DomainError.parse(res.json())).toMatchObject({ code: 'SLOT_FULL', details: { slotRoleId: backend } });
    expect(await project(v.info.org.id)).toMatchObject({ startDate: '2026-03-09', version: 0 });
    const rows = await atlasAssignments(v.info.org.id, atlas);
    expect(rows).toHaveLength(3);
    expect(rows.every((a) => a.from === '2026-03-09' && a.version === 0)).toBe(true);
  });

  it.each([
    ['the same person twice in the draft', 'Tom', 'Tom', 'DUPLICATE_ASSIGNMENT'],
    ['someone already on the team', 'Ana', null, 'DUPLICATE_ASSIGNMENT'],
    ['a person without an approver', 'Noor', null, 'NO_APPROVER'],
  ] as const)('refuses %s', async (_name, first, second, code) => {
    const { v, atlas, frontend, person } = await setup();
    const additions = [first, second]
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .map((p) => ({ userId: person(p), slotRoleId: frontend, hoursPerDay: 4 }));
    const res = await commit(v, atlas, { start: '2026-03-09', additions });
    expect(res.statusCode, res.body).toBe(409);
    expect(DomainError.parse(res.json())).toMatchObject({ code, details: { slotRoleId: frontend } });
    expect((await atlasAssignments(v.info.org.id, atlas)).length).toBe(3);
  });

  it('re-checks active hours when moving the start (invariant 1)', async () => {
    const { v, atlas, backend, person } = await setup();
    const orion = await database.db.collection('projects').findOne({ orgId: v.info.org.id, name: 'Orion' });
    // Ana is 8 h on Atlas until 06-01 and starts 4 h on Orion that day; moving Atlas 2 weeks overlaps them.
    await database.db.collection('assignments').insertOne({
      _id: 'ana-orion' as never,
      orgId: v.info.org.id,
      userId: person('Ana'),
      projectId: orion!._id,
      slotRoleId: backend,
      roleIds: [backend],
      hoursPerDay: 4,
      status: 'active',
      from: '2026-06-01',
      to: null,
      version: 0,
    });
    const res = await commit(v, atlas, { start: '2026-03-23', additions: [] });
    expect(res.statusCode).toBe(409);
    expect(DomainError.parse(res.json())).toMatchObject({
      code: 'CAPACITY_EXCEEDED',
      details: { userId: person('Ana'), date: '2026-06-01', used: 4, slotRoleId: backend },
    });
    expect(await project(v.info.org.id)).toMatchObject({ startDate: '2026-03-09' });
  });

  it('lets exactly one of two concurrent drafts take the last slot', async () => {
    const { v, atlas, backend, person } = await setup();
    const results = await Promise.all(
      ['Tom', 'Mira'].map((p) =>
        commit(v, atlas, {
          start: '2026-03-09',
          additions: [{ userId: person(p), slotRoleId: backend, hoursPerDay: 4 }],
        }),
      ),
    );
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.statusCode === 409)!.json().code).toBe('SLOT_FULL');
  });

  it.each([
    ['outside the scrub range', '2026-04-21', 400],
    ['a draft that changes nothing', '2026-03-09', 400],
  ])('refuses %s', async (_name, start, status) => {
    const { v, atlas } = await setup();
    expect((await commit(v, atlas, { start, additions: [] })).statusCode).toBe(status);
  });

  it('refuses to move a project that has started, and refuses non-PMs', async () => {
    const { v, person, backend } = await setup();
    const orion = await database.db.collection('projects').findOne({ orgId: v.info.org.id, name: 'Orion' });
    expect((await commit(v, String(orion!._id), { start: '2026-03-16', additions: [] })).statusCode).toBe(400);

    const dana = await switchTo(app, v, personaId(v, 'Dana'));
    const res = await commit(dana, v.info.landingProjectId!, {
      start: '2026-03-09',
      additions: [{ userId: person('Tom'), slotRoleId: backend, hoursPerDay: 4 }],
    });
    expect(res.statusCode).toBe(403);
  });

  it('is backed by a unique index on open assignments per person and project', async () => {
    const { v, atlas, person } = await setup();
    const row = { orgId: v.info.org.id, projectId: atlas, userId: person('Ana'), status: 'proposed' };
    await expect(database.db.collection('assignments').insertOne({ ...row })).rejects.toThrow(
      /org_project_user_open_unique/,
    );
    // Terminal rows are not constrained.
    await database.db.collection('assignments').insertOne({ ...row, status: 'rejected' });
    await database.db.collection('assignments').insertOne({ ...row, status: 'rejected' });
  });
});

describe('share snapshots', () => {
  async function share(v: Visitor, body: Record<string, unknown>) {
    const res = await call(app, v, 'POST', '/api/snapshots', body);
    expect(res.statusCode, res.body).toBe(201);
    return SnapshotCreated.parse(res.json()).id;
  }

  it('stores a server-rebuilt draft that anyone with the link can read; same draft, same link', async () => {
    const { v, atlas, backend, person } = await setup();
    const draft = {
      projectId: atlas,
      start: '2026-03-23',
      additions: [{ userId: person('Tom'), slotRoleId: backend, hoursPerDay: 8 }],
    };
    // Forged fields are dropped by the schema; names and the verdict come from the database.
    const id = await share(v, { ...draft, sentence: 'Everything is perfect', verdict: { b: { coverage: 1 } } });
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(await share(v, draft)).toBe(id);

    const res = await call(app, null, 'GET', `/api/snapshots/${id}`);
    expect(res.statusCode, res.body).toBe(200);
    const snap = SnapshotView.parse(res.json());
    expect(snap).toMatchObject({
      orgName: 'Northwind Labs',
      isDemo: true,
      project: { name: 'Atlas', startDate: '2026-03-23', deadline: '2026-06-15' },
      sentence: 'Draft vs current: start +2 wk → coverage 83% → 100%, +0 overbooked days, 1 slot open',
      missingSkills: [],
    });
    expect(snap.expiresAt).toBe(new Date(NOW.getTime() + 30 * 86_400_000).toISOString());
    expect(snap.slots.find((s) => s.roleName === 'Backend Developer')!.members).toEqual([
      { name: 'Ana Silva', hoursPerDay: 8, status: 'active' },
      { name: 'Tom Becker', hoursPerDay: 8, status: 'draft' },
    ]);
  });

  it('says so when Tom would start before Borealis ends', async () => {
    const { v, atlas, backend, person } = await setup();
    const id = await share(v, {
      projectId: atlas,
      start: '2026-03-09',
      additions: [{ userId: person('Tom'), slotRoleId: backend, hoursPerDay: 8 }],
    });
    const snap = SnapshotView.parse((await call(app, null, 'GET', `/api/snapshots/${id}`)).json());
    expect(snap.sentence).toBe('Draft vs current: same start → coverage 83% → 100%, +14 overbooked days, 1 slot open');
  });

  it('refuses employees, oversized bodies and unknown people', async () => {
    const { v, atlas, backend, person } = await setup();
    const huge = { projectId: atlas, start: '2026-03-09', additions: [], padding: 'x'.repeat(70 * 1024) };
    expect((await call(app, v, 'POST', '/api/snapshots', huge)).statusCode).toBe(400);

    const ghost = {
      projectId: atlas,
      start: '2026-03-09',
      additions: [{ userId: 'nobody', slotRoleId: backend, hoursPerDay: 4 }],
    };
    expect((await call(app, v, 'POST', '/api/snapshots', ghost)).statusCode).toBe(404);

    const tom = { userId: person('Tom'), slotRoleId: backend, hoursPerDay: 4 };
    const ana = await switchTo(app, v, personaId(v, 'Ana'));
    expect(
      (await call(app, ana, 'POST', '/api/snapshots', { projectId: atlas, start: '2026-03-09', additions: [tom] }))
        .statusCode,
    ).toBe(403);
  });

  it('gates real-org snapshots by session and org, and expires exactly', async () => {
    const { v, atlas } = await setup();
    const id = await share(v, { projectId: atlas, start: '2026-03-16', additions: [] });
    const snapshots = database.db.collection<{ _id: string }>('snapshots');

    await snapshots.updateOne({ _id: id }, { $set: { isDemo: false } });
    expect((await call(app, null, 'GET', `/api/snapshots/${id}`)).statusCode).toBe(401);
    const other = await startDemo(app);
    expect((await call(app, other, 'GET', `/api/snapshots/${id}`)).statusCode).toBe(403);
    expect((await call(app, v, 'GET', `/api/snapshots/${id}`)).statusCode).toBe(200);
    // Same org, but an employee may not see who is allocated where.
    const ana = await switchTo(app, v, personaId(v, 'Ana'));
    expect((await call(app, ana, 'GET', `/api/snapshots/${id}`)).statusCode).toBe(403);

    // The TTL monitor can lag by a minute: a document past expiresAt must already read as gone.
    await snapshots.updateOne({ _id: id }, { $set: { isDemo: true, expiresAt: new Date(NOW.getTime() - 1000) } });
    expect((await call(app, null, 'GET', `/api/snapshots/${id}`)).statusCode).toBe(404);
    expect((await call(app, null, 'GET', '/api/snapshots/does-not-exist')).statusCode).toBe(404);
  });

  it('outlives the sandbox it came from', async () => {
    const { v, atlas } = await setup();
    const id = await share(v, { projectId: atlas, start: '2026-03-16', additions: [] });
    for (const c of ['orgs', 'sessions', 'users', 'projects', 'assignments']) {
      await database.db
        .collection(c)
        .deleteMany(c === 'orgs' ? { _id: v.info.org.id as never } : { orgId: v.info.org.id });
    }
    expect((await call(app, null, 'GET', `/api/snapshots/${id}`)).statusCode).toBe(200);
  });
});
