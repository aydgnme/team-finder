import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SessionInfo } from '@team-finder/domain';
import { api, toErrorMessage } from '../lib/api.ts';
import { useAnnounce } from '../lib/announce.tsx';
import { coach, useCoach } from '../lib/coach.ts';
import { firstName } from '../lib/format.ts';
import { href, navigate, useRoute } from '../lib/route.ts';

export function useSwitchPersona() {
  const queryClient = useQueryClient();
  const announce = useAnnounce();
  return useMutation({
    mutationFn: api.switchPersona,
    onSuccess: (info) => {
      // New identity: drop every cached answer so nothing stale from the previous persona shows.
      queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== 'session' });
      queryClient.setQueryData(['session'], info);
      announce(`Now viewing as ${info.user.name} (${info.user.title}).`);
    },
    onError: (error) => announce(toErrorMessage(error), 'error'),
  });
}

export function Dock({
  session,
  onStartOver,
  startingOver,
  onSignOut,
}: {
  session: SessionInfo;
  onStartOver: () => void;
  startingOver: boolean;
  onSignOut: () => void;
}) {
  const route = useRoute();
  const step = useCoach();
  const switchPersona = useSwitchPersona();
  const isManager = session.user.roles.includes('deptManager');
  const approvals = useQuery({
    queryKey: ['approvals'],
    queryFn: api.approvals,
    enabled: isManager,
    refetchInterval: 30_000,
  });
  const manager = session.personas.find((p) => p.roles.includes('deptManager'));
  const pending = approvals.data?.items.length;

  return (
    <footer className="dock">
      {session.org.isDemo && session.personas.length > 0 && (
        <label className="persona">
          <span>Viewing as</span>
          <select
            value={session.user.id}
            disabled={switchPersona.isPending}
            onChange={(e) => switchPersona.mutate(e.target.value)}
            aria-label="Viewing as"
          >
            {session.personas.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.title})
              </option>
            ))}
          </select>
        </label>
      )}
      <nav className="dock-nav" aria-label="Screens">
        {session.landingProjectId && (
          <a href={href.canvas(session.landingProjectId)} aria-current={route.name === 'canvas' ? 'page' : undefined}>
            Canvas
          </a>
        )}
        <a href={href.projects()} aria-current={route.name === 'projects' ? 'page' : undefined}>
          Projects
        </a>
        <a href={href.approvals()} aria-current={route.name === 'approvals' ? 'page' : undefined}>
          Approvals{isManager && pending !== undefined ? <span className="badge mono">{pending}</span> : null}
        </a>
        <a href={href.org()} aria-current={['org', 'departments', 'skills'].includes(route.name) ? 'page' : undefined}>
          Organization
        </a>
      </nav>
      <span className="dock-org muted">
        {session.org.name}
        {session.org.isDemo ? ' · private demo sandbox' : ''}
      </span>
      {session.org.isDemo ? (
        <span className="dock-auth">
          <a href={href.signup()}>Create your organization</a>
          <a href={href.login()}>Sign in</a>
          <button
            type="button"
            className="btn btn-small btn-ghost"
            disabled={startingOver}
            title="A fresh copy of the demo: every change you made is discarded"
            onClick={() => {
              navigate('#/');
              onStartOver();
            }}
          >
            {startingOver ? 'Starting over…' : 'Start over'}
          </button>
        </span>
      ) : (
        <span className="dock-auth">
          <span className="muted" data-testid="signed-in-as">
            {session.user.name}
          </span>
          <button type="button" className="btn btn-small btn-ghost" onClick={onSignOut}>
            Sign out
          </button>
        </span>
      )}

      {step === 'switchToManager' && manager && session.user.id !== manager.id && (
        <div className="coach" role="dialog" aria-label="Next step" data-testid="coach-switch">
          <p>
            Proposed. Now approve it as <strong>{firstName(manager.name)}</strong> ({manager.title}).
          </p>
          <div className="coach-actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                coach.dismiss('switchToManager');
                switchPersona.mutate(manager.id, { onSuccess: () => navigate(href.approvals()) });
              }}
            >
              Switch to {firstName(manager.name)}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => coach.dismiss('switchToManager')}>
              Dismiss
            </button>
          </div>
        </div>
      )}
      {step === 'tryConflict' && route.name === 'approvals' && (
        <div className="coach" role="dialog" aria-label="Tip" data-testid="coach-conflict">
          <p>Approve your proposal, then try one marked ⚠: the server re-checks capacity inside the transaction.</p>
          <div className="coach-actions">
            <button type="button" className="btn btn-ghost" onClick={() => coach.dismiss('tryConflict')}>
              Got it
            </button>
          </div>
        </div>
      )}
    </footer>
  );
}
