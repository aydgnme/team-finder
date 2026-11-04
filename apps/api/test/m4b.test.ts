import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ApprovalsResponse,
  describeNotification,
  DomainError,
  Endorsement,
  monthsBetween,
  NotificationsResponse,
  ProjectsResponse,
  SkillsResponse,
  todayUtc,
  UpgradeProposalsResponse,
} from '@team-finder/domain';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { Database } from '../src/db/client.ts';
import { orgRepo } from '../src/db/org-repo.ts';
import { sessionStore } from '../src/db/sessions.ts';
import { runUpgradeJob, upgradeOrg } from '../src/services/upgrades.ts';
import { call, NOW, startDemo, testApp, testDatabase, type Visitor } from './helpers.ts';

// M4b: Skill-03 endorsements and Project-11 upgrade proposals. Fixed clock (NOW = 2026-03-02).
// Seed: Mira (since 2025-11-22) and Kai (since 2025-12-02) are active on Orion (tech: Go,
// PostgreSQL). Mira holds PostgreSQL 4 and no Go; Kai holds neither. Ana worked on Helios (past)
// and has one open suggestion (React, from Atlas). Tom and Ines hold everything their projects use.

let database: Database;
let app: FastifyInstance;
beforeAll(async () => {
  database = await testDatabase('m4b-test');
  app = testApp(database);
});
afterAll(() => database?.close());

const code = (res: LightMyRequestResponse) => DomainError.parse(res.json()).code;
const later = (days: number) => new Date(NOW.getTime() + days * 86_400_000);

async function demo() {
  const pat = await startDemo(app);
  const orgId = pat.info.org.id;
  const users = await database.db.collection<{ _id: string; name: string }>('users').find({ orgId }).toArray();
  const person = (first: string) => users.find((u) => u.name.startsWith(first))!._id;
  const as = async (first: string): Promise<Visitor> => {
    const id = `test-${Math.random().toString(36).slice(2)}`;
    await database.db.collection('sessions').insertOne({
      _id: id as never,
      orgId,
      userId: person(first),
      isDemo: true,
      expiresAt: new Date(Date.now() + 3_600_000),
      createdAt: new Date(),
    });
    return { cookie: id, info: pat.info };
  };
  const skills = SkillsResponse.parse((await call(app, pat, 'GET', '/api/skills')).json()).skills;
  const skill = (name: string) => skills.find((s) => s.name === name)!.id;
  const projects = ProjectsResponse.parse((await call(app, pat, 'GET', '/api/projects')).json()).projects;
  const project = (name: string) => projects.find((p) => p.name === name)!.id;
  const repo = orgRepo(database, { orgId, isDemo: true });
  const proposals = async (v: Visitor) =>
    UpgradeProposalsResponse.parse((await call(app, v, 'GET', '/api/me/upgrade-proposals')).json()).proposals;
  const mine = async (v: Visitor) => SkillsResponse.parse((await call(app, v, 'GET', '/api/skills')).json()).mine;
  const inbox = async (v: Visitor) =>
    NotificationsResponse.parse((await call(app, v, 'GET', '/api/notifications')).json());
  return { pat, orgId, as, person, skill, project, repo, proposals, mine, inbox };
}

describe('monthsBetween', () => {
  it('counts whole calendar months', () => {
    expect(monthsBetween('2025-12-02', '2026-03-01')).toBe(2);
    expect(monthsBetween('2025-12-02', '2026-03-02')).toBe(3);
    expect(monthsBetween('2025-11-30', '2026-02-28')).toBe(2);
    expect(monthsBetween('2026-03-02', '2026-03-02')).toBe(0);
  });
});

