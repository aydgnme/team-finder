import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  nextStatuses,
  type CreateProjectRequest,
  type ProjectStatus,
  type ProjectSummary,
  type SessionInfo,
} from '@team-finder/domain';
import { useState } from 'react';
import { api, toErrorMessage } from '../lib/api.ts';
import { useAnnounce } from '../lib/announce.tsx';
import { formatRange } from '../lib/format.ts';
import { href } from '../lib/route.ts';

// Project-01 and the lifecycle (M3a). A row opens the staffing canvas; the PM edits, moves the
// status forward and deletes never-active projects. The server enforces every rule shown here.

export const STATUS_LABEL: Record<ProjectStatus, string> = {
  notStarted: 'Not started',
  starting: 'Starting',
  inProgress: 'In progress',
  closing: 'Closing',
  closed: 'Closed',
};

export function ProjectsPage({ session }: { session: SessionInfo }) {
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects });
  const [creating, setCreating] = useState(false);
  const data = projects.data;
  return (
    <>
      <header className="topbar">
        <p className="crumbs">
          <span className="brand">Team Finder</span> <span aria-hidden="true">▸</span> Projects
        </p>
        <h1 className="goal" data-testid="projects-title">
          {session.org.name} projects
        </h1>
      </header>
      <main className="org-page">
        {projects.isError && <p role="alert">{toErrorMessage(projects.error)}</p>}
        <p className="projects-head">
          {data && data.canCreate && !creating && (
            <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
              New project
            </button>
          )}
          <a href={href.person(session.user.id)}>My projects</a>
        </p>
        {creating && <ProjectForm onDone={() => setCreating(false)} />}
        {data && data.projects.length === 0 && (
          <p className="note" data-testid="no-projects">
            No projects yet.{' '}
            {data.canCreate
              ? 'Create the first one to start staffing.'
              : 'A project manager creates them; an admin can give someone that role on the Organization screen.'}
          </p>
        )}
        {data && data.projects.length > 0 && (
          <ul className="project-list" data-testid="projects">
            {data.projects.map((p) => (
              <ProjectRow key={p.id} project={p} />
            ))}
          </ul>
        )}
      </main>
    </>
  );
}

function ProjectRow({ project: p }: { project: ProjectSummary }) {
  const queryClient = useQueryClient();
  const announce = useAnnounce();
  const [editing, setEditing] = useState(false);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['projects'] });
    void queryClient.invalidateQueries({ queryKey: ['board', p.id] });
    void queryClient.invalidateQueries({ queryKey: ['candidates'] });
  };
  const status = useMutation({
    mutationFn: (next: ProjectStatus) => api.setProjectStatus(p.id, next),
    onSuccess: (r) => {
      const c = r.closed;
      announce(
        `${p.name} is now ${STATUS_LABEL[r.project.status].toLowerCase()}.` +
          (c ? ` ${c.ended} assignment${c.ended === 1 ? '' : 's'} ended, ${c.rejected} rejected.` : ''),
      );
      refresh();
    },
  });
  const remove = useMutation({
    mutationFn: () => api.deleteProject(p.id),
    onSuccess: () => {
      announce(`${p.name} deleted.`);
      refresh();
    },
  });
  const next = nextStatuses(p.status);
  const error = status.error ?? remove.error;

  return (
    <li className="project-row" data-testid={`project-${p.name}`}>
      <div className="project-main">
        <a className="project-name" href={href.project(p.id)}>
          {p.name}
        </a>
        <span className={`status status-${p.status}`}>{STATUS_LABEL[p.status]}</span>
        <span className="muted mono">{formatRange(p.startDate, p.deadline)}</span>
        <span className="muted">PM {p.pm.name}</span>
        <span className="mono" title="People holding a slot / slots">
          {p.slots.filled}/{p.slots.total} slots
        </span>
      </div>
      {p.description && <p className="muted project-desc">{p.description}</p>}
      {!editing && (
        <div className="project-actions">
          <a className="btn btn-small" href={href.canvas(p.id)}>
            Staff
          </a>
        </div>
      )}
      {p.canEdit && !editing && (
        <div className="project-actions">
          {p.status !== 'closed' && (
            <button type="button" className="btn btn-small" onClick={() => setEditing(true)}>
              Edit
            </button>
          )}
          {next.length > 0 && (
            <label className="status-move">
              <span className="sr-only">Move {p.name} to</span>
              <select
                value=""
                disabled={status.isPending}
                aria-label={`Move ${p.name} to`}
                onChange={(e) => {
                  const to = e.target.value as ProjectStatus;
                  if (!to) return;
                  if (
                    to === 'closed' &&
                    !confirm(`Close ${p.name}? Started assignments end today; the rest are rejected.`)
                  )
                    return;
                  status.mutate(to);
                }}
              >
                <option value="">Move to…</option>
                {next.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABEL[s]}
                  </option>
                ))}
              </select>
            </label>
          )}
          {!p.everActive && (
            <button
              type="button"
              className="btn btn-small btn-ghost"
              disabled={remove.isPending}
              onClick={() => confirm(`Delete ${p.name} and its proposals? This cannot be undone.`) && remove.mutate()}
            >
              Delete
            </button>
          )}
        </div>
      )}
      {editing && <ProjectForm project={p} onDone={() => setEditing(false)} />}
      {error && (
        <p role="alert" className="inline-error">
          {toErrorMessage(error)}
        </p>
      )}
    </li>
  );
}

