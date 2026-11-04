import {
  AddEndorsementRequest,
  can,
  Experience,
  fail,
  MAX_ENDORSEMENTS,
  type Endorsement,
  type MySkill,
  type SkillClaimItem,
  type SkillRequest,
  type SkillsResponse,
} from '@team-finder/domain';
import type { z } from 'zod';
import { duplicateKeyOn } from '../db/auth.ts';
import type { EndorsementDoc, SkillDoc, UserDoc, UserSkillDoc } from '../db/documents.ts';
import { newId, type DbSession, type OrgRepo } from '../db/org-repo.ts';
import type { ServiceContext } from './context.ts';
import { notify } from './notifications.ts';
import { touchReferences } from './references.ts';
import { approverOf, unique } from './shared.ts';

// Skill-01/02 (docs/plans/m3-organization-data.md, M3a). Department managers and admins create
// categories and skills; only a skill's author edits or deletes it. Everyone keeps their own
// skills; since Skill-04 (M4a) new claims and raises wait for their department manager, and only
// validated skills count for matching, coverage and views.

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
    mine: mine.map((m) => ({
      skillId: m.skillId,
      level: m.level,
      experience: m.experience,
      validated: m.validated,
      endorsements: (m.endorsements ?? []).map(toEndorsement),
    })),
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

const EXPERIENCE = Experience.options;

/** A change that claims more than was validated: a higher level or longer experience. */
function isRaise(from: { level: number; experience: Experience }, to: { level: number; experience: Experience }) {
  return to.level > from.level || EXPERIENCE.indexOf(to.experience) > EXPERIENCE.indexOf(from.experience);
}

/**
 * Who validates someone's claims: their department manager now (never stored), but never the
 * claimer. Null means nobody but an admin can (no department, no manager, or their own claim).
 */
export async function validatorOf(
  repo: OrgRepo,
  owner: Pick<UserDoc, '_id' | 'departmentId'>,
  session?: DbSession,
): Promise<string | null> {
  const managerId = await approverOf(repo, owner, session);
  return managerId === owner._id ? null : managerId;
}

/**
 * Skill-02 + Skill-04: add or update one of your own skills. A new skill, or a raise of a validated
 * one, waits for validation (the validated values are kept in `previous`); lowering keeps its state.
 */
export async function setMySkill(ctx: ServiceContext, skillId: string, level: number, experience: Experience) {
  requireOwnSkills(ctx);
  return ctx.repo.withTransaction((session) => applyMySkill(ctx, session, skillId, level, experience));
}

function requireOwnSkills({ actor }: ServiceContext) {
  if (!can(actor, 'userSkill.edit', { orgId: actor.orgId, userId: actor.userId })) {
    fail('FORBIDDEN', { action: 'edit skills' });
  }
}

/** The body of setMySkill, inside the caller's transaction (also used to accept an upgrade proposal). */
export async function applyMySkill(
  ctx: ServiceContext,
  session: DbSession,
  skillId: string,
  level: number,
  experience: Experience,
): Promise<MySkill> {
  const { repo, actor } = ctx;
  await touchReferences(repo, session, { skillIds: [skillId] });
  const current = await repo.userSkills.findOne({ userId: actor.userId, skillId }, { session });
  const next = { level, experience };
  let validated: boolean;
  let id: string;
  if (!current) {
    validated = false;
    id = (
      await repo.userSkills.insertOne(
        { userId: actor.userId, skillId, ...next, validated, previous: null, version: 0 },
        { session },
      )
    )._id;
  } else {
    id = current._id;
    // Compare with the last validated values: a pending raise taken back to (or below) them needs no
    // validation any more, while a raise of a validated skill keeps those values to restore on reject.
    const base = current.validated ? current : current.previous;
    const raise = !base || isRaise(base, next);
    validated = !raise;
    await repo.userSkills.updateOne(
      { _id: current._id },
      {
        $set: {
          ...next,
          validated,
          previous: !raise
            ? null
            : current.validated
              ? { level: current.level, experience: current.experience }
              : (current.previous ?? null),
        },
        $inc: { version: 1 },
      },
      { session },
    );
  }
  // Ask for validation when the skill becomes pending, not on every edit of a pending claim.
  if (!validated && (!current || current.validated)) {
    const [owner, skill] = await Promise.all([
      repo.users.findOne({ _id: actor.userId }, { session }),
      repo.skills.findOne({ _id: skillId }, { session, projection: { name: 1 } }),
    ]);
    await notify(ctx, session, [
      {
        userId: owner ? await validatorOf(repo, owner, session) : null,
        type: 'skillPendingValidation',
        refId: id,
        data: { personName: owner?.name ?? 'Someone', skillName: skill?.name ?? 'a skill' },
      },
    ]);
  }
  return { skillId, level, experience, validated, endorsements: current?.endorsements ?? [] };
}

