import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DepartmentsResponse, DepartmentStats, DomainError } from '@team-finder/domain';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { Database } from '../src/db/client.ts';
import { call, personaId, startDemo, switchTo, testApp, testDatabase, type Visitor } from './helpers.ts';

// M5: Stats-01 and the 60-person seed. Engineering (Dana) holds Ana, Leo, Mira, Tom, Ines, Kai and
// Jo; Jo's Go claim is still pending, so it never counts.

let database: Database;
let app: FastifyInstance;
beforeAll(async () => {
  database = await testDatabase('m5-test');
  app = testApp(database);
});
afterAll(() => database?.close());

const code = (res: LightMyRequestResponse) => DomainError.parse(res.json()).code;
const as = (v: Visitor, first: string) => switchTo(app, v, personaId(v, first));

describe('the 60-person seed', () => {
  it('clones a whole company in well under 2 s', async () => {
    const started = performance.now();
    const v = await startDemo(app);
    expect(performance.now() - started).toBeLessThan(2_000);
    const count = (c: string) => database.db.collection(c).countDocuments({ orgId: v.info.org.id });
    expect(await count('users')).toBe(60);
    expect(await count('projects')).toBe(12);
    // Everyone belongs to a department except the PMs and the admin; Noor's Design has no manager.
    const homeless = await database.db
      .collection<{ name: string }>('users')
      .find({ orgId: v.info.org.id, departmentId: null })
      .toArray();
    expect(homeless.map((u) => u.name).sort()).toEqual(['Olivia Grant', 'Pat Reyes', 'Sam Ortiz']);
    const depts = DepartmentsResponse.parse((await call(app, v, 'GET', '/api/departments')).json()).departments;
    expect(depts.filter((d) => d.manager === null).map((d) => d.name)).toEqual(['Design']);
  });
});

describe('Stats-01 department skills', () => {
  it("shows a department's validated skills to its manager", async () => {
    const pat = await startDemo(app);
    const dana = await as(pat, 'Dana');
    const depts = DepartmentsResponse.parse((await call(app, dana, 'GET', '/api/departments')).json()).departments;
    const eng = depts.find((d) => d.name === 'Engineering')!;
    const res = await call(app, dana, 'GET', `/api/departments/${eng.id}/stats`);
    expect(res.statusCode, res.body).toBe(200);
    const s = DepartmentStats.parse(res.json());
    expect(s).toMatchObject({ department: { name: 'Engineering' }, people: 8, withoutSkills: 1 });
    expect(s.skills.map((k) => [k.name, k.holders])).toEqual([
      ['TypeScript', 7],
      ['Node.js', 4],
      ['PostgreSQL', 4],
      ['AWS', 3],
      ['React', 3],
      ['Playwright', 2],
    ]);
    expect(s.skills[0]!.levels).toEqual([0, 2, 1, 2, 2]);
    // Jo's pending Go claim does not count.
    expect(s.skills.some((k) => k.name === 'Go')).toBe(false);

    // Another department: Dana is not its manager; an admin sees any.
    const data = depts.find((d) => d.name === 'Data')!;
    expect(code(await call(app, dana, 'GET', `/api/departments/${data.id}/stats`))).toBe('FORBIDDEN');
    const olivia = await as(dana, 'Olivia');
    const dataStats = DepartmentStats.parse(
      (await call(app, olivia, 'GET', `/api/departments/${data.id}/stats`)).json(),
    );
    expect(dataStats.people).toBe(12);
    expect(dataStats.skills.map((k) => k.name)).toEqual(expect.arrayContaining(['Python', 'Spark', 'dbt']));
    // Plain employees see no department's stats.
    const ana = await as(olivia, 'Ana');
    expect(code(await call(app, ana, 'GET', `/api/departments/${eng.id}/stats`))).toBe('FORBIDDEN');
    expect(code(await call(app, ana, 'GET', '/api/departments/nope/stats'))).toBe('NOT_FOUND');
  });
});
