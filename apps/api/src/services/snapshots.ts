import { createHash, randomBytes } from 'node:crypto';
import { can, fail, shiftProject, verdictSentence, type SnapshotRequest, type SnapshotView } from '@team-finder/domain';
import type { z } from 'zod';
import type { Database } from '../db/client.ts';
import type { ResolvedActor } from '../db/sessions.ts';
import type { ServiceContext } from './context.ts';
import { rebuildScenarios } from './scenarios.ts';

// Share snapshots (docs/design.md, "E4 Share snapshots"). An immutable, server-rebuilt copy of one
// draft and its verdict, in a non-tenant collection with its own expiry, so a demo link keeps
// working after the 24 h sandbox is gone. getSnapshot() is the one read path outside orgRepo.

export const SNAPSHOT_TTL_DAYS = { demo: 30, real: 90 } as const;
const DAY_MS = 86_400_000;

type Content = Omit<SnapshotView, 'id' | 'createdAt' | 'expiresAt'>;

export interface SnapshotDoc {
  _id: string;
  orgId: string;
  isDemo: boolean;
  /** Same draft of the same project version -> same snapshot (double-clicking "Share"). */
  hash: string;
  createdAt: Date;
  expiresAt: Date;
  content: Content;
}

const collection = (database: Database) => database.db.collection<SnapshotDoc>('snapshots');

/** 128-bit random id: unguessable, so a demo link is the only way in. */
export const newSnapshotId = () => randomBytes(16).toString('base64url');

export async function createSnapshot(
  ctx: ServiceContext,
  database: Database,
  orgName: string,
  input: z.output<typeof SnapshotRequest>,
): Promise<{ id: string; expiresAt: string }> {
  const { actor, now } = ctx;
  if (!can(actor, 'snapshot.share', { orgId: actor.orgId })) fail('FORBIDDEN', { action: 'share staffing drafts' });
  const rebuilt = await rebuildScenarios(ctx, input.projectId, input.start, input.additions);
  const additions = [...input.additions].sort((a, b) => a.userId.localeCompare(b.userId));
  const hash = createHash('sha256')
    .update(JSON.stringify([rebuilt.project._id, rebuilt.project.version, input.start, additions]))
    .digest('base64url');

  const existing = await collection(database).findOne({ orgId: actor.orgId, hash, expiresAt: { $gt: now } });
  if (existing) return { id: existing._id, expiresAt: existing.expiresAt.toISOString() };

  const shifted = shiftProject(rebuilt.project, input.start);
  const doc: SnapshotDoc = {
    _id: newSnapshotId(),
    orgId: actor.orgId,
    isDemo: actor.isDemo,
    hash,
    createdAt: now,
    expiresAt: new Date(now.getTime() + (actor.isDemo ? SNAPSHOT_TTL_DAYS.demo : SNAPSHOT_TTL_DAYS.real) * DAY_MS),
    content: {
      orgName,
      isDemo: actor.isDemo,
      project: { name: rebuilt.project.name, startDate: shifted.startDate, deadline: shifted.deadline },
      slots: rebuilt.slots,
      missingSkills: rebuilt.missingSkills,
      verdict: rebuilt.verdict,
      sentence: verdictSentence(rebuilt.verdict),
    },
  };
  await collection(database).insertOne(doc);
  return { id: doc._id, expiresAt: doc.expiresAt.toISOString() };
}

/**
 * Demo snapshots are public (seeded, fictional data). Real-org snapshots need a session in the same
 * org with a role that may see allocations. Expiry is checked here, not left to the TTL monitor,
 * which can lag by a minute.
 */
export async function getSnapshot(
  database: Database,
  actor: ResolvedActor | null,
  id: string,
  now: Date,
): Promise<SnapshotView> {
  const doc = await collection(database).findOne({ _id: id });
  if (!doc || doc.expiresAt <= now) fail('NOT_FOUND', { resource: 'snapshot' });
  if (!doc.isDemo) {
    if (!actor) fail('UNAUTHENTICATED', {});
    if (!can(actor, 'snapshot.share', { orgId: doc.orgId })) fail('FORBIDDEN', { action: 'view this snapshot' });
  }
  return {
    id: doc._id,
    createdAt: doc.createdAt.toISOString(),
    expiresAt: doc.expiresAt.toISOString(),
    ...doc.content,
  };
}
