import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ProjectStatus, type SessionInfo, type TeamMember } from '@team-finder/domain';
import { useState, type ReactNode } from 'react';
import { api, toErrorMessage } from '../lib/api.ts';
import { useAnnounce } from '../lib/announce.tsx';
import { formatDay, formatRange } from '../lib/format.ts';
import { href } from '../lib/route.ts';
import { STATUS_LABEL } from './ProjectsPage.tsx';

// Project-06..09 views (M3b): a project with its team, a person's projects, a department's
// projects. Plain screens (design premise 1); the server decides who may see what.

function Page({
  crumb,
  title,
  testId,
  children,
}: {
  crumb: string;
  title: string;
  testId: string;
  children: ReactNode;
}) {
  return (
    <>
      <header className="topbar">
        <p className="crumbs">
          <span className="brand">Team Finder</span> <span aria-hidden="true">▸</span> {crumb}
        </p>
        <h1 className="goal" data-testid={testId}>
          {title}
        </h1>
      </header>
      <main className="org-page">{children}</main>
    </>
  );
}

const range = (from: string, to: string | null) =>
  to ? `${formatDay(from)} – ${formatDay(to)}` : `from ${formatDay(from)}`;

/** Project-06/09: details, then the team as proposed, active and past; the PM can end assignments. */
export function ProjectPage({ projectId }: { projectId: string }) {
  const details = useQuery({ queryKey: ['project-details', projectId], queryFn: () => api.projectDetails(projectId) });
  if (details.isError) {
    return (
      <Page crumb="Project" title="Project" testId="project-title">
        <p role="alert">{toErrorMessage(details.error)}</p>
      </Page>
    );
  }
  const d = details.data;
  if (!d) return <main className="fullscreen" aria-busy="true" />;
  const p = d.project;
  return (
    <Page crumb={`Projects ▸ ${p.name}`} title={p.name} testId="project-title">
      <p className="project-main">
        <span className={`status status-${p.status}`}>{STATUS_LABEL[p.status]}</span>
        <span className="muted mono">{formatRange(p.startDate, p.deadline)}</span>
        <span className="muted">PM {p.pm.name}</span>
        <a href={href.canvas(p.id)}>Open the staffing canvas</a>
      </p>
      {p.description && <p>{p.description}</p>}
      <p className="muted">
        Team: {d.roles.map((r) => `${r.count} × ${r.name}`).join(', ') || 'no roles yet'} · Tech stack:{' '}
        {d.techStack.map((s) => s.name).join(', ') || 'none'}
      </p>
      <TeamSection title="Active" members={d.team.active} canEnd={p.canEdit} projectId={p.id} testId="team-active" />
      <TeamSection title="Proposed" members={d.team.proposed} canEnd={false} projectId={p.id} testId="team-proposed" />
      <TeamSection title="Past" members={d.team.past} canEnd={false} projectId={p.id} testId="team-past" />
    </Page>
  );
}

function TeamSection({
  title,
  members,
  canEnd,
  projectId,
  testId,
}: {
  title: string;
  members: TeamMember[];
  canEnd: boolean;
  projectId: string;
  testId: string;
}) {
  return (
    <section className="org-section" aria-label={`${title} team`}>
      <h2>{title}</h2>
      {members.length === 0 ? (
        <p className="muted">Nobody.</p>
      ) : (
        <ul className="plain-list" data-testid={testId}>
          {members.map((m) => (
            <TeamRow key={m.assignmentId} member={m} canEnd={canEnd} projectId={projectId} />
          ))}
        </ul>
      )}
    </section>
  );
}

