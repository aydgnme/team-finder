import { MongoClient, type Db, type MongoClientOptions } from 'mongodb';

// The only directory allowed to import 'mongodb' outside tests (enforced by eslint.config.js).
// Routes receive orgRepo(actor) built on top of this, never the raw Db.

export interface Database {
  client: MongoClient;
  db: Db;
  ping: () => Promise<boolean>;
  /** Transactions need a replica set (invariant 2); a standalone mongod has none. */
  isReplicaSet: () => Promise<boolean>;
  close: () => Promise<void>;
}

export async function connectDatabase(
  uri: string,
  dbName: string,
  options: MongoClientOptions = {},
): Promise<Database> {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5_000, ...options });
  await client.connect();
  const db = client.db(dbName);
  return {
    client,
    db,
    ping: async () => {
      try {
        await db.command({ ping: 1 });
        return true;
      } catch {
        return false;
      }
    },
    isReplicaSet: async () => {
      const hello = await db.admin().command({ hello: 1 });
      return typeof hello.setName === 'string' && hello.setName.length > 0;
    },
    close: () => client.close(),
  };
}

/** Driver errors that mean "database not reachable" (mapped to 503 DB_UNAVAILABLE). */
export function isDbUnavailableError(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return (
    typeof name === 'string' &&
    [
      'MongoServerSelectionError',
      'MongoNetworkError',
      'MongoNetworkTimeoutError',
      'MongoNotConnectedError',
      'MongoTopologyClosedError',
    ].includes(name)
  );
}
