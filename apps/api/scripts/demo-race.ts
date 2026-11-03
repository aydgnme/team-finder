// `pnpm demo:race`: the concurrency proof in one command, no accounts. Starts an in-memory replica
// set (transactions need one), runs the real approve() twice at once through a barrier (see
// src/services/race.ts) and prints both lanes, the result and the replay count. Exits 1 if the
// invariant ever breaks. `--runs=N` repeats it.
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { RaceLane } from '@team-finder/domain';
import { connectDatabase } from '../src/db/client.ts';
import { ensureIndexes } from '../src/db/indexes.ts';
import { sessionStore } from '../src/db/sessions.ts';
import { RACE_HOURS, runRace } from '../src/services/race.ts';

const runs = Number(process.argv.find((a) => a.startsWith('--runs='))?.split('=')[1] ?? 1);

const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
const database = await connectDatabase(replSet.getUri(), 'team-finder-race');
await ensureIndexes(database, { warn: () => {} });
const store = sessionStore(database);

const lane = (l: RaceLane) =>
  `  ${l.lane} ${l.project.padEnd(9)} ` +
  l.events.map((e) => `${e.kind}${e.kind === 'refused' ? ` ${e.detail}` : ''} @${e.at.toFixed(1)}ms`).join(' → ');

console.log(
  `Two approvals for Riley at the same moment: ${RACE_HOURS} h/day on Apollo and ${RACE_HOURS} h/day on Borealis (max 8 h/day).\n` +
    'Both read capacity and pass the check, wait at a barrier, then write. The capacityVersion write conflicts;\n' +
    'the driver replays the loser, whose re-check refuses it.\n',
);

let broken = 0;
let totalReplays = 0;
for (let i = 1; i <= runs; i++) {
  try {
    const r = await runRace(database, store, new Date());
    totalReplays += r.replays;
    const loser = r.lanes.find((l) => l.lane !== r.winner)!;
    if (runs === 1 || i === runs) {
      console.log(r.lanes.map(lane).join('\n'));
      console.log(
        `\n  ${r.winner} committed, ${loser.lane} refused (${loser.code}) · replays=${r.replays} · ${r.totalMs.toFixed(0)} ms`,
      );
    }
  } catch (error) {
    broken++;
    console.error(`run ${i}:`, (error as Error).message);
  }
}
console.log(
  runs === 1
    ? `\n${broken ? 'FAILED' : '1 ok, 1 CAPACITY_EXCEEDED'}, replays=${totalReplays}`
    : `\n${runs - broken}/${runs} runs: exactly one approval committed (replays=${totalReplays})`,
);
console.log('Test: apps/api/test/race.test.ts · How it works: docs/architecture.md#concurrency-proof');

await database.close();
await replSet.stop();
process.exit(broken ? 1 : 0);
