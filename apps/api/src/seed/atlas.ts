import { addDays, type AccessRole, type AssignmentStatus, type Experience } from '@team-finder/domain';
import { newId } from '../db/org-repo.ts';
import type {
  AssignmentDoc,
  DepartmentDoc,
  ProjectDoc,
  SkillDoc,
  TeamRoleDoc,
  UserDoc,
  UserSkillDoc,
} from '../db/documents.ts';

// The "Atlas" demo seed: one complete staffing decision (docs/design.md, Cross-Model Perspective,
// "Weekend build"). Eight employees plus a project manager and a department manager. Atlas starts in
// a week, half-staffed, with one conflicting proposal. Dates are relative to "today" so the demo
// never goes stale; every visitor gets a fresh clone with fresh ids.
//
//   Ana    Backend, already active on Atlas
//   Leo    Frontend, proposed on Atlas (pending)
//   Kai    QA, proposed on Atlas for 6 h while 4 h busy on Orion -> conflict (approval fails)
//   Mira   Backend, 2 h on Orion -> partially available, strong fit, covers AWS
//   Tom    Backend, 8 h on Borealis until 2 weeks into Atlas -> rolling off
//   Ines   Staff engineer, 8 h on ongoing Cobalt -> great but unavailable
//   Jo     QA, fully available, partial fit
//   Noor   Frontend, department without a manager -> no approver

type Seedless<T> = Omit<T, 'orgId' | 'expiresAt'>;

export interface SeedData {
  orgName: string;
  landingProjectId: string;
  pmUserId: string;
  users: Seedless<UserDoc>[];
  departments: Seedless<DepartmentDoc>[];
  teamRoles: Seedless<TeamRoleDoc>[];
  skills: Seedless<SkillDoc>[];
  userSkills: Seedless<UserSkillDoc>[];
  projects: Seedless<ProjectDoc>[];
  assignments: Seedless<AssignmentDoc>[];
}

const SKILLS = {
  node: ['Node.js', 'Backend'],
  ts: ['TypeScript', 'Languages'],
  react: ['React', 'Frontend'],
  pg: ['PostgreSQL', 'Data'],
  aws: ['AWS', 'Cloud'],
  pw: ['Playwright', 'Testing'],
  go: ['Go', 'Languages'],
  figma: ['Figma', 'Design'],
} as const;
type SkillKey = keyof typeof SKILLS;

const ROLES = { backend: 'Backend Developer', frontend: 'Frontend Developer', qa: 'QA Engineer' } as const;
type RoleKey = keyof typeof ROLES;

type PersonKey = 'pat' | 'dana' | 'olivia' | 'ana' | 'leo' | 'mira' | 'tom' | 'ines' | 'kai' | 'jo' | 'noor';
const PEOPLE: Record<
  PersonKey,
  {
    name: string;
    title: string;
    roles: AccessRole[];
    dept: 'eng' | 'design' | null;
    persona?: number;
    skills?: [SkillKey, number, Experience][];
  }
