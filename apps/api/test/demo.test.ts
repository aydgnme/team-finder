import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../src/db/client.ts';
import { TENANT_COLLECTIONS } from '../src/db/documents.ts';
import { call, personaId, startDemo, switchTo, testApp, testDatabase } from './helpers.ts';

let database: Database;
beforeAll(async () => {
  database = await testDatabase('demo-test');
});
afterAll(() => database?.close());

describe('POST /api/demo/sessions', () => {
  it('clones the Atlas seed into a fresh sandbox and signs in as its project manager', async () => {
    const v = await startDemo(testApp(database));
    expect(v.info.user).toMatchObject({ name: 'Pat Reyes', roles: ['employee', 'projectManager'] });
    expect(v.info.org).toMatchObject({ name: 'Northwind Labs', isDemo: true });
    expect(v.info.landingProjectId).toEqual(expect.any(String));
    expect(v.info.personas.map((p) => p.name)).toEqual(['Pat Reyes', 'Dana Okafor', 'Ana Silva', 'Olivia Grant']);
    const users = await database.db.collection('users').countDocuments({ orgId: v.info.org.id });
    expect(users).toBe(11); // 8 employees + PM + dept manager + org admin
  });

  it('stamps expiresAt on every document of the sandbox (TTL cleanup)', async () => {
    const v = await startDemo(testApp(database));
    const org = await database.db.collection('orgs').findOne({ _id: v.info.org.id as never });
    expect(org?.expiresAt).toBeInstanceOf(Date);
    for (const name of TENANT_COLLECTIONS) {
      const missing = await database.db
        .collection(name)
        .countDocuments({ orgId: v.info.org.id, expiresAt: { $exists: false } });
      expect(missing, name).toBe(0);
    }
    expect(
      await database.db.collection('sessions').countDocuments({ orgId: v.info.org.id, expiresAt: org!.expiresAt }),
    ).toBe(1);
  });

  it('gives two visitors independent sandboxes', async () => {
    const app = testApp(database);
    const a = await startDemo(app);
    const b = await startDemo(app);
    expect(a.info.org.id).not.toBe(b.info.org.id);
    expect(a.info.landingProjectId).not.toBe(b.info.landingProjectId);
    // Visitor A's project does not exist for visitor B.
    expect((await call(app, b, 'GET', `/api/projects/${a.info.landingProjectId}`)).statusCode).toBe(404);
  });
});

describe('POST /api/demo/sessions/switch', () => {
  it('switches persona with a new session id and invalidates the old one', async () => {
    const app = testApp(database);
    const pm = await startDemo(app);
    const dm = await switchTo(app, pm, personaId(pm, 'Dana'));
    expect(dm.info.user.name).toBe('Dana Okafor');
    expect(dm.cookie).not.toBe(pm.cookie);
    expect((await call(app, pm, 'GET', '/api/session')).statusCode).toBe(401);
    expect((await call(app, dm, 'GET', '/api/session')).json().user.name).toBe('Dana Okafor');
  });

  it('cannot impersonate a user of another org', async () => {
    const app = testApp(database);
    const a = await startDemo(app);
    const b = await startDemo(app);
    const res = await call(app, a, 'POST', '/api/demo/sessions/switch', { userId: personaId(b, 'Dana') });
    expect(res.statusCode).toBe(404);
  });

  it('is refused outside demo orgs', async () => {
    const app = testApp(database);
    const v = await startDemo(app);
    await database.db.collection('orgs').updateOne({ _id: v.info.org.id as never }, { $set: { isDemo: false } });
    await database.db.collection('sessions').updateMany({ orgId: v.info.org.id }, { $set: { isDemo: false } });
    const res = await call(app, v, 'POST', '/api/demo/sessions/switch', { userId: personaId(v, 'Dana') });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('FORBIDDEN');
  });
});
