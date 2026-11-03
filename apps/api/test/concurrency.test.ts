import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApprovalsResponse, CandidatesResponse, ProjectBoard } from '@team-finder/domain';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../src/db/client.ts';
import { call, personaId, startDemo, switchTo, testApp, testDatabase } from './helpers.ts';

let database: Database;
let app: FastifyInstance;
beforeAll(async () => {
  database = await testDatabase('concurrency-test');
  app = testApp(database);
});
afterAll(() => database?.close());

describe('approve under concurrency (invariant 2)', () => {
  it('approves exactly one of two different proposals that together overbook the same person', async () => {
    for (let round = 0; round < 5; round++) {
      const pm = await startDemo(app);
      const atlas = ProjectBoard.parse(
        (await call(app, pm, 'GET', `/api/projects/${pm.info.landingProjectId}`)).json(),
      );
      const backend = atlas.roles.find((r) => r.name === 'Backend Developer')!.id;
      const jo = CandidatesResponse.parse(
        (await call(app, pm, 'GET', `/api/projects/${atlas.project.id}/candidates`)).json(),
      ).candidates.find((c) => c.name === 'Jo Park')!;
      const orion = await database.db.collection('projects').findOne({ orgId: pm.info.org.id, name: 'Orion' });

      // Jo is free: 5 h on Atlas fits, 5 h on Orion fits, both together (10 h) do not.
      for (const projectId of [atlas.project.id, String(orion!._id)]) {
        const res = await call(app, pm, 'POST', '/api/assignments', {
          projectId,
          userId: jo.userId,
          slotRoleId: backend,
          hoursPerDay: 5,
          from: '2026-03-09',
        });
        expect(res.statusCode, res.body).toBe(201);
      }

      const dm = await switchTo(app, pm, personaId(pm, 'Dana'));
      const items = ApprovalsResponse.parse((await call(app, dm, 'GET', '/api/approvals')).json()).items.filter(
        (i) => i.user.id === jo.userId,
      );
      expect(items).toHaveLength(2);
      expect(items.every((i) => i.check?.fits)).toBe(true);

      const results = await Promise.all(
        items.map((i) => call(app, dm, 'POST', `/api/assignments/${i.assignmentId}/approve`, { version: i.version })),
      );
      const statuses = results.map((r) => r.statusCode).sort();
      expect(statuses, results.map((r) => r.body).join('\n')).toEqual([200, 409]);
      expect(results.find((r) => r.statusCode === 409)!.json().code).toBe('CAPACITY_EXCEEDED');

      const active = await database.db
        .collection('assignments')
        .countDocuments({ orgId: pm.info.org.id, userId: jo.userId, status: 'active' });
      expect(active).toBe(1);
    }
  });
});