function TeamRow({ member: m, canEnd, projectId }: { member: TeamMember; canEnd: boolean; projectId: string }) {
  const queryClient = useQueryClient();
  const announce = useAnnounce();
  const [reason, setReason] = useState<string | null>(null);
  const end = useMutation({
    mutationFn: () => api.deallocate(m.assignmentId, m.version, reason ?? ''),
    onSuccess: () => {
      announce(`Asked ${m.name}'s manager to end their assignment.`);
      setReason(null);
      void queryClient.invalidateQueries({ queryKey: ['project-details', projectId] });
      void queryClient.invalidateQueries({ queryKey: ['board', projectId] });
    },
  });
  return (
    <li className="team-role" data-testid={`member-${m.name}`}>
      <a className="team-role-name" href={href.person(m.userId)}>
        {m.name}
      </a>
      <span className="muted">{m.roleName}</span>
      <span className="mono">{m.hoursPerDay} h/day</span>
      <span className="muted mono">{range(m.from, m.to)}</span>
      {m.status === 'deallocationProposed' && (
        <span className="status status-closing">Ending: “{m.deallocationReason}”, waiting for their manager</span>
      )}
      {canEnd && m.status === 'active' && reason === null && (
        <span className="team-role-actions">
          <button type="button" className="btn btn-small btn-ghost" onClick={() => setReason('')}>
            End assignment
          </button>
        </span>
      )}
      {reason !== null && (
        <form
          className="team-role-edit"
          onSubmit={(e) => {
            e.preventDefault();
            end.mutate();
          }}
        >
          <input
            aria-label={`Why end ${m.name}'s assignment`}
            placeholder="Why? Their manager will see this"
            value={reason}
            maxLength={500}
            autoFocus
            onChange={(e) => setReason(e.target.value)}
          />
          <button
            type="submit"
            className="btn btn-small btn-primary"
            disabled={reason.trim().length < 3 || end.isPending}
          >
            Ask their manager
          </button>
          <button type="button" className="btn btn-small btn-ghost" onClick={() => setReason(null)}>
            Cancel
          </button>
        </form>
      )}
      {end.isError && (
        <p role="alert" className="inline-error">
          {toErrorMessage(end.error)}
        </p>
      )}
    </li>
  );
}

/** Project-07: someone's current and past projects. */
export function PersonPage({ userId, session }: { userId: string; session: SessionInfo }) {
  const data = useQuery({ queryKey: ['person-projects', userId], queryFn: () => api.personProjects(userId) });
  const self = userId === session.user.id;
  if (data.isError) {
    return (
      <Page crumb="People" title={self ? 'My projects' : 'Projects'} testId="person-title">
        <p role="alert">{toErrorMessage(data.error)}</p>
      </Page>
    );
  }
  const d = data.data;
  if (!d) return <main className="fullscreen" aria-busy="true" />;
  const rows = (list: typeof d.current, testId: string) =>
    list.length === 0 ? (
      <p className="muted">None.</p>
    ) : (
      <ul className="plain-list" data-testid={testId}>
        {list.map((r) => (
          <li key={`${r.projectId}-${r.from}`} className="team-role">
            <a className="team-role-name" href={href.project(r.projectId)}>
              {r.projectName}
            </a>
            <span className="muted">{r.roleName}</span>
            <span className="mono">{r.hoursPerDay} h/day</span>
            <span className="muted mono">{range(r.from, r.to)}</span>
            {r.status !== 'active' && r.status !== 'past' && (
              <span className="status status-starting">{r.status === 'proposed' ? 'Pending approval' : 'Ending'}</span>
            )}
          </li>
        ))}
      </ul>
    );
  return (
    <Page crumb="People" title={self ? 'My projects' : d.person.name} testId="person-title">
      <p className="muted">
        {d.person.title || 'No title'} · {d.person.departmentName ?? 'Not in a department'}
      </p>
      <section className="org-section">
        <h2>Current</h2>
        {rows(d.current, 'person-current')}
      </section>
      <section className="org-section">
        <h2>Past</h2>
        {rows(d.past, 'person-past')}
      </section>
    </Page>
  );
}

/** Project-08: projects that have this department's members, by status. */
export function DepartmentProjectsPage({ departmentId }: { departmentId: string }) {
  const [status, setStatus] = useState('');
  const data = useQuery({
    queryKey: ['department-projects', departmentId, status],
    queryFn: () => api.departmentProjects(departmentId, status || undefined),
  });
  const d = data.data;
  return (
    <Page
      crumb="Departments"
      title={d ? `${d.department.name} projects` : 'Department projects'}
      testId="dept-projects-title"
    >
      <label className="field inline-filter">
        <span>Status</span>
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status">
          <option value="">All</option>
          {ProjectStatus.options.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
      </label>
      {data.isError && <p role="alert">{toErrorMessage(data.error)}</p>}
      {d && d.projects.length === 0 && <p className="muted">No projects with members of {d.department.name}.</p>}
      {d && d.projects.length > 0 && (
        <ul className="project-list" data-testid="dept-projects">
          {d.projects.map((p) => (
            <li key={p.id} className="project-row" data-testid={`dept-project-${p.name}`}>
              <div className="project-main">
                <a className="project-name" href={href.project(p.id)}>
                  {p.name}
                </a>
                <span className={`status status-${p.status}`}>{STATUS_LABEL[p.status]}</span>
                <span className="muted mono">{formatRange(p.startDate, p.deadline)}</span>
                <span className="muted">{p.members.map((m) => m.name).join(', ')}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
}
