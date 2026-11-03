# Design system

The staffing canvas is the one hero surface; everything else uses the same tokens with no extra treatment. Source of truth for the values below is `apps/web/src/styles.css` (`:root`). Decisions and their reasoning live in [docs/design.md](docs/design.md) ("/autoplan Phase 2").

## Principles

- **The team is the anchor.** The first line states the goal ("Staff Atlas: 2 slots open, AWS not covered"), then the role slots, then the ranked candidates, then the persona dock.
- **Every number is explainable.** Scores show their three terms; capacity shows hours; conflicts show the date and the hours.
- **State is never color alone.** Each slot state has an icon and a word: ✓ Active, ◌ Pending approval, ⚠ Conflict.
- **Quiet surfaces.** No shadows, no gradients (the only patterns are the pending stripes), no emoji, no icon circles, no colored left borders.

## Tokens

| Token | Value | Use |
| --- | --- | --- |
| `--font-sans` | IBM Plex Sans 400/500/600 | All UI text |
| `--font-mono` | IBM Plex Mono 400/500, tabular figures | Hours, scores, percentages, dates in slots |
| `--bg` / `--surface` / `--surface-muted` | `#f8fafc` / `#ffffff` / `#f1f5f9` | Page, cards and slots, ghosts and skeletons |
| `--border` / `--border-strong` | `#cbd5e1` / `#94a3b8` | Outlines; inputs and free capacity segments |
| `--text` / `--text-muted` | `#0f172a` / `#475569` | Body (contrast 17:1) / secondary (7.5:1) |
| `--accent` | `#0f766e` (teal 700, 5.5:1 on white) | The one accent: primary buttons, active slots, coverage, focus ring |
| `--pending` | `#b45309` (amber 700) | Pending proposals, partial availability, "no approver" |
| `--conflict` | `#b91c1c` (red 700) | Overbooking, failed approvals |
| `--radius` | 6px | Slots, cards, popovers, buttons |
| Motion | 120 / 180 / 240 ms | Drop settle / snap-back on 409 / pending → active fill |

`prefers-reduced-motion: reduce` sets all three durations to 0 and disables keyframe animations. Dark mode is out of scope.

## Anatomy

**Role slot** — flat outlined container (1px border, 6px radius), never a card.

| State | Border | Fill | Content |
| --- | --- | --- | --- |
| Empty | dashed `--border` | none | "Open slot"; while dragging: "Open slot: drop here" |
| Drag over (fits) | solid accent | `--accent-soft` | name + "Fits: up to N h/day" |
| Drag over (overbooks) | `--conflict` | `--conflict-soft` | name + "Would exceed 8 h on <date>" |
| Pending | `--pending` | amber stripes | ◌ name, hours, "Pending approval" |
| Conflict | `--conflict` | `--conflict-soft` | ⚠ name, "Conflict: exceeds 8 h on <date> (N h booked)" |
| Active | accent | white | ✓ name, hours, "Active" (240 ms fill on arrival) |
| Error (409 on propose) | snap-back 180 ms | | inline alert with the DomainError message + hint |

**Candidate card** — the only card. Name, stacked score mini-bar, title, 8-segment capacity bar, availability line, up to four why-chips, "Add to slot". Rolling-off people ("ghosts") use a dashed border on `--surface-muted` and sit under a **Later** divider; fully booked people (when included) under **Fully booked**.

**Capacity bar** — 8 segments, one per hour of the day: solid `--text-muted` = booked, amber stripes = pending, accent = this proposal, outlined = free. Shows the peak over the project window (from `availableFrom` for ghosts).

**Score mini-bar** — 64px track split into skill fit (accent, max 60), past projects (teal 300, max 25), availability (`--text-muted`, max 15); the numbers appear on hover and keyboard focus and are always in the accessible name.

**Coverage meter** — solid accent for skills covered by active members, striped accent for skills covered only by pending proposals (or the card being dragged); "Missing: AWS" names gaps; "Fully covered" at 100%.

**Drop popover** — prefilled (hours = most that fit, start = window start or `availableFrom`), Enter confirms, Esc cancels and returns focus to the card's "Add to slot", focus trapped, "More options" (extra roles, comment) collapsed.

**Dock** — persona switcher ("Viewing as"), Canvas / Approvals (with pending count for managers), org name. Coach-marks (max two, dismissible, remembered in localStorage) appear above it.

## States

| Surface | Loading | Empty | Error | Success |
| --- | --- | --- | --- | --- |
| API cold start | "Waking the server" after 800 ms, polling `/api/health` with backoff | — | after 30 s: "Still asleep" + Try again | app renders |
| Demo entry | "Setting up your sample company" | — | "Couldn't create the demo" + Retry | lands on the Atlas canvas as the PM |
| Candidates | 6 skeleton rows | names the filter that excluded the most people + one-click relax | inline error + Retry, slots stay usable | ranked list |
| Approvals | 3 skeleton rows | "Nothing waiting. Proposals for your department show up here." | per-row reason (CAPACITY_EXCEEDED with date and max hours) | row leaves, banner + link back to the canvas |
| Session expired | — | — | modal "Your demo session ended" + Start a new demo | — |

## Responsive and accessibility

- ≥ 1024px: slots and a 380px sidebar. 768–1023px: 300px sidebar, chips and titles hidden. < 768px: slots stack above the list, drag is disabled, "Add to slot" is the path, tap targets ≥ 44px. (The design doc's bottom sheet was simplified to a stacked list in M1.)
- One `aria-live="polite"` region announces proposals ("Mira Chen proposed for Backend Developer. Coverage 100%."), approvals, persona switches and every error; a visible toast repeats it.
- Keyboard path: Tab to "Add to slot", Enter opens the menu (first open slot focused), Enter opens the popover, Enter proposes.
