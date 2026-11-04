import { z } from 'zod';

// Stats-01 (docs/plans/m5-statistics-and-seed.md): a department's skill landscape. Validated skills
// only (Skill-04); the aggregation is pure so it is tested without a database.

const Id = z.string().min(1);

export const SkillStat = z.object({
  skillId: Id,
  name: z.string(),
  category: z.string(),
  holders: z.number(),
  /** People at each level, index 0 = level 1 ("Learns") … index 4 = level 5 ("Teaches"). */
  levels: z.tuple([z.number(), z.number(), z.number(), z.number(), z.number()]),
});
export type SkillStat = z.infer<typeof SkillStat>;

export const DepartmentStats = z.object({
  department: z.object({ id: Id, name: z.string() }),
  people: z.number(),
  /** Members holding no validated skill at all. */
  withoutSkills: z.number(),
  skills: z.array(SkillStat),
});
export type DepartmentStats = z.infer<typeof DepartmentStats>;

export interface StatsInput {
  members: readonly { id: string }[];
  userSkills: readonly { userId: string; skillId: string; level: number; validated: boolean }[];
  skills: readonly { id: string; name: string; category: string }[];
}

/** Per-skill holders and level distribution over the members' validated skills, most held first. */
export function skillStats(input: StatsInput): Pick<DepartmentStats, 'people' | 'withoutSkills' | 'skills'> {
  const memberIds = new Set(input.members.map((m) => m.id));
  const known = new Map(input.skills.map((s) => [s.id, s]));
  const bySkill = new Map<string, SkillStat>();
  const holding = new Set<string>();
  for (const us of input.userSkills) {
    if (!us.validated || !memberIds.has(us.userId)) continue;
    const skill = known.get(us.skillId);
    if (!skill || us.level < 1 || us.level > 5) continue;
    let stat = bySkill.get(us.skillId);
    if (!stat) {
      stat = { skillId: skill.id, name: skill.name, category: skill.category, holders: 0, levels: [0, 0, 0, 0, 0] };
      bySkill.set(us.skillId, stat);
    }
    stat.holders++;
    stat.levels[us.level - 1]!++;
    holding.add(us.userId);
  }
  return {
    people: memberIds.size,
    withoutSkills: memberIds.size - holding.size,
    skills: [...bySkill.values()].sort((a, b) => b.holders - a.holders || a.name.localeCompare(b.name)),
  };
}
