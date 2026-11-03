import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ApprovalsResponse,
  CandidatesResponse,
  describeNotification,
  DomainError,
  NoApproverResponse,
  NotificationsResponse,
  ProjectsResponse,
  ProjectSummary,
  SkillsResponse,
  TeamRolesResponse,
} from '@team-finder/domain';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { Database } from '../src/db/client.ts';
import { call, startDemo, testApp, testDatabase, type Visitor } from './helpers.ts';

// M4a: Notification-01, Skill-04 validation, Project-10 requirements. Fixed clock (NOW = 2026-03-02).
// Seed: Pat is the PM of every project; Dana manages Engineering (Ana, Leo, Mira, Tom, Ines, Kai, Jo);
// Design has no manager (Noor); Olivia is the admin. Atlas starts 2026-03-09 with Ana active and Leo
// and Kai proposed; Dana's inbox starts with those two proposals and Jo's pending Go claim.

let database: Database;
let app: FastifyInstance;
beforeAll(async () => {
  database = await testDatabase('m4a-test');
  app = testApp(database);
});
afterAll(() => database?.close());

const code = (res: LightMyRequestResponse) => DomainError.parse(res.json()).code;

async function demo() {
  const pat = await startDemo(app);
  const orgId = pat.info.org.id;
  const users = await database.db.collection<{ _id: string; name: string }>('users').find({ orgId }).toArray();
  const person = (first: string) => users.find((u) => u.name.startsWith(first))!._id;
  /** An independent session per person (switching personas would rotate the first one). */
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
  const roles = TeamRolesResponse.parse((await call(app, pat, 'GET', '/api/team-roles')).json()).teamRoles;
  const role = (name: string) => roles.find((r) => r.name === name)!.id;
  const project = async (name: string) =>
    ProjectsResponse.parse((await call(app, pat, 'GET', '/api/projects')).json()).projects.find(
      (p) => p.name === name,
    )!;
  const skills = SkillsResponse.parse((await call(app, pat, 'GET', '/api/skills')).json()).skills;
  const skill = (name: string) => skills.find((s) => s.name === name)!.id;
  const inbox = async (v: Visitor) =>
    NotificationsResponse.parse((await call(app, v, 'GET', '/api/notifications')).json());
  const types = async (v: Visitor) => (await inbox(v)).items.map((n) => n.type);
  const approvals = async (v: Visitor) => ApprovalsResponse.parse((await call(app, v, 'GET', '/api/approvals')).json());
  const mine = async (v: Visitor) => SkillsResponse.parse((await call(app, v, 'GET', '/api/skills')).json()).mine;
  return { pat, orgId, as, person, role, project, skill, inbox, types, approvals, mine };
}

describe('Notification-01 inbox', () => {
  it('starts with what the seed sent Dana, and marks only your own notifications read', async () => {
    const d = await demo();
    const dana = await d.as('Dana');
    const box = await d.inbox(dana);
    expect(box.unread).toBe(3);
    expect(box.items.map((n) => n.type).sort()).toEqual([
      'assignmentProposed',
      'assignmentProposed',
      'skillPendingValidation',
    ]);
    expect(box.items[0]!.createdAt >= box.items[1]!.createdAt).toBe(true);
    expect(describeNotification(box.items.find((n) => n.type === 'skillPendingValidation')!)).toBe(
      'Jo Park claimed Go; it needs your validation.',
    );
    expect((await d.inbox(d.pat)).unread).toBe(0);

    // Pat cannot mark Dana's notifications read: ids that are not yours are ignored.
    const ids = box.items.map((n) => n.id);
    expect((await call(app, d.pat, 'POST', '/api/notifications/read', { ids })).json()).toEqual({
      updated: 0,
      unread: 0,
    });
    const one = await call(app, dana, 'POST', '/api/notifications/read', { ids: [ids[0]] });
    expect(one.json()).toEqual({ updated: 1, unread: 2 });
    expect((await call(app, dana, 'GET', '/api/notifications/unread-count')).json()).toEqual({ unread: 2 });
    expect((await call(app, dana, 'POST', '/api/notifications/read', { all: true })).json()).toEqual({
      updated: 2,
      unread: 0,
    });
    expect((await call(app, dana, 'POST', '/api/notifications/read', { ids: [] })).statusCode).toBe(400);
  });
});

