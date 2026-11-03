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
