import {
  AI_CANDIDATE_POOL,
  AiDraftOutput,
  coverage,
  Day,
  fail,
  HOURS_PER_DAY,
  maxDay,
  projectTargets,
  scenarioWindow,
  withProposal,
  type AiDraftItem,
  type AiDraftResponse,
  type AiSearchRequest,
  type CandidateView,
} from '@team-finder/domain';
import type { z } from 'zod';
import { renderPrompt } from '../ai/prompt.ts';
import { AiUnavailable, type DraftProvider, type PromptCandidate, type PromptInput } from '../ai/provider.ts';
import { projectBoard } from './board.ts';
import { listCandidates } from './candidates.ts';
import type { ServiceContext } from './context.ts';

type Request = z.output<typeof AiSearchRequest>;

function hoursFree(c: CandidateView): number {
  const a = c.availability;
  return a.kind === 'available' || a.kind === 'partial' ? a.hoursLeft : 0;
}

/**
 * AI-01: the model drafts from the engine's top-ranked candidates (pseudonymous), then every pick
 * goes through the same checks as a manual drop: slot limits counting the current team, one slot
 * per person, an approver, and withProposal() over the draft's window. Unknown refs or slots are
 * dropped, never guessed. Nothing is written: the PM decides what enters the draft and commits it
 * through scenarios/commit.
 */
export async function draftTeam(
  ctx: ServiceContext,
  provider: DraftProvider,
  input: Request,
  beforeCall: () => void,
): Promise<AiDraftResponse> {
  const { today } = ctx;
  const board = await projectBoard(ctx, input.projectId);
  if (!board.canStaff) fail('FORBIDDEN', { action: 'draft a team for this project' });
  const ranked = await listCandidates(ctx, input.projectId, {
    includePartial: true,
    includeRollingOffWithinWeeks: 6,
  });
  // People without an approver could never be proposed; leave them out of what the model sees.
  const pool = ranked.candidates.filter((c) => c.hasApprover).slice(0, AI_CANDIDATE_POOL);
  const refs = new Map(pool.map((c, i) => [`c${i + 1}`, c]));

  const project = board.project;
  const roleName = new Map(board.roles.map((r) => [r.id, r.name]));
  const skillName = new Map(board.skills.map((s) => [s.id, s.name]));
  const taken = new Map<string, number>();
  for (const a of board.assignments) taken.set(a.slotRoleId, (taken.get(a.slotRoleId) ?? 0) + 1);
  const targets = projectTargets(project);
  const covered = coverage(targets, board.assignments).covered;

  const promptInput: PromptInput = {
    today,
    project: { name: project.name, startDate: project.startDate, deadline: project.deadline, scrub: board.scrub },
    slots: project.teamRoles.map((r) => ({
      roleId: r.roleId,
      roleName: roleName.get(r.roleId) ?? 'Role',
      count: r.count,
      open: Math.max(0, r.count - (taken.get(r.roleId) ?? 0)),
    })),
    targets: targets.map((t) => ({ name: skillName.get(t.skillId) ?? 'skill', minLevel: t.minLevel ?? null })),
    coveredByTeam: covered.map((id) => skillName.get(id) ?? 'skill'),
    candidates: [...refs].map(([ref, c]): PromptCandidate => ({
      ref,
      title: c.title,
      skills: c.skills.map((s) => ({ name: skillName.get(s.skillId) ?? 'skill', level: s.level })),
      hoursFree: hoursFree(c),
      availableFrom: c.availability.kind === 'rollingOff' ? c.availability.availableFrom : null,
    })),
    text: input.text,
  };

  beforeCall();
  let raw: unknown;
  try {
    raw = await provider.draft(promptInput, renderPrompt(promptInput));
  } catch (error) {
    fail('AI_UNAVAILABLE', {
      reason: error instanceof AiUnavailable ? error.reason : 'the model could not be reached',
    });
  }
  const parsed = AiDraftOutput.safeParse(raw);
  if (!parsed.success) fail('AI_UNAVAILABLE', { reason: 'the answer could not be read' });
  const out = parsed.data!;

  // A suggested start is clamped into the scrub range; once the project has started it is ignored.
  let start = project.startDate;
  if (board.scrub && out.start && Day.safeParse(out.start).success) {
    start = out.start < board.scrub.from ? board.scrub.from : out.start > board.scrub.to! ? board.scrub.to! : out.start;
  }
  const window = scenarioWindow(project, start, today);

  const items: AiDraftItem[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const a of out.assignments) {
    const candidate = refs.get(a.candidateRef);
    const slot = project.teamRoles.find((r) => r.roleId === a.slotRoleId);
    if (!candidate || !slot) {
      dropped++;
      continue;
    }
    const hoursPerDay = Math.min(
      HOURS_PER_DAY,
      Math.max(1, Math.round(Number.isFinite(a.hoursPerDay) ? a.hoursPerDay : 1)),
    );
    const item = (verdict: AiDraftItem['verdict']) =>
      items.push({ candidate, slotRoleId: slot.roleId, hoursPerDay, verdict });
    if (seen.has(candidate.userId)) {
      item({ kind: 'rejected', reason: 'duplicate' });
      continue;
    }
    seen.add(candidate.userId);
    if ((taken.get(slot.roleId) ?? 0) >= slot.count) {
      item({ kind: 'rejected', reason: 'slotFull' });
      continue;
    }
    if (!candidate.hasApprover) {
      item({ kind: 'rejected', reason: 'noApprover' });
      continue;
    }
    taken.set(slot.roleId, (taken.get(slot.roleId) ?? 0) + 1);
    const check = withProposal(candidate.timeline, hoursPerDay, maxDay(window.from, today), window);
    item(
      check.fits
        ? { kind: 'fits', maxHours: check.maxHours }
        : { kind: 'conflict', date: check.worst.date, used: check.worst.used, maxHours: check.maxHours },
    );
  }

  return {
    start,
    items,
    dropped,
    // The model only knows refs; the manager reads names. The mapping never leaves this request.
    rationale: out.rationale
      .slice(0, 6)
      .map((r) => r.slice(0, 300).replace(/\bc(\d{1,2})\b/g, (ref) => refs.get(ref)?.name ?? ref)),
    raw,
    provider: provider.name,
  };
}
