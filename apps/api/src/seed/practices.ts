import { addDays, type Experience } from '@team-finder/domain';
import { newId } from '../db/org-repo.ts';
import type { AssignmentDoc, ProjectDoc, UserDoc, UserSkillDoc } from '../db/documents.ts';
import type { SeedData } from './atlas.ts';

// M5: the rest of Northwind Labs (docs/plans/m5-statistics-and-seed.md). Four more practices with
// their managers, a second PM, 49 more people and 7 more projects, so the sandbox feels like a
// 60-person consultancy. The Atlas story is untouched: nobody here holds a skill Atlas uses or has
// worked on a project sharing its tech, so they can only ever count as "no skill match" there.
// Deterministic: fixed lists, no randomness.

type Seedless<T> = Omit<T, 'orgId' | 'expiresAt'>;

const NEW_SKILLS: [name: string, category: string][] = [
  ['Python', 'Languages'],
  ['Spark', 'Data'],
  ['dbt', 'Data'],
  ['Kotlin', 'Mobile'],
  ['Swift', 'Mobile'],
  ['Terraform', 'Cloud'],
  ['Kubernetes', 'Cloud'],
  ['Java', 'Languages'],
];

interface Practice {
  key: 'data' | 'mobile' | 'cloud' | 'java';
  department: string;
  manager: string;
  title: string;
  role: string;
  skills: string[];
  people: string[];
}

const PRACTICES: Practice[] = [
  {
    key: 'data',
    department: 'Data',
    manager: 'Priya Raman',
    title: 'Data Engineer',
    role: 'Data Engineer',
    skills: ['Python', 'Spark', 'dbt'],
    people: [
      'Arjun Mehta',
      'Sofia Rossi',
      'Daniel Kim',
      'Fatima Zahra',
      'Lukas Weber',
      'Chloe Martin',
      'Mateo García',
      'Hannah Schmidt',
      'Yuki Tanaka',
      'Emeka Obi',
      'Laura Nilsen',
    ],
  },
  {
    key: 'mobile',
    department: 'Mobile',
    manager: 'Lucas Moreau',
    title: 'Mobile Developer',
    role: 'Mobile Developer',
    skills: ['Kotlin', 'Swift'],
    people: [
      'Amara Nwosu',
      'Ben Carter',
      'Elif Demir',
      'Grace Liu',
      'Ivan Petrov',
      'Julia Costa',
      'Kofi Mensah',
      'Lena Fischer',
      'Marco Bianchi',
      'Nadia Ali',
      'Oscar Lindqvist',
    ],
  },
  {
    key: 'cloud',
    department: 'Cloud Platform',
    manager: 'Hana Kim',
    title: 'Platform Engineer',
    role: 'Platform Engineer',
    skills: ['Terraform', 'Kubernetes', 'Python'],
    people: [
      'Rafael Souza',
      'Sara Johansson',
      'Tariq Hassan',
      'Uma Patel',
      'Victor Dubois',
      'Wen Zhao',
      'Ximena López',
      'Yara Haddad',
      'Zane Cooper',
      'Aiko Sato',
      'Bruno Alves',
    ],
  },
  {
    key: 'java',
    department: 'Java Services',
    manager: 'Omar Farouk',
    title: 'Java Developer',
    role: 'Java Developer',
    skills: ['Java', 'Spark'],
    people: [
      'Clara Becker',
      'Diego Ramírez',
      'Eva Novak',
      'Felix Wagner',
      'Gabriela Silva',
      'Hugo Laurent',
      'Isla Murphy',
      'Jonas Berg',
      'Kira Ivanova',
      'Leon Hoffmann',
      'Maya Cohen',
    ],
  },
];

const EXPERIENCE: Experience[] = ['6-12m', '1-2y', '2-4y', '4-7y', '7y+'];

const email = (name: string) =>
  `${name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z]+/g, '.')}@northwind.example`;

