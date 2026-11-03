import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DomainError, MembersResponse, OrgSettings, SessionInfo, TeamRolesResponse } from '@team-finder/domain';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { Database } from '../src/db/client.ts';
import { SESSION_COOKIE } from '../src/http/actor.ts';
import { call, personaId, sessionCookie, startDemo, switchTo, testApp, testDatabase, type Visitor } from './helpers.ts';

// Auth-01..03, Role-01, Role-02 (docs/plans/m2-auth-and-roles.md).

let database: Database;
let app: FastifyInstance;
beforeAll(async () => {
  database = await testDatabase('auth-test');
  app = testApp(database);
});
afterAll(() => database?.close());

let seq = 0;
const uniqueEmail = (name = 'admin') => `${name}.${++seq}.${Date.now()}@example.com`;
const PASSWORD = 'correct horse battery';

function visitor(res: LightMyRequestResponse): Visitor {
  return { cookie: sessionCookie(res), info: SessionInfo.parse(res.json()) };
}

async function signUp(over: Record<string, unknown> = {}) {
  const email = uniqueEmail();
  const res = await call(app, null, 'POST', '/api/auth/signup', {
    orgName: 'Acme Consulting',
    name: 'Mert Admin',
    email,
    password: PASSWORD,
    ...over,
  });
  expect(res.statusCode, res.body).toBe(201);
  return { admin: visitor(res), email: (over.email as string | undefined) ?? email };
}

async function invite(admin: Visitor) {
  return OrgSettings.parse((await call(app, admin, 'GET', '/api/org')).json()).inviteToken!;
}

async function join(token: string, name = 'Emma Employee') {
  const email = uniqueEmail('emma');
  const res = await call(app, null, 'POST', `/api/invites/${token}/join`, { name, email, password: PASSWORD });
  expect(res.statusCode, res.body).toBe(201);
  return { member: visitor(res), email };
}

const session = (v: Visitor) => call(app, v, 'GET', '/api/session');
const code = (res: LightMyRequestResponse) => DomainError.parse(res.json()).code;

