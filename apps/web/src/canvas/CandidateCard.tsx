import { useDraggable } from '@dnd-kit/core';
import { loadSummary, type CandidateView, type Interval } from '@team-finder/domain';
import { forwardRef, useState } from 'react';
import { formatDay, reasonText } from '../lib/format.ts';
import { CapacityBar, ScoreBar } from './bars.tsx';

export interface OpenSlot {
  key: string;
  roleId: string;
  label: string;
}

function availabilityLine(c: CandidateView): string {
  const a = c.availability;
  switch (a.kind) {
    case 'available':
      return '8 h/day free';
    case 'partial':
      return `${a.hoursLeft} h/day free`;
    case 'rollingOff':
      return `available from ${formatDay(a.availableFrom)}`;
    case 'unavailable':
      return 'fully booked';
  }
}

/** The capacity bar shows the peak load over the project window (from availableFrom for ghosts). */
export function cardLoad(c: CandidateView, window: Interval) {
  const from = c.availability.kind === 'rollingOff' ? c.availability.availableFrom : window.from;
  return loadSummary(c.timeline, { from, to: window.to });
}

interface Props {
  candidate: CandidateView;
  window: Interval;
  skillName: (id: string) => string;
  canStaff: boolean;
  draggable: boolean;
  openSlots: OpenSlot[];
  onChooseSlot: (slot: OpenSlot) => void;
}

export const CandidateCard = forwardRef<HTMLButtonElement, Props>(function CandidateCard(
  { candidate: c, window, skillName, canStaff, draggable, openSlots, onChooseSlot },
  addRef,
) {
  const [menuOpen, setMenuOpen] = useState(false);
  const blocked = !c.hasApprover;
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: c.userId,
    data: { candidate: c },
    disabled: !canStaff || !draggable || blocked,
  });
  const load = cardLoad(c, window);
  const chips = c.reasons
    .filter((r) => r.kind !== 'skill' || r.level >= 3)
    .sort((a, b) => (a.kind === 'skill' && b.kind === 'skill' ? b.level - a.level : 0))
    .map((r) => reasonText(r, skillName))
    .filter((t): t is string => t !== null)
    .slice(0, 4);
  const ghost = c.availability.kind === 'rollingOff';

  return (
    <li
      ref={setNodeRef}
      className={`card${ghost ? ' card-ghost' : ''}${isDragging ? ' card-dragging' : ''}${blocked ? ' card-blocked' : ''}`}
      data-testid={`candidate-${c.name}`}
      data-flip-key={c.userId}
      data-availability={c.availability.kind}
      aria-label={`${c.name}, ${c.title}, score ${Math.round(c.score)}, ${availabilityLine(c)}`}
      {...(draggable && canStaff && !blocked ? { ...attributes, ...listeners, tabIndex: -1 } : {})}
    >
      <div className="card-head">
        <span className="card-name">{c.name}</span>
        <ScoreBar score={c.score} points={c.points} />
      </div>
      <div className="card-sub">
        <span className="muted">{c.title}</span>
        <span className="card-avail">
          <CapacityBar
            used={load.used}
            pending={load.pending}
            label={`${load.used} of 8 h booked, ${load.pending} h pending`}
          />
          <span className="mono">{availabilityLine(c)}</span>
        </span>
      </div>
      {chips.length > 0 && (
        <ul className="chips" aria-label="Why">
          {chips.map((t) => (
            <li key={t} className={`chip${t.startsWith('No approver') ? ' chip-warn' : ''}`}>
              {t}
            </li>
          ))}
        </ul>
      )}
      {canStaff && !blocked && (
        <div className="card-actions">
          <button
            ref={addRef}
            type="button"
            className="btn btn-small"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => setMenuOpen((o) => !o)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setMenuOpen(false);
            }}
          >
            Add to slot
          </button>
          {menuOpen && (
            <ul className="menu" role="menu" aria-label={`Add ${c.name} to`} onPointerDown={(e) => e.stopPropagation()}>
              {openSlots.length === 0 && <li className="muted menu-empty">No open slots</li>}
              {openSlots.map((s, i) => (
                <li key={s.key} role="none">
                  <button
                    type="button"
                    role="menuitem"
                    autoFocus={i === 0}
                    onClick={() => {
                      setMenuOpen(false);
                      onChooseSlot(s);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') setMenuOpen(false);
                    }}
                  >
                    {s.label}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
});