/** Extends the Atlas seed in place with the other practices (keeps every Atlas document as it was). */
export function addPractices(seed: SeedData, today: string, now: Date): void {
  // Skills and categories (Mobile is new; the others exist).
  const categoryId = new Map(seed.skillCategories.map((c) => [c.name, c._id]));
  for (const [, category] of NEW_SKILLS) {
    if (!categoryId.has(category)) {
      const _id = newId();
      categoryId.set(category, _id);
      seed.skillCategories.push({ _id, name: category });
    }
  }
  const departmentId = new Map(PRACTICES.map((p) => [p.key, newId()]));
  const practiceOfSkill = (name: string) => PRACTICES.filter((p) => p.skills.includes(name)).map((p) => p.key);
  const skillId = new Map<string, string>();
  for (const [name, category] of NEW_SKILLS) {
    const _id = newId();
    skillId.set(name, _id);
    seed.skills.push({
      _id,
      name,
      description: '',
      categoryId: categoryId.get(category)!,
      authorId: null,
      departmentIds: practiceOfSkill(name).map((k) => departmentId.get(k)!),
    });
  }
  const roleId = new Map(PRACTICES.map((p) => [p.role, newId()]));
  for (const [name, _id] of roleId) seed.teamRoles.push({ _id, name });

  // People: a manager and eleven engineers per practice, and a second project manager.
  const user = (
    name: string,
    title: string,
    roles: UserDoc['accessRoles'],
    dept: string | null,
  ): Seedless<UserDoc> => ({
    _id: newId(),
    name,
    email: email(name),
    title,
    accessRoles: roles,
    departmentId: dept,
    capacityVersion: 0,
  });
  const sam = user('Sam Ortiz', 'Project Manager', ['employee', 'projectManager'], null);
  seed.users.push(sam);
  const members = new Map<Practice['key'], Seedless<UserDoc>[]>();
  for (const p of PRACTICES) {
    const dept = departmentId.get(p.key)!;
    const manager = user(p.manager, `${p.department} Manager`, ['employee', 'deptManager'], dept);
    seed.users.push(manager);
    seed.departments.push({ _id: dept, name: p.department, managerId: manager._id });
    const people = p.people.map((name, i) => user(name, i < 2 ? `Senior ${p.title}` : p.title, ['employee'], dept));
    seed.users.push(...people);
    members.set(p.key, people);
    people.forEach((person, i) => {
      // Two or three practice skills each, levels 2-5 spread across the team.
      const held = p.skills.filter((_, s) => s < 2 || (i + s) % 2 === 0);
      held.forEach((name, s) => {
        const pending = i === 10 && s === 0 && (p.key === 'data' || p.key === 'cloud');
        const doc: Seedless<UserSkillDoc> = {
          _id: newId(),
          userId: person._id,
          skillId: skillId.get(name)!,
          level: 2 + ((i * 3 + s * 2) % 4),
          experience: EXPERIENCE[(i + s) % EXPERIENCE.length]!,
          // Skill-04: a couple of claims waiting for their managers.
          validated: !pending,
          previous: null,
          version: 0,
        };
        seed.userSkills.push(doc);
      });
    });
  }

  // Projects: Sam runs them; each practice has current work, and two have history.
  const skills = (...names: string[]) => names.map((n) => skillId.get(n)!);
  const project = (
    p: Omit<Seedless<ProjectDoc>, '_id' | 'version' | 'everActive' | 'pmId' | 'skillRequirements'> &
      Partial<Pick<ProjectDoc, 'skillRequirements'>>,
  ): Seedless<ProjectDoc> => ({
    _id: newId(),
    pmId: sam._id,
    version: 0,
    everActive: p.status !== 'notStarted' && p.status !== 'starting',
    skillRequirements: [],
    ...p,
  });
  const role = (practice: Practice['key'], count: number) => [
    { roleId: roleId.get(PRACTICES.find((x) => x.key === practice)!.role)!, count },
  ];
  const lumen = project({
    name: 'Lumen',
    description: 'Analytics platform for a retail client (ongoing).',
    period: 'ongoing',
    startDate: addDays(today, -210),
    deadline: null,
    status: 'inProgress',
    techStack: skills('Python', 'Spark', 'dbt'),
    teamRoles: role('data', 5),
  });
  const prism = project({
    name: 'Prism',
    description: 'Forecasting models for an energy client.',
    period: 'fixed',
    startDate: addDays(today, 14),
    deadline: addDays(today, 120),
    status: 'starting',
    techStack: skills('Python', 'dbt'),
    skillRequirements: [{ skillId: skillId.get('Python')!, minLevel: 3 }],
    teamRoles: role('data', 3),
  });
  const pocket = project({
    name: 'Pocket',
    description: 'Banking app for iOS and Android.',
    period: 'fixed',
    startDate: addDays(today, -60),
    deadline: addDays(today, 90),
    status: 'inProgress',
    techStack: skills('Kotlin', 'Swift'),
    teamRoles: role('mobile', 6),
  });
  const harbor = project({
    name: 'Harbor',
    description: 'Shared cloud platform (ongoing).',
    period: 'ongoing',
    startDate: addDays(today, -300),
    deadline: null,
    status: 'inProgress',
    techStack: skills('Terraform', 'Kubernetes'),
    teamRoles: role('cloud', 5),
  });
  const nimbus = project({
    name: 'Nimbus',
    description: 'Data centre exit for a logistics client.',
    period: 'fixed',
    startDate: addDays(today, 30),
    deadline: addDays(today, 200),
    status: 'notStarted',
    techStack: skills('Terraform', 'Kubernetes'),
    skillRequirements: [{ skillId: skillId.get('Kubernetes')!, minLevel: 3 }],
    teamRoles: role('cloud', 3),
  });
  const quarry = project({
    name: 'Quarry',
    description: 'Claims processing services for an insurer.',
    period: 'fixed',
    startDate: addDays(today, -90),
    deadline: addDays(today, 60),
    status: 'inProgress',
    techStack: skills('Java'),
    teamRoles: role('java', 6),
  });
  const tidal = project({
    name: 'Tidal',
    description: 'Batch pipeline rewrite (closed).',
    period: 'fixed',
    startDate: addDays(today, -500),
    deadline: addDays(today, -250),
    status: 'closed',
    techStack: skills('Java', 'Spark'),
    teamRoles: role('java', 4),
  });
  seed.projects.push(lumen, prism, pocket, harbor, nimbus, quarry, tidal);

  const managerOf = (practice: Practice['key']) => seed.departments.find((d) => d._id === departmentId.get(practice))!;
  const assign = (
    practice: Practice['key'],
    person: Seedless<UserDoc>,
    p: Seedless<ProjectDoc>,
    status: AssignmentDoc['status'],
    hoursPerDay: number,
    from: string,
    to: string | null,
  ): Seedless<AssignmentDoc> => ({
    _id: newId(),
    userId: person._id,
    projectId: p._id,
    hoursPerDay,
    slotRoleId: p.teamRoles[0]!.roleId,
    roleIds: [p.teamRoles[0]!.roleId],
    status,
    from,
    to,
    comments: '',
    approverId: status === 'proposed' ? null : managerOf(practice).managerId,
    proposedBy: sam._id,
    version: 0,
    createdAt: now,
  });
  const team = (practice: Practice['key']) => members.get(practice)!;
  const data = team('data');
  const mobile = team('mobile');
  const cloud = team('cloud');
  const java = team('java');
  seed.assignments.push(
    // Data: five on Lumen, two proposed for Prism (waiting for Priya), the rest free.
    ...data.slice(0, 5).map((m, i) => assign('data', m, lumen, 'active', i < 3 ? 8 : 4, lumen.startDate, null)),
    ...data.slice(5, 7).map((m) => assign('data', m, prism, 'proposed', 6, prism.startDate, prism.deadline)),
    // Mobile: six on Pocket, part-time for two of them.
    ...mobile
      .slice(0, 6)
      .map((m, i) => assign('mobile', m, pocket, 'active', i < 4 ? 8 : 6, pocket.startDate, pocket.deadline)),
    // Cloud: five on Harbor; Nimbus has not started.
    ...cloud.slice(0, 5).map((m, i) => assign('cloud', m, harbor, 'active', i < 2 ? 8 : 6, harbor.startDate, null)),
    // Java: six on Quarry, and four who shipped Tidal last year.
    ...java.slice(0, 6).map((m) => assign('java', m, quarry, 'active', 8, quarry.startDate, quarry.deadline)),
    ...java.slice(4, 8).map((m) => assign('java', m, tidal, 'past', 8, tidal.startDate, tidal.deadline)),
  );
}
