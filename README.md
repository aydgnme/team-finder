# Team Finder

[![CI](https://github.com/aydgnme/team-finder/actions/workflows/ci.yml/badge.svg)](https://github.com/aydgnme/team-finder/actions/workflows/ci.yml)

**A team-first staffing canvas.** Start from the shape of a project team, drag ranked candidates into role slots, and see capacity, skill coverage and conflicts update before you commit. Every ranking explains itself, and approvals stay correct when two managers act at the same moment.

> **Status: early development.** The monorepo, CI and deployment setup (M0) are in place; the staffing canvas (M1) is next. See the [roadmap](#roadmap). The live demo link and walkthrough GIF will be added here once the demo is deployed.

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
pnpm dev
```

The web app runs on http://localhost:5173 and proxies `/api` to the API on port 3000. Without `MONGODB_URI` the API starts without a database and only `/api/health` is available. To use a database, copy `apps/api/.env.example` to `apps/api/.env` and set a replica-set connection string (transactions need a replica set). A one-command local setup with an in-memory database and seed data (`pnpm dev:local`) is planned for M1.

## Scripts

| Command | What it does |
| --- | --- |
| `pnpm dev` | Start API and web app in watch mode |
| `pnpm test` | Unit and API tests (first run downloads a MongoDB binary; `pnpm test:prepare` fetches it ahead of time) |
| `pnpm e2e` | Playwright tests in Chromium and WebKit (`pnpm exec playwright install` once) |
| `pnpm lint` / `pnpm format:check` / `pnpm typecheck` | Static checks, also enforced in CI |
| `pnpm build` | Production build of the web app |

## Roadmap

- [x] **M0** Monorepo, CI, deployment configuration, test harness with transactions
- [ ] **M1** Staffing canvas: ranking engine, drag and drop, proposals, atomic approvals, demo sandbox
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