describe('Project-11 upgrade job', () => {
  it('suggests missing skills once per 3-month milestone, never twice, and again after a dismissal', async () => {
    const d = await demo();
    const kaiOnOrion = monthsBetween(
      (await database.db
        .collection('assignments')
        .findOne({ orgId: d.orgId, userId: d.person('Kai'), status: 'active' }))!.from as string,
      todayUtc(NOW),
    );
    expect(kaiOnOrion).toBe(3);

    // The day before, Kai has not crossed 3 months yet. Mira lacks Go; Tom and Ines (also past a
    // milestone) hold everything their projects use, so their milestones pass without a suggestion.
    expect(await upgradeOrg(d.repo, later(-1))).toEqual({ assignments: 3, proposals: 1 });
    // Today Kai crosses too (Go and PostgreSQL); Mira's milestone is already handled.
    expect(await upgradeOrg(d.repo, NOW)).toEqual({ assignments: 1, proposals: 2 });
    expect(await upgradeOrg(d.repo, NOW)).toEqual({ assignments: 0, proposals: 0 });

    const [mira, kai] = [await d.as('Mira'), await d.as('Kai')];
    expect((await d.proposals(kai)).map((p) => p.skill.name).sort()).toEqual(['Go', 'PostgreSQL']);
    const miraGo = (await d.proposals(mira))[0]!;
    expect(miraGo).toMatchObject({ skill: { name: 'Go' }, project: { name: 'Orion' }, current: null, minLevel: null });
    const note = (await d.inbox(mira)).items[0]!;
    expect(note).toMatchObject({ type: 'skillUpgradeProposal', actor: null, refId: miraGo.id });
    expect(describeNotification(note)).toBe('Your work on Orion uses Go: add it to your skills?');

    // Mira dismisses; three months later she is asked again, Kai's open ones are not duplicated.
    expect((await call(app, mira, 'POST', `/api/me/upgrade-proposals/${miraGo.id}/dismiss`, {})).statusCode).toBe(200);
    expect(code(await call(app, mira, 'POST', `/api/me/upgrade-proposals/${miraGo.id}/dismiss`, {}))).toBe(
      'CONFLICT_STALE',
    );
    expect(await d.proposals(mira)).toEqual([]);
    expect(await upgradeOrg(d.repo, later(92))).toEqual({ assignments: 4, proposals: 1 });
    expect((await d.proposals(mira)).map((p) => p.skill.name)).toEqual(['Go']);
    expect(
      await database.db.collection('skillUpgradeProposals').countDocuments({ orgId: d.orgId, status: 'open' }),
    ).toBe(4);
  });

  it('suggests a raise when someone holds a skill below the project minimum', async () => {
    const d = await demo();
    const r = await call(app, d.pat, 'PATCH', `/api/projects/${d.project('Orion')}`, {
      skillRequirements: [{ skillId: d.skill('PostgreSQL'), minLevel: 5 }],
    });
    expect(r.statusCode, r.body).toBe(200);
    await upgradeOrg(d.repo, NOW);
    const mira = await d.as('Mira');
    const pg = (await d.proposals(mira)).find((p) => p.skill.name === 'PostgreSQL')!;
    expect(pg).toMatchObject({ minLevel: 5, current: { level: 4, validated: true } });
  });

  it('two runs at once create each suggestion once', async () => {
    const d = await demo();
    const [a, b] = await Promise.all([upgradeOrg(d.repo, NOW), upgradeOrg(d.repo, NOW)]);
    expect(a.proposals + b.proposals).toBe(3);
    expect(
      await database.db.collection('skillUpgradeProposals').countDocuments({ orgId: d.orgId, status: 'open' }),
    ).toBe(4);
    expect(await upgradeOrg(d.repo, NOW)).toEqual({ assignments: 0, proposals: 0 });
  });

  it('runs over every live org, and an expired sandbox is skipped', async () => {
    const d = await demo();
    const report = await runUpgradeJob(database, sessionStore(database), NOW);
    expect(report.orgs).toBeGreaterThan(0);
    expect(
      await database.db.collection('skillUpgradeProposals').countDocuments({ orgId: d.orgId, status: 'open' }),
    ).toBe(4);
    // Sandboxes live 24 h from their real creation time, whatever the test clock says.
    const orgs = await sessionStore(database).listOrgIds(new Date(Date.now() + 2 * 86_400_000));
    expect(orgs.some((o) => o.id === d.orgId)).toBe(false);
  });

  it('accepting adds the skill as a claim that waits for validation', async () => {
    const d = await demo();
    const [ana, dana] = [await d.as('Ana'), await d.as('Dana')];
    const react = (await d.proposals(ana)).find((p) => p.skill.name === 'React')!;
    expect(react.project.name).toBe('Atlas');
    expect(describeNotification((await d.inbox(ana)).items[0]!)).toBe(
      'Your work on Atlas uses React: add it to your skills?',
    );

    const ok = await call(app, ana, 'POST', `/api/me/upgrade-proposals/${react.id}/accept`, {
      level: 2,
      experience: '6-12m',
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ status: 'accepted', skill: { level: 2, validated: false } });
    expect((await d.mine(ana)).find((m) => m.skillId === react.skill.id)).toMatchObject({ validated: false });
    expect((await d.inbox(dana)).items[0]).toMatchObject({
      type: 'skillPendingValidation',
      data: { skillName: 'React' },
    });
    expect(await d.proposals(ana)).toEqual([]);
    expect(
      code(
        await call(app, ana, 'POST', `/api/me/upgrade-proposals/${react.id}/accept`, { level: 2, experience: '6-12m' }),
      ),
    ).toBe('CONFLICT_STALE');
    // Somebody else's suggestion does not exist for you.
    expect(code(await call(app, dana, 'POST', `/api/me/upgrade-proposals/${react.id}/dismiss`, {}))).toBe('NOT_FOUND');
  });
});

