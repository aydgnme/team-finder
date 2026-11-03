# Team Finder

[![CI](https://github.com/aydgnme/team-finder/actions/workflows/ci.yml/badge.svg)](https://github.com/aydgnme/team-finder/actions/workflows/ci.yml)

**A team-first staffing canvas.** Start from the shape of a project team, drag ranked candidates into role slots, and see capacity, skill coverage and conflicts update before you commit. Every ranking explains itself, and approvals stay correct when two managers act at the same moment.

> **Status: early development.** The staffing canvas (M1) works end to end locally (`pnpm dev:local`); deployment, the live demo link and the walkthrough GIF come next. See the [roadmap](#roadmap).

Inspired by the "Team Finder" brief from the ASSIST Tech Challenge 2024, rebuilt as an independent project.

## Why it is interesting

Most resource-planning tools start from a people-by-weeks grid and treat skills as a filter. This project starts from the team instead, and treats the hard parts as first-class engineering:

- **No double booking under concurrency.** Two managers approving different proposals for the same person at the same time must not push them past 8 hours a day. Approvals run in MongoDB transactions that also bump a per-user version, so competing writes conflict and the loser is re-checked and rejected with an exact reason.
- **One capacity model, client and server.** A pure `CapacityTimeline` in `packages/domain` drives ranking, the drag preview in the browser, and the server-side invariant, so the UI and the API cannot disagree.
- **Explainable, deterministic matching.** Candidates are scored on skill fit, past-project similarity and availability, with each term shown in the UI. An LLM can draft a team, but the deterministic engine validates every placement before anything is proposed.
- **Tenant isolation by construction.** Routes never touch the raw database; a scoped repository injects the organization into every query, and a lint rule enforces it.

The full design, including the review history behind these decisions, is in [docs/design.md](docs/design.md).

## Architecture

```
 Browser (React SPA)           same origin: /api/* proxied        Fastify API                     MongoDB (replica set)
 ┌───────────────────────┐ ───────────────────────────────────▶ ┌────────────────────────────┐   ┌───────────────────┐
 │ Canvas, drag and drop │   first-party session cookie          │ session -> request.actor   │   │ orgs, users       │
 │ capacity preview      │                                       │ routes -> services         │──▶│ projects, skills  │
 │ (packages/domain)     │ ◀──── ranked candidates + timelines ─ │ org-scoped repository      │   │ assignments       │
 └───────────────────────┘                                       │ approve(): transaction     │   └───────────────────┘
                                                                 └────────────────────────────┘
```

| Path | What lives there |
| --- | --- |
| `packages/domain` | Pure TypeScript: zod schemas, scoring, capacity timeline, permission rules. No I/O. |
| `apps/api` | Fastify API. Runs TypeScript directly with Node's built-in type stripping (no build step). |
| `apps/web` | React + Vite single-page app with TanStack Query. |
| `e2e` | Playwright tests (Chromium and WebKit). |

## Tech stack

TypeScript 6 · Node.js 26 · pnpm workspaces · Fastify 5 · MongoDB 7 driver · React 19 · Vite 8 · TanStack Query · zod · Vitest with an in-memory MongoDB replica set · Playwright · ESLint + Prettier · GitHub Actions · Render + Vercel

## Getting started

Prerequisites: **Node.js 26** and **pnpm 12** (Node 26 no longer bundles Corepack, so install pnpm with `npm i -g pnpm@12`).

```bash
git clone https://github.com/aydgnme/team-finder.git
cd team-finder
pnpm install
pnpm dev:local
```

`pnpm dev:local` starts an in-memory MongoDB replica set (transactions need one), the API against it and the web app. Open http://localhost:5173: every visit clones the "Atlas" sample company into its own sandbox and lands on the canvas as the project manager. No accounts or environment variables are needed; the first run downloads a MongoDB binary.

To run against your own database instead, copy `apps/api/.env.example` to `apps/api/.env`, set a replica-set `MONGODB_URI` and run `pnpm dev`. Without `MONGODB_URI` the API starts without a database and every route except `/api/health` answers `503 DB_UNAVAILABLE`.

### Try this

1. Press **Add to slot** on Mira (or drag her card) into the open Backend slot and press Enter: capacity and coverage update before you commit.
2. Follow the hint to switch to **Dana (Engineering Manager)** and approve Mira: the slot turns active.
3. Approve Kai: the server re-checks capacity inside the transaction and refuses with the exact date and the most hours that would fit.

## Scripts

| Command | What it does |
| --- | --- |
| `pnpm dev:local` | In-memory replica set + API + web app; also used by the e2e suite |
| `pnpm dev` | Start API and web app in watch mode against `MONGODB_URI` |
| `pnpm test` | Unit and API tests (first run downloads a MongoDB binary; `pnpm test:prepare` fetches it ahead of time) |
| `pnpm e2e` | Playwright tests in Chromium and WebKit against `pnpm dev:local` (`pnpm exec playwright install` once) |
| `pnpm lint` / `pnpm format:check` / `pnpm typecheck` | Static checks, also enforced in CI |
| `pnpm build` | Production build of the web app |

## How the matching works

Everything is evaluated over the project window `[max(today, start), deadline)` (open-ended for ongoing projects), in UTC days, with half-open intervals.

- **Capacity:** `buildTimeline()` turns a person's assignments into sorted segments of `{used, pending}` hours per day. Active and deallocation-proposed assignments count as used; proposals count as pending. `withProposal()` answers "does N h/day from this date still fit under 8?" and returns the first day that would break. The ranking, the drag preview in the browser and the approval transaction all call it.
- **Availability:** fully available (8 h free every day), partially available, rolling off (fully free from a date within N weeks; assignments on ongoing projects never roll off), or unavailable.
- **Score (0–100):** `60 × skill fit + 25 × past-project similarity + 15 × availability`, weights in one constant (`SCORE_WEIGHTS`). Skill fit averages, over the project's required skills, 80% level and 20% experience. Similarity is the best Jaccard overlap of skills and roles with a past project. Ties break by name.
- **Explanations:** the engine returns structured reasons (`rollsOff`, `pastProject`, `partial`, `noApprover`…); the UI turns them into chips.

## API

| Route | Purpose |
| --- | --- |
| `GET /api/health` | Liveness, database state, cookie round-trip probe |
| `POST /api/demo/sessions` | Clone the Atlas seed into a sandbox org and sign in as its project manager |
| `POST /api/demo/sessions/switch` | Switch persona inside the demo org (new session id) |
| `GET /api/session` | Current persona, org and the personas offered by the switcher |
| `GET /api/projects/:id` | Project, role slots, current team with capacity checks |
| `GET /api/projects/:id/candidates` | Ranked candidates with score terms, reasons and capacity timelines |
| `POST /api/assignments` | Propose a person for a role slot |
| `POST /api/assignments/:id/approve` · `/reject` | Decide on a proposal (department manager) |
| `GET /api/approvals` | Proposals waiting for the caller's department |

Every error uses one envelope, `{ code, message, details, hint }`, for example `409 CAPACITY_EXCEEDED` with `details: { date, used, requested, maxHours }`. Mutations must be `application/json` (anything else is `415`, a CSRF guard).

## Roadmap

- [x] **M0** Monorepo, CI, deployment configuration, test harness with transactions
- [ ] **M1** Staffing canvas: ranking engine, drag and drop, proposals, atomic approvals, demo sandbox (built and tested locally; deploy and GIF pending)
- [ ] **M1.5** Staffing decisions: scenario compare, start-date scrubber, shareable plans
- [ ] **M2** Authentication, roles and organization onboarding
- [ ] **M2.5** AI-drafted teams validated by the engine, live concurrency demo
- [ ] **M3–M5** Departments, skills, project lifecycle, endorsements, notifications, statistics
- [ ] **M7** Final polish, architecture notes and walkthrough

Details and the cut order are in [docs/design.md](docs/design.md#next-steps-milestones); deferred ideas are tracked in [TODOS.md](TODOS.md).

## Contributing

Commits follow [Conventional Commits](https://www.conventionalcommits.org/) (`type(scope): description`, scopes: `domain`, `api`, `web`, `e2e`, `deploy`, `deps`, `repo`). Git hooks run ESLint and Prettier on staged files and validate the commit message; they are installed automatically by `pnpm install`.

## License

[MIT](LICENSE)
