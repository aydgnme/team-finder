import { useMutation, useQueryClient } from '@tanstack/react-query';
import { SKILL_LEVELS, type SkillClaimItem } from '@team-finder/domain';
import { useState } from 'react';
import { api, errorCode, toErrorMessage } from '../lib/api.ts';
import { useAnnounce } from '../lib/announce.tsx';

// Skill-04: claims waiting for validation. The department manager sees their people's claims in
// Approvals; admins see claims nobody else can validate on the Organization screen.

const level = (n: number) => `level ${n} (${SKILL_LEVELS[n - 1] ?? '?'})`;

export function SkillClaims({ claims, title }: { claims: SkillClaimItem[]; title: string }) {
  const queryClient = useQueryClient();
  const announce = useAnnounce();
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const decide = useMutation({
    mutationFn: ({ claim, outcome }: { claim: SkillClaimItem; outcome: 'validate' | 'reject' }) =>
      api.decideClaim(claim.userSkillId, claim.version, outcome),
    onSuccess: (_r, { claim, outcome }) => {
      setRowError((e) => Object.fromEntries(Object.entries(e).filter(([id]) => id !== claim.userSkillId)));
      announce(
        outcome === 'validate'
          ? `${claim.user.name}'s ${claim.skill.name} is validated.`
          : claim.previous
            ? `${claim.user.name}'s ${claim.skill.name} stays at level ${claim.previous.level}.`
            : `${claim.user.name}'s ${claim.skill.name} claim was rejected.`,
      );
    },
    onError: (error, { claim }) => {
      const message = toErrorMessage(error);
      setRowError((e) => ({ ...e, [claim.userSkillId]: message }));
      announce(`${claim.user.name}: ${message}`, 'error');
    },
    onSettled: (_r, error) => {
      if (!error || errorCode(error) === 'CONFLICT_STALE' || errorCode(error) === 'NOT_FOUND') {
        void queryClient.invalidateQueries({ queryKey: ['approvals'] });
        void queryClient.invalidateQueries({ queryKey: ['no-approver'] });
      }
      void queryClient.invalidateQueries({ queryKey: ['candidates'] });
    },
  });

  if (claims.length === 0) return null;
  return (
    <section className="org-section" aria-labelledby="skill-claims-title" data-testid="skill-claims">
      <h2 id="skill-claims-title">{title}</h2>
      <p className="muted">Self-assigned skills count for matching only once validated.</p>
      <ul className="plain-list">
        {claims.map((c) => {
          const busy = decide.isPending && decide.variables?.claim.userSkillId === c.userSkillId;
          return (
            <li key={c.userSkillId} className="claim-row" data-testid={`claim-${c.user.name}-${c.skill.name}`}>
              <span>
                <strong>{c.user.name}</strong> · {c.skill.name} ·{' '}
                <span className="mono">
                  {c.previous ? `${level(c.previous.level)}, ${c.previous.experience} → ` : ''}
                  {level(c.level)}, {c.experience}
                </span>
                {c.previous && <span className="muted"> (raise)</span>}
              </span>
              <span className="actions">
                <button
                  type="button"
                  className="btn btn-primary btn-small"
                  disabled={busy}
                  onClick={() => decide.mutate({ claim: c, outcome: 'validate' })}
                  aria-label={`Validate ${c.user.name}'s ${c.skill.name}`}
                >
                  Validate
                </button>
                <button
                  type="button"
                  className="btn btn-small"
                  disabled={busy}
                  onClick={() => decide.mutate({ claim: c, outcome: 'reject' })}
                  aria-label={`Reject ${c.user.name}'s ${c.skill.name}`}
                >
                  Reject
                </button>
              </span>
              {rowError[c.userSkillId] && (
                <p className="row-error" role="alert">
                  {rowError[c.userSkillId]}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
