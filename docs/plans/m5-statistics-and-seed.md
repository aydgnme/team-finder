# M5 Statistics and seed

**Goal:** department managers see their skill landscape; the demo feels like a real company.
**Depends on:** M4. **Spec:** SRS Stats-01; design.md seed notes.

## Scope
- Stats-01: per-skill totals and level distribution for the manager's department, pie chart (accessible table fallback), validated skills only.
- 60-person, 12-project seed template for sandboxes that keeps the Atlas hero scenario intact.

## Tests
Aggregation correctness on fixtures; chart table fallback; seed clone time budget (< 2s on Atlas M0).

## Done when
Stats page renders for the seeded department; sandbox creation stays under 2s.

## Implementation notes (eng review)

One PR: the statistics are small, and the seed is data plus guard tests.

**Stats-01.**
- **Route:** `GET /api/departments/:id/stats`, for that department's manager and for admins (the same rule as the department's projects view).
- **Scope:** members of the department now, validated skills only.
- **Response:** per skill, the holders and a 5-bucket level distribution, plus the department's head count and how many hold no validated skill. Skills are sorted by holders, then name.
- **One pure function:** `skillStats()` in `packages/domain` does the aggregation, so tests cover it without a database.
- **Page:** "Skills" on the department view (`#/departments/:id/stats`), reached from the Departments tab and from a manager's department projects page.
  - **Charts:** a pie of holders per skill (top 6, then "Other"), and a pie of the level distribution for the selected skill.
  - **Table:** every number is also in a real table, which is the accessible fallback and the source the charts are drawn from.
  - **Labels:** each pie has a label in its title.

**Seed (60 people, 12 projects).**
- **Atlas stays as it is:** the 11 people and 5 projects stay byte-for-byte what they were (same names, skills, assignments, departments), so every hero number holds.
- **Who is added:** 49 people in four new practices, each with a manager:
  - Data (Python, Spark, dbt);
  - Mobile (Kotlin, Swift);
  - Cloud Platform (Terraform, Kubernetes);
  - Java Services (Java).
- **What is added:** 7 projects for them, run by a second PM (Sam Ortiz), with active, past and proposed assignments and a few pending claims.
- **Why Atlas can't change:** none of the added people holds an Atlas skill, and none of their past projects shares Atlas's tech, so they can only add to Atlas's `noSkillMatch` count.
- **Deterministic:** names and skills come from fixed lists, with no randomness.
- **Guard tests:**
  - head count is 60 and project count is 12;
  - Atlas's ranked candidates are unchanged;
  - every person has a department except the original three (Pat, Olivia, and Noor in the unmanaged Design);
  - sandbox creation stays under 2 s (measured in the test, against the in-memory replica set).

**Tests.**
- `skillStats()` on fixtures: validated only, buckets, sort, the "no validated skill" count.
- The route: Dana for Engineering, an admin for any department, 403 for other managers and employees, 404 across orgs (isolation suite).
- e2e: Dana opens Engineering's stats, reads a number from the table, and switches the selected skill.
