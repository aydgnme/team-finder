import { HOURS_PER_DAY, withProposal, type CandidateView, type Interval } from '@team-finder/domain';
import { useEffect, useMemo, useRef, useState } from 'react';
import { formatDay } from '../lib/format.ts';

export interface ProposalInput {
  hoursPerDay: number;
  from: string;
  roleIds: string[];
  comment: string;
}

export function defaultFrom(c: CandidateView, window: Interval): string {
  return c.availability.kind === 'rollingOff' ? c.availability.availableFrom : window.from;
}

/** Most hours that fit from the default start; the popover pre-fills it so Enter confirms. */
export function defaultHours(c: CandidateView, window: Interval): number {
  const max = withProposal(c.timeline, 1, defaultFrom(c, window), window).maxHours;
  return max > 0 ? max : 1;
}

/** Drop popover: prefilled, Enter confirms, Esc cancels, focus trapped; "More options" collapsed. */
export function ProposePopover({
  candidate,
  roleId,
  roleName,
  roles,
  window,
  onSubmit,
  onCancel,
}: {
  candidate: CandidateView;
  roleId: string;
  roleName: string;
  roles: { id: string; name: string }[];
  window: Interval;
  onSubmit: (input: ProposalInput) => void;
  onCancel: () => void;
}) {
  const [hours, setHours] = useState(() => defaultHours(candidate, window));
  const [from, setFrom] = useState(() => defaultFrom(candidate, window));
  const [extraRoles, setExtraRoles] = useState<string[]>([]);
  const [comment, setComment] = useState('');
  const ref = useRef<HTMLFormElement>(null);
  const firstInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    firstInput.current?.focus();
    firstInput.current?.select();
  }, []);

  const check = useMemo(() => withProposal(candidate.timeline, hours, from, window), [candidate, hours, from, window]);
  const maxInput = check.maxHours > 0 ? Math.max(check.maxHours, 1) : HOURS_PER_DAY;
  const lastDay = window.to;

  return (
    <form
      ref={ref}
      className="popover"
      role="dialog"
      aria-modal="true"
      aria-label={`Propose ${candidate.name} for ${roleName}`}
      data-testid="propose-popover"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ hoursPerDay: hours, from, roleIds: extraRoles, comment });
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onCancel();
        }
        if (e.key === 'Tab' && ref.current) {
          const focusable = [
            ...ref.current.querySelectorAll<HTMLElement>('input, button, textarea, summary, select'),
          ].filter((el) => !el.hasAttribute('disabled'));
          const first = focusable[0];
          const last = focusable.at(-1);
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last?.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first?.focus();
          }
        }
      }}
    >
      <p className="popover-title">
        <strong>{candidate.name}</strong> → {roleName}
      </p>
      <div className="popover-row">
        <label>
          Hours/day
          <input
            ref={firstInput}
            className="mono"
            type="number"
            min={1}
            max={maxInput}
            value={hours}
            onChange={(e) => setHours(Math.max(1, Math.min(HOURS_PER_DAY, Number(e.target.value) || 1)))}
          />
        </label>
        <label>
          Start
          <input
            className="mono"
            type="date"
            min={window.from}
            {...(lastDay ? { max: lastDay } : {})}
            value={from}
            onChange={(e) => e.target.value && setFrom(e.target.value)}
          />
        </label>
      </div>
      <p className={`popover-check ${check.fits ? 'ok' : 'warn'}`} data-testid="propose-check">
        {check.fits
          ? `✓ Fits: ${check.worst.used} h booked at peak, ${check.maxHours - hours} h to spare`
          : `⚠ Exceeds 8 h on ${formatDay(check.worst.date)} (${check.worst.used} h booked). Approval will fail above ${check.maxHours} h.`}
      </p>
      <details className="popover-more">
        <summary>More options</summary>
        <fieldset>
          <legend>Also on the team as</legend>
          {roles
            .filter((r) => r.id !== roleId)
            .map((r) => (
              <label key={r.id} className="check">
                <input
                  type="checkbox"
                  checked={extraRoles.includes(r.id)}
                  onChange={(e) =>
                    setExtraRoles((xs) => (e.target.checked ? [...xs, r.id] : xs.filter((x) => x !== r.id)))
                  }
                />
                {r.name}
              </label>
            ))}
        </fieldset>
        <label>
          Comment for the approver
          <textarea value={comment} maxLength={500} rows={2} onChange={(e) => setComment(e.target.value)} />
        </label>
      </details>
      <div className="popover-actions">
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary">
          Propose <kbd>Enter</kbd>
        </button>
      </div>
    </form>
  );
}
