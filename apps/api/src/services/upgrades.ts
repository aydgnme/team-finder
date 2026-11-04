import {
  can,
  CAPACITY_CONSUMING_STATUSES,
  fail,
  monthsBetween,
  projectTargets,
  todayUtc,
  UPGRADE_EVERY_MONTHS,
  type Experience,
  type UpgradeProposalView,
} from '@team-finder/domain';
import { duplicateKeyOn } from '../db/auth.ts';
import type { Database } from '../db/client.ts';
import type { AssignmentDoc } from '../db/documents.ts';
import { orgRepo, type OrgRepo } from '../db/org-repo.ts';
import type { SessionStore } from '../db/sessions.ts';
import type { ServiceContext } from './context.ts';
import { notify } from './notifications.ts';
import { unique } from './shared.ts';
import { applyMySkill } from './skills.ts';

// Project-11 (docs/plans/m4-skills-and-notifications.md, M4b). A daily job suggests skills to people
// who have spent another 3 months on a project that uses them. `upgradeMilestone` on the assignment
// records the last multiple handled, so reruns and concurrent runs never suggest twice.

export interface UpgradeJobReport {
  orgs: number;
  assignments: number;
  proposals: number;
}

/** Runs the job for every live org, each through its own orgRepo; one org failing never stops the rest. */
export async function runUpgradeJob(
  database: Database,
  store: SessionStore,
  now: Date,
  onError: (orgId: string, error: unknown) => void = () => {},
): Promise<UpgradeJobReport> {
  const report: UpgradeJobReport = { orgs: 0, assignments: 0, proposals: 0 };
  for (const org of await store.listOrgIds(now)) {
    const repo = orgRepo(database, { orgId: org.id, isDemo: org.isDemo, expiresAt: org.expiresAt });
    try {
      const r = await upgradeOrg(repo, now);
      report.assignments += r.assignments;
      report.proposals += r.proposals;
    } catch (error) {
      onError(org.id, error);
    }
    report.orgs++;
  }
  return report;
}

/** The job for one org. Exported for tests. */
export async function upgradeOrg(repo: OrgRepo, now: Date): Promise<Omit<UpgradeJobReport, 'orgs'>> {
  const today = todayUtc(now);
  const candidates = await repo.assignments.find({
    status: { $in: [...CAPACITY_CONSUMING_STATUSES] },
    from: { $lte: today },
  });
  let assignments = 0;
  let proposals = 0;
  for (const a of candidates) {
    const milestone = Math.floor(monthsBetween(a.from, today) / UPGRADE_EVERY_MONTHS);
    if (milestone < 1 || milestone <= (a.upgradeMilestone ?? 0)) continue;
    const created = await handleMilestone(repo, now, a, milestone);
    if (created === null) continue;
    assignments++;
    proposals += created;
  }
  return { assignments, proposals };
}

/** One transaction per assignment; null when another run handled this milestone first. */
async function handleMilestone(repo: OrgRepo, now: Date, a: AssignmentDoc, milestone: number): Promise<number | null> {
  try {
    return await proposeForMilestone(repo, now, a, milestone);
  } catch (error) {
    // A concurrent run proposed the same skill from another assignment: this one rolled back, so its
    // milestone stays unclaimed and the next run retries it against the open proposal.
    if (duplicateKeyOn(error, 'org_user_skill_open_unique')) return null;
    throw error;
  }
}

