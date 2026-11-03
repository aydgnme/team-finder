import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { HealthResponse } from '@team-finder/domain';
import { buildApp, PROBE_COOKIE } from '../src/app.ts';

let app: FastifyInstance;
afterEach(() => app?.close());

describe('GET /api/health', () => {
  it('reports not_configured without a database', async () => {
    app = buildApp({ secureCookies: false });
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(HealthResponse.parse(res.json())).toEqual({ status: 'ok', db: 'not_configured', cookieRoundTrip: false });
  });

  it('reports up and down from the ping', async () => {
    app = buildApp({ secureCookies: false, pingDb: async () => true });
    expect((await app.inject('/api/health')).json().db).toBe('up');
    await app.close();
    app = buildApp({ secureCookies: false, pingDb: async () => false });
    expect((await app.inject('/api/health')).json().db).toBe('down');
  });

  it('sets a first-party probe cookie and detects it on the next request', async () => {
    app = buildApp({ secureCookies: true });
    const first = await app.inject('/api/health');
    const setCookie = first.cookies.find((c) => c.name === PROBE_COOKIE);
    expect(setCookie).toMatchObject({ value: '1', path: '/api', httpOnly: true, sameSite: 'Lax', secure: true });

    const second = await app.inject({ method: 'GET', url: '/api/health', cookies: { [PROBE_COOKIE]: '1' } });
    expect(second.json().cookieRoundTrip).toBe(true);
  });
});
