import type { AccessRole, AssignmentStatus, Experience } from '@team-finder/domain';

// Stored document shapes. Ids are strings (ObjectId hex) so services never need the mongodb package.
// Every tenant document carries `orgId`; demo sandboxes also carry `expiresAt` (TTL cleanup).

export interface TenantDoc {
  _id: string;
  orgId: string;
  expiresAt?: Date;
}

export interface OrgDoc {
  _id: string;
  name: string;
  hqAddress?: string;
  isDemo: boolean;
  /** Auth-02: the invite link's secret; real orgs only. Regenerating it revokes the old link. */
  inviteToken?: string;
  /** Bumped by every role change, so two admins demoting each other conflict (see setRoles). */
  rolesVersion?: number;
  expiresAt?: Date;
  landingProjectId: string | null;
  createdAt: Date;
}

export interface UserDoc extends TenantDoc {
  name: string;
  email: string;
  title: string;
  accessRoles: AccessRole[];
  departmentId: string | null;
  /** argon2id PHC string; absent for demo users, who can never log in. */
  passwordHash?: string;
  /** Bumped by every transaction that changes this person's capacity (invariant 2). */
  capacityVersion: number;
  /** Order in the demo role switcher; absent for people who are not offered as personas. */
  personaOrder?: number;
}

export interface DepartmentDoc extends TenantDoc {
  name: string;
  managerId: string | null;
}

export interface TeamRoleDoc extends TenantDoc {
  name: string;
  /** Bumped by every transaction that starts referencing the role (no delete-while-used race). */
  version?: number;
}

export interface SkillCategoryDoc extends TenantDoc {
  name: string;
  /** Bumped whenever a skill joins the category, so deleting it conflicts with that (see skills). */
  version?: number;
}

export interface SkillDoc extends TenantDoc {
  name: string;
  description: string;
  categoryId: string;
  /** Who created it; only the author edits or deletes it (Skill-01). Null for seeded skills. */
  authorId: string | null;
  departmentIds: string[];
  /** Bumped by every transaction that starts referencing the skill (no delete-while-used race). */
  version?: number;
}

export interface UserSkillDoc extends TenantDoc {
  userId: string;
  skillId: string;
  level: number;
  experience: Experience;
  validated: boolean;
}

export type ProjectStatus = 'notStarted' | 'starting' | 'inProgress' | 'closing' | 'closed';

export interface ProjectDoc extends TenantDoc {
  name: string;
  description: string;
  period: 'fixed' | 'ongoing';
  startDate: string;
  deadline: string | null;
  status: ProjectStatus;
  everActive: boolean;
  techStack: string[];
  teamRoles: { roleId: string; count: number }[];
  skillRequirements: { skillId: string; minLevel?: number }[];
  pmId: string;
  /** Project conflict boundary: bumped by touchProject() in every assignment-changing transaction. */
  version: number;
}

export interface AssignmentDoc extends TenantDoc {
  userId: string;
  projectId: string;
  hoursPerDay: number;
  slotRoleId: string;
  roleIds: string[];
  status: AssignmentStatus;
  from: string;
  to: string | null;
  comments: string;
  /** Project-04: the PM's reason for ending it, while a deallocation is proposed. */
  deallocationReason?: string | null;
  /** Who actually decided (audit), not who is allowed to. */
  approverId: string | null;
  proposedBy: string;
  version: number;
  createdAt: Date;
  decidedAt?: Date;
}

export interface SessionDoc {
  _id: string;
  orgId: string;
  userId: string;
  isDemo: boolean;
  expiresAt: Date;
  createdAt: Date;
}

/** Tenant collections reachable through orgRepo(). */
export interface TenantCollections {
  users: UserDoc;
  departments: DepartmentDoc;
  teamRoles: TeamRoleDoc;
  skillCategories: SkillCategoryDoc;
  skills: SkillDoc;
  userSkills: UserSkillDoc;
  projects: ProjectDoc;
  assignments: AssignmentDoc;
}
export type TenantCollectionName = keyof TenantCollections;
export const TENANT_COLLECTIONS = [
  'users',
  'departments',
  'teamRoles',
  'skillCategories',
  'skills',
  'userSkills',
  'projects',
  'assignments',
] as const satisfies TenantCollectionName[];
