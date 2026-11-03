import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.ts';

export type ServerState =
  | { kind: 'checking' }
  | { kind: 'waking'; elapsedMs: number; gaveUp: boolean }
  | { kind: 'up' }
  | { kind: 'notConfigured' };

const GIVE_UP_MS = 30_000;
const SHOW_WAKING_AFTER_MS = 800;

/**
 * A sleeping free-tier API makes the SPA host's rewrite time out before anything renders. So the
 * SPA boots first, then polls /api/health with backoff (1 s, 2 s, 4 s... capped) until the database
 * answers, behind the "Waking the server" screen (docs/design.md, Phase 3 eng #2).
 */
export function useServerAwake(): { state: ServerState; retry: () => void } {
  const [state, setState] = useState<ServerState>({ kind: 'checking' });
  const [attempt, setAttempt] = useState(0);
  const cancelled = useRef(false);

  useEffect(() => {
    cancelled.current = false;
    const started = Date.now();
    let delay = 1000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const slow = setTimeout(() => {
      if (!cancelled.current)
        setState((s) => (s.kind === 'checking' ? { kind: 'waking', elapsedMs: 0, gaveUp: false } : s));
    }, SHOW_WAKING_AFTER_MS);

    const poll = async () => {
      try {
        const health = await api.health();
        if (cancelled.current) return;
        if (health.db === 'up') return setState({ kind: 'up' });
        if (health.db === 'not_configured') return setState({ kind: 'notConfigured' });
      } catch {
        // proxy timeout / 502 while the instance boots
      }
      if (cancelled.current) return;
      const elapsedMs = Date.now() - started;
      if (elapsedMs >= GIVE_UP_MS) return setState({ kind: 'waking', elapsedMs, gaveUp: true });
      setState({ kind: 'waking', elapsedMs, gaveUp: false });
      timer = setTimeout(poll, delay);
      delay = Math.min(delay * 2, 8000);
    };
    void poll();
    return () => {
      cancelled.current = true;
      clearTimeout(slow);
      clearTimeout(timer);
    };
  }, [attempt]);

  const retry = useCallback(() => {
    setState({ kind: 'checking' });
    setAttempt((a) => a + 1);
  }, []);
  return { state, retry };
}
