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
