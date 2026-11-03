import type { OrgRepo } from '../db/org-repo.ts';
import type { ResolvedActor } from '../db/sessions.ts';

/** Everything a service needs for one request: the caller, a repository scoped to their org, and the clock. */
export interface ServiceContext {
  actor: ResolvedActor;
  repo: OrgRepo;
  now: Date;
  /** UTC calendar day of `now`. */
  today: string;
}
