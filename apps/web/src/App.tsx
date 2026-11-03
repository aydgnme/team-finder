import { useQuery } from '@tanstack/react-query';
import { fetchHealth } from './api.ts';

export function App() {
  const health = useQuery({ queryKey: ['health'], queryFn: fetchHealth });

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: 24 }}>
      <h1>Team Finder</h1>
      {health.isPending && <p>Checking API…</p>}
      {health.isError && <p role="alert">API unreachable: {health.error.message}</p>}
      {health.isSuccess && (
        <dl data-testid="health">
          <dt>API</dt>
          <dd data-testid="health-status">{health.data.status}</dd>
          <dt>Database</dt>
          <dd data-testid="health-db">{health.data.db}</dd>
          <dt>Cookie round-trip</dt>
          <dd data-testid="health-cookie">{String(health.data.cookieRoundTrip)}</dd>
        </dl>
      )}
      <button type="button" onClick={() => health.refetch()}>
        Check again
      </button>
    </main>
  );
}
