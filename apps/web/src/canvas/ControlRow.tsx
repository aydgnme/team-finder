import { addDays, type Day, type ProjectBoard } from '@team-finder/domain';
import { useState } from 'react';
import { formatDay } from '../lib/format.ts';
import { storage } from '../lib/route.ts';
import type { Draft } from './draft.ts';
import { Scrubber } from './Scrubber.tsx';

const COACH_KEY = 'tf.coach.scrub.dismissed';

/**
 * One control row under the goal line (design.md, /autoplan #2 Pass 1): fork, start scrubber and
 * the draft's actions. The baseline is always the current team; the draft is the only fork.
 */
export function ControlRow({
  board,
  draft,
  dirty,
  start,
  stale,
  shareUrl,
  committing,
  sharing,
  onFork,
  onDiscard,
  onScrub,
  onCommit,
  onShare,
}: {
  board: ProjectBoard;
  draft: Draft | null;
  dirty: boolean;
  start: Day;
  stale: boolean;
  shareUrl: string | null;
  committing: boolean;
  sharing: boolean;
  onFork: () => void;
  onDiscard: () => void;
  onScrub: (start: Day) => void;
  onCommit: () => void;
  onShare: () => void;
}) {
  const [coachOpen, setCoachOpen] = useState(() => storage.get(COACH_KEY) !== '1');
  const dismissCoach = () => {
    storage.set(COACH_KEY, '1');
    setCoachOpen(false);
  };
  const scrub = board.scrub;
  const n = draft?.additions.length ?? 0;
  const moved = draft !== null && draft.start !== board.project.startDate;
  const commitLabel =
    n === 0 ? 'Move start' : `${moved ? 'Move start and send' : 'Send'} ${n} proposal${n === 1 ? '' : 's'}`;
  const hintDay = scrub ? addDays(scrub.from, 14) : null;

  return (
    <div className="control-row" data-testid="control-row">
      <div className="fork" role="group" aria-label="Scenario">
        {draft ? (
          <>
            <span className="fork-tab">Current</span>
            <span className="fork-tab fork-tab-active" aria-current="true">
              Draft
            </span>
          </>
        ) : (
          <button type="button" className="btn btn-small" onClick={onFork}>
            Fork to compare
          </button>
        )}
      </div>
      {scrub && scrub.to && (
        <Scrubber
          range={{ from: scrub.from, to: scrub.to }}
          base={board.project.startDate}
          value={start}
          stale={stale}
          onChange={(s) => {
            if (coachOpen) dismissCoach();
            onScrub(s);
          }}
        />
      )}
      {draft && (
        <div className="draft-actions">
          <button type="button" className="btn btn-small btn-ghost" onClick={onDiscard}>
            Discard draft
          </button>
          <button type="button" className="btn btn-small" disabled={!dirty || sharing} onClick={onShare}>
            {sharing ? 'Sharing…' : 'Share'}
          </button>
          <button
            type="button"
            className="btn btn-small btn-primary"
            disabled={!dirty || committing}
            aria-busy={committing}
            onClick={onCommit}
          >
            {committing ? 'Sending…' : commitLabel}
          </button>
        </div>
      )}
      {shareUrl && (
        <label className="share-link">
          <span className="muted">Read-only link</span>
          <input
            readOnly
            className="mono"
            value={shareUrl}
            data-testid="share-link"
            onFocus={(e) => e.target.select()}
          />
        </label>
      )}
      {coachOpen && scrub && !draft && hintDay && (
        <div className="coach coach-inline" role="note" data-testid="coach-scrub">
          <p>
            What if {board.project.name} started later? Drag the start to <strong>{formatDay(hintDay)}</strong> and
            watch who becomes available.
          </p>
          <button type="button" className="btn btn-ghost btn-small" onClick={dismissCoach}>
            Got it
          </button>
        </div>
      )}
    </div>
  );
}
