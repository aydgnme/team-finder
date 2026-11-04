# Architecture notes

Three properties carry the product: approvals never overbook anyone, a decision can be compared before it is made, and one organization can never touch another's data. Each section says how it is enforced and which test proves it.

## Concurrency proof

**Invariant:** nobody is booked for more than 8 hours on any day, even when two managers approve different proposals for the same person at the same moment.

`approve()` in `apps/api/src/services/assignments.ts` runs in one MongoDB transaction:

```
 manager A: approve(Apollo, 5 h)          manager B: approve(Borealis, 5 h)
 ─────────────────────────────            ─────────────────────────────
 read Riley's assignments (0 h used)      read Riley's assignments (0 h used)
 check 0 + 5 ≤ 8  ✓                       check 0 + 5 ≤ 8  ✓
        └──────────── afterRead() barrier (demo only) ────────────┘
 set Apollo active                        set Borealis active
 users.capacityVersion += 1  ──┐   ┌──    users.capacityVersion += 1
                               ▼   ▼
                     write conflict on Riley's user doc
 commit ✓                                 driver replays the transaction
                                          read: 5 h used, check 5 + 5 ≤ 8 ✗
                                          409 CAPACITY_EXCEEDED
```

Both transactions read the same snapshot, so the check alone cannot catch the race: it is classic write skew. The fix is the version bump. Every write that changes someone's capacity (approve, date moves, deallocation, closing a project) increments `users.capacityVersion` in the same transaction, so two of them always write the same document. MongoDB lets only one commit; the other gets a transient write conflict, `withTransaction` replays it from the start, and the replay reads the committed booking and refuses with the exact date and the most hours that would still fit.

**Watching it happen.** `POST /api/demo/race` (the *How it works* page) and `pnpm demo:race` run the real `approve()` twice at once. The only seam is `ApproveOptions.afterRead`, called after the capacity read and check and before the first write. The race passes a two-party barrier there so both lanes are guaranteed to have read and passed the check before either writes; production passes nothing. Replays skip the barrier: by the time the loser replays, the winner has committed and will never arrive again, so waiting would only time out (2 s, `RACE_TIMEOUT`).

The race never touches the visitor's sandbox. Each run builds a throwaway org ("Race": a manager, Riley Race, projects Apollo and Borealis, two 5 h proposals), runs both approvals, records each lane's events (`start`, `read`, `released`, `replay`, `committed`/`refused`) and deletes the org in a `finally`. If not exactly one lane committed, the route answers `500 INVARIANT_BROKEN` and logs it at error level.

**Tests:**

- `apps/api/test/concurrency.test.ts`: concurrent approvals through the HTTP API.
- `apps/api/test/race.test.ts`: 20 races, each with exactly one winner, both lanes past the barrier before either wrote, a replay on the loser and no leftover documents; cleanup on failure; the visitor's sandbox fingerprint unchanged; one race per session; rate limit; demo-only; and a static check that `afterRead` is passed only by the race service.

The choice of MongoDB with version bumps over Postgres exclusion constraints is recorded in [ADR 0001](adr/0001-mongodb-capacity.md).

## Scenario verdict

A draft team is compared with the current one by one pure function, `compareScenarios()` in `packages/domain/src/scenarios.ts`. It evaluates both scenarios over the project window (coverage of required skills, open slots, overbooked person-days) and returns the start delay and the change in overbooked days. The verdict line in the browser (`apps/web/src/canvas/draft.ts`) and the server (`apps/api/src/services/scenarios.ts`, for snapshots and commits) call the same function, so the sentence a manager reads is the sentence the server would compute.

Committing a draft re-runs every check inside one transaction: the start move (with its team, clamped like any date edit) and every proposal succeed together or nothing is written; the failing slot comes back in `details.slotRoleId`. Share links store a snapshot the server rebuilt from its own data, never the client's numbers.

**Tests:** `packages/domain/test/scenarios.test.ts`, `apps/api/test/scenarios.test.ts`, `e2e/scenarios.spec.ts`.

## Tenant isolation

Routes never see the database driver. `orgRepo(actor)` wraps every tenant collection and injects `orgId` into each filter, insert and update, so a query cannot forget it. An ESLint `no-restricted-imports` rule forbids importing `mongodb` outside `apps/api/src/db`, and `apps/api/test/lint-rule.test.ts` checks the rule fires. Ids from another org therefore behave like ids that do not exist (`404`), and permission checks (`can()` in `packages/domain`) run on top for the actor's own org.

**Tests:** `apps/api/test/org-repo.test.ts` (the wrapper itself) and `apps/api/test/isolation.test.ts`, which builds two real orgs and two demo sandboxes, calls every id-taking route as a member of another org with the victim's ids, expects `403`/`404` for each, and compares a SHA-256 fingerprint of all the victim's documents before and after.

## Notifications

A notification is written by `notify()` (`apps/api/src/services/notifications.ts`) inside the transaction of the action that caused it: proposing (including scenario and AI commits), asking to end an assignment, deciding either, claiming or raising a skill, and deleting a project. A refused or rolled-back action therefore leaves no notification behind, and a replayed transaction writes exactly one. The recipient is resolved when the action happens (the person's department manager at that moment, or whoever proposed). Nobody is notified about their own action. `data` keeps the names a notification needs, so it still reads correctly after the project is deleted. Notifications are a tenant collection like any other: orgRepo scopes them, demo sandboxes expire them, and the isolation suite checks that another org's ids can be neither read nor marked read.

**Tests:** `apps/api/test/m4a.test.ts` (every trigger, no self-notifications, a refused approval and a failed scenario commit write nothing), `e2e/inbox.spec.ts`.
