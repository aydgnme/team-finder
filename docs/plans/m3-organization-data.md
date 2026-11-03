# M3 Organization data

**Goal:** organizations manage their real structure: departments, skills, projects and their lifecycle.
**Depends on:** M2. **Spec:** SRS Department-01..03, Skill-01..02, Project-01, Project-04..09; design.md data model, assignment state machine, project transitions, date-edit clamp.

## Scope
- Departments CRUD, assign manager (one per department, unique partial index), assign/remove members (unassigned list).
- Skill categories and skills CRUD (author-owned updates, department linking); employee skill self-assignment (level, experience).
- Projects CRUD with status rules (`transitionProject`, `everActive`, deletion only if never active, close semantics).
- Date edits with clamp and recheck; deallocation proposal and confirmation (Project-04/05).
- Views: project team (proposed/active/past), employee projects (current/past), department projects (filter by status), project details.

## Tests
Department manager uniqueness; skill ownership rules; status transitions table; deletion rule; date-edit clamp (late joiner, close-before-start); deallocation flow; view permissions (dept manager sees only projects with their members).

## Done when
All SRS core features above work end to end and are covered by API tests and one e2e per view.
