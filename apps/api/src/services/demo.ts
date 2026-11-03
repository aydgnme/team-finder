import { todayUtc, type SessionInfo } from '@team-finder/domain';
import type { Database } from '../db/client.ts';
import { newId, orgRepo, type OrgRepo } from '../db/org-repo.ts';
import type { ResolvedActor, SessionStore } from '../db/sessions.ts';
import { atlasSeed } from '../seed/atlas.ts';

export const SANDBOX_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Per-visitor sandbox: clones the Atlas seed into a fresh demo org (one insertMany per collection).
 * Every document carries `expiresAt`, so TTL indexes remove the whole sandbox after 24 h.
 */
export async function createSandbox(database: Database, store: SessionStore, now: Date) {
  const seed = atlasSeed(todayUtc(now), now);
  const orgId = newId();
  const expiresAt = new Date(now.getTime() + SANDBOX_TTL_MS);
  await store.createOrg({
    _id: orgId,
    name: seed.orgName,
    isDemo: true,
    expiresAt,
    landingProjectId: seed.landingProjectId,
    createdAt: now,
  });
  const repo = orgRepo(database, { orgId, isDemo: true, expiresAt });
  await Promise.all([
    repo.users.insertMany(seed.users),
    repo.departments.insertMany(seed.departments),
    repo.teamRoles.insertMany(seed.teamRoles),
    repo.skills.insertMany(seed.skills),
    repo.userSkills.insertMany(seed.userSkills),
    repo.projects.insertMany(seed.projects),
    repo.assignments.insertMany(seed.assignments),
  ]);
  return { orgId, expiresAt, pmUserId: seed.pmUserId };
}

export async function sessionInfo(repo: OrgRepo, store: SessionStore, actor: ResolvedActor): Promise<SessionInfo> {
  const [user, org, personas] = await Promise.all([
    repo.users.findOne({ _id: actor.userId }),
    store.getOrg(actor.orgId),
    actor.isDemo ? repo.users.find({ personaOrder: { $exists: true } }, { sort: { personaOrder: 1 } }) : [],
  ]);
  if (!user || !org) throw new Error('session refers to a missing user or org');
  const persona = (u: typeof user) => ({ id: u._id, name: u.name, title: u.title, roles: u.accessRoles });
  return {
    user: persona(user),
    org: { id: org._id, name: org.name, isDemo: org.isDemo, expiresAt: org.expiresAt?.toISOString() ?? null },
    landingProjectId: org.landingProjectId,
    personas: personas.map(persona),
  };
}
