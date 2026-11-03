import { addDays, maxDay, type AiDraftOutput, type Day } from '@team-finder/domain';
import { AiUnavailable, type DraftProvider, type PromptInput } from './provider.ts';

// Deterministic stand-in for the model (LLM_PROVIDER=fake): CI, e2e and local runs without a key.
// It reads counts and roles from the request ("2 backend devs and a QA", "two weeks later",
// "from March") and picks from the shortlist in rank order, like a cooperative model would.
// Bracketed markers simulate failures: [malformed], [refuse], [timeout], [unknown].

const NUMBERS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4 };
const ROLE_WORDS: [RegExp, string][] = [
  [/^(backend|back-end|node)/i, 'backend'],
  [/^(frontend|front-end|react)/i, 'frontend'],
  [/^(qa|tester|test)/i, 'qa'],
];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function roleKey(text: string): string | null {
  return ROLE_WORDS.find(([re]) => re.test(text))?.[1] ?? null;
}

function requestedRoles(text: string): { role: string; count: number }[] {
  const out: { role: string; count: number }[] = [];
  const re = /\b(\d+|a|an|one|two|three|four)\s+(?:senior\s+|junior\s+)?([a-z-]+)/gi;
  for (const m of text.matchAll(re)) {
    const role = roleKey(m[2]!);
    if (!role) continue;
    const count = /^\d+$/.test(m[1]!) ? Number(m[1]) : NUMBERS[m[1]!.toLowerCase()]!;
    out.push({ role, count: Math.min(count, 4) });
  }
  return out;
}

function requestedStart(text: string, input: PromptInput): Day | null {
  const base = input.project.scrub?.from ?? input.project.startDate;
  const weeks = /\b(\d+|one|two|three|four)\s+weeks?\s+(?:later|delay)|\bin\s+(\d+|one|two|three|four)\s+weeks?/i.exec(
    text,
  );
  if (weeks) {
    const n = weeks[1] ?? weeks[2]!;
    return addDays(base, 7 * (/^\d+$/.test(n) ? Number(n) : NUMBERS[n.toLowerCase()]!));
  }
  const month = /\bfrom\s+([a-z]{3})[a-z]*\b/i.exec(text);
  const index = month ? MONTHS.indexOf(month[1]!.toLowerCase()) : -1;
  if (index >= 0) {
    const year = Number(base.slice(0, 4));
    const mm = String(index + 1).padStart(2, '0');
    // "from March" means the next March on or after the project's start month.
    const day =
      `${year}-${mm}-01` < `${input.project.startDate.slice(0, 7)}-01` ? `${year + 1}-${mm}-01` : `${year}-${mm}-01`;
    return maxDay(day, base);
  }
  return null;
}

export const fakeProvider: DraftProvider = {
  name: 'fake',
  async draft(input) {
    const text = input.text;
    if (text.includes('[refuse]')) throw new AiUnavailable('the model declined this request');
    if (text.includes('[timeout]')) throw new AiUnavailable('the model timed out');
    if (text.includes('[malformed]')) return { assignments: 'not a list' };

    const used = new Set<string>();
    const assignments: AiDraftOutput['assignments'] = [];
    const rationale: string[] = [];
    for (const { role, count } of requestedRoles(text)) {
      const slot = input.slots.find((s) => roleKey(s.roleName) === role);
      if (!slot) continue;
      const picks = input.candidates.filter(
        (c) => !used.has(c.ref) && roleKey(c.title.replace(/^senior\s+/i, '')) === role,
      );
      for (const c of picks.slice(0, count)) {
        used.add(c.ref);
        assignments.push({
          candidateRef: c.ref,
          slotRoleId: slot.roleId,
          hoursPerDay: c.hoursFree > 0 ? c.hoursFree : 8,
        });
        rationale.push(
          `${c.ref}: ${c.title}, ${c.availableFrom ? `free from ${c.availableFrom}` : `${c.hoursFree} h/day free`}.`,
        );
      }
    }
    if (text.includes('[unknown]')) {
      assignments.push({ candidateRef: 'c99', slotRoleId: input.slots[0]?.roleId ?? 'x', hoursPerDay: 4 });
      assignments.push({ candidateRef: 'c1', slotRoleId: 'not-a-slot', hoursPerDay: 4 });
    }
    if (assignments.length === 0) rationale.push('No candidate on the shortlist matches that request.');
    return {
      start: requestedStart(text, input),
      assignments,
      rationale: rationale.slice(0, 4),
    } satisfies AiDraftOutput;
  },
};
