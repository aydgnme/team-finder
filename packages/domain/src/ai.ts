import { z } from 'zod';
import { CandidateView } from './api.ts';
import { HOURS_PER_DAY } from './constants.ts';
import { Day } from './dates.ts';

// AI-01 (docs/design.md, "AI-01"; docs/plans/m1.75-ai-drafted-teams.md): the LLM drafts a team from
// the engine's top-ranked candidates, seen pseudonymously; the server validates every pick with the
// same domain checks as a manual drop; the PM decides what enters the draft and what is committed.

/** Longest request text accepted (cost and prompt-injection surface). */
export const AI_REQUEST_MAX_CHARS = 500;
/** Candidates the model may choose from (the engine's top N). */
export const AI_CANDIDATE_POOL = 20;

export const AiSearchRequest = z.object({
  projectId: z.string().min(1),
  text: z.string().trim().min(3).max(AI_REQUEST_MAX_CHARS),
});
export type AiSearchRequest = z.input<typeof AiSearchRequest>;

/**
 * What the model must return (sent as a JSON schema with structured outputs). Deliberately loose on
 * ranges: structured outputs guarantee the shape, the server checks every value.
 */
export const AiDraftOutput = z.object({
  /** Suggested start (YYYY-MM-DD) when the request implies one, otherwise null. */
  start: z.string().nullable(),
  assignments: z.array(
    z.object({
      candidateRef: z.string(),
      slotRoleId: z.string(),
      hoursPerDay: z.number(),
    }),
  ),
  /** Short reasons, one per line, written for the project manager. */
  rationale: z.array(z.string()),
});
export type AiDraftOutput = z.infer<typeof AiDraftOutput>;

export const AiVerdict = z.discriminatedUnion('kind', [
  /** Fits under 8 h/day on every day of the draft's window. */
  z.object({ kind: z.literal('fits'), maxHours: z.number() }),
  /** Would overbook: first day it breaks and the most hours that would fit. */
  z.object({ kind: z.literal('conflict'), date: Day, used: z.number(), maxHours: z.number() }),
  /** Not allowed at all; never enters the draft. */
  z.object({ kind: z.literal('rejected'), reason: z.enum(['duplicate', 'slotFull', 'noApprover']) }),
]);
export type AiVerdict = z.infer<typeof AiVerdict>;

export const AiDraftItem = z.object({
  candidate: CandidateView,
  slotRoleId: z.string(),
  hoursPerDay: z.number().int().min(1).max(HOURS_PER_DAY),
  verdict: AiVerdict,
});
export type AiDraftItem = z.infer<typeof AiDraftItem>;

export const AiDraftResponse = z.object({
  /** Start the draft should use (the model's suggestion clamped into the scrub range). */
  start: Day,
  items: z.array(AiDraftItem),
  /** Picks dropped because the model named an unknown candidate or slot. */
  dropped: z.number(),
  rationale: z.array(z.string()),
  /** The model's raw JSON, logged to the browser console (SRS). */
  raw: z.unknown(),
  provider: z.string(),
});
export type AiDraftResponse = z.infer<typeof AiDraftResponse>;

export const AiStatus = z.object({ enabled: z.boolean(), provider: z.string().nullable() });
export type AiStatus = z.infer<typeof AiStatus>;
