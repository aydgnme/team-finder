import { inject } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { SessionInfo } from '@team-finder/domain';
import { buildApp, type AppOptions } from '../src/app.ts';
import { connectDatabase, type Database } from '../src/db/client.ts';
import { ensureIndexes } from '../src/db/indexes.ts';
import { SESSION_COOKIE } from '../src/http/actor.ts';

/** Fixed clock: Atlas then starts 2026-03-09 and ends 2026-06-01. */
export const NOW = new Date('2026-03-02T12:00:00Z');

export async function testDatabase(name: string): Promise<Database> {
  const database = await connectDatabase(inject('mongoUri'), name, { monitorCommands: true });
  await database.db.dropDatabase();
  await ensureIndexes(database, { warn: () => {} });
  return database;
}

export function testApp(database: Database | undefined, options: Partial<AppOptions> = {}): FastifyInstance {
  return buildApp({
    ...(database ? { getDatabase: () => database } : {}),
    secureCookies: false,
    now: () => NOW,
    rateLimits: {
      demoPerClient: { max: 1000, windowMs: 60_000 },
      demoGlobal: { max: 1000, windowMs: 60_000 },
      mutationsPerSession: { max: 1000, windowMs: 60_000 },
    },
    ...options,
  });
}

export interface Visitor {
  cookie: string;
  info: SessionInfo;
}

export function sessionCookie(res: LightMyRequestResponse): string {
  const c = res.cookies.find((x) => x.name === SESSION_COOKIE);
  if (!c) throw new Error(`no session cookie (status ${res.statusCode}: ${res.body})`);
  return c.value;
}

export async function startDemo(app: FastifyInstance): Promise<Visitor> {
  const res = await app.inject({ method: 'POST', url: '/api/demo/sessions', payload: {} });
  if (res.statusCode !== 201) throw new Error(`demo failed: ${res.statusCode} ${res.body}`);
  return { cookie: sessionCookie(res), info: SessionInfo.parse(res.json()) };
}

export function personaId(v: Visitor, firstName: string): string {
  const p = v.info.personas.find((x) => x.name.startsWith(firstName));
  if (!p) throw new Error(`no persona ${firstName}`);
  return p.id;
}

/** Switch persona in place (mutates the visitor's cookie, like the browser would). */
export async function switchTo(app: FastifyInstance, v: Visitor, userId: string): Promise<Visitor> {
  const res = await call(app, v, 'POST', '/api/demo/sessions/switch', { userId });
  if (res.statusCode !== 200) throw new Error(`switch failed: ${res.statusCode} ${res.body}`);
  return { cookie: sessionCookie(res), info: SessionInfo.parse(res.json()) };
}

export function call(
  app: FastifyInstance,
  v: Pick<Visitor, 'cookie'> | null,
  method: 'GET' | 'POST',
  url: string,
  payload?: unknown,
) {
  return app.inject({
    method,
    url,
    ...(v ? { cookies: { [SESSION_COOKIE]: v.cookie } } : {}),
    ...(method === 'POST' ? { payload: (payload ?? {}) as object } : {}),
  });
}