> = {
  pat: { name: 'Pat Reyes', title: 'Project Manager', roles: ['employee', 'projectManager'], dept: null, persona: 0 },
  dana: {
    name: 'Dana Okafor',
    title: 'Engineering Manager',
    roles: ['employee', 'deptManager'],
    dept: 'eng',
    persona: 1,
  },
  olivia: {
    name: 'Olivia Grant',
    title: 'Organization admin',
    roles: ['employee', 'admin'],
    dept: null,
    persona: 3,
  },
  ana: {
    name: 'Ana Silva',
    title: 'Backend Developer',
    roles: ['employee'],
    dept: 'eng',
    persona: 2,
    skills: [
      ['node', 4, '4-7y'],
      ['ts', 4, '2-4y'],
      ['pg', 3, '2-4y'],
    ],
  },
  leo: {
    name: 'Leo Martin',
    title: 'Frontend Developer',
    roles: ['employee'],
    dept: 'eng',
    skills: [
      ['react', 4, '2-4y'],
      ['ts', 3, '1-2y'],
    ],
  },
  mira: {
    name: 'Mira Chen',
    title: 'Backend Developer',
    roles: ['employee'],
    dept: 'eng',
    skills: [
      ['node', 4, '2-4y'],
      ['ts', 4, '2-4y'],
      ['pg', 4, '2-4y'],
      ['aws', 3, '1-2y'],
    ],
  },
  tom: {
    name: 'Tom Becker',
    title: 'Senior Backend Developer',
    roles: ['employee'],
    dept: 'eng',
    skills: [
      ['node', 5, '7y+'],
      ['ts', 5, '4-7y'],
      ['pg', 4, '4-7y'],
      ['aws', 4, '2-4y'],
    ],
  },
  ines: {
    name: 'Ines Duarte',
    title: 'Staff Engineer',
    roles: ['employee'],
    dept: 'eng',
    skills: [
      ['node', 5, '7y+'],
      ['ts', 5, '7y+'],
      ['react', 5, '4-7y'],
      ['pg', 5, '7y+'],
      ['aws', 5, '4-7y'],
    ],
  },
  kai: {
    name: 'Kai Nakamura',
    title: 'QA Engineer',
    roles: ['employee'],
    dept: 'eng',
    skills: [
      ['pw', 4, '2-4y'],
      ['ts', 2, '1-2y'],
    ],
  },
  jo: {
    name: 'Jo Park',
    title: 'QA Engineer',
    roles: ['employee'],
    dept: 'eng',
    skills: [
      ['pw', 3, '1-2y'],
      ['ts', 2, '6-12m'],
      ['react', 2, '6-12m'],
    ],
  },
  noor: {
    name: 'Noor Haddad',
    title: 'Frontend Developer',
    roles: ['employee'],
    dept: 'design',
    skills: [
      ['react', 4, '2-4y'],
      ['ts', 3, '2-4y'],
      ['figma', 4, '4-7y'],
    ],
  },
};

