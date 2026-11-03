import { SKILL_LEVELS, type Reason } from '@team-finder/domain';

export function formatDay(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export function formatRange(from: string, to: string | null): string {
  return to ? `${formatDay(from)} – ${formatDay(to)}` : `from ${formatDay(from)}, ongoing`;
}

export function firstName(name: string): string {
  return name.split(' ')[0] ?? name;
}

/** Structured engine reasons -> chip text. The engine never builds strings; the UI does. */
export function reasonText(r: Reason, skillName: (id: string) => string): string | null {
  switch (r.kind) {
    case 'skill':
      return `${SKILL_LEVELS[r.level - 1]} ${skillName(r.skillId)}, ${r.experience}`;
    case 'missingSkill':
      return null;
    case 'belowMinLevel':
      return `${skillName(r.skillId)} below level ${r.minLevel}`;
    case 'pastProject':
      return `Worked on ${r.name}`;
    case 'rollsOff':
      return `Frees up ${formatDay(r.date)}${r.projectName ? ` from ${r.projectName}` : ''}`;
    case 'partial':
      return `${r.hoursLeft} h/day free`;
    case 'unavailable':
      return 'Fully booked';
    case 'noApprover':
      return 'No approver: assign to a department first';
  }
}