describe('Auth-01 sign-up', () => {
  it('creates a real org and its first admin, signed in', async () => {
    const { admin, email } = await signUp({ hqAddress: 'Iasi, Romania' });
    expect(admin.info).toMatchObject({
      user: { name: 'Mert Admin', roles: ['employee', 'admin'] },
      org: { name: 'Acme Consulting', isDemo: false, expiresAt: null },
      landingProjectId: null,
      personas: [],
    });
    const user = await database.db.collection('users').findOne({ email });
    expect(user!.passwordHash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(JSON.stringify(user)).not.toContain(PASSWORD);
    const org = await database.db.collection('orgs').findOne({ _id: admin.info.org.id as never });
    expect(org).toMatchObject({ hqAddress: 'Iasi, Romania', isDemo: false });
    expect(org!.inviteToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('normalizes the email and refuses a second account for it, creating nothing', async () => {
    const email = uniqueEmail();
    await signUp({ email: `  ${email.toUpperCase()} ` });
    expect(await database.db.collection('users').countDocuments({ email })).toBe(1);
    const orgs = await database.db.collection('orgs').countDocuments({ name: 'Taken Inc' });
    const res = await call(app, null, 'POST', '/api/auth/signup', {
      orgName: 'Taken Inc',
      name: 'X',
      email,
      password: PASSWORD,
    });
    expect(res.statusCode).toBe(409);
    expect(code(res)).toBe('EMAIL_TAKEN');
    expect(await database.db.collection('orgs').countDocuments({ name: 'Taken Inc' })).toBe(orgs);
  });

  it.each([
    ['a short password', { password: 'short' }],
    ['a bad email', { email: 'not-an-email' }],
    ['no org name', { orgName: '' }],
  ])('rejects %s', async (_n, over) => {
    const res = await call(app, null, 'POST', '/api/auth/signup', {
      orgName: 'Acme',
      name: 'X',
      email: uniqueEmail(),
      password: PASSWORD,
      ...over,
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('login and logout', () => {
  it('logs in with a fresh session id and deletes the one the browser held (fixation)', async () => {
    const { admin, email } = await signUp();
    const res = await call(app, admin, 'POST', '/api/auth/login', { email: email.toUpperCase(), password: PASSWORD });
    expect(res.statusCode, res.body).toBe(200);
    const next = sessionCookie(res);
    expect(next).not.toBe(admin.cookie);
    expect(await database.db.collection('sessions').countDocuments({ _id: admin.cookie as never })).toBe(0);
    expect((await session(admin)).statusCode).toBe(401);
    expect((await session({ cookie: next, info: admin.info })).statusCode).toBe(200);
  });

  it('answers a wrong password and an unknown email identically', async () => {
    const { email } = await signUp();
    const wrong = await call(app, null, 'POST', '/api/auth/login', { email, password: 'wrong password!!' });
    const unknown = await call(app, null, 'POST', '/api/auth/login', { email: uniqueEmail(), password: PASSWORD });
    expect([wrong.statusCode, unknown.statusCode]).toEqual([401, 401]);
    expect(wrong.json()).toEqual(unknown.json());
    expect(code(wrong)).toBe('INVALID_CREDENTIALS');
  });

  it('never lets demo personas log in', async () => {
    await startDemo(app);
    const res = await call(app, null, 'POST', '/api/auth/login', {
      email: 'ana@northwind.example',
      password: PASSWORD,
    });
    expect(code(res)).toBe('INVALID_CREDENTIALS');
  });

  it('logs out: the session is gone and the cookie cleared', async () => {
    const { admin } = await signUp();
    const res = await call(app, admin, 'POST', '/api/auth/logout', {});
    expect(res.statusCode).toBe(200);
    expect(res.cookies.find((c) => c.name === SESSION_COOKIE)?.value).toBe('');
    expect((await session(admin)).statusCode).toBe(401);
  });

  it('limits login attempts per email', async () => {
    const limited = testApp(database, {
      rateLimits: {
        authPerClient: { max: 1000, windowMs: 60_000 },
        loginPerEmail: { max: 2, windowMs: 60_000 },
      },
    });
    const { email } = await signUp();
    for (let i = 0; i < 2; i++) {
      expect(
        (await call(limited, null, 'POST', '/api/auth/login', { email, password: 'nope nope nope' })).statusCode,
      ).toBe(401);
    }
    const third = await call(limited, null, 'POST', '/api/auth/login', { email, password: PASSWORD });
    expect(third.statusCode).toBe(429);
  });
});

describe('Auth-02/03 invites', () => {
  it('lets an employee join through the invite link', async () => {
    const { admin } = await signUp({ orgName: 'Invite Co' });
    const token = await invite(admin);
    expect((await call(app, null, 'GET', `/api/invites/${token}`)).json()).toEqual({ orgName: 'Invite Co' });
    const { member } = await join(token);
    expect(member.info).toMatchObject({ user: { roles: ['employee'] }, org: { id: admin.info.org.id } });
    const members = MembersResponse.parse((await call(app, member, 'GET', '/api/org/members')).json()).members;
    expect(members.map((m) => m.name)).toEqual(['Emma Employee', 'Mert Admin']);
    // Employees see members but not the invite secret.
    expect((await call(app, member, 'GET', '/api/org')).statusCode).toBe(403);
  });

  it('revokes the old link when an admin regenerates it', async () => {
    const { admin } = await signUp();
    const old = await invite(admin);
    const res = await call(app, admin, 'POST', '/api/org/invite', {});
    const fresh = OrgSettings.parse(res.json()).inviteToken!;
    expect(fresh).not.toBe(old);
    expect((await call(app, null, 'GET', `/api/invites/${old}`)).statusCode).toBe(404);
    expect(
      (
        await call(app, null, 'POST', `/api/invites/${old}/join`, {
          name: 'X',
          email: uniqueEmail(),
          password: PASSWORD,
        })
      ).statusCode,
    ).toBe(404);
    await join(fresh);
  });

  it('takes no invites into demo sandboxes', async () => {
    const v = await startDemo(app);
    const olivia = await switchTo(app, v, personaId(v, 'Olivia'));
    expect(OrgSettings.parse((await call(app, olivia, 'GET', '/api/org')).json())).toMatchObject({
      isDemo: true,
      inviteToken: null,
    });
    expect((await call(app, olivia, 'POST', '/api/org/invite', {})).statusCode).toBe(403);
  });

  it('refuses an email that already has an account', async () => {
    const { admin, email } = await signUp();
    const res = await call(app, null, 'POST', `/api/invites/${await invite(admin)}/join`, {
      name: 'Dup',
      email,
      password: PASSWORD,
    });
    expect(code(res)).toBe('EMAIL_TAKEN');
  });
});

describe('Role-01 access roles', () => {
  it('lets an admin grant roles; they apply on the next request; employee is always kept', async () => {
    const { admin } = await signUp();
    const { member } = await join(await invite(admin));
    const res = await call(app, admin, 'PUT', `/api/org/members/${member.info.user.id}/roles`, {
      roles: ['deptManager', 'projectManager'],
    });
    expect(res.json()).toEqual({ id: member.info.user.id, roles: ['employee', 'deptManager', 'projectManager'] });
    expect(SessionInfo.parse((await session(member)).json()).user.roles).toEqual([
      'employee',
      'deptManager',
      'projectManager',
    ]);
  });

  it('only admins change roles', async () => {
    const { admin } = await signUp();
    const { member } = await join(await invite(admin));
    const res = await call(app, member, 'PUT', `/api/org/members/${member.info.user.id}/roles`, { roles: ['admin'] });
    expect(res.statusCode).toBe(403);
  });

  it('keeps at least one admin', async () => {
    const { admin } = await signUp();
    const res = await call(app, admin, 'PUT', `/api/org/members/${admin.info.user.id}/roles`, { roles: [] });
    expect(code(res)).toBe('LAST_ADMIN');
    expect(SessionInfo.parse((await session(admin)).json()).user.roles).toContain('admin');
  });

  it('does not let two admins demote each other at the same moment', async () => {
    for (let round = 0; round < 5; round++) {
      const { admin: a } = await signUp();
      const { member: b } = await join(await invite(a));
      await call(app, a, 'PUT', `/api/org/members/${b.info.user.id}/roles`, { roles: ['admin'] });
      const results = await Promise.all([
        call(app, a, 'PUT', `/api/org/members/${b.info.user.id}/roles`, { roles: [] }),
        call(app, b, 'PUT', `/api/org/members/${a.info.user.id}/roles`, { roles: [] }),
      ]);
      expect(results.map((r) => r.statusCode).sort(), results.map((r) => r.body).join('\n')).toEqual([200, 409]);
      expect(await database.db.collection('users').countDocuments({ orgId: a.info.org.id, accessRoles: 'admin' })).toBe(
        1,
      );
    }
  });
});

describe('Role-02 team roles', () => {
  it('lists roles with whether they are in use, and manages the rest', async () => {
    const v = await startDemo(app);
    const admin = await switchTo(app, v, personaId(v, 'Olivia'));
    const list = async () =>
      TeamRolesResponse.parse((await call(app, admin, 'GET', '/api/team-roles')).json()).teamRoles;
    expect((await list()).every((r) => r.inUse)).toBe(true);

    const created = await call(app, admin, 'POST', '/api/team-roles', { name: 'Designer' });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    expect(code(await call(app, admin, 'POST', '/api/team-roles', { name: 'designer' }))).toBe('NAME_TAKEN');
    expect(code(await call(app, admin, 'PATCH', `/api/team-roles/${id}`, { name: 'backend developer' }))).toBe(
      'NAME_TAKEN',
    );
    expect(
      (await call(app, admin, 'PATCH', `/api/team-roles/${id}`, { name: 'Product Designer' })).json(),
    ).toMatchObject({ name: 'Product Designer', inUse: false });

    const backend = (await list()).find((r) => r.name === 'Backend Developer')!;
    expect(code(await call(app, admin, 'DELETE', `/api/team-roles/${backend.id}`, {}))).toBe('IN_USE');
    expect((await call(app, admin, 'DELETE', `/api/team-roles/${id}`, {})).statusCode).toBe(200);
    expect((await list()).map((r) => r.name)).not.toContain('Product Designer');

    // Project managers read team roles but do not manage them.
    expect((await call(app, v, 'GET', '/api/team-roles')).statusCode).toBe(401); // v's session was rotated by the switch
    const pat = await switchTo(app, admin, personaId(admin, 'Pat'));
    expect((await call(app, pat, 'GET', '/api/team-roles')).statusCode).toBe(200);
    expect((await call(app, pat, 'POST', '/api/team-roles', { name: 'Ops' })).statusCode).toBe(403);
  });
});