/** Skill-03: attach evidence to one of your own skills. Project endorsements name a project you worked on. */
export async function addEndorsement(
  ctx: ServiceContext,
  skillId: string,
  input: z.output<typeof AddEndorsementRequest>,
) {
  requireOwnSkills(ctx);
  const { repo, actor } = ctx;
  return repo.withTransaction(async (session) => {
    const mine = await repo.userSkills.findOne({ userId: actor.userId, skillId }, { session });
    if (!mine) fail('NOT_FOUND', { resource: 'skill', id: skillId });
    const list = mine!.endorsements ?? [];
    if (list.length >= MAX_ENDORSEMENTS) {
      fail('VALIDATION', { issues: [{ path: 'endorsements', message: `at most ${MAX_ENDORSEMENTS} per skill` }] });
    }
    let endorsement: EndorsementDoc;
    if (input.kind === 'project') {
      const worked = await repo.assignments.findOne(
        {
          userId: actor.userId,
          projectId: input.projectId,
          status: { $in: ['active', 'deallocationProposed', 'past'] },
        },
        { session },
      );
      const project = worked ? await repo.projects.findOne({ _id: input.projectId }, { session }) : null;
      if (!project) {
        fail('VALIDATION', { issues: [{ path: 'projectId', message: 'only projects you worked on' }] });
      }
      if (list.some((e) => e.projectId === input.projectId)) {
        fail('VALIDATION', { issues: [{ path: 'projectId', message: 'this project is already listed' }] });
      }
      endorsement = { id: newId(), kind: 'project', title: project!.name, url: null, projectId: project!._id };
    } else {
      endorsement = { id: newId(), kind: input.kind, title: input.title, url: input.url, projectId: null };
    }
    // Evidence changes what a manager would decide on: bump the version like any edit.
    await repo.userSkills.updateOne(
      { _id: mine!._id },
      { $push: { endorsements: endorsement }, $inc: { version: 1 } },
      { session },
    );
    return toEndorsement(endorsement);
  });
}

export async function removeEndorsement(ctx: ServiceContext, skillId: string, endorsementId: string) {
  requireOwnSkills(ctx);
  const { repo, actor } = ctx;
  const r = await repo.userSkills.updateOne(
    { userId: actor.userId, skillId, 'endorsements.id': endorsementId },
    { $pull: { endorsements: { id: endorsementId } }, $inc: { version: 1 } },
  );
  if (r.matchedCount === 0) fail('NOT_FOUND', { resource: 'endorsement', id: endorsementId });
  return { id: endorsementId };
}

function toEndorsement(e: EndorsementDoc): Endorsement {
  return { id: e.id, kind: e.kind, title: e.title, url: e.url, projectId: e.projectId };
}

async function toClaimItems(
  repo: OrgRepo,
  claims: UserSkillDoc[],
  users: Map<string, UserDoc>,
): Promise<SkillClaimItem[]> {
  const skills = await repo.skills.find(
    { _id: { $in: unique(claims.map((c) => c.skillId)) } },
    { projection: { name: 1 } },
  );
  const skillName = new Map(skills.map((s) => [s._id, s.name]));
  return claims.map((c) => ({
    userSkillId: c._id,
    version: c.version ?? 0,
    user: { id: c.userId, name: users.get(c.userId)?.name ?? 'Unknown' },
    skill: { id: c.skillId, name: skillName.get(c.skillId) ?? 'Skill' },
    level: c.level,
    experience: c.experience,
    previous: c.previous ? { level: c.previous.level, experience: c.previous.experience } : null,
    endorsements: (c.endorsements ?? []).map(toEndorsement),
  }));
}

