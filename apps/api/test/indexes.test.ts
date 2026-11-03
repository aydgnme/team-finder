import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../src/db/client.ts';
import { ensureIndexes, INDEXES } from '../src/db/indexes.ts';
import { testDatabase } from './helpers.ts';

let database: Database;
beforeAll(async () => {
  database = await testDatabase('indexes-test');
});
afterAll(() => database?.close());

describe('ensureIndexes', () => {
  it('is idempotent and reports, but never drops, unknown indexes', async () => {
    await database.db.collection('users').createIndex({ email: 1 }, { name: 'adhoc_email' });
    const warnings: unknown[] = [];
    const report = await ensureIndexes(database, { warn: (obj) => warnings.push(obj) });
    expect(report.ensured).toBe(INDEXES.length);
    expect(report.unknown).toEqual([{ collection: 'users', name: 'adhoc_email' }]);
    expect(warnings).toHaveLength(1);
    expect((await database.db.collection('users').indexes()).map((i) => i.name)).toContain('adhoc_email');
  });

  it('leads every non-TTL index with orgId', () => {
    for (const index of INDEXES.filter((i) => i.options?.expireAfterSeconds === undefined)) {
      expect(Object.keys(index.key as object)[0], `${index.collection}.${index.name}`).toBe('orgId');
    }
  });
});
