import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AccessRole, Member, SessionInfo, TeamRoleView } from '@team-finder/domain';
import { useState } from 'react';
import { api, toErrorMessage } from '../lib/api.ts';
import { useAnnounce } from '../lib/announce.tsx';
import { href } from '../lib/route.ts';

// Organization screen (Auth-02, Role-01, Role-02). Everyone sees members and team roles; admins
// also get the invite link, role checkboxes and team-role editing. The server enforces all of it.

const GRANTABLE: { role: AccessRole; label: string }[] = [
  { role: 'projectManager', label: 'Project manager' },
  { role: 'deptManager', label: 'Department manager' },
  { role: 'admin', label: 'Admin' },
];

export function OrgPage({ session }: { session: SessionInfo }) {
  const isAdmin = session.user.roles.includes('admin');
  return (
    <>
      <header className="topbar">
        <p className="crumbs">
          <span className="brand">Team Finder</span> <span aria-hidden="true">▸</span> Organization
        </p>
        <h1 className="goal" data-testid="org-title">
          {session.org.name}
        </h1>
      </header>
      <main className="org-page">
        {!session.landingProjectId && (
          <p className="note" data-testid="no-projects">
            No projects yet. Project setup is the next milestone; until then you can invite people and set up roles
            here, or explore staffing in the <a href="#/">demo</a>.
          </p>
        )}
        {isAdmin && <InviteSection />}
        <MembersSection session={session} isAdmin={isAdmin} />
        <TeamRolesSection isAdmin={isAdmin} />
      </main>
    </>
  );
}

function InviteSection() {
  const queryClient = useQueryClient();
  const announce = useAnnounce();
  const org = useQuery({ queryKey: ['org'], queryFn: api.org });
  const regenerate = useMutation({
    mutationFn: api.regenerateInvite,
    onSuccess: (o) => {
      queryClient.setQueryData(['org'], o);
      announce('New invite link created. The old link no longer works.');
    },
    onError: (e) => announce(toErrorMessage(e), 'error'),
  });
  if (!org.data) return null;
  const link = org.data.inviteToken ? `${location.origin}${location.pathname}${href.join(org.data.inviteToken)}` : null;
  return (
    <section className="org-section" aria-labelledby="invite-title">
      <h2 id="invite-title">Invite people</h2>
      {link ? (
        <>
          <p className="muted">Anyone with this link can join as an employee. Replace it to revoke it.</p>
          <div className="invite-row">
            <input
              readOnly
              className="mono"
              value={link}
              aria-label="Invite link"
              data-testid="invite-link"
              onFocus={(e) => e.target.select()}
            />
            <button
              type="button"
              className="btn btn-small"
              onClick={() => {
                void navigator.clipboard?.writeText(link).then(
                  () => announce('Invite link copied.'),
                  () => announce('Copy the link from the field.'),
                );
              }}
            >
              Copy
            </button>
            <button
              type="button"
              className="btn btn-small btn-ghost"
              disabled={regenerate.isPending}
              onClick={() => regenerate.mutate()}
            >
              {regenerate.isPending ? 'Replacing…' : 'Replace link'}
            </button>
          </div>
        </>
      ) : (
        <p className="muted">Invites are off in the demo sandbox. Create your own organization to invite people.</p>
      )}
    </section>
  );
}