describe('Notification-01 triggers (written in the trigger transaction)', () => {
  it('proposals notify the approver, decisions notify the proposer, and nobody hears about their own action', async () => {
    const d = await demo();
    const dana = await d.as('Dana');
    await call(app, dana, 'POST', '/api/notifications/read', { all: true });
    const atlas = await d.project('Atlas');

    const proposed = await call(app, d.pat, 'POST', '/api/assignments', {
      projectId: atlas.id,
      userId: d.person('Mira'),
      slotRoleId: d.role('Backend Developer'),
      hoursPerDay: 2,
      from: '2026-03-09',
    });
    expect(proposed.statusCode, proposed.body).toBe(201);
    expect(await d.types(dana)).toEqual([
      'assignmentProposed',
      'skillPendingValidation',
      'assignmentProposed',
      'assignmentProposed',
    ]);
    const newest = (await d.inbox(dana)).items[0]!;
    expect(newest).toMatchObject({ type: 'assignmentProposed', read: false, actor: { name: 'Pat Reyes' } });
    expect(describeNotification(newest)).toBe('Pat Reyes proposed Mira Chen for Atlas.');
    expect((await d.inbox(d.pat)).unread).toBe(0);

    // Decisions go back to the PM who proposed.
    const items = (await d.approvals(dana)).items;
    const mira = items.find((i) => i.user.name === 'Mira Chen')!;
    const leo = items.find((i) => i.user.name === 'Leo Martin')!;
    expect(
      (await call(app, dana, 'POST', `/api/assignments/${mira.assignmentId}/approve`, { version: mira.version }))
        .statusCode,
    ).toBe(200);
    expect(
      (await call(app, dana, 'POST', `/api/assignments/${leo.assignmentId}/reject`, { version: leo.version }))
        .statusCode,
    ).toBe(200);
    const patBox = await d.inbox(d.pat);
    expect(patBox.items.map((n) => describeNotification(n))).toEqual([
      'Dana Okafor rejected Leo Martin on Atlas.',
      'Dana Okafor approved Mira Chen on Atlas.',
    ]);

    // A refused approval (Kai would exceed 8 h) rolls back and notifies nobody.
    const kai = items.find((i) => i.user.name === 'Kai Nakamura')!;
    expect(
      code(await call(app, dana, 'POST', `/api/assignments/${kai.assignmentId}/approve`, { version: kai.version })),
    ).toBe('CAPACITY_EXCEEDED');
    expect((await d.inbox(d.pat)).items).toHaveLength(2);
  });

  it('deallocation requests notify the approver and their outcome notifies the PM', async () => {
    const d = await demo();
    const dana = await d.as('Dana');
    await call(app, dana, 'POST', '/api/notifications/read', { all: true });
    const atlas = await d.project('Atlas');
    const ana = (await database.db.collection('assignments').findOne({
      orgId: d.orgId,
      projectId: atlas.id,
      userId: d.person('Ana'),
    }))!;
    const asked = await call(app, d.pat, 'POST', `/api/assignments/${String(ana._id)}/deallocate`, {
      version: ana.version,
      reason: 'Moving to Orion',
    });
    expect(asked.statusCode, asked.body).toBe(200);
    const box = await d.inbox(dana);
    expect(box.unread).toBe(1);
    expect(describeNotification(box.items[0]!)).toBe("Pat Reyes asked to end Ana Silva's assignment on Atlas.");

    const item = (await d.approvals(dana)).items.find((i) => i.kind === 'deallocation')!;
    await call(app, dana, 'POST', `/api/assignments/${item.assignmentId}/reject`, { version: item.version });
    expect(describeNotification((await d.inbox(d.pat)).items[0]!)).toBe(
      "Dana Okafor rejected ending Ana Silva's assignment on Atlas.",
    );
  });

  it('a failed scenario commit sends nothing; deleting a project tells the managers of the people on it', async () => {
    const d = await demo();
    const dana = await d.as('Dana');
    await call(app, dana, 'POST', '/api/notifications/read', { all: true });
    const atlas = await d.project('Atlas');
    const commit = await call(app, d.pat, 'POST', `/api/projects/${atlas.id}/scenarios/commit`, {
      start: '2026-03-09',
      additions: [
        { userId: d.person('Mira'), slotRoleId: d.role('Backend Developer'), hoursPerDay: 2 },
        { userId: 'nope', slotRoleId: d.role('Backend Developer'), hoursPerDay: 2 },
      ],
    });
    expect(commit.statusCode).toBe(404);
    expect((await d.inbox(dana)).unread).toBe(0);

    const created = await call(app, d.pat, 'POST', '/api/projects', {
      name: 'Short-lived',
      period: 'fixed',
      startDate: '2026-04-01',
      deadline: '2026-05-01',
      teamRoles: [{ roleId: d.role('QA Engineer'), count: 1 }],
    });
    const id = ProjectSummary.parse(created.json()).id;
    await call(app, d.pat, 'POST', '/api/assignments', {
      projectId: id,
      userId: d.person('Jo'),
      slotRoleId: d.role('QA Engineer'),
      hoursPerDay: 4,
      from: '2026-04-01',
    });
    expect((await call(app, d.pat, 'DELETE', `/api/projects/${id}`, {})).statusCode).toBe(200);
    const box = await d.inbox(dana);
    expect(box.items.filter((n) => !n.read).map((n) => n.type)).toEqual(['projectDeleted', 'assignmentProposed']);
    expect(describeNotification(box.items[0]!)).toBe(
      'Pat Reyes deleted Short-lived; its proposals for your people are gone.',
    );
  });
});

