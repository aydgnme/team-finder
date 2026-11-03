import { can, fail, type Experience, type SkillRequest, type SkillsResponse } from '@team-finder/domain';
import type { z } from 'zod';
import { duplicateKeyOn } from '../db/auth.ts';
import type { SkillDoc } from '../db/documents.ts';
import type { ServiceContext } from './context.ts';
import { touchReferences } from './references.ts';
import { unique } from './shared.ts';

// Skill-01/02 (docs/plans/m3-organization-data.md, M3a). Department managers and admins create
// categories and skills; only a skill's author edits or deletes it. Everyone keeps their own
// skills; until Skill-04 (M4) they count as validated.

const nameTaken = (name: string) => (error: unknown) => {
  if (duplicateKeyOn(error, 'org_name_unique_ci')) fail('NAME_TAKEN', { name });
  throw error;
};

function requireCreate({ actor }: ServiceContext) {
  if (!can(actor, 'skill.create', { orgId: actor.orgId })) fail('FORBIDDEN', { action: 'manage skills' });
}

function requireAuthor({ actor }: ServiceContext, skill: SkillDoc) {
  if (!can(actor, 'skill.edit', { orgId: actor.orgId, authorId: skill.authorId })) {
    fail('FORBIDDEN', { action: 'edit a skill someone else created' });
  }
}

export async function listSkills(ctx: ServiceContext): Promise<SkillsResponse> {
  const { repo, actor } = ctx;
  if (!can(actor, 'org.view', { orgId: actor.orgId })) fail('FORBIDDEN', { action: 'view skills' });
  const [categories, skills, held, projects, mine] = await Promise.all([
    repo.skillCategories.find({}, { sort: { name: 1 } }),
    repo.skills.find({}, { sort: { name: 1 } }),
    repo.userSkills.find({}, { projection: { skillId: 1 } }),
    repo.projects.find({}, { projection: { techStack: 1, skillRequirements: 1 } }),
    repo.userSkills.find({ userId: actor.userId }),
  ]);
  const authors = await repo.users.find(
    { _id: { $in: unique(skills.map((s) => s.authorId).filter((a): a is string => a !== null)) } },
    { projection: { name: 1 } },
  );
  const authorName = new Map(authors.map((u) => [u._id, u.name]));
  const used = new Set([
    ...held.map((h) => h.skillId),
    ...projects.flatMap((p) => [...p.techStack, ...p.skillRequirements.map((r) => r.skillId)]),
  ]);
  const usedCategories = new Set(skills.map((s) => s.categoryId));
  return {
    canCreate: can(actor, 'skill.create', { orgId: actor.orgId }),
    categories: categories.map((c) => ({ id: c._id, name: c.name, inUse: usedCategories.has(c._id) })),
    skills: skills.map((s) => ({
      id: s._id,
      name: s.name,
      description: s.description,
      categoryId: s.categoryId,
      author: s.authorId ? { id: s.authorId, name: authorName.get(s.authorId) ?? 'Unknown' } : null,
      departmentIds: s.departmentIds,
      inUse: used.has(s._id),
      canEdit: can(actor, 'skill.edit', { orgId: actor.orgId, authorId: s.authorId }),
    })),
    mine: mine.map((m) => ({ skillId: m.skillId, level: m.level, experience: m.experience, validated: m.validated })),
  };
}

export async function createCategory(ctx: ServiceContext, name: string) {
  requireCreate(ctx);
  const doc = await ctx.repo.skillCategories.insertOne({ name }).catch(nameTaken(name));
  return { id: doc._id, name };
}

export async function renameCategory(ctx: ServiceContext, id: string, name: string) {
  requireCreate(ctx);
  const r = await ctx.repo.skillCategories.updateOne({ _id: id }, { $set: { name } }).catch(nameTaken(name));
  if (r.matchedCount === 0) fail('NOT_FOUND', { resource: 'skill category', id });
  return { id, name };
}

