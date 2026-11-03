import { HOURS_PER_DAY, SCORE_WEIGHTS, type ScoreTerms } from '@team-finder/domain';

/** 8 segments, one per hour: solid = used, striped = pending, accent = this proposal, outlined = free. */
export function CapacityBar({
  used,
  pending,
  proposed = 0,
  label,
}: {
  used: number;
  pending: number;
  proposed?: number;
  label: string;
}) {
  const segments = Array.from({ length: HOURS_PER_DAY }, (_, i) => {
    if (i < used) return 'used';
    if (i < used + proposed) return 'proposed';
    if (i < used + proposed + pending) return 'pending';
    return 'free';
  });
  const over = used + pending + proposed > HOURS_PER_DAY;
  return (
    <span className={`capacity${over ? ' capacity-over' : ''}`} role="img" aria-label={label}>
      {segments.map((kind, i) => (
        <span key={i} className={`seg seg-${kind}`} />
      ))}
    </span>
  );
}

/** Score as a stacked mini-bar (skill / history / availability); numbers on hover and focus. */
export function ScoreBar({ score, points }: { score: number; points: ScoreTerms }) {
  const label =
    `Score ${Math.round(score)}: skill fit ${Math.round(points.skillFit)} of ${SCORE_WEIGHTS.skillFit}, ` +
    `past projects ${Math.round(points.history)} of ${SCORE_WEIGHTS.history}, ` +
    `availability ${Math.round(points.availability)} of ${SCORE_WEIGHTS.availability}`;
  return (
    <span className="score" tabIndex={0} aria-label={label} title={label}>
      <span className="score-num mono">{Math.round(score)}</span>
      <span className="score-bar" aria-hidden="true">
        <span className="score-skill" style={{ width: `${points.skillFit}%` }} />
        <span className="score-history" style={{ width: `${points.history}%` }} />
        <span className="score-avail" style={{ width: `${points.availability}%` }} />
      </span>
      <span className="score-detail mono" aria-hidden="true">
        skill {Math.round(points.skillFit)} · past {Math.round(points.history)} · avail{' '}
        {Math.round(points.availability)}
      </span>
    </span>
  );
}

export function CoverageMeter({
  committed,
  planned,
  missing,
}: {
  committed: number;
  planned: number;
  missing: string[];
}) {
  const pct = Math.round(planned * 100);
  const full = planned >= 1;
  return (
    <div className={`coverage${full ? ' coverage-full' : ''}`} data-testid="coverage">
      <div className="coverage-head">
        <span>Skill coverage</span>
        <span className="mono" data-testid="coverage-pct">
          {pct}%
        </span>
      </div>
      <div
        className="coverage-track"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-label="Required skill coverage"
      >
        <span className="coverage-committed" style={{ width: `${committed * 100}%` }} />
        <span className="coverage-pending" style={{ width: `${Math.max(0, planned - committed) * 100}%` }} />
      </div>
      <p className="coverage-note">
        {full ? 'Fully covered' : `Missing: ${missing.join(', ')}`}
        {planned > committed && <span className="muted"> · striped part is pending approval</span>}
      </p>
    </div>
  );
}