function MembersSection({ session, isAdmin }: { session: SessionInfo; isAdmin: boolean }) {
  const members = useQuery({ queryKey: ['members'], queryFn: api.members });
  return (
    <section className="org-section" aria-labelledby="members-title">
      <h2 id="members-title">Members</h2>
      {members.isError && <p role="alert">{toErrorMessage(members.error)}</p>}
      {members.data && (
        <table className="members" data-testid="members">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Department</th>
              <th scope="col">Access roles</th>
            </tr>
          </thead>
          <tbody>
            {members.data.members.map((m) => (
              <MemberRow key={m.id} member={m} isAdmin={isAdmin} isSelf={m.id === session.user.id} />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function MemberRow({ member, isAdmin, isSelf }: { member: Member; isAdmin: boolean; isSelf: boolean }) {
  const queryClient = useQueryClient();
  const announce = useAnnounce();
  const [error, setError] = useState<string | null>(null);
  // Optimistic: the box flips at once; a refusal (e.g. the last admin) puts it back with the reason.
  const [pending, setPending] = useState<AccessRole[] | null>(null);
  const roles = pending ?? member.roles;
  const save = useMutation({
    mutationFn: (next: AccessRole[]) => api.setRoles(member.id, next),
    onSuccess: async () => {
      setError(null);
      announce(`Roles updated for ${member.name}.`);
      await queryClient.invalidateQueries({ queryKey: ['members'] });
      if (isSelf) await queryClient.invalidateQueries({ queryKey: ['session'] });
      setPending(null);
    },
    onError: (e) => {
      setPending(null);
      setError(toErrorMessage(e));
    },
  });
  const toggle = (role: AccessRole, on: boolean) => {
    const next = on ? [...roles, role] : roles.filter((r) => r !== role);
    setPending(next);
    save.mutate(next);
  };

  return (
    <tr data-testid={`member-${member.name}`}>
      <th scope="row">
        <span className="member-name">{member.name}</span>
        <span className="muted member-email">{member.email}</span>
      </th>
      <td>{member.departmentName ?? <span className="muted">Unassigned</span>}</td>
      <td>
        {isAdmin ? (
          <fieldset className="role-boxes" disabled={save.isPending}>
            <legend className="sr-only">Access roles for {member.name}</legend>
            {GRANTABLE.map(({ role, label }) => (
              <label key={role} className="check">
                <input
                  type="checkbox"
                  checked={roles.includes(role)}
                  onChange={(e) => toggle(role, e.target.checked)}
                />
                {label}
              </label>
            ))}
          </fieldset>
        ) : (
          <span>
            {GRANTABLE.filter(({ role }) => member.roles.includes(role))
              .map(({ label }) => label)
              .join(', ') || 'Employee'}
          </span>
        )}
        {error && (
          <p role="alert" className="inline-error">
            {error}
          </p>
        )}
      </td>
    </tr>
  );
}

function TeamRolesSection({ isAdmin }: { isAdmin: boolean }) {
  const queryClient = useQueryClient();
  const announce = useAnnounce();
  const roles = useQuery({ queryKey: ['team-roles'], queryFn: api.teamRoles });
  const [name, setName] = useState('');
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['team-roles'] });
  const create = useMutation({
    mutationFn: () => api.createTeamRole(name),
    onSuccess: (r) => {
      setName('');
      announce(`Team role "${r.name}" added.`);
      refresh();
    },
  });
  return (
    <section className="org-section" aria-labelledby="team-roles-title">
      <h2 id="team-roles-title">Team roles</h2>
      <p className="muted">The roles a project team is made of (Backend Developer, QA Engineer…).</p>
      <ul className="team-roles" data-testid="team-roles">
        {roles.data?.teamRoles.map((r) => (
          <TeamRoleRow key={r.id} role={r} isAdmin={isAdmin} onChanged={refresh} />
        ))}
      </ul>
      {isAdmin && (
        <form
          className="team-role-add"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim().length >= 2) create.mutate();
          }}
        >
          <input
            aria-label="New team role"
            placeholder="New team role"
            value={name}
            maxLength={60}
            onChange={(e) => setName(e.target.value)}
          />
          <button type="submit" className="btn btn-small" disabled={create.isPending || name.trim().length < 2}>
            Add
          </button>
          {create.isError && (
            <p role="alert" className="inline-error">
              {toErrorMessage(create.error)}
            </p>
          )}
        </form>
      )}
    </section>
  );
}

function TeamRoleRow({ role, isAdmin, onChanged }: { role: TeamRoleView; isAdmin: boolean; onChanged: () => void }) {
  const announce = useAnnounce();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(role.name);
  const rename = useMutation({
    mutationFn: () => api.renameTeamRole(role.id, name),
    onSuccess: () => {
      setEditing(false);
      onChanged();
    },
  });
  const remove = useMutation({
    mutationFn: () => api.deleteTeamRole(role.id),
    onSuccess: () => {
      announce(`Team role "${role.name}" deleted.`);
      onChanged();
    },
  });
  const error = rename.error ?? remove.error;
  return (
    <li className="team-role" data-testid={`team-role-${role.name}`}>
      {editing ? (
        <form
          className="team-role-edit"
          onSubmit={(e) => {
            e.preventDefault();
            rename.mutate();
          }}
        >
          <input
            aria-label={`Rename ${role.name}`}
            value={name}
            maxLength={60}
            autoFocus
            onChange={(e) => setName(e.target.value)}
          />
          <button type="submit" className="btn btn-small">
            Save
          </button>
          <button type="button" className="btn btn-small btn-ghost" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </form>
      ) : (
        <>
          <span className="team-role-name">{role.name}</span>
          {role.inUse && <span className="muted team-role-use">in use</span>}
          {isAdmin && (
            <span className="team-role-actions">
              <button type="button" className="btn btn-small btn-ghost" onClick={() => setEditing(true)}>
                Rename
              </button>
              <button
                type="button"
                className="btn btn-small btn-ghost"
                disabled={role.inUse || remove.isPending}
                title={role.inUse ? 'Used by a project or an assignment' : undefined}
                onClick={() => remove.mutate()}
              >
                Delete
              </button>
            </span>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="inline-error">
          {toErrorMessage(error)}
        </p>
      )}
    </li>
  );
}
