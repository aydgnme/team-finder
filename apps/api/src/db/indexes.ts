import type { IndexSpecification, CreateIndexesOptions } from 'mongodb';
import type { Database } from './client.ts';
import { NON_TERMINAL_STATUSES } from '@team-finder/domain';
import { TENANT_COLLECTIONS } from './documents.ts';

// Mongo has no migrations: indexes are the schema. This declared list is applied idempotently at
// boot; unknown indexes are logged, never dropped (docs/design.md, Phase 3.5 DX #8). Every query
// index leads with orgId; TTL indexes are the documented exception (they clean up demo sandboxes).

export interface DeclaredIndex {
  collection: string;
  name: string;
  key: IndexSpecification;
  options?: Omit<CreateIndexesOptions, 'name'>;
  /**
   * Why this index does not lead with orgId. Only for lookups that happen before the org is known
   * (login by email, invite links); never applied to Mongo.
   */
  global?: string;
}

const ttl = (collection: string): DeclaredIndex => ({
  collection,
  name: 'ttl_expiresAt',
  key: { expiresAt: 1 },
  options: { expireAfterSeconds: 0 },
});

export const INDEXES: DeclaredIndex[] = [
  ttl('orgs'),
  ttl('sessions'),
  ...TENANT_COLLECTIONS.map(ttl),
  { collection: 'users', name: 'org_department', key: { orgId: 1, departmentId: 1 } },
  {
    collection: 'users',
    name: 'login_email_unique',
    key: { email: 1 },
    global: 'login finds the account by email before the org is known',
    // Login looks people up by email before the org is known: one account per address. Demo users
    // carry no password and are not constrained (every sandbox reuses the seed's addresses).
    options: { unique: true, partialFilterExpression: { passwordHash: { $type: 'string' } } },
  },
  {
    collection: 'orgs',
    name: 'invite_token_unique',
    key: { inviteToken: 1 },
    global: 'an invite link identifies its org',
    options: { unique: true, partialFilterExpression: { inviteToken: { $type: 'string' } } },
  },
  {
    collection: 'skillCategories',
    name: 'org_name_unique_ci',
    key: { orgId: 1, name: 1 },
    options: { unique: true, collation: { locale: 'en', strength: 2 } },
  },
  {
    collection: 'skills',
    name: 'org_name_unique_ci',
    key: { orgId: 1, name: 1 },
    options: { unique: true, collation: { locale: 'en', strength: 2 } },
  },
  {
    collection: 'departments',
    name: 'org_name_unique_ci',
    key: { orgId: 1, name: 1 },
    options: { unique: true, collation: { locale: 'en', strength: 2 } },
  },
  {
    collection: 'teamRoles',
    name: 'org_name_unique_ci',
    key: { orgId: 1, name: 1 },
    // Role-02: names are unique per org regardless of case ("QA" and "qa" are the same role).
    options: { unique: true, collation: { locale: 'en', strength: 2 } },
  },
  {
    collection: 'departments',
    name: 'org_manager_unique',
    key: { orgId: 1, managerId: 1 },
    // One department per manager; departments without a manager are not constrained.
    options: { unique: true, partialFilterExpression: { managerId: { $type: 'string' } } },
  },
  { collection: 'userSkills', name: 'org_user', key: { orgId: 1, userId: 1 } },
  {
    collection: 'userSkills',
    name: 'org_user_skill_unique',
    key: { orgId: 1, userId: 1, skillId: 1 },
    options: { unique: true },
  },
  { collection: 'projects', name: 'org_pm', key: { orgId: 1, pmId: 1 } },
  { collection: 'assignments', name: 'org_user_status_from', key: { orgId: 1, userId: 1, status: 1, from: 1 } },
  { collection: 'assignments', name: 'org_project_status', key: { orgId: 1, projectId: 1, status: 1 } },
  {
    collection: 'assignments',
    name: 'org_project_user_open_unique',
    key: { orgId: 1, projectId: 1, userId: 1 },
    // At most one open assignment per person and project; backs the in-transaction duplicate check.
    options: { unique: true, partialFilterExpression: { status: { $in: [...NON_TERMINAL_STATUSES] } } },
  },
  // Snapshots live outside tenancy (the one exception, see services/snapshots.ts) with their own expiry.
  ttl('snapshots'),
  { collection: 'snapshots', name: 'org_hash', key: { orgId: 1, hash: 1 } },
];

export interface IndexReport {
  ensured: number;
  unknown: { collection: string; name: string }[];
}

export async function ensureIndexes(
  database: Database,
  log: { warn: (obj: object, msg: string) => void } = console as never,
  indexes: DeclaredIndex[] = INDEXES,
): Promise<IndexReport> {
  for (const index of indexes) {
    await database.db.collection(index.collection).createIndex(index.key, { ...index.options, name: index.name });
  }
  const unknown: IndexReport['unknown'] = [];
  for (const collection of new Set(indexes.map((i) => i.collection))) {
    const declared = new Set(indexes.filter((i) => i.collection === collection).map((i) => i.name));
    for (const existing of await database.db.collection(collection).indexes()) {
      const name = String(existing.name);
      if (name !== '_id_' && !declared.has(name)) unknown.push({ collection, name });
    }
  }
  if (unknown.length > 0) log.warn({ unknown }, 'indexes not in the declared list (left in place)');
  return { ensured: indexes.length, unknown };
}
