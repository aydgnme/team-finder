import { useQuery } from '@tanstack/react-query';
import { errorCode, api, toErrorMessage } from '../lib/api.ts';
import { formatDay, formatRange } from '../lib/format.ts';

const STATUS_TEXT = { active: 'Active', proposed: 'Pending approval', draft: 'Draft' } as const;
const STATUS_ICON = { active: '✓', proposed: '◌', draft: '+' } as const;

/**
 * Read-only share page (#/s/:id). Works without a session: demo snapshots are public, and they
 * outlive the sandbox they came from. Everything shown was rebuilt by the server.
 */
export function SnapshotPage({ id }: { id: string }) {
  const snap = useQuery({ queryKey: ['snapshot', id], queryFn: () => api.snapshot(id), retry: false });

  if (snap.isPending) return <main className="fullscreen" aria-busy="true" />;
  if (snap.isError) {
    const gone = errorCode(snap.error) === 'NOT_FOUND';
    return (
      <main className="fullscreen snapshot-missing" data-testid="snapshot-missing">
        <h1>{gone ? 'This snapshot has expired' : 'This snapshot is not available'}</h1>
        <p className="muted">
          {gone ? 'Demo snapshots last 30 days. The live demo is one click away.' : toErrorMessage(snap.error)}
        </p>
        <a className="btn btn-primary" href="#/">
          Try the live demo
        </a>
      </main>
    );
  }

  const s = snap.data;
  return (
    <div className="app snapshot">
      <header className="topbar">
        <p className="crumbs" data-testid="snapshot-header">
          <span className="brand">Team Finder</span> <span aria-hidden="true">▸</span> Snapshot ·{' '}
          {formatDay(s.createdAt.slice(0, 10))} · read-only
        </p>
        <h1 className="goal goal-verdict" data-testid="snapshot-verdict">
          <span className="sr-only">{s.project.name}: </span>
          {s.sentence}
        </h1>
        <p className="muted">
          {s.orgName} · {s.project.name} ·{' '}
          <span className="mono">{formatRange(s.project.startDate, s.project.deadline)}</span>
          {s.missingSkills.length > 0 ? ` · ${s.missingSkills.join(', ')} not covered` : ' · all skills covered'}
        </p>
      </header>
      <main className="canvas snapshot-body">
        <section className="slots" aria-label="Role slots">
          {s.slots.map((slot) => (
            <div className="role-row" key={slot.roleName}>
              <h3 className="role-name">{slot.roleName}</h3>
              <div className="role-slots">
                {Array.from({ length: Math.max(slot.count, slot.members.length) }, (_, i) => {
                  const m = slot.members[i];
                  const state = m ? (m.status === 'proposed' ? 'pending' : m.status) : 'empty';
                  return (
                    <div
                      key={i}
                      className={`slot slot-${state}`}
                      data-testid={`snapshot-slot-${slot.roleName}-${i + 1}`}
                    >
                      {m ? (
                        <>
                          <span className="slot-icon" aria-hidden="true">
                            {STATUS_ICON[m.status]}
                          </span>
                          <span className="slot-body">
                            <span className="slot-name">{m.name}</span>
                            <span className="slot-meta mono">{m.hoursPerDay} h/day</span>
                            <span className={`slot-status slot-status-${state}`}>{STATUS_TEXT[m.status]}</span>
                          </span>
                        </>
                      ) : (
                        <span className="slot-empty muted">Open slot</span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </section>
        <aside className="sidebar snapshot-cta">
          <p>Explore this decision yourself: drag the start date, fork the team and watch the verdict change.</p>
          <a className="btn btn-primary" href="#/">
            Try the live demo
          </a>
          <p className="muted">Link valid until {formatDay(s.expiresAt.slice(0, 10))}.</p>
        </aside>
      </main>
    </div>
  );
}
