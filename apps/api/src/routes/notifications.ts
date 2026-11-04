import { MarkReadRequest } from '@team-finder/domain';
import type { FastifyInstance } from 'fastify';
import { contextFor, type RequestDeps } from '../http/actor.ts';
import { parse } from '../http/validate.ts';
import { listNotifications, markRead, unreadCount } from '../services/notifications.ts';

/** Notification-01: the caller's own inbox; nobody reads or marks anyone else's. */
export function notificationRoutes(app: FastifyInstance, deps: RequestDeps) {
  app.get('/api/notifications', async (request) => listNotifications(contextFor(request, deps)));
  app.get('/api/notifications/unread-count', async (request) => {
    const ctx = contextFor(request, deps);
    return { unread: await unreadCount(ctx.repo, ctx.actor.userId) };
  });
  app.post('/api/notifications/read', async (request) =>
    markRead(contextFor(request, deps), parse(MarkReadRequest, request.body)),
  );
}
