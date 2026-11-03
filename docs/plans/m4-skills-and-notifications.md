# M4 Skills lifecycle and notifications

**Goal:** skill data becomes trustworthy and the system tells people what needs their attention.
**Depends on:** M3. **Spec:** SRS Skill-03, Skill-04, Project-10, Project-11, Notification-01; design.md "Skill validation", "Notifications", "Project-11".

## Scope
- Skill-04 validation: self-assigned skills start unvalidated, visible to owner and dept manager, ignored by matching and stats until validated.
- Skill-03 endorsements: trainings/courses/certifications and past projects (only projects the user was on).
- Project-10 skill requirements with minimum level (gate in matching).
- Project-11 upgrade proposals: daily job at 3-month multiples, deduplicated per user and skill, accept by level and experience.
- Notification-01: all six types, unread count, refetch on role switch.

## Tests
Validation visibility and matching exclusion; endorsement project restriction; minLevel gate and near-miss reason; upgrade job idempotency; each notification trigger writes in the same transaction.

## Done when
Every notification type is produced by its trigger and visible in the UI; the upgrade job is idempotent.

## Implementation notes (eng review, M4a)

Split into two PRs: **M4a** Project-10, Skill-04, Notification-01; **M4b** Skill-03 endorsements and the Project-11 upgrade job (its `skillUpgradeProposal` notifications reuse M4a's store).

Already in place from M1: the matching engine ignores unvalidated skills, and `minLevel` is a gate with a `belowMinLevel` near-miss reason. What is missing is the PM being able to set requirements, and validation actually happening.

**Project-10.** `POST/PATCH /api/projects` accept `skillRequirements: [{skillId, minLevel 1-5}]` (unique skills, known ids, `touchReferences` so a concurrent skill delete conflicts). The form gets a "Required skills" block: a skill select plus a minimum-level select per row.

**Skill-04.**
- `setMySkill` creates new claims as `validated: false`.
- Raising the level or experience of a validated skill makes it pending again and keeps the old values in `previous`. Lowering it, or saving the same values, keeps its state.
- `userSkills.version` guards decisions against a concurrent edit.
- The validator is the claimer's department manager now (`approverOf`, never stored), but never the claimer themselves.
- Claims with no validator (no department, an unmanaged department, or the manager's own claim) can be decided by admins, except their own, and show up in `GET /api/org/no-approver`.
- `GET /api/approvals` gains `kind: 'skill'` items.
- `POST /api/skills/claims/:id/validate|reject {version}`. Reject deletes a new claim, or restores `previous` for a raise.
- Visibility: unvalidated skills are visible only to their owner (marked "Pending validation") and their validator; matching, coverage and views ignore them.

**Notification-01.**
- Storage: a tenant collection, `notifications {userId, type, refId, actorId, data, createdAt, readAt}`. It is covered by orgRepo, the isolation suite, demo TTL and race cleanup.
- Writing: `notify(repo, session, [...])` writes inside the trigger's transaction. It skips a recipient who is the actor, or null. `data` snapshots the display names, so a notification still reads correctly after its project is deleted.
- Triggers:
  - `assignmentProposed`: propose, and scenario/AI commits; sent to the approver.
  - `deallocationProposed`: sent to the approver.
  - `proposalDecided`: approve or reject of either kind; sent to `proposedBy`.
  - `skillPendingValidation`: sent to the validator.
  - `projectDeleted`: sent to each distinct approver of the people who had assignments on it.
  - `skillUpgradeProposal`: the type exists, but nothing produces it until M4b.
- Routes:
  - `GET /api/notifications`: newest 50.
  - `GET /api/notifications/unread-count`.
  - `POST /api/notifications/read {ids} | {all: true}`.
- Web:
  - The dock shows "Inbox" with an unread badge, polled every 30 s and keyed by user so a persona switch refetches it.
  - A `#/inbox` page: every row links to where the item is acted on; "Mark all read".
- Seed: notifications for the demo's existing proposals, and one pending skill claim in Dana's department, so the inbox and the validation flow are visible on first visit.

**Tests.**
- Every trigger writes its notification in the same transaction, and a refused trigger writes none.
- No self-notifications.
- Read and unread across personas.
- Isolation attacks on the new routes.
- Validation visibility, and exclusion from matching and coverage.
- Raise, reject and restore.
- No self-validation; admin fallback.
- Stale validate vs edit (`CONFLICT_STALE`).
- Requirements validation and the near-miss on the canvas.
- e2e: claim, validate, inbox.
