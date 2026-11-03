import type { CommandStartedEvent } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApprovalsResponse, CandidatesResponse, DomainError, ProjectBoard } from '@team-finder/domain';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../src/db/client.ts';
import { call, personaId, startDemo, switchTo, testApp, testDatabase, type Visitor } from './helpers.ts';

let database: Database;
let app: FastifyInstance;
beforeAll(async () => {
  database = await testDatabase('staffing-test');
  app = testApp(database);
});
afterAll(() => database?.close());

const ALL = 'includePartial=true&includeRollingOffWithinWeeks=4&includeUnavailable=true';

async function board(v: Visitor) {
  return ProjectBoard.parse((await call(app, v, 'GET', `/api/projects/${v.info.landingProjectId}`)).json());
}
async function candidates(v: Visitor, query = '') {
  const res = await call(app, v, 'GET', `/api/projects/${v.info.landingProjectId}/candidates?${query}`);
  expect(res.statusCode).toBe(200);
  return CandidatesResponse.parse(res.json());
}
async function ids(v: Visitor) {
  const b = await board(v);
  const role = (name: string) => b.roles.find((r) => r.name === name)!.id;
  const c = await candidates(v, `${ALL}&includeNearMisses=true`);
  const person = (first: string) =>
    c.candidates.find((x) => x.name.startsWith(first))?.userId ??
    b.assignments.find((a) => a.userName.startsWith(first))!.userId;
  return {
    b,
    backend: role('Backend Developer'),
    frontend: role('Frontend Developer'),
    qa: role('QA Engineer'),
    person,
  };
}
const proposal = (v: Visitor, body: Record<string, unknown>) =>
  call(app, v, 'POST', '/api/assignments', {
    projectId: v.info.landingProjectId,
    hoursPerDay: 4,
    from: '2026-03-09',
    ...body,
  });

describe('GET /api/projects/:id (board)', () => {
  it('shows Atlas half-staffed with a conflicting proposal', async () => {
    const v = await startDemo(app);
    const b = await board(v);
    expect(b.project).toMatchObject({ name: 'Atlas', startDate: '2026-03-09', deadline: '2026-06-01' });
    expect(b.canStaff).toBe(true);
    const byName = Object.fromEntries(b.assignments.map((a) => [a.userName.split(' ')[0], a]));
    expect(byName.Ana).toMatchObject({ status: 'active', check: null });
    expect(byName.Leo).toMatchObject({ status: 'proposed', check: { fits: true } });
    expect(byName.Kai).toMatchObject({
      status: 'proposed',
      check: { fits: false, worst: { date: '2026-03-09', used: 4 }, maxHours: 4 },
    });
  });
});

describe('GET /api/projects/:id/candidates', () => {
  it('defaults to fully available candidates and counts exclusions', async () => {
    const v = await startDemo(app);
    const r = await candidates(v);
    expect(r.window).toEqual({ from: '2026-03-09', to: '2026-06-01' });
    expect(r.candidates.map((c) => c.name)).toEqual(['Noor Haddad', 'Jo Park']);
    expect(r.excluded).toEqual({
      onProject: 3,
      noSkillMatch: 3, // Pat, Dana and Olivia (PM, manager, admin) hold no project skills
      belowMinLevel: 0,
      partial: 1,
      rollingOff: 1,
      unavailable: 1,
    });
    expect(r.candidates[0]!.reasons).toContainEqual({ kind: 'noApprover' });
  });

  it('ranks partial and rolling-off people with explanations and timelines', async () => {
    const v = await startDemo(app);
    const r = await candidates(v, ALL);
    expect(r.candidates.map((c) => c.name)).toEqual([
      'Tom Becker',
      'Mira Chen',
      'Ines Duarte',
      'Noor Haddad',
      'Jo Park',
    ]);
    const [tom, mira] = r.candidates;
    expect(tom!.availability).toEqual({ kind: 'rollingOff', availableFrom: '2026-03-23', weeksUntil: 2 });
    expect(tom!.reasons).toContainEqual(
      expect.objectContaining({ kind: 'rollsOff', date: '2026-03-23', projectName: 'Borealis' }),
    );
    expect(mira!.availability).toEqual({ kind: 'partial', hoursLeft: 6 });
    expect(mira!.reasons).toContainEqual(expect.objectContaining({ kind: 'pastProject', name: 'Helios' }));
    expect(mira!.timeline).toEqual([{ from: '2025-11-22', to: null, used: 2, pending: 0 }]);
    expect(mira!.points.skillFit + mira!.points.history + mira!.points.availability).toBeCloseTo(mira!.score);
  });

  it('loads ranking inputs in a constant number of queries', async () => {
    const v = await startDemo(app);
    const count = async () => {
      const seen: string[] = [];
      const listener = (e: CommandStartedEvent) => {
        const collection = e.command[e.commandName];
        if (['find', 'aggregate', 'count'].includes(e.commandName) && !['sessions', 'orgs'].includes(collection)) {
          seen.push(`${e.commandName}:${collection}`);
        }
      };
      database.client.on('commandStarted', listener);
      await candidates(v, ALL);
      database.client.off('commandStarted', listener);
      return seen.sort();
    };
    const before = await count();
    // 1 user lookup by resolveActor, 1 project read, then 4 batched ranking queries.
    expect(before).toEqual([
      'aggregate:users',
      'find:assignments',
      'find:projects',
      'find:projects',
      'find:userSkills',
      'find:users',
    ]);
    const extra = Array.from({ length: 25 }, (_, i) => ({
      _id: `extra-${v.info.org.id}-${i}`,
      orgId: v.info.org.id,
      name: `Extra ${i}`,
      email: `e${i}@x`,
      title: 'Dev',
      accessRoles: ['employee'],
      departmentId: null,
      capacityVersion: 0,
    }));
    await database.db.collection('users').insertMany(extra as never[]);
    expect(await count()).toEqual(before);
  });
});

