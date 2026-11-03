import { fail } from '@team-finder/domain';
import type { DbSession, OrgRepo } from '../db/org-repo.ts';
import { unique } from './shared.ts';

/**
 * Inside the caller's transaction: proves every referenced team role and skill exists in this org
 * and bumps its version. A transaction that deletes one of them writes the same document, so a
 * role or skill can never be deleted while a project or a person starts using it (either order
 * conflicts and the driver replays against fresh state).
 */
export async function touchReferences(
  repo: OrgRepo,
  session: DbSession,
  refs: {
    teamRoleIds?: readonly string[] | undefined;
    skillIds?: readonly string[] | undefined;
    categoryIds?: readonly string[] | undefined;
  },
): Promise<void> {
  const check = async (
    collection: 'teamRoles' | 'skills' | 'skillCategories',
    ids: readonly string[] | undefined,
    resource: string,
  ) => {
    const list = unique(ids ?? []);
    if (list.length === 0) return;
    const r = await repo[collection].updateMany({ _id: { $in: list } }, { $inc: { version: 1 } }, { session });
    if (r.matchedCount !== list.length) fail('NOT_FOUND', { resource });
  };
  await check('teamRoles', refs.teamRoleIds, 'team role');
  await check('skills', refs.skillIds, 'skill');
  await check('skillCategories', refs.categoryIds, 'skill category');
}
