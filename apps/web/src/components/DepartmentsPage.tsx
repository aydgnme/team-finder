import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DepartmentView, DepartmentsResponse, SessionInfo } from '@team-finder/domain';
import { useState } from 'react';
import { api, toErrorMessage } from '../lib/api.ts';
import { useAnnounce } from '../lib/announce.tsx';
import { href } from '../lib/route.ts';
import { OrgTabs } from './OrgTabs.tsx';

// Department-01..03 (M3a). Admins create, rename and delete departments and pick managers;
// admins and a department's manager move people in and out. Moving someone re-routes their
// pending approvals to their new manager.

export function DepartmentsPage({ session }: { session: SessionInfo }) {
  const queryClient = useQueryClient();
  const announce = useAnnounce();
  const depts = useQuery({ queryKey: ['departments'], queryFn: api.departments });
  const [name, setName] = useState('');
  const create = useMutation({
    mutationFn: () => api.createDepartment(name),
    onSuccess: () => {
      announce(`Department "${name}" created.`);
      setName('');
      void queryClient.invalidateQueries({ queryKey: ['departments'] });
    },
  });
  const data = depts.data;
  return (
    <>
      <header className="topbar">
        <p className="crumbs">
          <span className="brand">Team Finder</span> <span aria-hidden="true">▸</span> Organization
        </p>
        <h1 className="goal">{session.org.name}</h1>
        <OrgTabs />
      </header>
      <main className="org-page">
        {depts.isError && <p role="alert">{toErrorMessage(depts.error)}</p>}
        {data?.departments.map((d) => (
          <DepartmentCard key={d.id} dept={d} data={data} />
        ))}
        {data && data.departments.length === 0 && <p className="muted">No departments yet.</p>}
        {data?.canManage && (
          <form
            className="team-role-add org-section"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim().length >= 2) create.mutate();
            }}
          >
            <input
              aria-label="New department"
              placeholder="New department"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <button type="submit" className="btn btn-small" disabled={create.isPending || name.trim().length < 2}>
              Add department
            </button>
            {create.isError && (
              <p role="alert" className="inline-error">
                {toErrorMessage(create.error)}
              </p>
            )}
          </form>
        )}
        {data && data.unassigned.length > 0 && (
          <section className="org-section" aria-labelledby="unassigned-title">
            <h2 id="unassigned-title">Not in a department</h2>
            <p className="muted">They cannot be proposed for projects until they have a department with a manager.</p>
            <ul className="plain-list" data-testid="unassigned">
              {data.unassigned.map((u) => (
                <li key={u.id}>
                  {u.name} <span className="muted">{u.title}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>
    </>
  );
}

function DepartmentCard({ dept: d, data }: { dept: DepartmentView; data: DepartmentsResponse }) {
  const queryClient = useQueryClient();
  const announce = useAnnounce();
  const [rename, setRename] = useState<string | null>(null);
  const done = (text: string) => {
    announce(text);
    void queryClient.invalidateQueries({ queryKey: ['departments'] });
    void queryClient.invalidateQueries({ queryKey: ['approvals'] });
    void queryClient.invalidateQueries({ queryKey: ['members'] });
  };
  const act = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
  });
  const run = (fn: () => Promise<unknown>, text: string) => act.mutate(fn, { onSuccess: () => done(text) });
  // Admins can move anyone in; a manager takes people from the unassigned list.
  const addable = data.canManage
    ? [...data.unassigned, ...data.departments.filter((x) => x.id !== d.id).flatMap((x) => x.members)]
    : data.unassigned;
  const managerChoices = d.manager ? [d.manager, ...data.managerCandidates] : data.managerCandidates;

  return (
    <section className="org-section dept" aria-labelledby={`dept-${d.id}`} data-testid={`dept-${d.name}`}>
      <div className="dept-head">
        {rename === null ? (
          <h2 id={`dept-${d.id}`}>{d.name}</h2>
        ) : (
          <form
            className="team-role-edit"
            onSubmit={(e) => {
              e.preventDefault();
              run(() => api.renameDepartment(d.id, rename), `Renamed to ${rename}.`);
              setRename(null);
            }}
          >
            <input
              aria-label={`Rename ${d.name}`}
              value={rename}
              autoFocus
              onChange={(e) => setRename(e.target.value)}
            />
            <button type="submit" className="btn btn-small">
              Save
            </button>
          </form>
        )}
        {d.canManageMembers && rename === null && (
          <>
            <a className="btn btn-small btn-ghost" href={href.departmentProjects(d.id)}>
              Projects
            </a>
            <a
              className="btn btn-small btn-ghost"
              href={href.departmentStats(d.id)}
              aria-label={`Skill stats for ${d.name}`}
            >
              Stats
            </a>
          </>
        )}
        {data.canManage && rename === null && (
          <span className="team-role-actions">
            <button type="button" className="btn btn-small btn-ghost" onClick={() => setRename(d.name)}>
              Rename
            </button>
            <button
              type="button"
              className="btn btn-small btn-ghost"
              disabled={d.members.length > 0}
              title={d.members.length > 0 ? 'Move its members out first' : undefined}
              onClick={() => run(() => api.deleteDepartment(d.id), `${d.name} deleted.`)}
            >
              Delete
            </button>
          </span>
        )}
      </div>
      <p className="dept-manager">
        Manager:{' '}
        {data.canManage ? (
          <select
            aria-label={`Manager of ${d.name}`}
            value={d.manager?.id ?? ''}
            onChange={(e) => {
              // Read the choice now: the mutation runs after React resets this controlled select.
              const managerId = e.target.value || null;
              run(() => api.setManager(d.id, managerId), `Manager of ${d.name} updated.`);
            }}
          >
            <option value="">No manager</option>
            {managerChoices.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        ) : (
          <strong>{d.manager?.name ?? 'none'}</strong>
        )}
        {!d.manager && <span className="muted"> · nobody here can be proposed until it has one</span>}
      </p>
      <ul className="plain-list">
        {d.members.map((m) => (
          <li key={m.id} className="team-role">
            {d.canManageMembers ? (
              <a className="team-role-name" href={href.person(m.id)}>
                {m.name}
              </a>
            ) : (
              <span className="team-role-name">{m.name}</span>
            )}
            <span className="muted">{m.title}</span>
            {d.canManageMembers && (
              <span className="team-role-actions">
                <button
                  type="button"
                  className="btn btn-small btn-ghost"
                  aria-label={`Remove ${m.name} from ${d.name}`}
                  onClick={() => run(() => api.removeMember(d.id, m.id), `${m.name} left ${d.name}.`)}
                >
                  Remove
                </button>
              </span>
            )}
          </li>
        ))}
      </ul>
      {d.canManageMembers && addable.length > 0 && (
        <select
          aria-label={`Add someone to ${d.name}`}
          value=""
          onChange={(e) => {
            const person = addable.find((u) => u.id === e.target.value);
            if (person) run(() => api.addMember(d.id, person.id), `${person.name} joined ${d.name}.`);
          }}
        >
          <option value="">Add someone…</option>
          {addable.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </select>
      )}
      {act.isError && (
        <p role="alert" className="inline-error">
          {toErrorMessage(act.error)}
        </p>
      )}
    </section>
  );
}
