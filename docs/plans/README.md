# Milestone plans

Implementation plans derived from the reviewed design in [../design.md](../design.md). Each plan lists scope, ordered tasks, tests and a definition of done. Build in this order; cut from the bottom when time runs short (see design.md, "If time runs short").

| Milestone | Plan | Status |
| --- | --- | --- |
| M0 Foundations | (done, see git history) | done |
| M1 Staffing canvas | spec in design.md, built in the M1 cloud session | merged (#1); deploy + GIF pending |
| M1.5 Staffing decisions | [m1.5-staffing-decisions.md](m1.5-staffing-decisions.md) | merged (#2); GIF pending |
| M1.75 AI-drafted teams | [m1.75-ai-drafted-teams.md](m1.75-ai-drafted-teams.md) | merged (#3); real-model eval pending a key |
| M2 Auth and roles | [m2-auth-and-roles.md](m2-auth-and-roles.md) | in review |
| M2.5 Concurrency proof and docs | [m2.5-concurrency-proof.md](m2.5-concurrency-proof.md) | planned |
| Polish bucket | [polish.md](polish.md) | planned, first to slip |
| M3 Organization data | [m3-organization-data.md](m3-organization-data.md) | planned |
| M4 Skills lifecycle and notifications | [m4-skills-and-notifications.md](m4-skills-and-notifications.md) | planned |
| M5 Statistics and seed | [m5-statistics-and-seed.md](m5-statistics-and-seed.md) | planned |
| M7 Release | [m7-release.md](m7-release.md) | planned |

Conventions for every milestone: feature branch `feat/<milestone>`, Conventional Commits with workspace scopes, PR into `main`, CI green (lint, format, typecheck, tests, build, e2e) before merge.
