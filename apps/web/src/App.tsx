import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { ApprovalsInbox } from './approvals/ApprovalsInbox.tsx';
import { Canvas } from './canvas/Canvas.tsx';
import { Dock } from './components/Dock.tsx';
import { NotConfiguredScreen, SessionEndedModal, SetupScreen, WakingScreen } from './components/Screens.tsx';
import { api, errorCode, toErrorMessage } from './lib/api.ts';
import { useRoute } from './lib/route.ts';
import { useServerAwake } from './lib/use-server-awake.ts';
import { setSessionEnded, useSessionEnded } from './lib/session-ended.ts';

export function App() {
  const server = useServerAwake();
  if (server.state.kind === 'checking') return <main className="fullscreen" aria-busy="true" />;
  if (server.state.kind === 'waking') {
    return <WakingScreen elapsedMs={server.state.elapsedMs} gaveUp={server.state.gaveUp} onRetry={server.retry} />;
  }
  if (server.state.kind === 'notConfigured') return <NotConfiguredScreen />;
  return <DemoApp />;
}

/** Lands directly on the Atlas canvas: an existing session is reused, otherwise a sandbox is created. */
function DemoApp() {
  const queryClient = useQueryClient();
  const route = useRoute();
  const sessionEnded = useSessionEnded();

  const session = useQuery({ queryKey: ['session'], queryFn: api.session, retry: false, staleTime: Infinity });
  const startDemo = useMutation({
    mutationFn: api.startDemo,
    onSuccess: (info) => {
      queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== 'session' });
      queryClient.setQueryData(['session'], info);
      setSessionEnded(false);
    },
  });

  const needsDemo = session.isError && errorCode(session.error) === 'UNAUTHENTICATED';
  const { isIdle, mutate } = startDemo;
  useEffect(() => {
    if (needsDemo && isIdle) mutate();
  }, [needsDemo, isIdle, mutate]);

  if (session.isPending) return <main className="fullscreen" aria-busy="true" />;
  if (needsDemo || (startDemo.isPending && !session.data)) {
    return (
      <SetupScreen
        error={startDemo.isError ? toErrorMessage(startDemo.error) : null}
        onRetry={() => startDemo.mutate()}
      />
    );
  }
  if (!session.data) {
    return <SetupScreen error={toErrorMessage(session.error)} onRetry={() => void session.refetch()} />;
  }

  const info = session.data;
  const projectId = route.name === 'canvas' ? (route.projectId ?? info.landingProjectId) : null;
  return (
    <div className="app">
      {route.name === 'approvals' ? (
        <ApprovalsInbox session={info} />
      ) : projectId ? (
        <Canvas key={`${projectId}-${info.user.id}`} projectId={projectId} session={info} />
      ) : (
        <main className="fullscreen">No project to show.</main>
      )}
      <Dock session={info} />
      {sessionEnded && <SessionEndedModal onRestart={() => startDemo.mutate()} />}
    </div>
  );
}
