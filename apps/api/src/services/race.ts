import {
  addDays,
  DomainException,
  domainError,
  fail,
  todayUtc,
  type RaceEventKind,
  type RaceLane,
  type RaceResult,
} from '@team-finder/domain';
import type { Database } from '../db/client.ts';
import { TENANT_COLLECTIONS } from '../db/documents.ts';
import { newId, orgRepo } from '../db/org-repo.ts';
import type { SessionStore } from '../db/sessions.ts';
import { approve } from './assignments.ts';
import type { ServiceContext } from './context.ts';

// "Watch the race" (docs/plans/m2.5-concurrency-proof.md). Each run builds a throwaway org (a
// manager, one person in their department, two projects, two 5 h proposals), approves both at
// once through the real approve() with a barrier in its afterRead hook, and deletes the org in
// `finally`. Tenant isolation keeps it out of every other query; `expiresAt` is a backstop.

export const RACE_HOURS = 5;
export const BARRIER_TIMEOUT_MS = 2_000;

/** Two-party barrier for one run: releases both once both arrived, or fails both after a timeout. */
export function createBarrier(timeoutMs: number) {
  let arrived = 0;
  let release!: () => void;
  let abort!: (e: Error) => void;
  const gate = new Promise<void>((resolve, reject) => {
    release = resolve;
    abort = reject;
  });
  gate.catch(() => {});
  const timer = setTimeout(() => abort(new DomainException(domainError('RACE_TIMEOUT', {}))), timeoutMs);
  return {
    arrive(): Promise<void> {
      arrived++;
      if (arrived === 2) {
        clearTimeout(timer);
        release();
      }
      return gate;
    },
    dispose() {
      clearTimeout(timer);
    },
  };
}

async function buildRaceOrg(database: Database, store: SessionStore, now: Date) {
  const orgId = newId();
  const expiresAt = new Date(now.getTime() + 10 * 60_000);
  await store.createOrg({ _id: orgId, name: 'Race', isDemo: true, expiresAt, landingProjectId: null, createdAt: now });
  const repo = orgRepo(database, { orgId, isDemo: true, expiresAt });
  const today = todayUtc(now);
  const start = addDays(today, 7);
  const deadline = addDays(start, 28);
  const [manager, person] = [newId(), newId()];
  const dept = newId();
  const role = newId();
  await repo.users.insertMany([
    {
      _id: manager,
      name: 'Race Manager',
      email: 'manager@race.example',
      title: '',
      accessRoles: ['employee', 'deptManager', 'projectManager'],
      departmentId: null,
      capacityVersion: 0,
    },
    {
      _id: person,
      name: 'Riley Race',
      email: 'riley@race.example',
      title: 'Engineer',
      accessRoles: ['employee'],
      departmentId: dept,
      capacityVersion: 0,
    },
  ]);
  await repo.departments.insertOne({ _id: dept, name: 'Race', managerId: manager });
  await repo.teamRoles.insertOne({ _id: role, name: 'Engineer' });
  const lanes = (['A', 'B'] as const).map((lane) => ({
    lane,
    projectId: newId(),
    proposalId: newId(),
    name: lane === 'A' ? 'Apollo' : 'Borealis',
  }));
  for (const l of lanes) {
    await repo.projects.insertOne({
      _id: l.projectId,
      name: l.name,
      description: '',
      period: 'fixed',
      startDate: start,
      deadline,
      status: 'starting',
      everActive: false,
      techStack: [],
      teamRoles: [{ roleId: role, count: 1 }],
      skillRequirements: [],
      pmId: manager,
      version: 0,
    });
    await repo.assignments.insertOne({
      _id: l.proposalId,
      userId: person,
      projectId: l.projectId,
      hoursPerDay: RACE_HOURS,
      slotRoleId: role,
      roleIds: [role],
      status: 'proposed',
      from: start,
      to: deadline,
      comments: '',
      approverId: null,
      proposedBy: manager,
      version: 0,
      createdAt: now,
    });
  }
  const ctx: ServiceContext = {
    repo,
    now,
    today,
    actor: {
      sessionId: 'race',
      userId: manager,
      orgId,
      roles: ['employee', 'deptManager', 'projectManager'],
      isDemo: true,
      expiresAt,
    },
  };
  return { orgId, repo, ctx, lanes };
}

/**
 * Runs one race and returns both lanes' real timelines. Throws RACE_TIMEOUT if a lane never reaches
 * the barrier, INVARIANT_BROKEN if both approvals commit (logged by the caller; should never happen).
 */
export async function runRace(
  database: Database,
  store: SessionStore,
  now: Date,
  options: { timeoutMs?: number; onBuilt?: (orgId: string) => void } = {},
): Promise<RaceResult> {
  const race = await buildRaceOrg(database, store, now);
  options.onBuilt?.(race.orgId);
  const barrier = createBarrier(options.timeoutMs ?? BARRIER_TIMEOUT_MS);
  const t0 = performance.now();
  const at = () => Math.round((performance.now() - t0) * 10) / 10;
  try {
    const runs = race.lanes.map(async (l) => {
      const events: RaceLane['events'] = [{ at: at(), kind: 'start' }];
      const log = (kind: RaceEventKind, detail?: string) =>
        events.push({ at: at(), kind, ...(detail ? { detail } : {}) });
      let attempt = 0;
      try {
        await approve(race.ctx, l.proposalId, 0, {
          afterRead: async () => {
            attempt++;
            // First attempt only: a replay must never wait, or the loser would deadlock the run.
            if (attempt > 1) {
              log('replay', `attempt ${attempt}`);
              return;
            }
            log('read', 'capacity read and checked: fits');
            await barrier.arrive();
            log('released');
          },
        });
        log('committed');
        return {
          lane: l.lane,
          project: l.name,
          hoursPerDay: RACE_HOURS,
          events,
          outcome: 'committed' as const,
          code: null,
          attempts: attempt,
        };
      } catch (error) {
        if (!(error instanceof DomainException)) throw error;
        if (error.error.code === 'RACE_TIMEOUT') throw error;
        // A refused re-check may happen before the hook runs again; count that attempt as the replay.
        if (attempt === 1) {
          attempt++;
          log('replay', 'attempt 2');
        }
        log('refused', error.error.code);
        return {
          lane: l.lane,
          project: l.name,
          hoursPerDay: RACE_HOURS,
          events,
          outcome: 'refused' as const,
          code: error.error.code,
          attempts: attempt,
        };
      }
    });
    const [a, b] = await Promise.all(runs);
    const committed = [a!, b!].filter((l) => l.outcome === 'committed');
    if (committed.length !== 1) {
      fail(committed.length === 2 ? 'INVARIANT_BROKEN' : 'RACE_TIMEOUT', {});
    }
    const strip = (l: NonNullable<typeof a>): RaceLane => ({
      lane: l.lane,
      project: l.project,
      hoursPerDay: l.hoursPerDay,
      events: l.events,
      outcome: l.outcome,
      code: l.code,
    });
    return {
      person: { name: 'Riley Race', maxHours: 8 },
      lanes: [strip(a!), strip(b!)],
      winner: committed[0]!.lane,
      replays: Math.max(0, a!.attempts - 1) + Math.max(0, b!.attempts - 1),
      totalMs: at(),
    };
  } finally {
    barrier.dispose();
    for (const c of TENANT_COLLECTIONS) await race.repo[c].deleteMany({});
    await store.deleteOrg(race.orgId);
  }
}
