# Polish bucket

Built after M2.5; first to slip if time runs short (cut counterfactuals first, then delight items).

## Delight items
- **Undo proposal:** 10s toast after propose; `POST /api/assignments/:id/withdraw` with `{version}`; only while `proposed`; `can(actor,'withdrawAssignment')`; transaction with `touchProject`; removes the manager's notification; `CONFLICT_STALE` -> "Too late, Dana already approved it". One toast at a time, timer pauses on hover/focus, keyboard reachable.
- **Keyboard shortcuts:** `/` focus candidate search, `1`-`9` send focused candidate to slot N, `?` cheat sheet; disabled while typing or while the slider has focus.
- **Capacity bar breakdown:** hover/focus lists projects, hours and until-dates.
- **Copy team as Markdown:** client-side, escaped.

## Team counterfactuals
`teamDelta(team, {slotRoleId, out, in})` -> coverage before/after, overbooking delta, freed hours, start delay; shares `coverage()` with `compareScenarios`; slot popover + keyboard panel.

## Tests
Undo racing an approval within 10s -> `CONFLICT_STALE`; shortcut inertness in inputs; teamDelta table tests incl. overbooking swap.
