import { ObjectId, type ClientSession, type Document, type Filter, type FindOptions, type UpdateFilter } from 'mongodb';
import { fail } from '@team-finder/domain';
import type { Database } from './client.ts';
import type { TenantCollectionName, TenantCollections, TenantDoc } from './documents.ts';

// Tenant isolation by construction (docs/design.md, invariant 3). Routes and services never see the
// raw Db: they get orgRepo(actor), which injects orgId into every filter, insert, update and the
// first $match of every aggregation, refuses cross-collection stages that were not built by
// scopedLookup(), and checks foreign ids with assertOwned().

export type { ClientSession as DbSession, Filter, UpdateFilter } from 'mongodb';

export interface RepoScope {
  orgId: string;
  isDemo: boolean;
  /** Demo sandboxes: copied onto every inserted document so TTL indexes clean them up. */
  expiresAt?: Date | undefined;
}

export interface SessionOption {
  session?: ClientSession | undefined;
}
type FindOpts = Omit<FindOptions, 'session'> & SessionOption;

/** Drops `session: undefined` (exactOptionalPropertyTypes) so callers can pass an optional session through. */
function opts<O extends SessionOption>(o: O | undefined): Omit<O, 'session'> & { session?: ClientSession } {
  const { session, ...rest } = o ?? ({} as O);
  return session ? { ...rest, session } : rest;
}

type Insertable<T extends TenantDoc> = Omit<T, 'orgId' | 'expiresAt' | '_id'> & { _id?: string };

export function newId(): string {
  return new ObjectId().toHexString();
}

const FORBIDDEN_STAGES = ['$lookup', '$unionWith', '$graphLookup'] as const;
const scopedStages = new WeakSet<object>();

function assertPipelineScoped(pipeline: readonly Document[]): void {
  for (const stage of pipeline) {
    for (const op of FORBIDDEN_STAGES) {
      if (op in stage && !scopedStages.has(stage)) {
        throw new Error(`orgRepo: raw ${op} is not allowed; build it with scopedLookup() so orgId is injected.`);
      }
    }
    if ('$facet' in stage) {
      for (const sub of Object.values(stage.$facet as Record<string, Document[]>)) assertPipelineScoped(sub);
    }
  }
}

function assertNoOrgIdWrite(update: Document): void {
  for (const [op, fields] of Object.entries(update)) {
    if (op.startsWith('$') && fields && typeof fields === 'object' && 'orgId' in fields) {
      throw new Error(`orgRepo: updates may not change orgId (${op}).`);
    }
  }
}

export interface ScopedCollection<T extends TenantDoc> {
  find(filter?: Filter<T>, options?: FindOpts): Promise<T[]>;
  findOne(filter: Filter<T>, options?: FindOpts): Promise<T | null>;
  countDocuments(filter?: Filter<T>, options?: SessionOption): Promise<number>;
  insertOne(doc: Insertable<T>, options?: SessionOption): Promise<T>;
  insertMany(docs: Insertable<T>[], options?: SessionOption): Promise<T[]>;
  updateOne(
    filter: Filter<T>,
    update: UpdateFilter<T>,
    options?: SessionOption,
  ): Promise<{ matchedCount: number; modifiedCount: number }>;
  updateMany(
    filter: Filter<T>,
    update: UpdateFilter<T>,
    options?: SessionOption,
  ): Promise<{ matchedCount: number; modifiedCount: number }>;
  deleteMany(filter: Filter<T>, options?: SessionOption): Promise<number>;
  aggregate<R extends Document = Document>(pipeline: Document[], options?: SessionOption): Promise<R[]>;
}

