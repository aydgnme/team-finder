import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DomainError } from '@team-finder/domain';
import type { Database } from '../src/db/client.ts';
import { SESSION_COOKIE } from '../src/http/actor.ts';
import { parseTrustProxy } from '../src/config.ts';
import { call, NOW, startDemo, testApp, testDatabase } from './helpers.ts';

let database: Database;
beforeAll(async () => {
  database = await testDatabase('http-test');
});
afterAll(() => database?.close());

describe('HTTP edge', () => {
  it('rejects non-JSON mutations with 415 (CSRF guard)', async () => {
    const app = testApp(database);
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/demo/sessions',
        headers: { 'content-type': type },
        payload: 'a=1',
      });
      expect(res.statusCode, type).toBe(415);
      expect(DomainError.parse(res.json()).code).toBe('UNSUPPORTED_MEDIA_TYPE');
    }
    const noType = await app.inject({ method: 'POST', url: '/api/assignments/x/approve' });
    expect(noType.statusCode).toBe(415);
  });

  it('answers 401 UNAUTHENTICATED without a session, and for unknown or expired sessions', async () => {
    const app = testApp(database);
    const anonymous = await app.inject('/api/session');
    expect(anonymous.statusCode).toBe(401);
    expect(DomainError.parse(anonymous.json())).toMatchObject({ code: 'UNAUTHENTICATED', hint: expect.any(String) });

    expect((await call(app, { cookie: 'forged' }, 'GET', '/api/session')).statusCode).toBe(401);

    const v = await startDemo(app);
    expect((await call(app, v, 'GET', '/api/session')).statusCode).toBe(200);
    const later = testApp(database, { now: () => new Date(NOW.getTime() + 25 * 3600 * 1000) });
    expect((await call(later, v, 'GET', '/api/session')).statusCode).toBe(401);
  });

  it('rejects a session whose demo org expired even if the session document survives', async () => {
    const app = testApp(database);
    const v = await startDemo(app);
    await database.db
      .collection('orgs')
      .updateOne({ _id: v.info.org.id as never }, { $set: { expiresAt: new Date(NOW.getTime() - 1) } });
    expect((await call(app, v, 'GET', '/api/session')).statusCode).toBe(401);
  });

  it('sets an HttpOnly, SameSite=Lax session cookie scoped to /api', async () => {
    const res = await testApp(database, { secureCookies: true }).inject({
      method: 'POST',
      url: '/api/demo/sessions',
      payload: {},
    });
    expect(res.cookies.find((c) => c.name === SESSION_COOKIE)).toMatchObject({
      path: '/api',
      httpOnly: true,
      sameSite: 'Lax',
      secure: true,
    });
  });

  it('answers 503 DB_UNAVAILABLE when the database is not connected', async () => {
    const res = await testApp(undefined).inject({ method: 'POST', url: '/api/demo/sessions', payload: {} });
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe('DB_UNAVAILABLE');
  });

  it('uses the error envelope for unknown routes and malformed JSON', async () => {
    const app = testApp(database);
    const missing = await app.inject('/api/nope');
    expect(missing.statusCode).toBe(404);
    expect(DomainError.parse(missing.json()).code).toBe('NOT_FOUND');
    const bad = await app.inject({
      method: 'POST',
      url: '/api/demo/sessions',
      headers: { 'content-type': 'application/json' },
      payload: '{',
    });
    expect(bad.statusCode).toBe(400);
    expect(DomainError.parse(bad.json()).code).toBe('VALIDATION');
  });

  it('rate-limits sandbox creation per client IP (behind a trusted proxy) and globally', async () => {
    const app = testApp(database, {
      trustProxy: true,
      rateLimits: { demoPerClient: { max: 2, windowMs: 60_000 }, demoGlobal: { max: 3, windowMs: 60_000 } },
    });
    const create = (ip: string) =>
      app.inject({ method: 'POST', url: '/api/demo/sessions', headers: { 'x-forwarded-for': ip }, payload: {} });
    expect((await create('1.1.1.1')).statusCode).toBe(201);
    expect((await create('1.1.1.1')).statusCode).toBe(201);
    const limited = await create('1.1.1.1');
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
    expect(DomainError.parse(limited.json()).code).toBe('RATE_LIMITED');
    expect((await create('2.2.2.2')).statusCode).toBe(201); // other client: own bucket
    expect((await create('3.3.3.3')).statusCode).toBe(429); // global bucket (3) exhausted
  });

  it('parses TRUST_PROXY', () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy('true')).toBe(true);
    expect(parseTrustProxy('2')).toBe(2);
    expect(parseTrustProxy('10.0.0.0/8,127.0.0.1')).toBe('10.0.0.0/8,127.0.0.1');
  });
});
