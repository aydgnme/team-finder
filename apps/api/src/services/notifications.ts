import {
  type MarkReadRequest,
  type NotificationData,
  type NotificationsResponse,
  type NotificationType,
} from '@team-finder/domain';
import type { DbSession, OrgRepo } from '../db/org-repo.ts';
import type { ServiceContext } from './context.ts';
import { unique } from './shared.ts';

// Notification-01 (docs/plans/m4-skills-and-notifications.md). Every trigger calls notify() inside
// its own transaction, so a refused or replayed trigger leaves no notification behind.

export const INBOX_LIMIT = 50;

export interface NewNotification {
  /** Who gets it; null (nobody can act) is skipped. */
  userId: string | null;
  type: NotificationType;
  refId: string;
  data: NotificationData;
}

/** Writes notifications in the caller's transaction. Never notifies the actor about their own action. */
export async function notify(
  ctx: Pick<ServiceContext, 'repo' | 'actor' | 'now'>,
  session: DbSession,
  items: readonly NewNotification[],
): Promise<void> {
  const docs = items
    .filter((n): n is NewNotification & { userId: string } => n.userId !== null && n.userId !== ctx.actor.userId)
    .map((n) => ({
      userId: n.userId,
      type: n.type,
      refId: n.refId,
      actorId: ctx.actor.userId,
      data: n.data,
      createdAt: ctx.now,
      readAt: null,
    }));
  if (docs.length > 0) await ctx.repo.notifications.insertMany(docs, { session });
}

/** Unread notifications of one user (the dock badge). */
export async function unreadCount(repo: OrgRepo, userId: string): Promise<number> {
  return repo.notifications.countDocuments({ userId, readAt: null });
}

export async function listNotifications({ repo, actor }: ServiceContext): Promise<NotificationsResponse> {
  const docs = await repo.notifications.find(
    { userId: actor.userId },
    { sort: { createdAt: -1, _id: -1 }, limit: INBOX_LIMIT },
  );
  const actorIds = unique(docs.map((d) => d.actorId).filter((id): id is string => id !== null));
  const actors = await repo.users.find({ _id: { $in: actorIds } }, { projection: { name: 1 } });
  const name = new Map(actors.map((u) => [u._id, u.name]));
  return {
    items: docs.map((d) => ({
      id: d._id,
      type: d.type,
      refId: d.refId,
      actor: d.actorId ? { id: d.actorId, name: name.get(d.actorId) ?? 'Someone' } : null,
      data: d.data,
      createdAt: d.createdAt.toISOString(),
      read: d.readAt !== null,
    })),
    unread: await unreadCount(repo, actor.userId),
  };
}

/** Marks the caller's own notifications read; ids that are not theirs are ignored. */
export async function markRead({ repo, actor, now }: ServiceContext, request: MarkReadRequest) {
  const filter = 'all' in request ? {} : { _id: { $in: request.ids } };
  const r = await repo.notifications.updateMany(
    { ...filter, userId: actor.userId, readAt: null },
    { $set: { readAt: now } },
  );
  return { updated: r.modifiedCount, unread: await unreadCount(repo, actor.userId) };
}
