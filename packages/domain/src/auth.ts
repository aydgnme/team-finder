import { z } from 'zod';
import { AccessRole } from './permissions.ts';

// Auth-01..03 and Role-01/02 request and response shapes (docs/plans/m2-auth-and-roles.md).

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 200;

/** Trimmed and lower-cased: one account per address, whatever the capitalisation. */
export const Email = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .pipe(z.email({ message: 'Enter a valid email address' }));

export const Password = z
  .string()
  .min(PASSWORD_MIN, `Use at least ${PASSWORD_MIN} characters`)
  .max(PASSWORD_MAX, `Use at most ${PASSWORD_MAX} characters`);

const PersonName = z.string().trim().min(1, 'Enter your name').max(100);

/** Auth-01: an org admin signs up and creates the organization. */
export const SignUpRequest = z.object({
  orgName: z.string().trim().min(2, 'Enter the organization name').max(100),
  hqAddress: z.string().trim().max(200).default(''),
  name: PersonName,
  email: Email,
  password: Password,
});
export type SignUpRequest = z.input<typeof SignUpRequest>;

export const LoginRequest = z.object({
  email: Email,
  // Never length-checked on login: the generic error must not reveal which rule failed.
  password: z.string().min(1).max(PASSWORD_MAX),
});
export type LoginRequest = z.input<typeof LoginRequest>;

/**
 * Invite tokens are secrets: they travel in JSON bodies, never in API URL paths, so neither our
 * request logs nor the SPA host's proxy logs ever record them.
 */
const InviteToken = z.string().min(1).max(100);
export const InviteLookupRequest = z.object({ token: InviteToken });

/** Auth-03: an employee joins through the invite URL. */
export const JoinRequest = z.object({ token: InviteToken, name: PersonName, email: Email, password: Password });
export type JoinRequest = z.input<typeof JoinRequest>;

export const InviteInfo = z.object({ orgName: z.string() });
export type InviteInfo = z.infer<typeof InviteInfo>;

export const OrgSettings = z.object({
  id: z.string(),
  name: z.string(),
  hqAddress: z.string(),
  isDemo: z.boolean(),
  /** Only admins receive it; null in demo sandboxes, which take no invites. */
  inviteToken: z.string().nullable(),
});
export type OrgSettings = z.infer<typeof OrgSettings>;

export const Member = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  title: z.string(),
  roles: z.array(AccessRole),
  departmentName: z.string().nullable(),
});
export type Member = z.infer<typeof Member>;
export const MembersResponse = z.object({ members: z.array(Member) });

/** Role-01: the full set of access roles; `employee` is always kept. */
export const SetRolesRequest = z.object({ roles: z.array(AccessRole).max(4) });

export const TeamRoleView = z.object({ id: z.string(), name: z.string(), inUse: z.boolean() });
export type TeamRoleView = z.infer<typeof TeamRoleView>;
export const TeamRolesResponse = z.object({ teamRoles: z.array(TeamRoleView) });
export const TeamRoleRequest = z.object({ name: z.string().trim().min(2, 'Use at least 2 characters').max(60) });
