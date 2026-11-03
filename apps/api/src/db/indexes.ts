import type { IndexSpecification, CreateIndexesOptions } from 'mongodb';
import type { Database } from './client.ts';
import { TENANT_COLLECTIONS } from './documents.ts';

// Mongo has no migrations: indexes are the schema. This declared list is applied idempotently at
// boot; unknown indexes are logged, never dropped (docs/design.md, Phase 3.5 DX #8). Every query
// index leads with orgId; TTL indexes are the documented exception (they clean up demo sandboxes).

export interface DeclaredIndex {
  collection: string;
  name: string;
  key: IndexSpecification;
  options?: Omit<CreateIndexesOptions, 'name'>;
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
    collection: 'departments',
    name: 'org_manager_unique',
    key: { orgId: 1, managerId: 1 },
    // One department per manager; departments without a manager are not constrained.
    options: { unique: true, partialFilterExpression: { managerId: { $type: 'string' } } },
  },
  { collection: 'userSkills', name: 'org_user', key: { orgId: 1, userId: 1 } },
  { collection: 'projects', name: 'org_pm', key: { orgId: 1, pmId: 1 } },
  { collection: 'assignments', name: 'org_user_status_from', key: { orgId: 1, userId: 1, status: 1, from: 1 } },
  { collection: 'assignments', name: 'org_project_status', key: { orgId: 1, projectId: 1, status: 1 } },
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
