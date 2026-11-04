import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { describeNotification, type NotificationItem, type SessionInfo } from '@team-finder/domain';
import { api, toErrorMessage } from '../lib/api.ts';
import { useAnnounce } from '../lib/announce.tsx';
import { href } from '../lib/route.ts';

// Notification-01: the caller's inbox, newest first. Each row links to where it is acted on;
// following a link marks it read.

function target(n: NotificationItem): { to: string; label: string } {
  switch (n.type) {
    case 'assignmentProposed':
    case 'deallocationProposed':
    case 'skillPendingValidation':
      return { to: href.approvals(), label: 'Open approvals' };
    case 'proposalDecided':
      return n.data.projectId
        ? { to: href.project(n.data.projectId), label: `Open ${n.data.projectName ?? 'the project'}` }
        : { to: href.projects(), label: 'Open projects' };
    case 'skillUpgradeProposal':
      return { to: href.skills(), label: 'Open my skills' };
    case 'projectDeleted':
      return { to: href.projects(), label: 'Open projects' };
  }
}

function ago(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(iso).toLocaleDateString('en', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export function useUnreadCount(session: SessionInfo) {
  return useQuery({
    queryKey: ['notifications', 'unread', session.user.id],
    queryFn: api.unreadCount,
    refetchInterval: 30_000,
  });
}

export function InboxPage({ session }: { session: SessionInfo }) {
  const queryClient = useQueryClient();
  const announce = useAnnounce();
  const inbox = useQuery({ queryKey: ['notifications', 'list', session.user.id], queryFn: api.notifications });
  const mark = useMutation({
    mutationFn: api.markRead,
    onSuccess: (r, body) => {
      if ('all' in body) announce('All notifications marked read.');
      queryClient.setQueryData(['notifications', 'unread', session.user.id], { unread: r.unread });
      void queryClient.invalidateQueries({ queryKey: ['notifications', 'list'] });
    },
    onError: (error) => announce(toErrorMessage(error), 'error'),
  });
  const unread = inbox.data?.unread ?? 0;

  return (
    <>
      <header className="topbar">
        <p className="crumbs">
          <span className="brand">Team Finder</span> <span aria-hidden="true">▸</span> Inbox
        </p>
        <h1 className="goal">{unread === 0 ? 'You are all caught up' : `${unread} unread`}</h1>
      </header>
      <main className="org-page inbox-page">
        {inbox.isPending && (
          <div aria-busy="true">
            {[0, 1, 2].map((i) => (
              <div key={i} className="skeleton skeleton-row" />
            ))}
          </div>
        )}
        {inbox.isError && (
          <div role="alert" className="inline-error">
            {toErrorMessage(inbox.error)}{' '}
            <button type="button" className="btn btn-small" onClick={() => void inbox.refetch()}>
              Retry
            </button>
          </div>
        )}
        {inbox.data && inbox.data.items.length === 0 && (
          <p className="empty">Nothing yet. Proposals, decisions and skill claims that need you show up here.</p>
        )}
        {inbox.data && inbox.data.items.length > 0 && (
          <>
            <div className="inbox-actions">
              <button
                type="button"
                className="btn btn-small"
                disabled={unread === 0 || mark.isPending}
                onClick={() => mark.mutate({ all: true })}
              >
                Mark all read
              </button>
            </div>
            <ul className="plain-list notifications" data-testid="notifications">
              {inbox.data.items.map((n) => {
                const t = target(n);
                return (
                  <li key={n.id} className={n.read ? 'notification' : 'notification unread'} data-testid="notification">
                    <span className="notification-dot" aria-hidden="true" />
                    <span className="notification-text">
                      {!n.read && <span className="sr-only">Unread: </span>}
                      {describeNotification(n)}
                      <span className="muted mono notification-time">{ago(n.createdAt)}</span>
                    </span>
                    <a href={t.to} onClick={() => !n.read && mark.mutate({ ids: [n.id] })}>
                      {t.label}
                    </a>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </main>
    </>
  );
}
