import { z } from 'zod';
import type { CapacityTimeline } from './capacity.ts';
import { HOURS_PER_DAY } from './constants.ts';
import { addDays, Day, daysBetween, isEmptyInterval, maxDay, minEnd, type Interval } from './dates.ts';
import { coverage, projectTargets, type MatchProject } from './matching.ts';

// Staffing decisions (docs/design.md, "E1 Scenarios"; docs/plans/m1.5-staffing-decisions.md). A
// scenario is a start date plus a team. A is the current team at the project start; B is a draft:
// A plus additions, possibly at a later start. Everything here is pure and takes `today` as a
// parameter, so the canvas (live, while scrubbing), the snapshot endpoint and tests agree.

/** The scrubber moves the start up to this many weeks later. */
export const SCRUB_WEEKS = 6;
/** Overbooking on an ongoing (open-ended) project is counted over this horizon. */
export const ONGOING_HORIZON_DAYS = 84;

export type ScenarioProject = Pick<
  MatchProject,
  'startDate' | 'deadline' | 'techStack' | 'skillRequirements' | 'teamRoles'
>;

/**
 * Allowed starts `[start, start + 6 wk]`, or `null` once the project has started (its team is
 * already working, so moving the start would rewrite history).
 */
export function scrubRange(project: Pick<ScenarioProject, 'startDate'>, today: Day): Interval | null {
  if (project.startDate <= today) return null;
  return { from: project.startDate, to: addDays(project.startDate, SCRUB_WEEKS * 7) };
}

/** Is `start` a valid scrub target? (Inclusive upper bound: "+6 wk" is reachable.) */
export function inScrubRange(project: Pick<ScenarioProject, 'startDate'>, start: Day, today: Day): boolean {
  if (start === project.startDate) return true;
  const range = scrubRange(project, today);
  return range !== null && start >= range.from && start <= range.to!;
}

/** Moves the project to `start`, keeping its duration (ongoing projects stay open-ended). */
export function shiftProject<P extends Pick<ScenarioProject, 'startDate' | 'deadline'>>(project: P, start: Day): P {
  const delta = daysBetween(project.startDate, start);
  return {
    ...project,
    startDate: start,
    deadline: project.deadline === null ? null : addDays(project.deadline, delta),
  };
}

/** Window a scenario is judged over: `[max(today, start), end)`, same rule as the evaluation window. */
export function scenarioWindow(project: Pick<ScenarioProject, 'startDate' | 'deadline'>, start: Day, today: Day) {
  const shifted = shiftProject(project, start);
  return { from: maxDay(today, shifted.startDate), to: shifted.deadline };
}

/**
 * Person-days on which `hours` on top of the committed load exceeds 8 h, over `window` (open-ended
 * windows are cut at ONGOING_HORIZON_DAYS). Pending proposals elsewhere are not counted: only
 * committed hours make a day overbooked, as in invariant 1.
 */
export function overbookedDays(timeline: CapacityTimeline, hours: number, window: Interval): number {
  const end = window.to ?? addDays(window.from, ONGOING_HORIZON_DAYS);
  const range: Interval = { from: window.from, to: end };
  if (isEmptyInterval(range)) return 0;
  let days = 0;
  for (const s of timeline) {
    if (s.used + hours <= HOURS_PER_DAY) continue;
    const from = maxDay(s.from, range.from);
    const to = minEnd(s.to, end)!;
    if (to > from) days += daysBetween(from, to);
  }
  return days;
}

export interface ScenarioMember {
  userId: string;
  slotRoleId: string;
  hoursPerDay: number;
  /** Validated levels on this project's target skills. */
  skills: readonly { skillId: string; level: number }[];
  /** Capacity on *other* projects (this project's own assignment excluded). */
  timeline: CapacityTimeline;
}

export interface Scenario {
  start: Day;
  members: readonly ScenarioMember[];
}

export const ScenarioMetrics = z.object({
  start: Day,
  /** Share of target skills someone on the team meets (0..1). */
  coverage: z.number(),
  missingSkillIds: z.array(z.string()),
  overbookedPersonDays: z.number(),
  slotsOpen: z.number(),
});
export type ScenarioMetrics = z.infer<typeof ScenarioMetrics>;

export function evaluateScenario(project: ScenarioProject, scenario: Scenario, today: Day): ScenarioMetrics {
  const window = scenarioWindow(project, scenario.start, today);
  const cov = coverage(projectTargets(project), scenario.members);
  const overbookedPersonDays = scenario.members.reduce(
    (sum, m) => sum + overbookedDays(m.timeline, m.hoursPerDay, window),
    0,
  );
  const slotsOpen = project.teamRoles.reduce((open, r) => {
    const taken = scenario.members.filter((m) => m.slotRoleId === r.roleId).length;
    return open + Math.max(0, r.count - taken);
  }, 0);
  return { start: scenario.start, coverage: cov.ratio, missingSkillIds: cov.missing, overbookedPersonDays, slotsOpen };
}

export const Verdict = z.object({
  a: ScenarioMetrics,
  b: ScenarioMetrics,
  startDelayDays: z.number(),
  /** B minus A; the seeded demo keeps a known conflict in A, so the verdict reports the change. */
  overbookedDelta: z.number(),
});
export type Verdict = z.infer<typeof Verdict>;

/** The verdict: B judged against A (the current team at the current start). */
export function compareScenarios(project: ScenarioProject, a: Scenario, b: Scenario, today: Day): Verdict {
  const ma = evaluateScenario(project, a, today);
  const mb = evaluateScenario(project, b, today);
  return {
    a: ma,
    b: mb,
    startDelayDays: daysBetween(a.start, b.start),
    overbookedDelta: mb.overbookedPersonDays - ma.overbookedPersonDays,
  };
}

/** "+2 wk", "+3 d", "+1 wk 2 d", "same start". */
export function formatDelay(days: number): string {
  if (days === 0) return 'same start';
  const sign = days > 0 ? '+' : '−';
  const abs = Math.abs(days);
  const weeks = Math.floor(abs / 7);
  const rest = abs % 7;
  const parts = [weeks > 0 ? `${weeks} wk` : '', rest > 0 ? `${rest} d` : ''].filter(Boolean);
  return `start ${sign}${parts.join(' ')}`;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** One sentence, numbers only, never KPI cards (design.md, /autoplan #2 Pass 4). */
export function verdictSentence(v: Verdict): string {
  const cov =
    v.a.coverage === v.b.coverage
      ? `coverage ${pct(v.b.coverage)}`
      : `coverage ${pct(v.a.coverage)} → ${pct(v.b.coverage)}`;
  const d = v.overbookedDelta;
  const over = `${d >= 0 ? '+' : '−'}${Math.abs(d)} overbooked day${Math.abs(d) === 1 ? '' : 's'}`;
  const open = v.b.slotsOpen === 0 ? 'all slots filled' : `${v.b.slotsOpen} slot${v.b.slotsOpen === 1 ? '' : 's'} open`;
  return `Draft vs current: ${formatDelay(v.startDelayDays)} → ${cov}, ${over}, ${open}`;
}
