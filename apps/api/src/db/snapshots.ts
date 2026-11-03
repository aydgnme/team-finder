import { randomBytes } from 'node:crypto';
import type { SnapshotView } from '@team-finder/domain';
import type { Database } from './client.ts';

// Share snapshots live outside tenancy (docs/design.md, "E4 Share snapshots"): a demo link must
// outlive its 24 h sandbox. Like sessions, the raw collection stays in db/; services get this store,
// and the access rules (demo public, real orgs gated, expiry) live in one function in
// services/snapshots.ts.

export type SnapshotContent = Omit<SnapshotView, 'id' | 'createdAt' | 'expiresAt'>;

export interface SnapshotDoc {
  _id: string;
  orgId: string;
  isDemo: boolean;
  /** Same draft of the same project version -> same snapshot (double-clicking "Share"). */
  hash: string;
  createdAt: Date;
  expiresAt: Date;
  content: SnapshotContent;
}

/** 128-bit random id: unguessable, so a demo link is the only way in. */
export const newSnapshotId = () => randomBytes(16).toString('base64url');

export function snapshotStore(database: Database) {
  const snapshots = database.db.collection<SnapshotDoc>('snapshots');
  return {
    findLive: (orgId: string, hash: string, now: Date) => snapshots.findOne({ orgId, hash, expiresAt: { $gt: now } }),
    get: (id: string) => snapshots.findOne({ _id: id }),
    async insert(doc: SnapshotDoc): Promise<void> {
      await snapshots.insertOne(doc);
    },
  };
}
