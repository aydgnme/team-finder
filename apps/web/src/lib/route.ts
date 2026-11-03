import { useEffect, useState } from 'react';

export type Route =
  { name: 'canvas'; projectId: string | null } | { name: 'approvals' } | { name: 'snapshot'; id: string };

function parse(hash: string): Route {
  if (hash.startsWith('#/approvals')) return { name: 'approvals' };
  const snap = /^#\/s\/([^/?]+)/.exec(hash);
  if (snap) return { name: 'snapshot', id: decodeURIComponent(snap[1]!) };
  const m = /^#\/projects\/([^/?]+)/.exec(hash);
  return { name: 'canvas', projectId: m ? decodeURIComponent(m[1]!) : null };
}

/** Hash routing: two screens do not justify a router dependency, and deep links still work. */
export function useRoute(): Route {
  const [route, setRoute] = useState(() => parse(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parse(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export const href = {
  canvas: (projectId: string) => `#/projects/${encodeURIComponent(projectId)}`,
  approvals: () => '#/approvals',
  snapshot: (id: string) => `#/s/${encodeURIComponent(id)}`,
};

export function navigate(to: string) {
  if (window.location.hash !== to) window.location.hash = to;
}

/** Best-effort persistence (private mode and blocked storage just forget). */
export const storage = {
  get(key: string): string | null {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string) {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // ignore
    }
  },
};
