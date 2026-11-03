import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CASES, runEval } from '../src/ai/eval.ts';
import { fakeProvider } from '../src/ai/fake.ts';
import type { Database } from '../src/db/client.ts';
import { testApp, testDatabase } from './helpers.ts';

// The eval set on every PR, with the fake provider: proves the harness and the validation
// pipeline (every case answers, scores are in range) and pins the fake's baseline, so a change
// that silently breaks drafting shows up here before the nightly real-model run.

let database: Database;
beforeAll(async () => {
  database = await testDatabase('ai-eval-test');
});
afterAll(() => database?.close());

describe('AI-01 eval set (fake provider)', () => {
  it('has 20 distinct cases', () => {
    expect(CASES).toHaveLength(20);
    expect(new Set(CASES.map((c) => c.id)).size).toBe(20);
  });

  it('runs every case through the real route and scores it', async () => {
    const unlimited = { max: 10_000, windowMs: 60_000 };
    const app = testApp(database, {
      aiProvider: fakeProvider,
      rateLimits: {
        demoPerClient: unlimited,
        demoGlobal: unlimited,
        mutationsPerSession: unlimited,
        aiPerSession: unlimited,
        aiDaily: unlimited,
      },
    });
    const { results, summary } = await runEval(app);
    for (const r of results) {
      expect(r.error, r.id).toBeUndefined();
      expect(r.passRate).toBeGreaterThanOrEqual(0);
      expect(r.passRate).toBeLessThanOrEqual(1);
      expect(r.startDelay).toBeGreaterThanOrEqual(0);
      expect(r.startDelay).toBeLessThanOrEqual(42);
    }
    // Baseline of the keyword-matching fake; the real model is held to `pnpm eval:ai --min=0.8`.
    expect(summary.ok).toBe(15);
    console.info(
      `fake baseline: ${summary.ok}/${summary.cases} ok, pass ${summary.passRate.toFixed(2)}, coverage ${summary.coverage.toFixed(2)}`,
    );
  });
});
