import { z } from 'zod';
import { buildTimeline, minHoursLeft, peakUsed, type CapacityAssignment, type CapacityTimeline } from './capacity.ts';
import { HOURS_PER_DAY } from './constants.ts';
import { addDays, daysBetween, Day, isEmptyInterval, maxDay, type Interval } from './dates.ts';

/** Score weights (sum 100). One constant so they can be tuned, tested and shown in the README. */
export const SCORE_WEIGHTS = { skillFit: 60, history: 25, availability: 15 } as const;

/** SRS: "projects close to finish" means N between 2 and 6 weeks. */
export const ROLLING_OFF_WEEKS = { min: 2, max: 6 } as const;

export const SKILL_LEVELS = ['Learns', 'Knows', 'Does', 'Helps', 'Teaches'] as const;
export const SkillLevel = z.number().int().min(1).max(5);
export const Experience = z.enum(['0-6m', '6-12m', '1-2y', '2-4y', '4-7y', '7y+']);
export type Experience = z.infer<typeof Experience>;

export interface UserSkill {
  skillId: string;
  level: number;
  experience: Experience;
}

export interface SkillTarget {
  skillId: string;
  minLevel?: number | undefined;
}

export interface MatchProject {
  startDate: Day;
  deadline: Day | null;
  techStack: readonly string[];
  skillRequirements: readonly SkillTarget[];
  teamRoles: readonly { roleId: string; count: number }[];
}

export interface PastProject {
  projectId: string;
  name: string;
  techStack: readonly string[];
  roleIds: readonly string[];
}

export interface CandidateAssignment extends CapacityAssignment {
  projectId: string;
  projectName?: string | undefined;
}

export interface CandidateInput {
  userId: string;
  name: string;
  skills: readonly UserSkill[];
  /** Assignments on other projects that may overlap the window (any status; non-consuming ones are ignored). */
  assignments: readonly CandidateAssignment[];
  pastProjects: readonly PastProject[];
  hasApprover: boolean;
  /** Already holds a non-terminal assignment on this project. */
  onProject?: boolean;
}

export const RankOptions = z.object({
  includePartial: z.boolean().default(false),
  includeRollingOffWithinWeeks: z
    .number()
    .int()
    .min(ROLLING_OFF_WEEKS.min)
    .max(ROLLING_OFF_WEEKS.max)
    .nullable()
    .default(null),
  includeUnavailable: z.boolean().default(false),
  includeNearMisses: z.boolean().default(false),
});
export type RankOptions = z.infer<typeof RankOptions>;

export const Availability = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('available'), hoursLeft: z.number() }),
  z.object({ kind: z.literal('partial'), hoursLeft: z.number() }),
  z.object({ kind: z.literal('rollingOff'), availableFrom: Day, weeksUntil: z.number() }),
  z.object({ kind: z.literal('unavailable'), hoursLeft: z.number() }),
]);
export type Availability = z.infer<typeof Availability>;

export const Reason = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('skill'),
    skillId: z.string(),
    level: z.number(),
    experience: Experience,
    minLevel: z.number().optional(),
  }),
  z.object({ kind: z.literal('missingSkill'), skillId: z.string() }),
  z.object({ kind: z.literal('belowMinLevel'), skillId: z.string(), level: z.number(), minLevel: z.number() }),
  z.object({ kind: z.literal('pastProject'), projectId: z.string(), name: z.string(), similarity: z.number() }),
  z.object({
    kind: z.literal('rollsOff'),
    date: Day,
    projectId: z.string().optional(),
    projectName: z.string().optional(),
  }),
  z.object({ kind: z.literal('partial'), hoursLeft: z.number() }),
  z.object({ kind: z.literal('unavailable') }),
  z.object({ kind: z.literal('noApprover') }),
]);
export type Reason = z.infer<typeof Reason>;

export const ScoreTerms = z.object({ skillFit: z.number(), history: z.number(), availability: z.number() });
export type ScoreTerms = z.infer<typeof ScoreTerms>;

export const ExclusionReason = z.enum([
  'onProject',
  'noSkillMatch',
  'belowMinLevel',
  'partial',
  'rollingOff',
  'unavailable',
]);
export type ExclusionReason = z.infer<typeof ExclusionReason>;

/**
 * Evaluation window `W = [max(today, start), deadline)`, open-ended for ongoing projects. The same
 * definition is used by ranking, the canvas preview and approval.
 */
export function evaluationWindow(project: Pick<MatchProject, 'startDate' | 'deadline'>, today: Day): Interval {
  return { from: maxDay(today, project.startDate), to: project.deadline };
}

/** Deduplicated union of techStack and skillRequirements; a skill in both keeps its minLevel. */
export function projectTargets(project: Pick<MatchProject, 'techStack' | 'skillRequirements'>): SkillTarget[] {
  const targets = new Map<string, SkillTarget>();
  for (const skillId of project.techStack) targets.set(skillId, { skillId });
  for (const r of project.skillRequirements) {
    const minLevel = r.minLevel ?? targets.get(r.skillId)?.minLevel;
    targets.set(r.skillId, minLevel === undefined ? { skillId: r.skillId } : { skillId: r.skillId, minLevel });
  }
  return [...targets.values()];
}

