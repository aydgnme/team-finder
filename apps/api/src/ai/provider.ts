import type { Day, Interval } from '@team-finder/domain';

// AI-01 provider seam. A provider turns a (pseudonymous) prompt into the model's raw JSON; it never
// sees names or ids of people, and it never writes anything. The service validates what comes back.

export interface PromptCandidate {
  /** Pseudonym for this request only: c1..cN. */
  ref: string;
  title: string;
  skills: { name: string; level: number }[];
  /** Hours per day free over the whole project window (0 when rolling off). */
  hoursFree: number;
  /** Fully free from this day (rolling off), otherwise null. */
  availableFrom: Day | null;
}

export interface PromptInput {
  today: Day;
  project: { name: string; startDate: Day; deadline: Day | null; scrub: Interval | null };
  slots: { roleId: string; roleName: string; count: number; open: number }[];
  targets: { name: string; minLevel: number | null }[];
  coveredByTeam: string[];
  candidates: PromptCandidate[];
  text: string;
}

export interface RenderedPrompt {
  system: string;
  user: string;
}

/** Thrown by providers; the route answers 503 AI_UNAVAILABLE with this reason. */
export class AiUnavailable extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.reason = reason;
    this.name = 'AiUnavailable';
  }
}

export interface DraftProvider {
  readonly name: string;
  /** Returns the model's JSON as parsed, unvalidated data. */
  draft(input: PromptInput, prompt: RenderedPrompt): Promise<unknown>;
}