describe('Skill-04 validation', () => {
  it('keeps a claim out of matching until the department manager validates it', async () => {
    const d = await demo();
    const [ana, dana] = [await d.as('Ana'), await d.as('Dana')];
    const aws = d.skill('AWS');
    const cloud = ProjectSummary.parse(
      (
        await call(app, d.pat, 'POST', '/api/projects', {
          name: 'Cloud move',
          period: 'fixed',
          startDate: '2026-09-01',
          deadline: '2026-12-01',
          techStack: [aws],
          teamRoles: [{ roleId: d.role('Backend Developer'), count: 1 }],
        })
      ).json(),
    );
    const anaSkills = async () =>
      CandidatesResponse.parse(
        (
          await call(
            app,
            d.pat,
            'GET',
            `/api/projects/${cloud.id}/candidates?includeUnavailable=true&includePartial=true&includeNearMisses=true`,
          )
        ).json(),
      ).candidates.find((c) => c.name === 'Ana Silva')?.skills ?? [];

    const claimed = await call(app, ana, 'PUT', `/api/me/skills/${aws}`, { level: 4, experience: '2-4y' });
    expect(claimed.json()).toMatchObject({ validated: false });
    expect((await d.mine(ana)).find((m) => m.skillId === aws)).toMatchObject({ validated: false });
    expect((await anaSkills()).some((s) => s.skillId === aws)).toBe(false);
    expect((await d.inbox(dana)).items[0]).toMatchObject({
      type: 'skillPendingValidation',
      data: { skillName: 'AWS' },
    });

    const claim = (await d.approvals(dana)).skillClaims.find((c) => c.user.name === 'Ana Silva')!;
    // Not Ana herself, not the PM.
    expect(
      code(
        await call(app, ana, 'POST', `/api/skills/claims/${claim.userSkillId}/validate`, { version: claim.version }),
      ),
    ).toBe('FORBIDDEN');
    expect(
      code(
        await call(app, d.pat, 'POST', `/api/skills/claims/${claim.userSkillId}/validate`, { version: claim.version }),
      ),
    ).toBe('FORBIDDEN');
    expect(
      (
        await call(app, dana, 'POST', `/api/skills/claims/${claim.userSkillId}/validate`, { version: claim.version })
      ).json(),
    ).toEqual({
      userSkillId: claim.userSkillId,
      outcome: 'validated',
    });
    expect((await d.mine(ana)).find((m) => m.skillId === aws)).toMatchObject({ validated: true, level: 4 });
    expect(await anaSkills()).toContainEqual({ skillId: aws, level: 4 });
    expect(
      code(
        await call(app, dana, 'POST', `/api/skills/claims/${claim.userSkillId}/validate`, {
          version: claim.version + 1,
        }),
      ),
    ).toBe('CONFLICT_STALE');
  });

  it('a raise waits for validation and a rejected raise restores the validated values; lowering stays validated', async () => {
    const d = await demo();
    const [ana, dana] = [await d.as('Ana'), await d.as('Dana')];
    const node = d.skill('Node.js');
    await call(app, ana, 'PUT', `/api/me/skills/${node}`, { level: 5, experience: '4-7y' });
    const claim = (await d.approvals(dana)).skillClaims.find((c) => c.skill.id === node)!;
    expect(claim).toMatchObject({ level: 5, previous: { level: 4, experience: '4-7y' } });
    await call(app, dana, 'POST', `/api/skills/claims/${claim.userSkillId}/reject`, { version: claim.version });
    expect((await d.mine(ana)).find((m) => m.skillId === node)).toMatchObject({
      level: 4,
      experience: '4-7y',
      validated: true,
    });

    // Raising and then taking the raise back needs no validation: it is the validated value again.
    await call(app, ana, 'PUT', `/api/me/skills/${node}`, { level: 5, experience: '4-7y' });
    await call(app, ana, 'PUT', `/api/me/skills/${node}`, { level: 4, experience: '4-7y' });
    expect((await d.mine(ana)).find((m) => m.skillId === node)).toMatchObject({ level: 4, validated: true });
    expect((await d.approvals(dana)).skillClaims.some((c) => c.skill.id === node)).toBe(false);

    await call(app, ana, 'PUT', `/api/me/skills/${node}`, { level: 3, experience: '4-7y' });
    expect((await d.mine(ana)).find((m) => m.skillId === node)).toMatchObject({ level: 3, validated: true });
    expect((await d.approvals(dana)).skillClaims.some((c) => c.skill.id === node)).toBe(false);
  });

  it('rejecting a new claim removes it; deciding on values the manager did not see is stale', async () => {
    const d = await demo();
    const [jo, dana] = [await d.as('Jo'), await d.as('Dana')];
    const go = d.skill('Go');
    const seen = (await d.approvals(dana)).skillClaims.find((c) => c.skill.id === go)!;
    expect(seen).toMatchObject({ user: { name: 'Jo Park' }, previous: null });
    // Jo edits the pending claim: still pending, no second notification, and Dana's view is stale.
    await call(app, jo, 'PUT', `/api/me/skills/${go}`, { level: 3, experience: '6-12m' });
    expect((await d.inbox(dana)).items.filter((n) => n.type === 'skillPendingValidation')).toHaveLength(1);
    expect(
      code(await call(app, dana, 'POST', `/api/skills/claims/${seen.userSkillId}/validate`, { version: seen.version })),
    ).toBe('CONFLICT_STALE');
    const fresh = (await d.approvals(dana)).skillClaims.find((c) => c.skill.id === go)!;
    expect(fresh.level).toBe(3);
    await call(app, dana, 'POST', `/api/skills/claims/${fresh.userSkillId}/reject`, { version: fresh.version });
    expect((await d.mine(jo)).some((m) => m.skillId === go)).toBe(false);
  });

  it('decides claims stored before versions existed', async () => {
    const d = await demo();
    const dana = await d.as('Dana');
    await database.db
      .collection('userSkills')
      .updateOne({ orgId: d.orgId, userId: d.person('Jo'), skillId: d.skill('Go') }, { $unset: { version: '' } });
    const claim = (await d.approvals(dana)).skillClaims.find((c) => c.skill.id === d.skill('Go'))!;
    expect(claim.version).toBe(0);
    const r = await call(app, dana, 'POST', `/api/skills/claims/${claim.userSkillId}/validate`, { version: 0 });
    expect(r.statusCode, r.body).toBe(200);
  });

  it('claims nobody else can validate go to admins, never to the claimer', async () => {
    const d = await demo();
    const [noor, dana, olivia] = [await d.as('Noor'), await d.as('Dana'), await d.as('Olivia')];
    const figma = d.skill('Figma');
    const go = d.skill('Go');
    const before = (await d.inbox(dana)).items.length;
    await call(app, noor, 'PUT', `/api/me/skills/${go}`, { level: 2, experience: '0-6m' }); // Design has no manager
    await call(app, dana, 'PUT', `/api/me/skills/${figma}`, { level: 2, experience: '0-6m' }); // Dana manages herself
    await call(app, olivia, 'PUT', `/api/me/skills/${figma}`, { level: 1, experience: '0-6m' }); // no department

    expect((await d.inbox(dana)).items).toHaveLength(before);
    expect((await d.approvals(dana)).skillClaims.map((c) => c.user.name)).toEqual(['Jo Park']);
    const stranded = NoApproverResponse.parse(
      (await call(app, olivia, 'GET', '/api/org/no-approver')).json(),
    ).skillClaims;
    expect(stranded.map((c) => c.user.name).sort()).toEqual(['Dana Okafor', 'Noor Haddad']);
    for (const c of stranded) {
      const r = await call(app, olivia, 'POST', `/api/skills/claims/${c.userSkillId}/validate`, { version: c.version });
      expect(r.statusCode, r.body).toBe(200);
    }
    const own = (await database.db.collection('userSkills').findOne({ orgId: d.orgId, userId: d.person('Olivia') }))!;
    expect(
      code(await call(app, olivia, 'POST', `/api/skills/claims/${String(own._id)}/validate`, { version: own.version })),
    ).toBe('FORBIDDEN');
  });
});

