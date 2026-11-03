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

## Implementation notes (eng review, 2026-11-03)
Split into two PRs (decided with the owner): **M3a** = departments, skills, projects CRUD and lifecycle; **M3b** = date-edit clamp with recheck, deallocation (Project-04/05) and the four views (Project-06..09). Decisions for M3a, checked against the merged M0-M2 code:

1. **Departments (Department-01..03).** Admins create, rename and delete departments and pick the manager (a member holding `deptManager`; one department per manager, already backed by the unique partial index). Admins and that department's manager move members in and out; the unassigned list is the source. Deleting a department with members is refused (`IN_USE`). Moving someone re-routes their pending approvals automatically (approvers are resolved at decision time); the move writes the user document, so it conflicts with a concurrent approval of that person.
2. **Skills (Skill-01/02).** Department managers and admins create categories and skills; only a skill's author edits or deletes it, and links it to departments. A skill used by a project or held by someone cannot be deleted (`IN_USE`). Employees add, update and remove their own skills (level 1-5, experience); until Skill-04 (M4) they are created `validated: true`, as the design says.
3. **Projects (Project-01).** Project managers create projects (they become `pmId`): name, description, fixed or ongoing, start and deadline, status `notStarted` or `starting`, tech stack (skills) and team roles with counts. Only the project's PM edits it. Lowering a role's count below the people holding it is refused (`SLOT_FULL`).
4. **Lifecycle.** One pure `transitionProject(project, next, today)` in domain: forward-only along notStarted → starting → inProgress → closing → closed (skipping forward allowed), the only place that sets `everActive`. Closing to `closed` runs in one transaction: started active/deallocation-proposed assignments become `past` with `to = today`; not-yet-started ones and open proposals become `rejected`; affected people get `capacityVersion` bumped; `touchProject`. Delete only when `everActive` is false; it removes the project's assignments in the same transaction.
5. **Dates in M3a.** Start and deadline can be edited only while the project has no open assignments. Moving dates under a team needs the clamp-and-recheck rule, which ships in M3b (the scrubber's whole-team move from M1.5 stays as it is).
6. **Reference races (closes the M2 trade-off).** Saving a project touches (version bump) every team role and skill it references inside its transaction; deleting a team role or skill writes that document in its own transaction after the in-use check. Either order conflicts, so a role or skill can never be deleted while a project starts using it.
7. **Permissions.** New `can()` actions with table tests: `department.manage` (admin), `department.members` (admin, or that department's manager), `skill.create` (dept manager, admin), `skill.edit` (the author), `project.create` (project manager), `project.edit` (the project's PM), `userSkill.edit` (yourself). The cross-org suite grows to every new route.
8. **Web.** `#/projects`: the list (status, dates, PM, open slots) with "New project" for PMs and per-project edit, status change and delete; a row opens the canvas, so real orgs can finally staff. `#/departments` and `#/skills` (including "My skills"), linked from the Organization screen's tabs; the dock gains Projects.