/** Pending claims of the people in the departments the caller manages (never their own). */
export async function claimsForManager({ repo, actor }: ServiceContext): Promise<SkillClaimItem[]> {
  const depts = await repo.departments.find({ managerId: actor.userId });
  if (depts.length === 0) return [];
  const users = await repo.users.find({ departmentId: { $in: depts.map((d) => d._id) }, _id: { $ne: actor.userId } });
  const claims = await repo.userSkills.find(
    { userId: { $in: users.map((u) => u._id) }, validated: false },
    { sort: { _id: 1 } },
  );
  return toClaimItems(repo, claims, new Map(users.map((u) => [u._id, u])));
}

/** Claims nobody but an admin can validate: no department, an unmanaged one, or a manager's own. */
export async function strandedClaims({ repo, actor }: ServiceContext): Promise<SkillClaimItem[]> {
  const claims = await repo.userSkills.find({ validated: false, userId: { $ne: actor.userId } }, { sort: { _id: 1 } });
  if (claims.length === 0) return [];
  const users = await repo.users.find({ _id: { $in: unique(claims.map((c) => c.userId)) } });
  const userById = new Map(users.map((u) => [u._id, u]));
  const stranded: UserSkillDoc[] = [];
  for (const c of claims) {
    const owner = userById.get(c.userId);
    if (owner && (await validatorOf(repo, owner)) === null) stranded.push(c);
  }
  return toClaimItems(repo, stranded, userById);
}

/** Skill-04: the validator accepts a claim (it starts counting) or rejects it (new: removed; raise: restored). */
export async function decideClaim(
  ctx: ServiceContext,
  userSkillId: string,
  version: number,
  outcome: 'validated' | 'rejected',
) {
  const { repo, actor } = ctx;
  return repo.withTransaction(async (session) => {
    const claim = await repo.userSkills.findOne({ _id: userSkillId }, { session });
    if (!claim) fail('NOT_FOUND', { resource: 'skill claim', id: userSkillId });
    const owner = await repo.users.findOne({ _id: claim!.userId }, { session });
    const validatorId = owner ? await validatorOf(repo, owner, session) : null;
    if (!can(actor, 'skill.validate', { orgId: repo.orgId, ownerId: claim!.userId, validatorId })) {
      fail('FORBIDDEN', { action: 'validate this skill' });
    }
    if (claim!.validated || (claim!.version ?? 0) !== version) {
      fail('CONFLICT_STALE', { resource: 'skill claim', id: userSkillId });
    }
    // Claims from before Skill-04 carry no version field: match that, or they could never be decided.
    const guard = {
      _id: claim!._id,
      validated: false,
      ...(claim!.version === undefined ? { version: { $exists: false } } : { version: claim!.version }),
    };
    const changed =
      outcome === 'validated'
        ? await repo.userSkills.updateOne(
            guard,
            { $set: { validated: true, previous: null }, $inc: { version: 1 } },
            { session },
          )
        : claim!.previous
          ? await repo.userSkills.updateOne(
              guard,
              { $set: { ...claim!.previous, validated: true, previous: null }, $inc: { version: 1 } },
              { session },
            )
          : { matchedCount: await repo.userSkills.deleteMany(guard, { session }) };
    if (changed.matchedCount !== 1) fail('CONFLICT_STALE', { resource: 'skill claim', id: userSkillId });
    return { userSkillId, outcome };
  });
}

export async function removeMySkill(ctx: ServiceContext, skillId: string) {
  const { repo, actor } = ctx;
  const n = await repo.userSkills.deleteMany({ userId: actor.userId, skillId });
  if (n === 0) fail('NOT_FOUND', { resource: 'skill', id: skillId });
  return { skillId };
}
