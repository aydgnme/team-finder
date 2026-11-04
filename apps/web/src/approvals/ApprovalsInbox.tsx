import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ApprovalItem, SessionInfo } from '@team-finder/domain';
import { useEffect, useState } from 'react';
import { api, errorCode, toErrorMessage } from '../lib/api.ts';
import { useAnnounce } from '../lib/announce.tsx';
import { coach } from '../lib/coach.ts';
import { firstName, formatDay } from '../lib/format.ts';
import { href } from '../lib/route.ts';
import { SkillClaims } from '../components/SkillClaims.tsx';

export function ApprovalsInbox({ session }: { session: SessionInfo }) {
  const queryClient = useQueryClient();
  const announce = useAnnounce();
  const isManager = session.user.roles.includes('deptManager');
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [decided, setDecided] = useState<{
    name: string;
    projectId: string;
    projectName: string;
    ending: boolean;
  } | null>(null);
  const approvals = useQuery({ queryKey: ['approvals'], queryFn: api.approvals, enabled: isManager });

  useEffect(() => {
    if (isManager) coach.show('tryConflict');
  }, [isManager]);

  const decide = useMutation({
    mutationFn: ({ item, action }: { item: ApprovalItem; action: 'approve' | 'reject' }) =>
      action === 'approve' ? api.approve(item.assignmentId, item.version) : api.reject(item.assignmentId, item.version),
    onSuccess: (_v, { item, action }) => {
      setRowError((e) => Object.fromEntries(Object.entries(e).filter(([id]) => id !== item.assignmentId)));
      const ending = item.kind === 'deallocation';
      if (action === 'approve') {
        setDecided({ name: item.user.name, projectId: item.project.id, projectName: item.project.name, ending });
        announce(
          ending
            ? `${item.user.name} leaves ${item.project.name}.`
            : `${item.user.name} added to ${item.project.name}.`,
        );
      } else {
        announce(
          ending ? `${item.user.name} stays on ${item.project.name}.` : `Proposal for ${item.user.name} rejected.`,
        );
      }
    },
    onError: (error, { item }) => {
      const message = toErrorMessage(error);
      setRowError((e) => ({ ...e, [item.assignmentId]: message }));
      announce(`${item.user.name}: ${message}`, 'error');
    },
    onSettled: (_v, error) => {
      void queryClient.invalidateQueries({ queryKey: ['board'] });
      void queryClient.invalidateQueries({ queryKey: ['candidates'] });
      // On a stale decision, refetch to show the true state; on success the row slides out.
      if (!error || errorCode(error) === 'CONFLICT_STALE' || errorCode(error) === 'FORBIDDEN') {
        void queryClient.invalidateQueries({ queryKey: ['approvals'] });
      }
    },
  });

  return (
    <>
      <header className="topbar">
        <p className="crumbs">
          <span className="brand">Team Finder</span> <span aria-hidden="true">▸</span> Approvals
        </p>
        <h1 className="goal">
          {isManager ? `Proposals for ${firstName(session.user.name)}'s department` : 'Approvals'}
        </h1>
      </header>
      <main className="inbox">
        {decided && (
          <p className="success" role="status" data-testid="approved-banner">
            ✓ {decided.name} {decided.ending ? 'leaves' : 'added to'} {decided.projectName}.{' '}
            <a href={href.canvas(decided.projectId)}>View the {decided.projectName} canvas</a>
          </p>
        )}
        {!isManager && (
          <p className="empty">
            Only department managers approve proposals. Switch to the Dept Manager persona in the bar below.
          </p>
        )}
        {isManager && approvals.isPending && (
          <div aria-busy="true">
            {[0, 1, 2].map((i) => (
              <div key={i} className="skeleton skeleton-row" />
            ))}
          </div>
        )}
        {approvals.isError && (
          <div role="alert" className="inline-error">
            {toErrorMessage(approvals.error)}{' '}
            <button type="button" className="btn btn-small" onClick={() => void approvals.refetch()}>
              Retry
            </button>
          </div>
        )}
        {approvals.data && approvals.data.items.length === 0 && approvals.data.skillClaims.length === 0 && (
          <p className="empty">Nothing waiting. Proposals and skill claims for your department show up here.</p>
        )}
        {approvals.data && approvals.data.items.length > 0 && (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Person</th>
                  <th scope="col">Project · role</th>
                  <th scope="col">Hours/day</th>
                  <th scope="col">From</th>
                  <th scope="col">Capacity check</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {approvals.data.items.map((item) => {
                  const busy = decide.isPending && decide.variables?.item.assignmentId === item.assignmentId;
                  return (
                    <tr key={item.assignmentId} data-testid={`approval-${item.user.name}`}>
                      <th scope="row">{item.user.name}</th>
                      <td>
                        {item.kind === 'deallocation' && <strong className="block">Ends their assignment</strong>}
                        {item.project.name} · {item.slotRole.name}
                        {item.reason && <span className="muted block">Reason: “{item.reason}”</span>}
                        {item.comment && <span className="muted block">“{item.comment}”</span>}
                      </td>
                      <td className="mono">{item.hoursPerDay}</td>
                      <td className="mono">{formatDay(item.from)}</td>
                      <td>
                        {!item.check ? (
                          <span className="ok">Frees {item.hoursPerDay} h/day</span>
                        ) : item.check.fits ? (
                          <span className="ok">✓ Fits</span>
                        ) : (
                          <span className="warn">
                            ⚠ {item.check.worst.used} h booked on {formatDay(item.check.worst.date)}, max{' '}
                            {item.check.maxHours} h
                          </span>
                        )}
                        {rowError[item.assignmentId] && (
                          <p className="row-error" role="alert" data-testid="approval-error">
                            {rowError[item.assignmentId]}
                          </p>
                        )}
                      </td>
                      <td>
                        <div className="actions">
                          <button
                            type="button"
                            className="btn btn-primary btn-small"
                            disabled={busy}
                            onClick={() => decide.mutate({ item, action: 'approve' })}
                            aria-label={
                              item.kind === 'deallocation'
                                ? `Approve ending ${item.user.name} on ${item.project.name}`
                                : `Approve ${item.user.name} for ${item.project.name}`
                            }
                          >
                            Approve
                          </button>
                          <button
                            type="button"
                            className="btn btn-small"
                            disabled={busy}
                            onClick={() => decide.mutate({ item, action: 'reject' })}
                            aria-label={
                              item.kind === 'deallocation'
                                ? `Keep ${item.user.name} on ${item.project.name}`
                                : `Reject ${item.user.name} for ${item.project.name}`
                            }
                          >
                            Reject
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {approvals.data && <SkillClaims claims={approvals.data.skillClaims} title="Skills to validate" />}
      </main>
    </>
  );
}
