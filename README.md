# Team Finder

[![CI](https://github.com/aydgnme/team-finder/actions/workflows/ci.yml/badge.svg)](https://github.com/aydgnme/team-finder/actions/workflows/ci.yml)

**A team-first staffing canvas.** Start from the shape of a project team, drag ranked candidates into role slots, and see capacity, skill coverage and conflicts update before you commit. Every ranking explains itself, and approvals stay correct when two managers act at the same moment.

> **Status: early development.** The staffing canvas (M1), staffing decisions (M1.5), AI-drafted teams (M1.75), real accounts with roles (M2) and organization data (M3a: departments, skills, projects and their lifecycle) work end to end locally (`pnpm dev:local`); deployment, the live demo link and the walkthrough GIF come next. See the [roadmap](#roadmap).

**One decision, in numbers:** in the sample company, starting Atlas two weeks later lets the strongest backend developer roll off their current project first. The verdict line says so: *start +2 wk → coverage 83% → 100%, +0 overbooked days* (at the original start the same team would add 14 overbooked days).

Inspired by the "Team Finder" brief from the ASSIST Tech Challenge 2024, rebuilt as an independent project.

## Why it is interesting

Most resource-planning tools start from a people-by-weeks grid and treat skills as a filter. This project starts from the team instead, and treats the hard parts as first-class engineering:

- **No double booking under concurrency.** Two managers approving different proposals for the same person at the same time must not push them past 8 hours a day. Approvals run in MongoDB transactions that also bump a per-user version, so competing writes conflict and the loser is re-checked and rejected with an exact reason.
- **One capacity model, client and server.** A pure `CapacityTimeline` in `packages/domain` drives ranking, the drag preview in the browser, and the server-side invariant, so the UI and the API cannot disagree.
- **Explainable, deterministic matching.** Candidates are scored on skill fit, past-project similarity and availability, with each term shown in the UI. An LLM can draft a team, but the deterministic engine validates every placement before anything is proposed.
- **Decisions you can compare and share.** Fork the current team, drag the start date and watch availability and the verdict update live; the same pure `compareScenarios()` runs in the browser and on the server. Committing sends every proposal (and moves the project, if the start changed) in one all-or-nothing transaction; a share link stores a server-rebuilt, read-only snapshot.
- **AI drafts, the engine decides.** Describe the team in plain words; Claude picks from the engine's shortlist, seen only as `c1, c2…` (no names leave the server), and every pick is re-checked like a manual drop before it can enter the draft. Nothing is proposed until the manager commits. A 20-case eval set scores drafts by the share of picks that pass validation and by skill coverage.
- **Tenant isolation by construction.** Routes never touch the raw database; a scoped repository injects the organization into every query, and a lint rule enforces it. A cross-org suite calls every id-taking route with another organization's ids and checks the victim's data is byte-for-byte unchanged.
- **Accounts without a dependency.** Sign-up, login and invite links run on the same server-side sessions as the demo; passwords are hashed with argon2id from `node:crypto`, every sign-in rotates the session id, and two admins demoting each other at once cannot leave an org without an admin.

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

AI drafts are optional: set `LLM_API_KEY` (an Anthropic API key; model `claude-opus-5-5` unless `LLM_MODEL` says otherwise) to enable them, or `LLM_PROVIDER=fake` for the deterministic stand-in. Without either the panel says it is off and everything else works.

To run against your own database instead, copy `apps/api/.env.example` to `apps/api/.env`, set a replica-set `MONGODB_URI` and run `pnpm dev`. Without `MONGODB_URI` the API starts without a database and every route except `/api/health` answers `503 DB_UNAVAILABLE`.

### Try this

1. Press **Add to slot** on Mira (or drag her card) into the open Backend slot and press Enter: capacity and coverage update before you commit.
2. Follow the hint to switch to **Dana (Engineering Manager)** and approve Mira: the slot turns active.
3. Approve Kai: the server re-checks capacity inside the transaction and refuses with the exact date and the most hours that would fit.
4. **Start over** (bottom right), then follow the first hint: drag the start date two weeks later. Tom moves from "Later" to available as you drag. Add him to the draft: the verdict reads *+0 overbooked days*; drag back to the original start and it reads *+14*. **Share** gives a read-only link; **Move start and send 1 proposal** commits it all in one transaction.
5. **Projects** (dock): move Orion to Closed. Its people's hours end today, so Kai's conflicting proposal on Atlas turns into a fit. As Olivia (Organization admin), the Departments tab moves people between departments, and their pending approvals follow them.
6. **Create your organization** (bottom right of the demo): you land on its Organization screen with an invite link. Open the link in a private window to join as an employee, then make them a project manager from the admin's window.
7. **Start over**, then type *a backend dev, two weeks later* into **Draft with AI**: the draft, the start date and the verdict line fill in from one sentence. Locally this uses the deterministic fake provider when you run `LLM_PROVIDER=fake pnpm dev:local`; with `LLM_API_KEY` set it calls Claude.

## Scripts

| Command | What it does |
| --- | --- |
| `pnpm dev:local` | In-memory replica set + API + web app; also used by the e2e suite |
| `pnpm dev` | Start API and web app in watch mode against `MONGODB_URI` |
| `pnpm test` | Unit and API tests (first run downloads a MongoDB binary; `pnpm test:prepare` fetches it ahead of time) |
| `pnpm eval:ai` | AI-01 eval set: real model with `LLM_API_KEY` (about 20 small paid requests), or free with `LLM_PROVIDER=fake` |
| `pnpm e2e` | Playwright tests in Chromium and WebKit against `pnpm dev:local` (`pnpm exec playwright install` once) |
| `pnpm lint` / `pnpm format:check` / `pnpm typecheck` | Static checks, also enforced in CI |
| `pnpm build` | Production build of the web app |

### Upgrading

Indexes are the schema: the API creates the declared list in `apps/api/src/db/indexes.ts` on every boot and never drops one. One of them is unique: at most one open (proposed, active or deallocation-proposed) assignment per person and project. On a database that already holds data, find violations before deploying, or the API keeps retrying the index build and stays in `db: down`:

```js
db.assignments.aggregate([
  { $match: { status: { $in: ['proposed', 'active', 'deallocationProposed'] } } },
  { $group: { _id: { orgId: '$orgId', projectId: '$projectId', userId: '$userId' }, n: { $sum: 1 } } },
  { $match: { n: { $gt: 1 } } },
]);
```

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
| `GET /api/projects/:id/candidates?start=` | Ranked candidates with score terms, reasons and capacity timelines; `start` ranks as if the project started later (scrubber, up to 6 weeks) |
| `POST /api/projects/:id/scenarios/commit` | Commit a draft: move the start (with its team) and create every proposal in one transaction, all-or-nothing |
| `POST /api/auth/signup` · `/login` · `/logout` | Create an organization and its admin; sign in and out (server-side sessions, rotated on every sign-in) |
| `POST /api/invites/lookup` · `POST /api/invites/join` | Invite link: show the org, join it as an employee (the token goes in the JSON body, never in a URL that logs would keep) |
| `GET /api/org` · `POST /api/org/invite` | Org settings and invite link; replace the link (admins) |
| `GET /api/org/members` · `PUT /api/org/members/:id/roles` | Members with their access roles; change roles (admins; the last admin stays) |
| `GET/POST /api/team-roles` · `PATCH/DELETE /api/team-roles/:id` | Team roles, unique per org; delete only when unused (admins) |
| `GET/POST /api/projects` · `PATCH/DELETE /api/projects/:id` · `POST /api/projects/:id/status` | Projects: list, create (PMs), edit and delete (their PM; delete only if never active), move status forward (closing ends started work) |
| `GET/POST /api/departments` · `PATCH/DELETE /api/departments/:id` · `PUT .../manager` · `POST .../members` · `DELETE .../members/:userId` | Departments, managers (one each) and members |
| `GET /api/skills` · `POST /api/skills` · `PUT/DELETE /api/skills/:id` · `POST/PATCH/DELETE /api/skill-categories[/:id]` · `PUT/DELETE /api/me/skills/:skillId` | Skill catalog (managers and admins add, authors change) and your own skills |
| `GET /api/ai/status` · `POST /api/ai/search` | Whether AI drafts are enabled; draft a team from a plain-language request (checked picks, never written) |
| `POST /api/snapshots` · `GET /api/snapshots/:id` | Share a draft as a server-rebuilt, read-only snapshot (demo: public for 30 days) |
| `POST /api/assignments` | Propose a person for a role slot |
| `POST /api/assignments/:id/approve` · `/reject` | Decide on a proposal (department manager) |
| `GET /api/approvals` | Proposals waiting for the caller's department |

Every error uses one envelope, `{ code, message, details, hint }`, for example `409 CAPACITY_EXCEEDED` with `details: { date, used, requested, maxHours }`. Scenario commits add `details.slotRoleId`, so the canvas marks the slot that failed. Mutations (POST, PUT, PATCH, DELETE) must be `application/json` (anything else is `415`, a CSRF guard).

## Roadmap

- [x] **M0** Monorepo, CI, deployment configuration, test harness with transactions
- [ ] **M1** Staffing canvas: ranking engine, drag and drop, proposals, atomic approvals, demo sandbox (built and tested locally; deploy and GIF pending)
- [ ] **M1.5** Staffing decisions: draft vs current team, start-date scrubber, verdict line, atomic commit, share snapshots (built and tested locally; deploy and GIF pending)
- [ ] **M1.75** AI-drafted teams: Claude drafts from the engine's shortlist, the engine validates every pick, eval set (built and tested locally with the fake provider; real-model eval pending an API key)
- [ ] **M2** Sign-up, login, invite links, access roles, team roles, cross-org isolation suite (built and tested locally)
- [ ] **M2.5** Live concurrency demo ("Watch the race")
- [ ] **M3a** Departments, skills, projects with status lifecycle (built and tested locally)
- [ ] **M3b** Date edits with clamp and recheck, deallocation, project/employee/department views
- [ ] **M4–M5** Endorsements, skill validation, notifications, statistics
- [ ] **M7** Final polish, architecture notes and walkthrough

Details and the cut order are in [docs/design.md](docs/design.md#next-steps-milestones); deferred ideas are tracked in [TODOS.md](TODOS.md).

## Contributing

Commits follow [Conventional Commits](https://www.conventionalcommits.org/) (`type(scope): description`, scopes: `domain`, `api`, `web`, `e2e`, `deploy`, `deps`, `repo`). Git hooks run ESLint and Prettier on staged files and validate the commit message; they are installed automatically by `pnpm install`.

## License

[MIT](LICENSE)
