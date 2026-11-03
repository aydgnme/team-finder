import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DomainException } from '@team-finder/domain';
import type { Database } from '../src/db/client.ts';
import { newId, orgRepo } from '../src/db/org-repo.ts';
import { testDatabase } from './helpers.ts';

let database: Database;
const orgA = newId();
const orgB = newId();

beforeAll(async () => {
  database = await testDatabase('org-repo-test');
  const a = orgRepo(database, { orgId: orgA, isDemo: false });
  const b = orgRepo(database, { orgId: orgB, isDemo: false });
  await a.departments.insertOne({ _id: 'dA', name: 'Eng A', managerId: 'uA' });
  await b.departments.insertOne({ _id: 'dB', name: 'Eng B', managerId: 'uB' });
  await a.users.insertOne({
    _id: 'uA',
    name: 'Ann',
    email: 'a@x',
    title: '',
    accessRoles: ['employee'],
    departmentId: 'dA',
    capacityVersion: 0,
  });
  await b.users.insertOne({
    _id: 'uB',
    name: 'Bob',
    email: 'b@x',
    title: '',
    accessRoles: ['employee'],
    departmentId: 'dB',
    capacityVersion: 0,
  });
});
afterAll(() => database?.close());

describe('orgRepo (invariant 3)', () => {
  it('scopes reads to the caller org, even when the filter names another org', async () => {
    const a = orgRepo(database, { orgId: orgA, isDemo: false });
    expect((await a.users.find()).map((u) => u.name)).toEqual(['Ann']);
    expect(await a.users.findOne({ _id: 'uB' })).toBeNull();
    expect((await a.users.find({ orgId: orgB } as never)).map((u) => u.name)).toEqual(['Ann']); // orgId is overridden
    expect(await a.users.countDocuments()).toBe(1);
  });

  it('stamps orgId (and expiresAt for demo orgs) on insert', async () => {
    const expiresAt = new Date('2030-01-01T00:00:00Z');
    const demo = orgRepo(database, { orgId: orgA, isDemo: true, expiresAt });
    const doc = await demo.teamRoles.insertOne({ name: 'QA', orgId: orgB } as never);
    const raw = await database.db.collection('teamRoles').findOne({ _id: doc._id as never });
    expect(raw).toMatchObject({ orgId: orgA, expiresAt });
  });

  it('cannot update or delete another org documents, nor move a document between orgs', async () => {
    const a = orgRepo(database, { orgId: orgA, isDemo: false });
    expect((await a.users.updateOne({ _id: 'uB' }, { $set: { name: 'pwned' } })).matchedCount).toBe(0);
    expect(await a.users.deleteMany({ _id: 'uB' })).toBe(0);
    await expect(a.users.updateOne({ _id: 'uA' }, { $set: { orgId: orgB } } as never)).rejects.toThrow(/orgId/);
    expect(await database.db.collection('users').findOne({ _id: 'uB' as never })).toMatchObject({ name: 'Bob' });
  });

  it('prepends the org $match to aggregations and rejects raw cross-collection stages', async () => {
    const a = orgRepo(database, { orgId: orgA, isDemo: false });
    expect((await a.users.aggregate([{ $project: { name: 1 } }])).map((u) => u.name)).toEqual(['Ann']);
    for (const stage of [
      { $lookup: { from: 'departments', localField: 'departmentId', foreignField: '_id', as: 'd' } },
      { $unionWith: { coll: 'users' } },
      { $graphLookup: { from: 'users', startWith: '$_id', connectFromField: '_id', connectToField: '_id', as: 'g' } },
      { $facet: { x: [{ $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'u' } }] } },
    ]) {
      await expect(a.users.aggregate([stage])).rejects.toThrow(/scopedLookup/);
    }
  });

  it('scopedLookup injects orgId into the sub-pipeline', async () => {
    // Point Ann's department at org B's department id: a raw $lookup would leak it.
    await database.db.collection('users').updateOne({ _id: 'uA' as never }, { $set: { departmentId: 'dB' } });
    const a = orgRepo(database, { orgId: orgA, isDemo: false });
    const [ann] = await a.users.aggregate<{ d: unknown[] }>([
      a.scopedLookup({ from: 'departments', localField: 'departmentId', foreignField: '_id', as: 'd' }),
    ]);
    expect(ann!.d).toEqual([]);
    await database.db.collection('users').updateOne({ _id: 'uA' as never }, { $set: { departmentId: 'dA' } });
  });

  it('assertOwned rejects foreign ids with NOT_FOUND', async () => {
    const a = orgRepo(database, { orgId: orgA, isDemo: false });
    await expect(a.assertOwned('users', ['uA'])).resolves.toBeUndefined();
    const err = await a.assertOwned('users', ['uA', 'uB']).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DomainException);
    expect((err as DomainException).error.code).toBe('NOT_FOUND');
  });

  it('runs transactions and rolls back on a thrown error', async () => {
    const a = orgRepo(database, { orgId: orgA, isDemo: false });
    await expect(
      a.withTransaction(async (session) => {
        await a.teamRoles.insertOne({ _id: 'tx-role', name: 'Temp' }, { session });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await a.teamRoles.findOne({ _id: 'tx-role' })).toBeNull();
    expect(await a.withTransaction(async () => 42)).toBe(42);
  });
});