/**
 * Availability over W. `available`: 8 h left every day. `partial`: 0 < min hours left < 8. `rollingOff`:
 * not fully free now, but fully free from some date within N weeks of W's start until W's end (an
 * open-ended assignment never ends, so ongoing projects never roll off). `availableFrom` is that date.
 */
export function classifyAvailability(
  timeline: CapacityTimeline,
  window: Interval,
  rollingOffWeeks: number,
): Availability {
  const hoursLeft = minHoursLeft(timeline, window);
  if (hoursLeft === HOURS_PER_DAY) return { kind: 'available', hoursLeft };
  if (hoursLeft > 0) return { kind: 'partial', hoursLeft };
  const limit = addDays(window.from, rollingOffWeeks * 7);
  for (const s of timeline) {
    const t = s.to;
    if (t === null || t <= window.from || t > limit) continue;
    const rest: Interval = { from: t, to: window.to };
    if (isEmptyInterval(rest)) continue;
    if (peakUsed(timeline, rest).used === 0) {
      return { kind: 'rollingOff', availableFrom: t, weeksUntil: daysBetween(window.from, t) / 7 };
    }
  }
  return { kind: 'unavailable', hoursLeft: 0 };
}

const EXPERIENCE_INDEX: Record<Experience, number> = {
  '0-6m': 0,
  '6-12m': 1,
  '1-2y': 2,
  '2-4y': 3,
  '4-7y': 4,
  '7y+': 5,
};

/** Per-target fit: 0 if missing, else 80% level and 20% experience. */
export function skillTargetFit(skill: UserSkill | undefined): number {
  if (!skill) return 0;
  return (skill.level / 5) * 0.8 + (EXPERIENCE_INDEX[skill.experience] / 5) * 0.2;
}

export function jaccard<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function profile(techStack: readonly string[], roleIds: readonly string[]): Set<string> {
  return new Set([...techStack.map((s) => `s:${s}`), ...roleIds.map((r) => `r:${r}`)]);
}

export function availabilityTerm(a: Availability): number {
  switch (a.kind) {
    case 'available':
    case 'partial':
      return a.hoursLeft / HOURS_PER_DAY;
    case 'rollingOff':
      return Math.max(0, 1 - a.weeksUntil / ROLLING_OFF_WEEKS.max);
    case 'unavailable':
      return 0;
  }
}

export interface CandidateScore {
  score: number;
  terms: ScoreTerms;
  /** Weighted contribution of each term; sums to `score`. */
  points: ScoreTerms;
  reasons: Reason[];
  belowMinLevel: Reason[];
  /** Holds at least one target skill, or has a past project sharing tech and roles (SRS "AND/OR"). */
  matches: boolean;
}

/** Pure score for one candidate (0..100) with each term returned separately for the UI. */
export function scoreCandidate(
  project: MatchProject,
  candidate: Pick<CandidateInput, 'skills' | 'pastProjects'>,
  availability: Availability,
): CandidateScore {
  const targets = projectTargets(project);
  const skills = new Map(candidate.skills.map((s) => [s.skillId, s]));
  const reasons: Reason[] = [];
  const belowMinLevel: Reason[] = [];

  let fitSum = 0;
  for (const t of targets) {
    const s = skills.get(t.skillId);
    fitSum += skillTargetFit(s);
    if (!s) {
      reasons.push({ kind: 'missingSkill', skillId: t.skillId });
      continue;
    }
    const reason: Reason = { kind: 'skill', skillId: t.skillId, level: s.level, experience: s.experience };
    if (t.minLevel !== undefined) reason.minLevel = t.minLevel;
    reasons.push(reason);
    if (t.minLevel !== undefined && s.level < t.minLevel) {
      belowMinLevel.push({ kind: 'belowMinLevel', skillId: t.skillId, level: s.level, minLevel: t.minLevel });
    }
  }
  const skillFit = targets.length === 0 ? 0 : fitSum / targets.length;

  const roleIds = project.teamRoles.map((r) => r.roleId);
  const mine = profile(project.techStack, roleIds);
  const techSet = new Set(project.techStack);
  const roleSet = new Set(roleIds);
  let history = 0;
  let best: PastProject | undefined;
  let sharesTechAndRole = false;
  for (const p of candidate.pastProjects) {
    const sim = jaccard(mine, profile(p.techStack, p.roleIds));
    if (sim > history || (sim === history && best && p.name < best.name)) {
      history = sim;
      best = p;
    }
    if (p.techStack.some((s) => techSet.has(s)) && p.roleIds.some((r) => roleSet.has(r))) sharesTechAndRole = true;
  }
  if (best && history > 0) {
    reasons.push({ kind: 'pastProject', projectId: best.projectId, name: best.name, similarity: history });
  }

  const avail = availabilityTerm(availability);
  const terms = { skillFit, history, availability: avail };
  const points = {
    skillFit: SCORE_WEIGHTS.skillFit * skillFit,
    history: SCORE_WEIGHTS.history * history,
    availability: SCORE_WEIGHTS.availability * avail,
  };
  return {
    score: points.skillFit + points.history + points.availability,
    terms,
    points,
    reasons: [...reasons, ...belowMinLevel],
    belowMinLevel,
    matches: reasons.some((r) => r.kind === 'skill') || sharesTechAndRole,
  };
}

