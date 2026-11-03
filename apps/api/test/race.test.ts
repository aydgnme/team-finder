import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DomainError, RaceResult } from '@team-finder/domain';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../src/db/client.ts';
import { TENANT_COLLECTIONS } from '../src/db/documents.ts';
import { sessionStore } from '../src/db/sessions.ts';
import { createBarrier, runRace } from '../src/services/race.ts';
import { NOW, call, sessionCookie, startDemo, testApp, testDatabase } from './helpers.ts';

// M2.5 "Watch the race": the real approve() run twice at once through a barrier in its afterRead
// hook, inside a throwaway org that is deleted afterwards.

let database: Database;
let app: FastifyInstance;
beforeAll(async () => {
  database = await testDatabase('race-test');
  app = testApp(database);
});
afterAll(() => database?.close());

async function leftovers(orgId: string): Promise<number> {
  let n = await database.db.collection('orgs').countDocuments({ _id: orgId as never });
  for (const c of TENANT_COLLECTIONS) n += await database.db.collection(c).countDocuments({ orgId });
  return n;
}

describe('runRace (invariant 2, shown live)', () => {
  it('lets exactly one of two concurrent approvals win, every time, and leaves nothing behind', async () => {
    const store = sessionStore(database);
    for (let i = 0; i < 20; i++) {
      let orgId = '';
      const r = RaceResult.parse(await runRace(database, store, NOW, { onBuilt: (id) => (orgId = id) }));
      const winner = r.lanes.find((l) => l.lane === r.winner)!;
      const loser = r.lanes.find((l) => l.lane !== r.winner)!;
      expect(winner.outcome).toBe('committed');
      expect(loser).toMatchObject({ outcome: 'refused', code: 'CAPACITY_EXCEEDED' });
      // Both read and passed the check before either wrote: the conflict, not luck, decided it.
      for (const lane of r.lanes) {
        expect(lane.events.map((e) => e.kind).slice(0, 3)).toEqual(['start', 'read', 'released']);
        expect(lane.events.filter((e) => e.kind === 'released')).toHaveLength(1);
      }
      expect(loser.events.map((e) => e.kind)).toContain('replay');
      expect(r.replays).toBeGreaterThanOrEqual(1);
      expect(await leftovers(orgId)).toBe(0);
    }
  });

  it('releases the barrier only when both arrived, and times out otherwise', async () => {
    const both = createBarrier(1_000);
    const first = both.arrive();
    let released = false;
    void first.then(() => (released = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(released).toBe(false);
    await both.arrive();
    await first;
    expect(released).toBe(true);

    const alone = createBarrier(20);
    await expect(alone.arrive()).rejects.toMatchObject({ error: { code: 'RACE_TIMEOUT' } });
  });

  it('cleans up the race org when a run fails', async () => {
    let orgId = '';
    await expect(
      runRace(database, sessionStore(database), NOW, { timeoutMs: 0, onBuilt: (id) => (orgId = id) }),
    ).rejects.toMatchObject({ error: { code: 'RACE_TIMEOUT' } });
    expect(orgId).not.toBe('');
    expect(await leftovers(orgId)).toBe(0);
  });
});

describe('POST /api/demo/race', () => {
  it('runs from a demo sandbox without touching the sandbox', async () => {
    const v = await startDemo(app);
    const fingerprint = async () => {
      const parts: unknown[] = [];
      for (const c of TENANT_COLLECTIONS)
        parts.push(await database.db.collection(c).find({ orgId: v.info.org.id }).sort({ _id: 1 }).toArray());
      return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
    };
    const before = await fingerprint();
    const res = await call(app, v, 'POST', '/api/demo/race', {});
    expect(res.statusCode, res.body).toBe(200);
    expect(
      RaceResult.parse(res.json())
        .lanes.map((l) => l.outcome)
        .sort(),
    ).toEqual(['committed', 'refused']);
    expect(await fingerprint()).toBe(before);
  });

  it('runs one race at a time per session', async () => {
    const v = await startDemo(app);
    const [a, b] = await Promise.all([
      call(app, v, 'POST', '/api/demo/race', {}),
      call(app, v, 'POST', '/api/demo/race', {}),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    expect(DomainError.parse((a.statusCode === 409 ? a : b).json()).code).toBe('RACE_IN_PROGRESS');
  });

  it('is limited per session', async () => {
    const limited = testApp(database, { rateLimits: { racePerSession: { max: 1, windowMs: 60_000 } } });
    const v = await startDemo(limited);
    expect((await call(limited, v, 'POST', '/api/demo/race', {})).statusCode).toBe(200);
    expect((await call(limited, v, 'POST', '/api/demo/race', {})).statusCode).toBe(429);
  });

  it('is for demo sandboxes only, and can be switched off', async () => {
    const signup = await call(app, null, 'POST', '/api/auth/signup', {
      orgName: 'Real Co',
      name: 'Real Admin',
      email: `real.${Date.now()}@example.com`,
      password: 'correct horse battery',
    });
    const real = { cookie: sessionCookie(signup), info: signup.json() };
    expect(DomainError.parse((await call(app, real, 'POST', '/api/demo/race', {})).json()).code).toBe('DEMO_ONLY');

    const off = testApp(database, { demoRoutesEnabled: false });
    const v = await startDemo(off);
    expect((await call(off, v, 'POST', '/api/demo/race', {})).statusCode).toBe(404);
  });
});

describe('afterRead stays a demo-only seam', () => {
  it('is passed only by the race service and declared only in approve()', () => {
    const src = fileURLToPath(new URL('../src', import.meta.url));
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts')) files.push(p);
      }
    };
    walk(src);
    const users = files
      .filter((f) => readFileSync(f, 'utf8').includes('afterRead'))
      .map((f) => f.slice(src.length + 1));
    expect(users.sort()).toEqual(['services/assignments.ts', 'services/race.ts']);
  });
});
