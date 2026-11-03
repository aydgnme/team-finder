import { useDroppable } from '@dnd-kit/core';
import { withProposal, type BoardAssignment, type CandidateView, type Interval } from '@team-finder/domain';
import type { ReactNode } from 'react';
import { formatDay } from '../lib/format.ts';
import { DRAFT_ID_PREFIX } from './draft.ts';
import { defaultFrom, defaultHours } from './ProposePopover.tsx';

export type SlotState = 'empty' | 'pending' | 'active' | 'conflict' | 'draft' | 'draftConflict';

export function slotState(a: BoardAssignment | undefined): SlotState {
  if (!a) return 'empty';
  if (a.id.startsWith(DRAFT_ID_PREFIX)) return a.check && !a.check.fits ? 'draftConflict' : 'draft';
  if (a.status === 'proposed') return a.check && !a.check.fits ? 'conflict' : 'pending';
  return 'active';
}

const ICON: Record<SlotState, string> = {
  empty: '',
  pending: '◌',
  active: '✓',
  conflict: '⚠',
  draft: '+',
  draftConflict: '⚠',
};

export function Slot({
  slotKey,
  roleId,
  roleName,
  index,
  assignment,
  dragging,
  window,
  error,
  onRemove,
  children,
}: {
  slotKey: string;
  roleId: string;
  roleName: string;
  index: number;
  assignment: BoardAssignment | undefined;
  dragging: CandidateView | null;
  window: Interval;
  error: string | null;
  /** Draft entries can be taken out again. */
  onRemove?: (() => void) | undefined;
  children?: ReactNode;
}) {
  const state = slotState(assignment);
  const { setNodeRef, isOver } = useDroppable({ id: slotKey, data: { roleId }, disabled: state !== 'empty' });
  const preview =
    isOver && dragging
      ? withProposal(dragging.timeline, defaultHours(dragging, window), defaultFrom(dragging, window), window)
      : null;

  return (
    <div
      ref={setNodeRef}
      className={`slot slot-${state}${isOver ? ' slot-over' : ''}${preview && !preview.fits ? ' slot-preview-bad' : ''}${error ? ' slot-error' : ''}`}
      data-testid={`slot-${roleName}-${index + 1}`}
      data-state={state}
    >
      {assignment ? (
        <>
          <span className="slot-icon" aria-hidden="true">
            {ICON[state]}
          </span>
          <span className="slot-body">
            <span className="slot-name">{assignment.userName}</span>
            <span className="slot-meta mono">
              {assignment.hoursPerDay} h/day · from {formatDay(assignment.from)}
            </span>
            <span className={`slot-status slot-status-${state}`}>
              {state === 'active' && 'Active'}
              {state === 'pending' && 'Pending approval'}
              {state === 'conflict' &&
                assignment.check &&
                `Conflict: exceeds 8 h on ${formatDay(assignment.check.worst.date)} (${assignment.check.worst.used} h booked)`}
              {state === 'draft' && 'Draft: fits'}
              {state === 'draftConflict' &&
                assignment.check &&
                `Draft: overbooked from ${formatDay(assignment.check.worst.date)} (${assignment.check.worst.used} h booked)`}
            </span>
          </span>
          {onRemove && (
            <button
              type="button"
              className="btn btn-small btn-ghost slot-remove"
              aria-label={`Remove ${assignment.userName} from the draft`}
              onClick={onRemove}
            >
              Remove
            </button>
          )}
        </>
      ) : preview && dragging ? (
        <span className="slot-body">
          <span className="slot-name">{dragging.name}</span>
          <span className={`slot-status ${preview.fits ? 'slot-status-pending' : 'slot-status-conflict'}`}>
            {preview.fits
              ? `Fits: up to ${preview.maxHours} h/day`
              : `Would exceed 8 h on ${formatDay(preview.worst.date)}`}
          </span>
        </span>
      ) : (
        <span className="slot-empty muted">Open slot{dragging ? ': drop here' : ''}</span>
      )}
      {error && (
        <p className="slot-error-text" role="alert">
          {error}
        </p>
      )}
      {children}
    </div>
  );
}