export interface RankedCandidate {
  userId: string;
  name: string;
  score: number;
  terms: ScoreTerms;
  points: ScoreTerms;
  availability: Availability;
  timeline: CapacityTimeline;
  reasons: Reason[];
  nearMiss: boolean;
  hasApprover: boolean;
}

export interface RankResult {
  window: Interval;
  candidates: RankedCandidate[];
  excluded: Record<ExclusionReason, number>;
}

function availabilityReasons(c: CandidateInput, a: Availability): Reason[] {
  if (a.kind === 'partial') return [{ kind: 'partial', hoursLeft: a.hoursLeft }];
  if (a.kind === 'unavailable') return [{ kind: 'unavailable' }];
  if (a.kind === 'rollingOff') {
    // The blocking assignment that ends last is the one the person rolls off from.
    const from = c.assignments.find(
      (x) => x.to === a.availableFrom && (x.status === 'active' || x.status === 'deallocationProposed'),
    );
    const reason: Reason = { kind: 'rollsOff', date: a.availableFrom };
    if (from) {
      reason.projectId = from.projectId;
      if (from.projectName !== undefined) reason.projectName = from.projectName;
    }
    return [reason];
  }
  return [];
}

/**
 * Filters and ranks candidates for a project. Deterministic: score descending, then name, then id.
 * Every exclusion is counted by its first failing filter, so the UI can name the filter that
 * excluded the most people.
 */
export function rankCandidates(input: {
  project: MatchProject;
  today: Day;
  options?: Partial<RankOptions>;
  candidates: readonly CandidateInput[];
}): RankResult {
  const options = RankOptions.parse(input.options ?? {});
  const window = evaluationWindow(input.project, input.today);
  const excluded: Record<ExclusionReason, number> = {
    onProject: 0,
    noSkillMatch: 0,
    belowMinLevel: 0,
    partial: 0,
    rollingOff: 0,
    unavailable: 0,
  };
  const ranked: RankedCandidate[] = [];
  const rollWeeks = options.includeRollingOffWithinWeeks ?? ROLLING_OFF_WEEKS.max;

  for (const c of input.candidates) {
    if (c.onProject) {
      excluded.onProject++;
      continue;
    }
    const timeline = buildTimeline(c.assignments);
    const availability = classifyAvailability(timeline, window, rollWeeks);
    const s = scoreCandidate(input.project, c, availability);
    if (!s.matches) {
      excluded.noSkillMatch++;
      continue;
    }
    const nearMiss = s.belowMinLevel.length > 0;
    if (nearMiss && !options.includeNearMisses) {
      excluded.belowMinLevel++;
      continue;
    }
    if (availability.kind === 'partial' && !options.includePartial) {
      excluded.partial++;
      continue;
    }
    if (availability.kind === 'rollingOff' && options.includeRollingOffWithinWeeks === null) {
      excluded.rollingOff++;
      continue;
    }
    if (availability.kind === 'unavailable' && !options.includeUnavailable) {
      excluded.unavailable++;
      continue;
    }
    const reasons = [...s.reasons, ...availabilityReasons(c, availability)];
    if (!c.hasApprover) reasons.push({ kind: 'noApprover' });
    ranked.push({
      userId: c.userId,
      name: c.name,
      score: s.score,
      terms: s.terms,
      points: s.points,
      availability,
      timeline,
      reasons,
      nearMiss,
      hasApprover: c.hasApprover,
    });
  }

  ranked.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name) || a.userId.localeCompare(b.userId));
  return { window, candidates: ranked, excluded };
}

export interface CoverageMember {
  skills: readonly Pick<UserSkill, 'skillId' | 'level'>[];
}

/** Required-skill coverage of a (possibly hypothetical) team: share of targets someone meets. */
export function coverage(
  targets: readonly SkillTarget[],
  members: readonly CoverageMember[],
): { covered: string[]; missing: string[]; ratio: number } {
  const covered: string[] = [];
  const missing: string[] = [];
  for (const t of targets) {
    const min = t.minLevel ?? 1;
    const ok = members.some((m) => m.skills.some((s) => s.skillId === t.skillId && s.level >= min));
    (ok ? covered : missing).push(t.skillId);
  }
  return { covered, missing, ratio: targets.length === 0 ? 1 : covered.length / targets.length };
}
