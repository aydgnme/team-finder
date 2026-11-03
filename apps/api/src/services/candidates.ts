import {
  addDays,
  can,
  evaluationWindow,
  fail,
  inScrubRange,
  NON_TERMINAL_STATUSES,
  projectTargets,
  rankCandidates,
  SCRUB_WEEKS,
  shiftProject,
  type CandidateInput,
  type CandidatesResponse,
  type PastProject,
  type RankOptions,
} from '@team-finder/domain';
import type { AssignmentDoc, DepartmentDoc, UserDoc, UserSkillDoc } from '../db/documents.ts';
import type { ServiceContext } from './context.ts';
import { invalid } from './assignments.ts';
import { groupBy, loadProject, overlapFilter, unique } from './shared.ts';

type UserWithDept = Pick<UserDoc, '_id' | 'name' | 'title'> & { department: Pick<DepartmentDoc, 'managerId'>[] };

/**
 * Ranked candidates for a project. After the project read, ranking inputs load in 4 batched queries
 * (users + departments, userSkills, assignments, their projects) regardless of org size, then the
 * pure rankCandidates() does the rest. The browser receives timelines, never raw assignments.
 */
export async function listCandidates(
  { repo, actor, today }: ServiceContext,
  projectId: string,
  options: Partial<RankOptions>,
  start?: string,
): Promise<CandidatesResponse> {
  const stored = await loadProject(repo, projectId);
  if (!can(actor, 'project.view', { orgId: stored.orgId })) fail('FORBIDDEN', { action: 'view this project' });
  if (start !== undefined && !inScrubRange(stored, start, today)) {
    invalid('start', 'must be within 6 weeks after the start of a project that has not started');
  }
  // Rank as if the project started on `start` (the scrubber), keeping its duration.
  const project = start === undefined ? stored : shiftProject(stored, start);
  // Timelines cover the unshifted window through the end of the whole scrub range, whatever `start`
  // is, so the canvas can re-classify availability live while the slider moves and only refetch the
  // ranked order on release.
  const loadWindow = {
    from: evaluationWindow(stored, today).from,
    to: stored.deadline === null ? null : addDays(stored.deadline, SCRUB_WEEKS * 7),
  };
  const targets = projectTargets(project);
  const targetIds = new Set(targets.map((t) => t.skillId));

  const [users, userSkills, assignments] = await Promise.all([
    repo.users.aggregate<UserWithDept>([
      repo.scopedLookup({ from: 'departments', localField: 'departmentId', foreignField: '_id', as: 'department' }),
      { $project: { name: 1, title: 1, 'department.managerId': 1 } },
    ]),
    repo.userSkills.find({ validated: true }),
    repo.assignments.find({
      $or: [
        // Load on other projects that may overlap W (capacity and pending).
        { projectId: { $ne: project._id }, status: { $in: [...NON_TERMINAL_STATUSES] }, ...overlapFilter(loadWindow) },
        // History.
        { projectId: { $ne: project._id }, status: 'past' },
        // Already on this project.
        { projectId: project._id, status: { $in: [...NON_TERMINAL_STATUSES] } },
      ],
    }),
  ]);
  const otherProjects = await repo.projects.find(
    { _id: { $in: unique(assignments.map((a) => a.projectId).filter((id) => id !== project._id)) } },
    { projection: { name: 1, techStack: 1 } },
  );
  const projectById = new Map(otherProjects.map((p) => [p._id, p]));

  const skillsByUser = groupBy(userSkills, (s: UserSkillDoc) => s.userId);
  const assignmentsByUser = groupBy(assignments, (a: AssignmentDoc) => a.userId);

  const inputs: CandidateInput[] = users.map((u) => {
    const mine = assignmentsByUser.get(u._id) ?? [];
    const pastProjects: PastProject[] = mine
      .filter((a) => a.status === 'past')
      .flatMap((a) => {
        const p = projectById.get(a.projectId);
        return p ? [{ projectId: p._id, name: p.name, techStack: p.techStack, roleIds: a.roleIds }] : [];
      });
    return {
      userId: u._id,
      name: u.name,
      skills: (skillsByUser.get(u._id) ?? []).map((s) => ({
        skillId: s.skillId,
        level: s.level,
        experience: s.experience,
      })),
      assignments: mine
        .filter((a) => a.projectId !== project._id && a.status !== 'past')
        .map((a) => ({
          from: a.from,
          to: a.to,
          hoursPerDay: a.hoursPerDay,
          status: a.status,
          projectId: a.projectId,
          projectName: projectById.get(a.projectId)?.name,
        })),
      pastProjects,
      hasApprover: Boolean(u.department[0]?.managerId),
      onProject: mine.some((a) => a.projectId === project._id),
    };
  });

  const ranked = rankCandidates({ project, today, options, candidates: inputs });
  const titles = new Map(users.map((u) => [u._id, u.title]));
  return {
    window: ranked.window,
    excluded: ranked.excluded,
    candidates: ranked.candidates.map((c) => ({
      ...c,
      title: titles.get(c.userId) ?? '',
      skills: (skillsByUser.get(c.userId) ?? [])
        .filter((s) => targetIds.has(s.skillId))
        .map((s) => ({ skillId: s.skillId, level: s.level })),
    })),
  };
}
