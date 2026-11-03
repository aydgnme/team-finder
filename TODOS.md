# TODOS

## AI-01 eval set
- **What:** ~20 golden natural-language prompts (e.g. "2 senior React devs + a QA from March") with the expected filter JSON, run in CI against the real model.
- **Why:** model or prompt changes can silently break NL search; the canvas would get wrong filters with no failing test.
- **Pros:** catches prompt/model regressions; a concrete "how I test LLM features" artifact for interviews.
- **Cons:** costs API calls per CI run; needs an API key as a CI secret (run on main only, or nightly).
- **Context:** AI-01 lands in M2.5 (see docs/design.md, "AI-01" and milestones). The LLM only outputs `{skills:[{skillId,minLevel}], roles, availability options, startDate}` against the org's vocabulary; the deterministic engine ranks. Evals compare that JSON field by field against expectations, tolerating ordering.
- **Depends on / blocked by:** AI-01 (M2.5).

## Realtime updates (SSE) for approvals and notifications
- **What:** push `proposalDecided` and notification events to open clients over Server-Sent Events instead of 30s polling.
- **Why:** in the demo, after approving as Dept Manager and switching back to PM, other open tabs may look stale for up to 30s.
- **Pros:** livelier multi-tab demo; nicer notification badge.
- **Cons:** SSE through the `/api` proxy needs streaming support from the SPA host's rewrite; adds connection management.
- **Context:** M1 mitigates this by invalidating all TanStack Query caches on role switch (same tab). Only build SSE if the demo still feels dead after M4 notifications ship.
- **Depends on / blocked by:** M1 (proxy chosen), Notification-01 (M4).

## Role qualifications and complementary team scoring
- **What:** let employees carry team-role qualifications and score a *team* on complementary coverage, not just individuals.
- **Why:** an outside review noted that ranking individuals against project-wide skills can assemble an implausible team.
- **Pros:** recommendation quality you can defend in an interview.
- **Cons:** not in the SRS; new data entry burden in the seed and UI.
- **Context:** surfaced by /autoplan CEO phase (Codex). The coverage meter is the current partial answer.
- **Depends on / blocked by:** M3 (skills CRUD).

## Org time zones
- **What:** store an org time zone and compute "today" in it instead of UTC.
- **Why:** users west of UTC in the evening see tomorrow's date.
- **Pros:** correct dates for real users. **Cons:** touches every date computation.
- **Context:** /autoplan eng phase; deliberately out of scope for the demo.
- **Depends on / blocked by:** none.
