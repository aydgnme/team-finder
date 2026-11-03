import { href, useRoute } from '../lib/route.ts';

/** Members · Departments · Skills: the organization screens share one tab row. */
export function OrgTabs() {
  const route = useRoute();
  const tab = (name: 'org' | 'departments' | 'skills', label: string, to: string) => (
    <a href={to} aria-current={route.name === name ? 'page' : undefined}>
      {label}
    </a>
  );
  return (
    <nav className="org-tabs" aria-label="Organization">
      {tab('org', 'Members', href.org())}
      {tab('departments', 'Departments', href.departments())}
      {tab('skills', 'Skills', href.skills())}
    </nav>
  );
}
