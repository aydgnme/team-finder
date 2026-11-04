import { z } from 'zod';

// Notification-01 (docs/plans/m4-skills-and-notifications.md). Written in the same transaction as
// the trigger; `data` snapshots display names so a notification still reads after its subject is
// deleted.

const Id = z.string().min(1);

export const NotificationType = z.enum([
  'assignmentProposed',
  'deallocationProposed',
  'proposalDecided',
  'skillPendingValidation',
  'skillUpgradeProposal',
  'projectDeleted',
]);
export type NotificationType = z.infer<typeof NotificationType>;

export const NotificationData = z.object({
  personName: z.string().optional(),
  projectId: Id.optional(),
  projectName: z.string().optional(),
  skillName: z.string().optional(),
  /** proposalDecided: what was decided, and on which kind of request. */
  decision: z.enum(['approved', 'rejected']).optional(),
  kind: z.enum(['proposal', 'deallocation']).optional(),
});
export type NotificationData = z.infer<typeof NotificationData>;

export const NotificationItem = z.object({
  id: Id,
  type: NotificationType,
  refId: Id,
  actor: z.object({ id: Id, name: z.string() }).nullable(),
  data: NotificationData,
  createdAt: z.string(),
  read: z.boolean(),
});
export type NotificationItem = z.infer<typeof NotificationItem>;

export const NotificationsResponse = z.object({ items: z.array(NotificationItem), unread: z.number() });
export type NotificationsResponse = z.infer<typeof NotificationsResponse>;
export const UnreadCountResponse = z.object({ unread: z.number() });
export const MarkReadRequest = z.union([
  z.object({ ids: z.array(Id).min(1).max(100) }),
  z.object({ all: z.literal(true) }),
]);
export type MarkReadRequest = z.infer<typeof MarkReadRequest>;
export const MarkReadResponse = z.object({ updated: z.number(), unread: z.number() });

/** One sentence per notification, shared by the inbox and tests. */
export function describeNotification(n: Pick<NotificationItem, 'type' | 'data' | 'actor'>): string {
  const who = n.actor?.name ?? 'Someone';
  const d = n.data;
  switch (n.type) {
    case 'assignmentProposed':
      return `${who} proposed ${d.personName ?? 'someone'} for ${d.projectName ?? 'a project'}.`;
    case 'deallocationProposed':
      return `${who} asked to end ${d.personName ?? 'someone'}'s assignment on ${d.projectName ?? 'a project'}.`;
    case 'proposalDecided': {
      const what =
        d.kind === 'deallocation' ? `ending ${d.personName ?? 'someone'}'s assignment` : `${d.personName ?? 'someone'}`;
      return `${who} ${d.decision ?? 'decided'} ${what} on ${d.projectName ?? 'a project'}.`;
    }
    case 'skillPendingValidation':
      return `${d.personName ?? 'Someone'} claimed ${d.skillName ?? 'a skill'}; it needs your validation.`;
    case 'skillUpgradeProposal':
      return `Your work on ${d.projectName ?? 'a project'} uses ${d.skillName ?? 'a skill'}: add it to your skills?`;
    case 'projectDeleted':
      return `${who} deleted ${d.projectName ?? 'a project'}; its proposals for your people are gone.`;
  }
}