describe('POST /api/assignments (propose)', () => {
  it('creates a proposal with its own from and the project deadline as to', async () => {
    const v = await startDemo(app);
    const { backend, person } = await ids(v);
    const res = await proposal(v, { userId: person('Mira'), slotRoleId: backend, hoursPerDay: 6, from: '2026-03-16' });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      status: 'proposed',
      from: '2026-03-16',
      to: '2026-06-01',
      hoursPerDay: 6,
      roleIds: [backend],
    });
    const b = await board(v);
    expect(b.assignments.find((a) => a.userId === person('Mira'))?.check).toEqual({
      fits: true,
      worst: { date: '2026-03-16', used: 2 },
      maxHours: 6,
    });
  });

  it('enforces slot limits, duplicates, approvers, windows and ownership', async () => {
    const v = await startDemo(app);
    const { backend, frontend, qa, person } = await ids(v);
    const code = async (body: Record<string, unknown>) => {
      const res = await proposal(v, body);
      return res.statusCode === 201 ? 'OK' : DomainError.parse(res.json()).code;
    };
    expect(await code({ userId: person('Jo'), slotRoleId: qa })).toBe('SLOT_FULL'); // Kai holds the only QA slot
    expect(await code({ userId: person('Noor'), slotRoleId: frontend })).toBe('NO_APPROVER');
    expect(await code({ userId: person('Leo'), slotRoleId: frontend })).toBe('DUPLICATE_ASSIGNMENT');
    expect(await code({ userId: person('Jo'), slotRoleId: backend, from: '2026-03-08' })).toBe('VALIDATION');
    expect(await code({ userId: person('Jo'), slotRoleId: backend, from: '2026-06-01' })).toBe('VALIDATION');
    expect(await code({ userId: person('Jo'), slotRoleId: backend, hoursPerDay: 9 })).toBe('VALIDATION');
    expect(await code({ userId: person('Jo'), slotRoleId: backend, roleIds: ['not-a-role'] })).toBe('NOT_FOUND');
    expect(await code({ userId: person('Jo'), slotRoleId: backend })).toBe('OK');
    // Backend had Ana + one open slot; a third person does not fit.
    expect(await code({ userId: person('Tom'), slotRoleId: backend, from: '2026-03-23' })).toBe('SLOT_FULL');
  });

  it('allows only the project manager of the project to propose', async () => {
    const pm = await startDemo(app);
    const { backend, person } = await ids(pm);
    const dm = await switchTo(app, pm, personaId(pm, 'Dana'));
    const res = await proposal(dm, { userId: person('Jo'), slotRoleId: backend });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('FORBIDDEN');
  });
});

