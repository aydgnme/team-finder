import type { ReactNode } from 'react';

function FullScreen({ title, children, testId }: { title: string; children?: ReactNode; testId: string }) {
  return (
    <main className="fullscreen" data-testid={testId}>
      <div className="fullscreen-box">
        <p className="brand">Team Finder</p>
        <h1>{title}</h1>
        {children}
      </div>
    </main>
  );
}

export function WakingScreen({
  elapsedMs,
  onRetry,
  gaveUp,
}: {
  elapsedMs: number;
  onRetry: () => void;
  gaveUp: boolean;
}) {
  if (gaveUp) {
    return (
      <FullScreen title="Still asleep" testId="waking">
        <p>The free-tier server did not wake up within 30 seconds.</p>
        <button type="button" className="btn btn-primary" onClick={onRetry}>
          Try again
        </button>
      </FullScreen>
    );
  }
  return (
    <FullScreen title="Waking the server" testId="waking">
      <p>
        The API runs on a free tier and sleeps when idle. This usually takes about 10 seconds
        <span className="dots" aria-hidden="true">
          <span>.</span>
          <span>.</span>
          <span>.</span>
        </span>
      </p>
      <p className="muted mono">{Math.round(elapsedMs / 1000)} s</p>
    </FullScreen>
  );
}

export function NotConfiguredScreen() {
  return (
    <FullScreen title="No database configured" testId="not-configured">
      <p>
        The API is running without <code>MONGODB_URI</code>. For a local demo with an in-memory replica set, run{' '}
        <code>pnpm dev:local</code>.
      </p>
    </FullScreen>
  );
}

export function SetupScreen({ error, onRetry }: { error: string | null; onRetry: () => void }) {
  if (error) {
    return (
      <FullScreen title="Couldn't create the demo" testId="setup">
        <p role="alert">{error}</p>
        <button type="button" className="btn btn-primary" onClick={onRetry}>
          Retry
        </button>
      </FullScreen>
    );
  }
  return (
    <FullScreen title="Setting up your sample company" testId="setup">
      <p>Cloning Northwind Labs (10 people, 5 projects) into a private sandbox that lives for 24 hours.</p>
    </FullScreen>
  );
}

export function SessionEndedModal({ isDemo, onRestart }: { isDemo: boolean; onRestart: () => void }) {
  return (
    <div className="modal-backdrop">
      <div className="modal" role="alertdialog" aria-modal="true" aria-labelledby="ended-title">
        <h2 id="ended-title">{isDemo ? 'Your demo session ended' : 'Your session ended'}</h2>
        <p>
          {isDemo
            ? 'Demo sandboxes expire after 24 hours. Start a new one to keep exploring.'
            : 'You were signed out (sessions last 7 days). Sign in again to continue.'}
        </p>
        <button type="button" className="btn btn-primary" onClick={onRestart} autoFocus>
          {isDemo ? 'Start a new demo' : 'Sign in again'}
        </button>
      </div>
    </div>
  );
}
