import { randomBytes } from 'node:crypto';
import type { AccessRole } from '@team-finder/domain';
import type { Database } from './client.ts';
import type { OrgDoc, UserDoc } from './documents.ts';
import { newId, type DbSession } from './org-repo.ts';

// Pre-authentication reads and writes (Auth-01..03): who is behind this email, which org this
// invite link belongs to, and creating an org or a member before anyone has a session. Like the
// session store, this sits in db/ outside orgRepo because the org is not known yet; everything
// after login goes through orgRepo(actor).

export const newInviteToken = () => randomBytes(32).toString('base64url');

/** MongoDB duplicate-key error on one of our unique indexes. */
export function duplicateKeyOn(error: unknown, index: string): boolean {
  const e = error as { code?: number; message?: string };
  return e?.code === 11000 && typeof e.message === 'string' && e.message.includes(index);
}

export function authStore(database: Database) {
  const orgs = database.db.collection<OrgDoc>('orgs');
  const users = database.db.collection<UserDoc>('users');

  return {
    /** The account that may log in with this (normalized) email, if any. */
    findLoginUser: (email: string) =>
      users.findOne({ email, passwordHash: { $type: 'string' } }) as Promise<
        (UserDoc & { passwordHash: string }) | null
      >,

    /** A real org's invite link; demo sandboxes never accept invites. */
    findOrgByInvite: (token: string) => orgs.findOne({ inviteToken: token, isDemo: false }),

    /** Auth-01: the organization and its first admin, in one transaction (both or neither). */
    async createOrgWithAdmin(
      input: { orgName: string; hqAddress: string; name: string; email: string; passwordHash: string },
      now: Date,
    ): Promise<{ orgId: string; userId: string }> {
      const orgId = newId();
      const userId = newId();
      const session = database.client.startSession();
      try {
        await session.withTransaction(async () => {
          await orgs.insertOne(
            {
              _id: orgId,
              name: input.orgName,
              hqAddress: input.hqAddress,
              isDemo: false,
              inviteToken: newInviteToken(),
              rolesVersion: 0,
              landingProjectId: null,
              createdAt: now,
            },
            { session },
          );
          await users.insertOne(
            {
              _id: userId,
              orgId,
              name: input.name,
              email: input.email,
              title: 'Organization admin',
              accessRoles: ['employee', 'admin'],
              departmentId: null,
              passwordHash: input.passwordHash,
              capacityVersion: 0,
            },
            { session },
          );
        });
      } finally {
        await session.endSession();
      }
      return { orgId, userId };
    },

    /** Auth-03: a new employee of an existing org. */
    async addMember(
      orgId: string,
      input: { name: string; email: string; passwordHash: string; roles?: AccessRole[] },
    ): Promise<string> {
      const userId = newId();
      await users.insertOne({
        _id: userId,
        orgId,
        name: input.name,
        email: input.email,
        title: '',
        accessRoles: input.roles ?? ['employee'],
        departmentId: null,
        passwordHash: input.passwordHash,
        capacityVersion: 0,
      });
      return userId;
    },

    async regenerateInvite(orgId: string): Promise<string> {
      const token = newInviteToken();
      await orgs.updateOne({ _id: orgId, isDemo: false }, { $set: { inviteToken: token } });
      return token;
    },

    /** Write a common document in every role-changing transaction (no two admins demote each other). */
    async touchRoles(orgId: string, session: DbSession): Promise<void> {
      await orgs.updateOne({ _id: orgId }, { $inc: { rolesVersion: 1 } }, { session });
    },
  };
}
export type AuthStore = ReturnType<typeof authStore>;