describe('approvals', () => {
  it('lists proposals for the manager with a capacity preview, and is forbidden for others', async () => {
    const pm = await startDemo(app);
    expect((await call(app, pm, 'GET', '/api/approvals')).statusCode).toBe(403);
    const dm = await switchTo(app, pm, personaId(pm, 'Dana'));
    const r = ApprovalsResponse.parse((await call(app, dm, 'GET', '/api/approvals')).json());
    expect(r.items.map((i) => [i.user.name, i.slotRole.name, i.check?.fits])).toEqual([
      ['Leo Martin', 'Frontend Developer', true],
      ['Kai Nakamura', 'QA Engineer', false],
    ]);
  });

  it('approves a fitting proposal and bumps capacityVersion and project version', async () => {
    const pm = await startDemo(app);
    const dm = await switchTo(app, pm, personaId(pm, 'Dana'));
    const leo = ApprovalsResponse.parse((await call(app, dm, 'GET', '/api/approvals')).json()).items[0]!;
    const projectBefore = await database.db.collection('projects').findOne({ _id: leo.project.id as never });
    const res = await call(app, dm, 'POST', `/api/assignments/${leo.assignmentId}/approve`, { version: leo.version });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'active', from: '2026-03-09', to: '2026-06-01', version: 1 });
    expect((await database.db.collection('users').findOne({ _id: leo.user.id as never }))?.capacityVersion).toBe(1);
    expect((await database.db.collection('projects').findOne({ _id: leo.project.id as never }))?.version).toBe(
      projectBefore!.version + 1,
    );

    // Same click again (e.g. another tab): stale.
    const again = await call(app, dm, 'POST', `/api/assignments/${leo.assignmentId}/approve`, { version: leo.version });
    expect(again.statusCode).toBe(409);
    expect(DomainError.parse(again.json())).toMatchObject({
      code: 'CONFLICT_STALE',
      message: 'This proposal was already approved.',
    });
  });

  it('refuses an overbooking approval with the exact date and hours', async () => {
    const pm = await startDemo(app);
    const dm = await switchTo(app, pm, personaId(pm, 'Dana'));
    const kai = ApprovalsResponse.parse((await call(app, dm, 'GET', '/api/approvals')).json()).items[1]!;
    const res = await call(app, dm, 'POST', `/api/assignments/${kai.assignmentId}/approve`, { version: kai.version });
    expect(res.statusCode).toBe(409);
    expect(DomainError.parse(res.json())).toEqual({
      code: 'CAPACITY_EXCEEDED',
      details: { userId: kai.user.id, date: '2026-03-09', used: 4, requested: 6, maxHours: 4 },
      message: 'Would exceed 8 h/day on 2026-03-09: 4 h already booked, 6 h requested.',
      hint: 'The most you can request from 2026-03-09 is 4 h/day.',
    });
    // Rejecting it still works.
    const rejected = await call(app, dm, 'POST', `/api/assignments/${kai.assignmentId}/reject`, {
      version: kai.version,
    });
    expect(rejected.json()).toMatchObject({ status: 'rejected' });
    const after = ApprovalsResponse.parse((await call(app, dm, 'GET', '/api/approvals')).json());
    expect(after.items.map((i) => i.user.name)).toEqual(['Leo Martin']);
  });

  it('resolves the approver at decision time: moving an employee re-routes their proposals', async () => {
    const pm = await startDemo(app);
    const dm = await switchTo(app, pm, personaId(pm, 'Dana'));
    const leo = ApprovalsResponse.parse((await call(app, dm, 'GET', '/api/approvals')).json()).items[0]!;
    const design = await database.db.collection('departments').findOne({ orgId: pm.info.org.id, name: 'Design' });
    await database.db
      .collection('users')
      .updateOne({ _id: leo.user.id as never }, { $set: { departmentId: design!._id } });
    const list = ApprovalsResponse.parse((await call(app, dm, 'GET', '/api/approvals')).json());
    expect(list.items.map((i) => i.user.name)).toEqual(['Kai Nakamura']);
    const res = await call(app, dm, 'POST', `/api/assignments/${leo.assignmentId}/approve`, { version: leo.version });
    expect(res.statusCode).toBe(403);
  });

  it('never decides on another org proposals (tenant isolation)', async () => {
    const a = await startDemo(app);
    const b = await startDemo(app);
    const { backend } = await ids(b);
    const aDm = await switchTo(app, a, personaId(a, 'Dana'));
    const bDm = await switchTo(app, b, personaId(b, 'Dana'));
    const item = ApprovalsResponse.parse((await call(app, aDm, 'GET', '/api/approvals')).json()).items[0]!;
    const res = await call(app, bDm, 'POST', `/api/assignments/${item.assignmentId}/approve`, {
      version: item.version,
    });
    expect(res.statusCode).toBe(404);
    const bPm = await switchTo(app, bDm, personaId(b, 'Pat'));
    const crossUser = await proposal(bPm, { userId: item.user.id, slotRoleId: backend });
    expect(crossUser.statusCode).toBe(404);
    expect((await call(app, bPm, 'GET', `/api/projects/${a.info.landingProjectId}/candidates`)).statusCode).toBe(404);
  });
});
