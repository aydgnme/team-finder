import type { TestProject } from 'vitest/node';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

// One single-node replica set for the whole API suite: transactions need a replica set
// (docs/design.md, invariant 2). Each test file uses its own database name to stay isolated.
let replSet: MongoMemoryReplSet | undefined;

export async function setup(project: TestProject) {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  project.provide('mongoUri', replSet.getUri());
}

export async function teardown() {
  await replSet?.stop();
}

declare module 'vitest' {
  export interface ProvidedContext {
    mongoUri: string;
  }
}