export function atlasSeed(today: string, now: Date = new Date()): SeedData {
  const id = <K extends string>(keys: readonly K[]) =>
    Object.fromEntries(keys.map((k) => [k, newId()])) as Record<K, string>;
  const skillId = id(Object.keys(SKILLS) as SkillKey[]);
  const roleId = id(Object.keys(ROLES) as RoleKey[]);
  const userId = id(Object.keys(PEOPLE) as PersonKey[]);
  const deptId = id(['eng', 'design'] as const);
  const projectId = id(['atlas', 'orion', 'borealis', 'cobalt', 'helios'] as const);

  const atlasStart = addDays(today, 7);
  const atlasEnd = addDays(atlasStart, 84);
  const borealisEnd = addDays(atlasStart, 14);

  const users: Seedless<UserDoc>[] = (Object.keys(PEOPLE) as PersonKey[]).map((key) => {
    const p = PEOPLE[key];
    return {
      _id: userId[key],
      name: p.name,
      email: `${p.name.split(' ')[0]!.toLowerCase()}@northwind.example`,
      title: p.title,
      accessRoles: p.roles,
      departmentId: p.dept ? deptId[p.dept] : null,
      capacityVersion: 0,
      ...(p.persona === undefined ? {} : { personaOrder: p.persona }),
    };
  });

  const userSkills: Seedless<UserSkillDoc>[] = (Object.keys(PEOPLE) as PersonKey[]).flatMap((key) =>
    (PEOPLE[key].skills ?? []).map(([skill, level, experience]) => ({
      _id: newId(),
      userId: userId[key],
      skillId: skillId[skill],
      level,
      experience,
      validated: true,
    })),
  );

  const project = (
    key: keyof typeof projectId,
    p: Omit<Seedless<ProjectDoc>, '_id' | 'version' | 'everActive' | 'pmId'> & { pmId?: string },
  ): Seedless<ProjectDoc> => ({
    _id: projectId[key],
    pmId: userId.pat,
    version: 0,
    everActive: p.status !== 'notStarted' && p.status !== 'starting',
    ...p,
  });

  const projects: Seedless<ProjectDoc>[] = [
    project('atlas', {
      name: 'Atlas',
      description: 'Customer self-service portal: Node API, React front end, Postgres, on AWS.',
      period: 'fixed',
      startDate: atlasStart,
      deadline: atlasEnd,
      status: 'starting',
      techStack: [skillId.node, skillId.ts, skillId.react, skillId.pg],
      skillRequirements: [
        { skillId: skillId.node, minLevel: 3 },
        { skillId: skillId.aws, minLevel: 3 },
        { skillId: skillId.pw, minLevel: 2 },
      ],
      teamRoles: [
        { roleId: roleId.backend, count: 2 },
        { roleId: roleId.frontend, count: 2 },
        { roleId: roleId.qa, count: 1 },
      ],
    }),
    project('orion', {
      name: 'Orion',
      description: 'Internal data platform (ongoing).',
      period: 'ongoing',
      startDate: addDays(today, -120),
      deadline: null,
      status: 'inProgress',
      techStack: [skillId.go, skillId.pg],
      skillRequirements: [],
      teamRoles: [
        { roleId: roleId.backend, count: 3 },
        { roleId: roleId.qa, count: 1 },
      ],
    }),
    project('borealis', {
      name: 'Borealis',
      description: 'Billing migration, wrapping up.',
      period: 'fixed',
      startDate: addDays(today, -150),
      deadline: borealisEnd,
      status: 'closing',
      techStack: [skillId.node, skillId.ts, skillId.pg],
      skillRequirements: [],
      teamRoles: [{ roleId: roleId.backend, count: 2 }],
    }),
    project('cobalt', {
      name: 'Cobalt',
      description: 'Platform team (ongoing).',
      period: 'ongoing',
      startDate: addDays(today, -400),
      deadline: null,
      status: 'inProgress',
      techStack: [skillId.node, skillId.ts, skillId.react, skillId.aws],
      skillRequirements: [],
      teamRoles: [{ roleId: roleId.backend, count: 2 }],
    }),
    project('helios', {
      name: 'Helios',
      description: 'Partner API (closed).',
      period: 'fixed',
      startDate: addDays(today, -400),
      deadline: addDays(today, -200),
      status: 'closed',
      techStack: [skillId.node, skillId.ts, skillId.pg],
      skillRequirements: [],
      teamRoles: [{ roleId: roleId.backend, count: 3 }],
    }),
  ];

  const assignment = (
    who: PersonKey,
    on: keyof typeof projectId,
    role: RoleKey,
    status: AssignmentStatus,
    hoursPerDay: number,
    from: string,
    to: string | null,
  ): Seedless<AssignmentDoc> => ({
    _id: newId(),
    userId: userId[who],
    projectId: projectId[on],
    hoursPerDay,
    slotRoleId: roleId[role],
    roleIds: [roleId[role]],
    status,
    from,
    to,
    comments: '',
    approverId: status === 'proposed' ? null : userId.dana,
    proposedBy: userId.pat,
    version: 0,
    createdAt: now,
  });

  const helios: [string, string] = [addDays(today, -400), addDays(today, -200)];
  const assignments: Seedless<AssignmentDoc>[] = [
    assignment('ana', 'atlas', 'backend', 'active', 8, atlasStart, atlasEnd),
    assignment('leo', 'atlas', 'frontend', 'proposed', 6, atlasStart, atlasEnd),
    assignment('kai', 'atlas', 'qa', 'proposed', 6, atlasStart, atlasEnd),
    assignment('kai', 'orion', 'qa', 'active', 4, addDays(today, -90), null),
    assignment('mira', 'orion', 'backend', 'active', 2, addDays(today, -100), null),
    assignment('tom', 'borealis', 'backend', 'active', 8, addDays(today, -150), borealisEnd),
    assignment('ines', 'cobalt', 'backend', 'active', 8, addDays(today, -400), null),
    assignment('ana', 'helios', 'backend', 'past', 8, ...helios),
    assignment('mira', 'helios', 'backend', 'past', 6, ...helios),
    assignment('tom', 'helios', 'backend', 'past', 8, ...helios),
  ];

  return {
    orgName: 'Northwind Labs',
    landingProjectId: projectId.atlas,
    pmUserId: userId.pat,
    users,
    departments: [
      { _id: deptId.eng, name: 'Engineering', managerId: userId.dana },
      { _id: deptId.design, name: 'Design', managerId: null },
    ],
    teamRoles: (Object.keys(ROLES) as RoleKey[]).map((k) => ({ _id: roleId[k], name: ROLES[k] })),
    skills: (Object.keys(SKILLS) as SkillKey[]).map((k) => ({
      _id: skillId[k],
      name: SKILLS[k][0],
      category: SKILLS[k][1],
    })),
    userSkills,
    projects,
    assignments,
  };
}