function scopedCollection<T extends TenantDoc>(
  database: Database,
  name: string,
  scope: RepoScope,
): ScopedCollection<T> {
  const collection = database.db.collection<T>(name);
  const scoped = (filter: Filter<T> = {}): Filter<T> => ({ ...filter, orgId: scope.orgId }) as Filter<T>;
  const stamp = (doc: Insertable<T>): T =>
    ({
      _id: newId(),
      ...doc,
      orgId: scope.orgId,
      ...(scope.isDemo && scope.expiresAt ? { expiresAt: scope.expiresAt } : {}),
    }) as unknown as T;

  return {
    find: (filter, options) => collection.find(scoped(filter), opts(options)).toArray() as Promise<T[]>,
    findOne: (filter, options) => collection.findOne(scoped(filter), opts(options)) as Promise<T | null>,
    countDocuments: (filter, options) => collection.countDocuments(scoped(filter), opts(options)),
    async insertOne(doc, options) {
      const stamped = stamp(doc);
      await collection.insertOne(stamped as never, opts(options));
      return stamped;
    },
    async insertMany(docs, options) {
      if (docs.length === 0) return [];
      const stamped = docs.map(stamp);
      await collection.insertMany(stamped as never[], opts(options));
      return stamped;
    },
    async updateOne(filter, update, options) {
      assertNoOrgIdWrite(update);
      const r = await collection.updateOne(scoped(filter), update, opts(options));
      return { matchedCount: r.matchedCount, modifiedCount: r.modifiedCount };
    },
    async updateMany(filter, update, options) {
      assertNoOrgIdWrite(update);
      const r = await collection.updateMany(scoped(filter), update, opts(options));
      return { matchedCount: r.matchedCount, modifiedCount: r.modifiedCount };
    },
    async deleteMany(filter, options) {
      return (await collection.deleteMany(scoped(filter), opts(options))).deletedCount;
    },
    async aggregate<R extends Document>(pipeline: Document[], options?: SessionOption) {
      assertPipelineScoped(pipeline);
      return collection.aggregate<R>([{ $match: { orgId: scope.orgId } }, ...pipeline], opts(options)).toArray();
    },
  };
}

export type OrgRepo = { [K in TenantCollectionName]: ScopedCollection<TenantCollections[K]> } & {
  readonly orgId: string;
  /**
   * `$lookup` into another tenant collection with `orgId` injected into the sub-pipeline. The only
   * way a cross-collection stage passes the aggregate() guard.
   */
  scopedLookup(spec: {
    from: TenantCollectionName;
    localField: string;
    foreignField: string;
    as: string;
    pipeline?: Document[];
  }): Document;
  /** Throws NOT_FOUND unless every id exists in this org (foreign ids from request bodies). */
  assertOwned(collection: TenantCollectionName, ids: readonly string[], options?: SessionOption): Promise<void>;
  /** Runs `fn` in a transaction; the driver replays it on TransientTransactionError. */
  withTransaction<R>(fn: (session: ClientSession) => Promise<R>): Promise<R>;
};

export function orgRepo(database: Database, scope: RepoScope): OrgRepo {
  const collections = Object.fromEntries(
    (['users', 'departments', 'teamRoles', 'skills', 'userSkills', 'projects', 'assignments'] as const).map((name) => [
      name,
      scopedCollection(database, name, scope),
    ]),
  ) as { [K in TenantCollectionName]: ScopedCollection<TenantCollections[K]> };

  return {
    ...collections,
    orgId: scope.orgId,
    scopedLookup({ from, localField, foreignField, as, pipeline = [] }) {
      assertPipelineScoped(pipeline);
      const stage = {
        $lookup: { from, localField, foreignField, as, pipeline: [{ $match: { orgId: scope.orgId } }, ...pipeline] },
      };
      scopedStages.add(stage);
      return stage;
    },
    async assertOwned(collection, ids, options) {
      const unique = [...new Set(ids)];
      if (unique.length === 0) return;
      const found = await collections[collection].countDocuments({ _id: { $in: unique } } as never, options);
      if (found !== unique.length) fail('NOT_FOUND', { resource: collection });
    },
    async withTransaction(fn) {
      const session = database.client.startSession();
      try {
        let result: Awaited<ReturnType<typeof fn>> | undefined;
        await session.withTransaction(async () => {
          result = await fn(session);
        });
        return result as Awaited<ReturnType<typeof fn>>;
      } finally {
        await session.endSession();
      }
    },
  };
}
