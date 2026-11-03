import { useEffect, useState } from 'react';

export type Route =
  | { name: 'canvas'; projectId: string | null }
  | { name: 'approvals' }
  | { name: 'snapshot'; id: string }
  | { name: 'signup' }
  | { name: 'login' }
  | { name: 'join'; token: string }
  | { name: 'org' }
  | { name: 'projects' }
  | { name: 'departments' }
  | { name: 'skills' }
  | { name: 'project'; projectId: string }
  | { name: 'person'; userId: string }
  | { name: 'departmentProjects'; departmentId: string }
  | { name: 'race' }
  | { name: 'inbox' };

/** Screens that work without a session: they must never create a demo sandbox. */
export const PUBLIC_ROUTES = new Set<Route['name']>(['snapshot', 'signup', 'login', 'join']);

function parse(hash: string): Route {
  if (hash.startsWith('#/approvals')) return { name: 'approvals' };
  if (hash.startsWith('#/how-it-works')) return { name: 'race' };
  if (hash.startsWith('#/inbox')) return { name: 'inbox' };
  if (hash.startsWith('#/signup')) return { name: 'signup' };
  if (hash.startsWith('#/login')) return { name: 'login' };
  if (hash.startsWith('#/org')) return { name: 'org' };
  if (hash === '#/projects' || hash === '#/projects/') return { name: 'projects' };
  const deptProjects = /^#\/departments\/([^/?]+)\/projects/.exec(hash);
  if (deptProjects) return { name: 'departmentProjects', departmentId: decodeURIComponent(deptProjects[1]!) };
  if (hash.startsWith('#/departments')) return { name: 'departments' };
  const project = /^#\/project\/([^/?]+)/.exec(hash);
  if (project) return { name: 'project', projectId: decodeURIComponent(project[1]!) };
  const person = /^#\/people\/([^/?]+)/.exec(hash);
  if (person) return { name: 'person', userId: decodeURIComponent(person[1]!) };
  if (hash.startsWith('#/skills')) return { name: 'skills' };
  const join = /^#\/join\/([^/?]+)/.exec(hash);
  if (join) return { name: 'join', token: decodeURIComponent(join[1]!) };
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
  signup: () => '#/signup',
  login: () => '#/login',
  join: (token: string) => `#/join/${encodeURIComponent(token)}`,
  org: () => '#/org',
  race: () => '#/how-it-works',
  inbox: () => '#/inbox',
  projects: () => '#/projects',
  departments: () => '#/departments',
  skills: () => '#/skills',
  project: (id: string) => `#/project/${encodeURIComponent(id)}`,
  person: (id: string) => `#/people/${encodeURIComponent(id)}`,
  departmentProjects: (id: string) => `#/departments/${encodeURIComponent(id)}/projects`,
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
