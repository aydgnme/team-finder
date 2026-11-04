import { describe, expect, it } from 'vitest';
import { skillStats } from '../src/stats.ts';

const skills = [
  { id: 'ts', name: 'TypeScript', category: 'Languages' },
  { id: 'go', name: 'Go', category: 'Languages' },
  { id: 'aws', name: 'AWS', category: 'Cloud' },
];

describe('skillStats (Stats-01)', () => {
  it('counts validated skills of members only, by level, most held first', () => {
    const r = skillStats({
      members: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
      skills,
      userSkills: [
        { userId: 'a', skillId: 'ts', level: 4, validated: true },
        { userId: 'b', skillId: 'ts', level: 4, validated: true },
        { userId: 'c', skillId: 'ts', level: 1, validated: true },
        { userId: 'a', skillId: 'go', level: 5, validated: true },
        { userId: 'b', skillId: 'aws', level: 3, validated: true },
        // Pending claims and other departments never count.
        { userId: 'c', skillId: 'go', level: 2, validated: false },
        { userId: 'x', skillId: 'go', level: 3, validated: true },
        // Unknown skills (deleted) are ignored.
        { userId: 'd', skillId: 'gone', level: 3, validated: true },
      ],
    });
    expect(r.people).toBe(4);
    expect(r.withoutSkills).toBe(1);
    expect(r.skills).toEqual([
      { skillId: 'ts', name: 'TypeScript', category: 'Languages', holders: 3, levels: [1, 0, 0, 2, 0] },
      { skillId: 'aws', name: 'AWS', category: 'Cloud', holders: 1, levels: [0, 0, 1, 0, 0] },
      { skillId: 'go', name: 'Go', category: 'Languages', holders: 1, levels: [0, 0, 0, 0, 1] },
    ]);
  });

  it('handles an empty department', () => {
    expect(skillStats({ members: [], skills, userSkills: [] })).toEqual({ people: 0, withoutSkills: 0, skills: [] });
  });
});
