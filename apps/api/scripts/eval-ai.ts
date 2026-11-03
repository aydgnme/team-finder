// `pnpm eval:ai`: runs the AI-01 eval set (src/ai/eval.ts) against an in-memory replica set.
// With LLM_API_KEY it calls the real model (each run is ~20 small paid requests); with
// LLM_PROVIDER=fake it checks the pipeline for free. Exits 1 when fewer than --min cases pass.
import { writeFileSync } from 'node:fs';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { anthropicProvider } from '../src/ai/anthropic.ts';
import { runEval } from '../src/ai/eval.ts';
import { fakeProvider } from '../src/ai/fake.ts';
import { buildApp } from '../src/app.ts';
import { connectDatabase } from '../src/db/client.ts';
import { ensureIndexes } from '../src/db/indexes.ts';

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const min = Number(arg('min') ?? 0.8);
const out = arg('out');

const provider =
  process.env.LLM_PROVIDER === 'fake'
    ? fakeProvider
    : process.env.LLM_API_KEY
      ? anthropicProvider({ apiKey: process.env.LLM_API_KEY, model: process.env.LLM_MODEL || undefined })
      : null;
if (!provider) {
  console.error('Set LLM_API_KEY (real model, costs money) or LLM_PROVIDER=fake.');
  process.exit(2);
}

const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
const database = await connectDatabase(replSet.getUri(), 'team-finder-eval');
await ensureIndexes(database, { warn: () => {} });
const unlimited = { max: 10_000, windowMs: 60_000 };
const app = buildApp({
  getDatabase: () => database,
  secureCookies: false,
  aiProvider: provider,
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
  const line = `${r.ok ? 'ok  ' : 'FAIL'} ${r.id.padEnd(20)} pass ${(r.passRate * 100).toFixed(0).padStart(3)}%  coverage ${(r.coverage * 100).toFixed(0).padStart(3)}%  accepted ${r.accepted}  start +${r.startDelay}d`;
  console.log(r.ok ? line : `${line}  <- ${r.error ?? r.failures.join('; ')}`);
}
console.log(
  `\n${provider.name}: ${summary.ok}/${summary.cases} cases ok · picks passing validation ${(summary.passRate * 100).toFixed(0)}% · coverage ${(summary.coverage * 100).toFixed(0)}%`,
);
if (out)
  writeFileSync(
    out,
    JSON.stringify({ provider: provider.name, at: new Date().toISOString(), summary, results }, null, 2),
  );

await app.close();
await database.close();
await replSet.stop();
process.exit(summary.ok / summary.cases >= min ? 0 : 1);
