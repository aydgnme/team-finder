import { randomBytes } from 'node:crypto';
import type { Actor } from '@team-finder/domain';
import type { Database } from './client.ts';
import type { OrgDoc, SessionDoc, UserDoc } from './documents.ts';

// Server-side sessions (docs/design.md, Engineering decisions: "Auth seam from M1"). A session is
// looked up by its random id before the org is known, so this module (like orgs) sits outside
// orgRepo; everything after resolveActor goes through orgRepo(actor).

export interface ResolvedActor extends Actor {
  sessionId: string;
  /** Demo sandboxes expire; orgRepo stamps this onto inserts so TTL indexes clean them up. */
  expiresAt?: Date | undefined;
}

export function newSessionId(): string {
  return randomBytes(32).toString('base64url');
}

export function sessionStore(database: Database) {
  const sessions = database.db.collection<SessionDoc>('sessions');
  const orgs = database.db.collection<OrgDoc>('orgs');
  const users = database.db.collection<UserDoc>('users');

  return {
    async create(input: Omit<SessionDoc, '_id' | 'createdAt'>, now: Date): Promise<SessionDoc> {
      const doc: SessionDoc = { _id: newSessionId(), ...input, createdAt: now };
      await sessions.insertOne(doc);
      return doc;
    },

    async delete(id: string): Promise<void> {
      await sessions.deleteOne({ _id: id });
    },

    async createOrg(doc: OrgDoc): Promise<void> {
      await orgs.insertOne(doc);
    },

    async deleteOrg(orgId: string): Promise<void> {
      await orgs.deleteOne({ _id: orgId });
      await sessions.deleteMany({ orgId });
    },

    /** Ids of every live org (background jobs walk them one by one through orgRepo). */
    async listOrgIds(now: Date): Promise<{ id: string; isDemo: boolean; expiresAt?: Date }[]> {
      const docs = await orgs
        .find({ $or: [{ expiresAt: { $exists: false } }, { expiresAt: { $gt: now } }] })
        .project<{ _id: string; isDemo: boolean; expiresAt?: Date }>({ isDemo: 1, expiresAt: 1 })
        .toArray();
      return docs.map((o) => ({ id: o._id, isDemo: o.isDemo, ...(o.expiresAt ? { expiresAt: o.expiresAt } : {}) }));
    },

    async getOrg(orgId: string): Promise<OrgDoc | null> {
      return orgs.findOne({ _id: orgId });
    },

    /**
     * Session -> actor. Rejects expired sessions and expired orgs explicitly: TTL deletion lags by
     * up to ~60s, so a document that still exists is not proof it is alive.
     */
    async resolve(id: string, now: Date): Promise<ResolvedActor | null> {
      const session = await sessions.findOne({ _id: id, expiresAt: { $gt: now } });
      if (!session) return null;
      const org = await orgs.findOne({ _id: session.orgId });
      if (!org || (org.expiresAt && org.expiresAt <= now)) return null;
      const user = await users.findOne({ _id: session.userId, orgId: session.orgId });
      if (!user) return null;
      return {
        sessionId: session._id,
        userId: user._id,
        orgId: org._id,
        roles: user.accessRoles,
        isDemo: org.isDemo,
        expiresAt: org.expiresAt,
      };
    },
  };
}
export type SessionStore = ReturnType<typeof sessionStore>;