async function proposeForMilestone(
  repo: OrgRepo,
  now: Date,
  a: AssignmentDoc,
  milestone: number,
): Promise<number | null> {
  return repo.withTransaction(async (session) => {
    const claimed = await repo.assignments.updateOne(
      {
        _id: a._id,
        ...(a.upgradeMilestone === undefined
          ? { upgradeMilestone: { $exists: false } }
          : { upgradeMilestone: a.upgradeMilestone }),
      },
      { $set: { upgradeMilestone: milestone } },
      { session },
    );
    if (claimed.matchedCount !== 1) return null;
    const project = await repo.projects.findOne({ _id: a.projectId }, { session });
    if (!project) return 0;
    const targets = projectTargets(project);
    if (targets.length === 0) return 0;
    const ids = targets.map((t) => t.skillId);
    const [held, open, skills, user] = await Promise.all([
      repo.userSkills.find({ userId: a.userId, skillId: { $in: ids } }, { session }),
      repo.skillUpgradeProposals.find({ userId: a.userId, skillId: { $in: ids }, status: 'open' }, { session }),
      repo.skills.find({ _id: { $in: ids } }, { session, projection: { name: 1 } }),
      repo.users.findOne({ _id: a.userId }, { session, projection: { name: 1 } }),
    ]);
    if (!user) return 0;
    const level = new Map(held.map((h) => [h.skillId, h.level]));
    const pending = new Set(open.map((p) => p.skillId));
    const skillName = new Map(skills.map((s) => [s._id, s.name]));
    const missing = targets.filter((t) => {
      if (pending.has(t.skillId) || !skillName.has(t.skillId)) return false;
      const has = level.get(t.skillId);
      return has === undefined || (t.minLevel !== undefined && has < t.minLevel);
    });
    // A background job acts as nobody: notifications carry no actor and are never "your own".
    const system = { repo, now, actor: { userId: '' } };
    for (const t of missing) {
      const doc = await repo.skillUpgradeProposals.insertOne(
        {
          userId: a.userId,
          skillId: t.skillId,
          projectId: project._id,
          minLevel: t.minLevel ?? null,
          status: 'open',
          createdAt: now,
          decidedAt: null,
        },
        { session },
      );
      await notify(system, session, [
        {
          userId: a.userId,
          type: 'skillUpgradeProposal',
          refId: doc._id,
          data: { projectId: project._id, projectName: project.name, skillName: skillName.get(t.skillId)! },
        },
      ]);
    }
    return missing.length;
  });
}

export async function listMyProposals({ repo, actor }: ServiceContext): Promise<{ proposals: UpgradeProposalView[] }> {
  const open = await repo.skillUpgradeProposals.find(
    { userId: actor.userId, status: 'open' },
    { sort: { createdAt: -1, _id: 1 } },
  );
  if (open.length === 0) return { proposals: [] };
  const [skills, projects, held] = await Promise.all([
    repo.skills.find({ _id: { $in: unique(open.map((p) => p.skillId)) } }, { projection: { name: 1 } }),
    repo.projects.find({ _id: { $in: unique(open.map((p) => p.projectId)) } }, { projection: { name: 1 } }),
    repo.userSkills.find({ userId: actor.userId, skillId: { $in: unique(open.map((p) => p.skillId)) } }),
  ]);
  const skillName = new Map(skills.map((s) => [s._id, s.name]));
  const projectName = new Map(projects.map((p) => [p._id, p.name]));
  const mine = new Map(held.map((h) => [h.skillId, h]));
  return {
    // A suggestion whose skill was deleted since (projects can drop it) is no longer actionable.
    proposals: open
      .filter((p) => skillName.has(p.skillId))
      .map((p) => {
        const h = mine.get(p.skillId);
        return {
          id: p._id,
          skill: { id: p.skillId, name: skillName.get(p.skillId)! },
          project: { id: p.projectId, name: projectName.get(p.projectId) ?? 'a project' },
          minLevel: p.minLevel,
          current: h ? { level: h.level, experience: h.experience, validated: h.validated } : null,
          createdAt: p.createdAt.toISOString(),
        };
      }),
  };
}

/** Accepting goes through Skill-02 (applyMySkill), so the skill then waits for validation like any claim. */
export async function decideProposal(
  ctx: ServiceContext,
  proposalId: string,
  decision: { accept: { level: number; experience: Experience } } | { dismiss: true },
) {
  const { repo, actor, now } = ctx;
  if (!can(actor, 'userSkill.edit', { orgId: actor.orgId, userId: actor.userId })) {
    fail('FORBIDDEN', { action: 'edit skills' });
  }
  return repo.withTransaction(async (session) => {
    const p = await repo.skillUpgradeProposals.findOne({ _id: proposalId, userId: actor.userId }, { session });
    if (!p) fail('NOT_FOUND', { resource: 'upgrade proposal', id: proposalId });
    const status = 'accept' in decision ? 'accepted' : 'dismissed';
    const r = await repo.skillUpgradeProposals.updateOne(
      { _id: p!._id, status: 'open' },
      { $set: { status, decidedAt: now } },
      { session },
    );
    if (r.matchedCount !== 1) fail('CONFLICT_STALE', { resource: 'upgrade proposal', id: proposalId });
    const skill =
      'accept' in decision
        ? await applyMySkill(ctx, session, p!.skillId, decision.accept.level, decision.accept.experience)
        : null;
    return { id: proposalId, status, skill };
  });
}
