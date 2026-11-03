import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { ApprovalsInbox } from './approvals/ApprovalsInbox.tsx';
import { Canvas } from './canvas/Canvas.tsx';
import { Dock } from './components/Dock.tsx';
import { NotConfiguredScreen, SessionEndedModal, SetupScreen, WakingScreen } from './components/Screens.tsx';
import { JoinPage, LoginPage, SignUpPage } from './components/AuthPages.tsx';
import { DepartmentsPage } from './components/DepartmentsPage.tsx';
import { OrgPage } from './components/OrgPage.tsx';
import { ProjectsPage } from './components/ProjectsPage.tsx';
import { SkillsPage } from './components/SkillsPage.tsx';
import { SnapshotPage } from './components/SnapshotPage.tsx';
import { api, errorCode, toErrorMessage } from './lib/api.ts';
import { href, navigate, useRoute } from './lib/route.ts';
import { useServerAwake } from './lib/use-server-awake.ts';
import { setSessionEnded, useSessionEnded } from './lib/session-ended.ts';

export function App() {
  const server = useServerAwake();
  const route = useRoute();
  if (server.state.kind === 'checking') return <main className="fullscreen" aria-busy="true" />;
  if (server.state.kind === 'waking') {
    return <WakingScreen elapsedMs={server.state.elapsedMs} gaveUp={server.state.gaveUp} onRetry={server.retry} />;
  }
  if (server.state.kind === 'notConfigured') return <NotConfiguredScreen />;
  // Shared snapshots need no session: never create a sandbox just to read one.
  if (route.name === 'snapshot') return <SnapshotPage id={route.id} />;
  if (route.name === 'signup') return <SignUpPage />;
  if (route.name === 'login') return <LoginPage />;
  if (route.name === 'join') return <JoinPage token={route.token} />;
  return <DemoApp />;
}

/**
 * The signed-in app. Without a session, `/` still lands in a fresh demo sandbox (no sign-up wall,
 * design premise 2); a real org's member lands on their org's screen.
 */
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

  const signOut = useMutation({
    mutationFn: api.logout,
    onSettled: () => {
      queryClient.removeQueries();
      setSessionEnded(false);
      navigate(href.login());
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
      ) : route.name === 'org' ? (
        <OrgPage session={info} />
      ) : route.name === 'departments' ? (
        <DepartmentsPage session={info} />
      ) : route.name === 'skills' ? (
        <SkillsPage session={info} />
      ) : route.name === 'projects' || !projectId ? (
        <ProjectsPage session={info} />
      ) : (
        <Canvas key={`${projectId}-${info.user.id}`} projectId={projectId} session={info} />
      )}
      <Dock
        session={info}
        onStartOver={() => startDemo.mutate()}
        startingOver={startDemo.isPending}
        onSignOut={() => signOut.mutate()}
      />
      {sessionEnded && (
        <SessionEndedModal
          isDemo={info.org.isDemo}
          onRestart={() => (info.org.isDemo ? startDemo.mutate() : signOut.mutate())}
        />
      )}
    </div>
  );
}