type RoleRow = { roleId: string; count: number };

/** Create (no `project`) or edit. Dates are locked while someone is on the team (M3b adds the clamp). */
function ProjectForm({ project, onDone }: { project?: ProjectSummary; onDone: () => void }) {
  const queryClient = useQueryClient();
  const announce = useAnnounce();
  const roles = useQuery({ queryKey: ['team-roles'], queryFn: api.teamRoles });
  const skills = useQuery({ queryKey: ['skills'], queryFn: api.skills });
  const [f, setF] = useState({
    name: project?.name ?? '',
    description: project?.description ?? '',
    period: project?.period ?? ('fixed' as 'fixed' | 'ongoing'),
    startDate: project?.startDate ?? '',
    deadline: project?.deadline ?? '',
    status: 'notStarted' as 'notStarted' | 'starting',
  });
  const [teamRoles, setTeamRoles] = useState<RoleRow[]>(project?.teamRoles ?? []);
  const [techStack, setTechStack] = useState<string[]>(project?.techStack ?? []);
  // Started projects keep their start (it records when work began); the deadline still moves, and
  // the server clamps everyone's assignments, refusing dates that would overbook someone.
  const startLocked = Boolean(project && project.startDate <= new Date().toISOString().slice(0, 10));

  const save = useMutation({
    mutationFn: () => {
      const deadline = f.period === 'ongoing' ? null : f.deadline || null;
      if (project) {
        return api.updateProject(project.id, {
          name: f.name,
          description: f.description,
          teamRoles,
          techStack,
          ...(startLocked ? {} : { startDate: f.startDate }),
          deadline,
        });
      }
      const body: CreateProjectRequest = { ...f, deadline, teamRoles, techStack };
      return api.createProject(body);
    },
    onSuccess: (p) => {
      announce(project ? `${p.name} saved.` : `${p.name} created.`);
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
      void queryClient.invalidateQueries({ queryKey: ['board', p.id] });
      void queryClient.invalidateQueries({ queryKey: ['project-details', p.id] });
      onDone();
    },
  });
  const set = (k: keyof typeof f) => (v: string) => setF((x) => ({ ...x, [k]: v }));
  const unusedRoles = (roles.data?.teamRoles ?? []).filter((r) => !teamRoles.some((t) => t.roleId === r.id));

  return (
    <form
      className="project-form"
      data-testid="project-form"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <label className="field">
        <span>Name</span>
        <input value={f.name} required minLength={2} onChange={(e) => set('name')(e.target.value)} />
      </label>
      <label className="field">
        <span>Description</span>
        <textarea rows={2} value={f.description} onChange={(e) => set('description')(e.target.value)} />
      </label>
      {!project && (
        <div className="form-row">
          <label className="field">
            <span>Period</span>
            <select value={f.period} onChange={(e) => set('period')(e.target.value)}>
              <option value="fixed">Fixed (has a deadline)</option>
              <option value="ongoing">Ongoing</option>
            </select>
          </label>
          <label className="field">
            <span>Status</span>
            <select value={f.status} onChange={(e) => set('status')(e.target.value)}>
              <option value="notStarted">Not started</option>
              <option value="starting">Starting</option>
            </select>
          </label>
        </div>
      )}
      <div className="form-row">
        <label className="field">
          <span>Start</span>
          <input
            type="date"
            required
            value={f.startDate}
            disabled={startLocked}
            onChange={(e) => set('startDate')(e.target.value)}
          />
        </label>
        {f.period === 'fixed' && (
          <label className="field">
            <span>Deadline</span>
            <input type="date" required value={f.deadline} onChange={(e) => set('deadline')(e.target.value)} />
          </label>
        )}
      </div>
      {project && project.slots.filled > 0 && (
        <p className="muted field-hint">
          The team moves with the dates: nobody starts earlier than planned, and full-length assignments follow the
          deadline.
        </p>
      )}
      {startLocked && <p className="muted field-hint">The project has started, so its start date stays.</p>}

      <fieldset className="form-group">
        <legend>Team roles</legend>
        {teamRoles.map((t, i) => (
          <div className="form-row" key={t.roleId}>
            <span className="team-role-name">
              {roles.data?.teamRoles.find((r) => r.id === t.roleId)?.name ?? 'Role'}
            </span>
            <label className="inline-field">
              <span className="sr-only">How many</span>
              <input
                type="number"
                className="mono"
                min={1}
                max={20}
                value={t.count}
                aria-label={`How many ${roles.data?.teamRoles.find((r) => r.id === t.roleId)?.name ?? 'people'}`}
                onChange={(e) =>
                  setTeamRoles((rs) =>
                    rs.map((r, j) => (j === i ? { ...r, count: Math.max(1, Number(e.target.value) || 1) } : r)),
                  )
                }
              />
            </label>
            <button
              type="button"
              className="btn btn-small btn-ghost"
              onClick={() => setTeamRoles((rs) => rs.filter((_, j) => j !== i))}
            >
              Remove
            </button>
          </div>
        ))}
        {unusedRoles.length > 0 && (
          <select
            value=""
            aria-label="Add a team role"
            onChange={(e) => e.target.value && setTeamRoles((rs) => [...rs, { roleId: e.target.value, count: 1 }])}
          >
            <option value="">Add a team role…</option>
            {unusedRoles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        )}
        {roles.data && roles.data.teamRoles.length === 0 && (
          <p className="muted">No team roles yet: an admin adds them on the Organization screen.</p>
        )}
      </fieldset>

      <fieldset className="form-group">
        <legend>Tech stack</legend>
        <div className="check-grid">
          {skills.data?.skills.map((s) => (
            <label key={s.id} className="check">
              <input
                type="checkbox"
                checked={techStack.includes(s.id)}
                onChange={(e) =>
                  setTechStack((xs) => (e.target.checked ? [...xs, s.id] : xs.filter((x) => x !== s.id)))
                }
              />
              {s.name}
            </label>
          ))}
        </div>
        {skills.data && skills.data.skills.length === 0 && (
          <p className="muted">No skills yet: add them on the Skills screen.</p>
        )}
      </fieldset>

      {save.isError && (
        <p role="alert" className="inline-error">
          {toErrorMessage(save.error)}
        </p>
      )}
      <div className="form-actions">
        <button type="button" className="btn btn-ghost" onClick={onDone}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={save.isPending}>
          {save.isPending ? 'Saving…' : project ? 'Save' : 'Create project'}
        </button>
      </div>
    </form>
  );
}
