# M2 Authentication and roles

**Goal:** real organizations can sign up and use the app; demo sessions keep working through the same seam.
**Depends on:** M1 (sessions + `resolveActor`). **Spec:** design.md data model, "Engineering decisions" (auth seam), invariants 3-4, SRS Auth-01..03, Role-01/02.

## Scope
- Auth-01: org admin sign-up creates org + admin user (argon2id password hashing).
- Auth-02: invite URL (`orgs.inviteToken`, regenerate action).
- Auth-03: employee sign-up via invite URL.
- Login/logout creating/deleting the same `sessions` documents as the demo; session id rotation on login and role switch.
- Role-01: stackable access roles; admin assigns roles; `can()` permission table enforced on every route.
- Role-02: custom team roles CRUD (admin).
- Tenant-isolation suite: two orgs, every resource type, cross-org read/write attempts rejected.

## Tasks
1. domain: auth schemas, `can()` table completed for all SRS actions.
2. api: sign-up, login, logout, invite routes; rate limits on auth routes; generic auth error messages.
3. api: role assignment and team-roles routes.
4. web: sign-up, login, invite landing, admin role management, team roles page.
5. tests: auth flows, permission table, cross-org suite; e2e sign-up -> invite -> employee joins.

## Done when
A new org can be created, invite an employee, assign roles, and staff a project, with the cross-org suite green.

## Risks
Credential handling (argon2id, no password in logs); session fixation (rotation).

## Implementation notes (eng review, 2026-11-03)
Checked against the merged M1-M1.75 code. Decisions:

1. **Done-when narrowed.** "Staff a project" needs project creation, which is M3 scope (`m3-organization-data.md`). M2 is done when a new org can sign up, invite an employee who joins, assign roles and team roles, with the cross-org suite green; staffing stays exercised on the demo org until M3 adds projects.
2. **Hashing without a dependency.** `node:crypto` `argon2('argon2id')` (Node 24.7+, the repo pins 26): OWASP parameters m = 19 MiB, t = 2, p = 1, 16-byte salt, 32-byte tag, stored as a PHC string (`$argon2id$v=19$m=19456,t=2,p=1$salt$hash`) so parameters can be raised later; compared with `timingSafeEqual`. Unknown emails still pay for one verify (no timing oracle). Passwords: 10-200 characters, never logged.
3. **Identity.** Emails are trimmed and lower-cased, unique across all password users (partial unique index on `users.email` where `passwordHash` exists; demo users have no password and can never log in). The pre-auth lookup lives in `db/` next to sessions, outside `orgRepo`, like the session store.
4. **Error messages.** Login failures are one generic `INVALID_CREDENTIALS` (401). Sign-up and join say `EMAIL_TAKEN` (409): without email verification (out of scope) hiding it would only hurt real users; the auth rate limits bound enumeration.
5. **Sessions.** Real-org sessions last 7 days. Sign-up, join and login always issue a new session id and delete the one the browser held (fixation); logout deletes the session and clears the cookie. Roles are re-read on every request, so a role change applies on the next call.
6. **Rate limits.** Auth routes: 10 per minute per IP; login additionally 10 per 15 minutes per email.
7. **Roles (Role-01).** `employee` is always kept; only admins change roles; the last admin cannot lose `admin` (`LAST_ADMIN`). New permission actions: `org.manage` (admin: invite link, roles, team roles) and `org.view` (anyone in the org: member list, team roles). The rest of the SRS matrix lands with the milestone that adds each feature, so no rule exists without a route and a test.
8. **Team roles (Role-02).** Names unique per org, case-insensitive (`NAME_TAKEN`); delete refuses a role referenced by a project or an assignment (`IN_USE`).
9. **Invites (Auth-02/03).** `orgs.inviteToken`: 32 random bytes, base64url; `POST /api/invites/lookup` shows the org name and `POST /api/invites/join` creates an `employee`. The token is always in the JSON body, never in an API URL, because our request logs and the SPA host's proxy logs record URLs (found in review). Admins see and regenerate the link (old links stop working at once).
10. **Demo.** No sign-up wall (premise 2): `/` still lands in a sandbox. The seed gains an Org Admin persona so the new admin screen is reachable from the role switcher. Login and sign-up are linked from the dock.
11. **Web.** `#/signup`, `#/login`, `#/join/:token` work without a session (no sandbox is created for them); `#/org` is the admin screen (members and roles, invite link, team roles). A real org without projects lands on the org screen (admins) or an empty state that says projects arrive with M3.
12. **Cross-org suite.** Two real orgs plus a demo org; every route that takes an id is called with the other org's ids (projects, candidates, assignments, approvals, scenarios, snapshots, AI drafts, members, roles, team roles, invites) and must answer 404/403 without changing anything.
