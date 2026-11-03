import { z } from 'zod';

// "Watch the race" (docs/plans/m2.5-concurrency-proof.md): two approvals of different proposals
// for the same person run at once through the real approve(); both read capacity, wait at a
// barrier, then write. Exactly one commits; the other is replayed and refused.

export const RaceEventKind = z.enum(['start', 'read', 'released', 'replay', 'committed', 'refused']);
export type RaceEventKind = z.infer<typeof RaceEventKind>;

export const RaceLane = z.object({
  lane: z.enum(['A', 'B']),
  project: z.string(),
  hoursPerDay: z.number(),
  /** Milliseconds since the run started, in the order they happened. */
  events: z.array(z.object({ at: z.number(), kind: RaceEventKind, detail: z.string().optional() })),
  outcome: z.enum(['committed', 'refused']),
  /** For a refused lane: the error code its re-check returned. */
  code: z.string().nullable(),
});
export type RaceLane = z.infer<typeof RaceLane>;

export const RaceResult = z.object({
  person: z.object({ name: z.string(), maxHours: z.number() }),
  lanes: z.tuple([RaceLane, RaceLane]),
  winner: z.enum(['A', 'B']),
  /** Transaction attempts beyond the first, across both lanes: proof the conflict happened. */
  replays: z.number(),
  totalMs: z.number(),
});
export type RaceResult = z.infer<typeof RaceResult>;