describe('Project-10 skill requirements', () => {
  it('saves minimum levels, validates them, and gates matching with a near-miss reason', async () => {
    const d = await demo();
    const [ts, aws] = [d.skill('TypeScript'), d.skill('AWS')];
    const base = { name: 'Gatekeeper', period: 'fixed', startDate: '2026-04-01', deadline: '2026-06-01' };
    const bad: [unknown, number][] = [
      [[{ skillId: ts, minLevel: 6 }], 400],
      [
        [
          { skillId: ts, minLevel: 3 },
          { skillId: ts, minLevel: 4 },
        ],
        400,
      ],
      [[{ skillId: 'nope', minLevel: 3 }], 404],
    ];
    for (const [skillRequirements, status] of bad) {
      expect((await call(app, d.pat, 'POST', '/api/projects', { ...base, skillRequirements })).statusCode).toBe(status);
    }
    const created = await call(app, d.pat, 'POST', '/api/projects', {
      ...base,
      teamRoles: [{ roleId: d.role('Backend Developer'), count: 1 }],
      skillRequirements: [{ skillId: ts, minLevel: 5 }],
    });
    expect(created.statusCode, created.body).toBe(201);
    const p = ProjectSummary.parse(created.json());
    expect(p.skillRequirements).toEqual([{ skillId: ts, minLevel: 5 }]);

    const edited = await call(app, d.pat, 'PATCH', `/api/projects/${p.id}`, {
      skillRequirements: [
        { skillId: ts, minLevel: 5 },
        { skillId: aws, minLevel: 4 },
      ],
    });
    expect(ProjectSummary.parse(edited.json()).skillRequirements).toHaveLength(2);
    const candidates = CandidatesResponse.parse(
      (
        await call(
          app,
          d.pat,
          'GET',
          `/api/projects/${p.id}/candidates?includeUnavailable=true&includePartial=true&includeNearMisses=true`,
        )
      ).json(),
    ).candidates;
    const mira = candidates.find((c) => c.name === 'Mira Chen')!;
    expect(mira.nearMiss).toBe(true);
    expect(mira.reasons).toContainEqual({ kind: 'belowMinLevel', skillId: ts, level: 4, minLevel: 5 });
  });
});
