import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { connectDatabase, type Database } from '../src/db/client.ts';

// Proves the shared test replica set (test/global-setup.ts) supports transactions.
let database: Database;

beforeAll(async () => {
  database = await connectDatabase(inject('mongoUri'), 'database-test');
});

afterAll(async () => {
  await database?.db.dropDatabase();
  await database?.close();
});

describe('database harness', () => {
  it('answers ping', async () => {
    expect(await database.ping()).toBe(true);
  });

  it('supports multi-document transactions', async () => {
    const things = database.db.collection('things');
    const session = database.client.startSession();
    try {
      await session.withTransaction(async () => {
        await things.insertOne({ n: 1 }, { session });
        await things.insertOne({ n: 2 }, { session });
      });
    } finally {
      await session.endSession();
    }
    expect(await things.countDocuments()).toBe(2);
  });

  it('rolls back an aborted transaction', async () => {
    const things = database.db.collection('rollback');
    const session = database.client.startSession();
    await expect(
      session.withTransaction(async () => {
        await things.insertOne({ n: 1 }, { session });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await session.endSession();
    expect(await things.countDocuments()).toBe(0);
  });
});
