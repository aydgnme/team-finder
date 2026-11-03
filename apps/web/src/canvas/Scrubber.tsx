import { addDays, daysBetween, formatDelay, type Day, type Interval } from '@team-finder/domain';
import { formatDay } from '../lib/format.ts';

const weekday = (day: Day) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });

/**
 * Start-date scrubber: arrows = 1 day, PageUp/PageDown = 1 week, Home/End = range ends. Keeps the
 * project duration; the canvas re-classifies availability live and re-ranks once it settles.
 */
export function Scrubber({
  range,
  base,
  value,
  stale,
  onChange,
}: {
  range: Interval & { to: Day };
  base: Day;
  value: Day;
  stale: boolean;
  onChange: (start: Day) => void;
}) {
  const max = daysBetween(range.from, range.to);
  const offset = daysBetween(range.from, value);
  const set = (n: number) => onChange(addDays(range.from, Math.max(0, Math.min(max, n))));
  const delay = daysBetween(base, value);
  const later =
    delay === 0
      ? 'current start'
      : formatDelay(delay)
          .replace(/^start /, '')
          .replace('+', '') + ' later';

  return (
    <div className="scrubber">
      <label htmlFor="start-scrubber" className="scrubber-label">
        Start <span className="mono scrubber-value">{`${weekday(value)} ${formatDay(value)}`}</span>
      </label>
      <input
        id="start-scrubber"
        data-testid="start-scrubber"
        type="range"
        min={0}
        max={max}
        step={1}
        value={offset}
        aria-valuetext={`Start ${weekday(value)} ${formatDay(value)}, ${later}`}
        onChange={(e) => set(Number(e.target.value))}
        onKeyDown={(e) => {
          if (e.key === 'PageUp' || e.key === 'PageDown') {
            e.preventDefault();
            set(offset + (e.key === 'PageUp' ? 7 : -7));
          }
        }}
      />
      <span className="mono muted scrubber-hint">{offset === max ? '+6 wk max' : '+6 wk'}</span>
      {stale && (
        <span className="muted scrubber-stale" aria-hidden="true">
          re-ranking…
        </span>
      )}
    </div>
  );
}