export async function deleteCategory(ctx: ServiceContext, id: string) {
  requireCreate(ctx);
  const { repo } = ctx;
  return repo.withTransaction(async (session) => {
    const c = await repo.skillCategories.findOne({ _id: id }, { session });
    if (!c) fail('NOT_FOUND', { resource: 'skill category', id });
    if ((await repo.skills.countDocuments({ categoryId: id }, { session })) > 0) {
      fail('IN_USE', { resource: 'skill category' });
    }
    await repo.skillCategories.deleteMany({ _id: id }, { session });
    return { id };
  });
}

type SkillInput = z.output<typeof SkillRequest>;

async function checkSkillRefs(ctx: ServiceContext, input: SkillInput, session: Parameters<typeof touchReferences>[1]) {
  await touchReferences(ctx.repo, session, { categoryIds: [input.categoryId] });
  await ctx.repo.assertOwned('departments', input.departmentIds, { session });
}

export async function createSkill(ctx: ServiceContext, input: SkillInput) {
  requireCreate(ctx);
  const { repo, actor } = ctx;
  return repo.withTransaction(async (session) => {
    await checkSkillRefs(ctx, input, session);
    const doc = await repo.skills
      .insertOne(
        {
          name: input.name,
          description: input.description,
          categoryId: input.categoryId,
          authorId: actor.userId,
          departmentIds: unique(input.departmentIds),
        },
        { session },
      )
      .catch(nameTaken(input.name));
    return { id: doc._id };
  });
}

export async function updateSkill(ctx: ServiceContext, id: string, input: SkillInput) {
  const { repo } = ctx;
  return repo.withTransaction(async (session) => {
    const skill = await repo.skills.findOne({ _id: id }, { session });
    if (!skill) fail('NOT_FOUND', { resource: 'skill', id });
    requireAuthor(ctx, skill!);
    await checkSkillRefs(ctx, input, session);
    await repo.skills
      .updateOne(
        { _id: id },
        {
          $set: {
            name: input.name,
            description: input.description,
            categoryId: input.categoryId,
            departmentIds: unique(input.departmentIds),
          },
        },
        { session },
      )
      .catch(nameTaken(input.name));
    return { id };
  });
}

/** Refused while anyone holds it or a project lists it; runs in a transaction (see references). */
export async function deleteSkill(ctx: ServiceContext, id: string) {
  const { repo } = ctx;
  return repo.withTransaction(async (session) => {
    const skill = await repo.skills.findOne({ _id: id }, { session });
    if (!skill) fail('NOT_FOUND', { resource: 'skill', id });
    requireAuthor(ctx, skill!);
    const [held, projects] = await Promise.all([
      repo.userSkills.countDocuments({ skillId: id }, { session }),
      repo.projects.countDocuments({ $or: [{ techStack: id }, { 'skillRequirements.skillId': id }] }, { session }),
    ]);
    if (held + projects > 0) fail('IN_USE', { resource: 'skill' });
    await repo.skills.deleteMany({ _id: id }, { session });
    return { id };
  });
}

/** Skill-02: add or update one of your own skills. */
export async function setMySkill(ctx: ServiceContext, skillId: string, level: number, experience: Experience) {
  const { repo, actor } = ctx;
  if (!can(actor, 'userSkill.edit', { orgId: actor.orgId, userId: actor.userId })) {
    fail('FORBIDDEN', { action: 'edit skills' });
  }
  return repo.withTransaction(async (session) => {
    await touchReferences(repo, session, { skillIds: [skillId] });
    const r = await repo.userSkills.updateOne(
      { userId: actor.userId, skillId },
      { $set: { level, experience } },
      { session },
    );
    if (r.matchedCount === 0) {
      // Skill-04 (M4) will create these unvalidated; until then they count right away.
      await repo.userSkills.insertOne(
        { userId: actor.userId, skillId, level, experience, validated: true },
        { session },
      );
    }
    return { skillId, level, experience, validated: true };
  });
}

export async function removeMySkill(ctx: ServiceContext, skillId: string) {
  const { repo, actor } = ctx;
  const n = await repo.userSkills.deleteMany({ userId: actor.userId, skillId });
  if (n === 0) fail('NOT_FOUND', { resource: 'skill', id: skillId });
  return { skillId };
}