describe('Skill-03 endorsements', () => {
  it('attaches courses, certifications and past projects to your own skills', async () => {
    const d = await demo();
    const ana = await d.as('Ana');
    const node = d.skill('Node.js');
    const add = (body: unknown, skillId = node) =>
      call(app, ana, 'POST', `/api/me/skills/${skillId}/endorsements`, body);

    const cert = await add({
      kind: 'certification',
      title: 'OpenJS Node.js Application Developer',
      url: 'https://openjsf.org/certification',
    });
    expect(cert.statusCode, cert.body).toBe(201);
    expect(Endorsement.parse(cert.json())).toMatchObject({ kind: 'certification', projectId: null });
    const helios = await add({ kind: 'project', projectId: d.project('Helios') });
    expect(helios.statusCode, helios.body).toBe(201);
    expect(helios.json()).toMatchObject({ kind: 'project', title: 'Helios' });

    // Only projects she worked on, each once; links must be http(s); only skills she holds.
    expect((await add({ kind: 'project', projectId: d.project('Orion') })).statusCode).toBe(400);
    expect((await add({ kind: 'project', projectId: d.project('Helios') })).statusCode).toBe(400);
    expect((await add({ kind: 'course', title: 'Sneaky', url: 'javascript:alert(1)' })).statusCode).toBe(400);
    expect((await add({ kind: 'course', title: 'Go basics' }, d.skill('Go'))).statusCode).toBe(404);

    const mine = (await d.mine(ana)).find((m) => m.skillId === node)!;
    expect(mine.endorsements.map((e) => e.title)).toEqual(['OpenJS Node.js Application Developer', 'Helios']);
    // Evidence does not change validation.
    expect(mine.validated).toBe(true);

    for (let i = mine.endorsements.length; i < 10; i++) {
      expect((await add({ kind: 'training', title: `Workshop ${i}` })).statusCode).toBe(201);
    }
    expect(code(await add({ kind: 'training', title: 'One too many' }))).toBe('VALIDATION');

    const first = mine.endorsements[0]!.id;
    expect((await call(app, ana, 'DELETE', `/api/me/skills/${node}/endorsements/${first}`, {})).statusCode).toBe(200);
    expect((await call(app, ana, 'DELETE', `/api/me/skills/${node}/endorsements/${first}`, {})).statusCode).toBe(404);
  });

  it('the manager sees the evidence, and new evidence makes an open decision stale', async () => {
    const d = await demo();
    const [jo, dana] = [await d.as('Jo'), await d.as('Dana')];
    const go = d.skill('Go');
    const seen = ApprovalsResponse.parse((await call(app, dana, 'GET', '/api/approvals')).json()).skillClaims.find(
      (c) => c.skill.id === go,
    )!;
    await call(app, jo, 'POST', `/api/me/skills/${go}/endorsements`, { kind: 'course', title: 'A Tour of Go' });
    expect(
      code(await call(app, dana, 'POST', `/api/skills/claims/${seen.userSkillId}/validate`, { version: seen.version })),
    ).toBe('CONFLICT_STALE');
    const fresh = ApprovalsResponse.parse((await call(app, dana, 'GET', '/api/approvals')).json()).skillClaims.find(
      (c) => c.skill.id === go,
    )!;
    expect(fresh.endorsements).toEqual([expect.objectContaining({ kind: 'course', title: 'A Tour of Go', url: null })]);
    expect(
      (await call(app, dana, 'POST', `/api/skills/claims/${fresh.userSkillId}/validate`, { version: fresh.version }))
        .statusCode,
    ).toBe(200);
  });
});
