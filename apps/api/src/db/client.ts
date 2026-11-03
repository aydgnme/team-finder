import { MongoClient, type Db } from 'mongodb';

// The only module allowed to import 'mongodb' outside tests (enforced by eslint.config.js).
// Routes will receive orgRepo(actor) built on top of this in M1, never the raw Db.

export interface Database {
  client: MongoClient;
  db: Db;
  ping: () => Promise<boolean>;
  close: () => Promise<void>;
}

export async function connectDatabase(uri: string, dbName: string): Promise<Database> {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5_000 });
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
    close: () => client.close(),
  };
}
