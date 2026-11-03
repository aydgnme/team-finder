# ADR 0001: Capacity invariant on MongoDB with version bumps

**Status:** accepted (M1, written up in M2.5)

## Context

Invariant 1 says nobody is booked for more than 8 hours on any day. Bookings are date intervals with hours per day, and several of them can overlap for one person. Two managers can approve different proposals for the same person at the same moment, so the check has to hold under concurrency (invariant 2).

The two realistic options were:

1. **Postgres** with a range type and an exclusion constraint, or a trigger that sums overlapping ranges.
2. **MongoDB** with multi-document transactions, re-checking capacity inside the transaction and bumping a per-person version so competing writes conflict.

## Decision

MongoDB, with `users.capacityVersion` bumped by every write that changes someone's capacity, inside the same transaction that re-checks it.

## Why

- **The constraint is a sum, not an overlap.** An exclusion constraint forbids overlapping ranges; it cannot say "the hours of overlapping ranges add up to at most 8". Postgres would need a trigger with `SERIALIZABLE` isolation (or explicit row locks on the person) anyway, which is the same idea as the version bump, written in PL/pgSQL instead of the shared domain code.
- **One capacity model.** The check is `withProposal(buildTimeline(...))` from `packages/domain`, the same pure code the browser uses for the drag preview and the ranking. Keeping it in application code means the UI and the database cannot disagree.
- **The documents fit the reads.** A project board, a person with their skills, and a candidate's timeline are each one or two queries; there is no reporting workload that needs joins yet.
- **Free hosting.** MongoDB Atlas's free tier runs a replica set, which transactions need.

## Consequences

- Every capacity-changing write must bump `capacityVersion`. Forgetting it reintroduces write skew silently, so each such path has a concurrency test, and the race demo (`apps/api/test/race.test.ts`, `pnpm demo:race`) shows the mechanism on the real `approve()`.
- Transactions need a replica set, including in tests (`MongoMemoryReplSet`) and local development (`pnpm dev:local`).
- The loser of a race pays one replay. At this scale (a handful of managers per org) that is negligible.
- If reporting grows into heavy cross-entity queries, a read model or a move to Postgres would be revisited; the domain package has no database dependency, so the capacity check would move unchanged.
