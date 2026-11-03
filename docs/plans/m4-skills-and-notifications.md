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
