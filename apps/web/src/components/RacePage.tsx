import { useMutation } from '@tanstack/react-query';
import type { RaceLane, RaceResult, SessionInfo } from '@team-finder/domain';
import { api, ApiError, errorCode, toErrorMessage } from '../lib/api.ts';
import { useAnnounce } from '../lib/announce.tsx';

// "Watch the race" (M2.5, design.md E2). Runs the real approve() twice at once on the server and
// draws what happened: two swimlanes on one millisecond axis, the barrier as a vertical rule, the
// losing write in red with its real replay. The same timeline is listed as text.

const LABEL: Record<string, string> = {
  start: 'start',
  read: 'read + check',
  released: 'barrier',
  replay: 'replay',
  committed: 'committed',
  refused: 'refused',
};

function Lanes({ result }: { result: RaceResult }) {
  const total = Math.max(result.totalMs, 1);
  const x = (at: number) => `${Math.min(100, (at / total) * 100)}%`;
  const barrier = Math.max(
    ...result.lanes.flatMap((l) => l.events.filter((e) => e.kind === 'released').map((e) => e.at)),
  );
  return (
    <figure className="race-figure" aria-hidden="true">
      <div className="race-lanes">
        <div className="race-overlay">
          <div className="race-barrier" style={{ left: x(barrier) }}>
            <span>barrier</span>
          </div>
        </div>
        {result.lanes.map((l) => (
          <div key={l.lane} className={`race-lane race-${l.outcome}`} data-testid={`lane-${l.lane}`}>
            <span className="race-lane-name">
              {l.lane} · {l.project}
            </span>
            <div className="race-track">
              <div
                className="race-bar"
                style={{ left: x(l.events[0]!.at), width: x(l.events.at(-1)!.at - l.events[0]!.at) }}
              />
              {l.events.map((e, i) => (
                <span
                  key={i}
                  className={`race-mark race-mark-${e.kind}`}
                  style={{ left: x(e.at) }}
                  title={`${LABEL[e.kind]} @${e.at} ms`}
                />
              ))}
            </div>
          </div>
        ))}
        <div className="race-axis mono">
          <span>0 ms</span>
          <span>{result.totalMs.toFixed(0)} ms</span>
        </div>
      </div>
    </figure>
  );
}

const sentence = (l: RaceLane) =>
  `${l.lane} (${l.project}): ` +
  l.events.map((e) => `${LABEL[e.kind]}${e.kind === 'refused' ? ` ${e.detail}` : ''} at ${e.at} ms`).join(', ');

export function RacePage({ session }: { session: SessionInfo }) {
  const announce = useAnnounce();
  const race = useMutation({
    mutationFn: api.race,
    onSuccess: (r) => {
      const loser = r.lanes.find((l) => l.lane !== r.winner)!;
      announce(`${r.winner} committed; ${loser.lane} was replayed and refused with ${loser.code}.`);
    },
  });
  const r = race.data;
  const loser = r?.lanes.find((l) => l.lane !== r.winner);
  const retryAfter =
    race.error instanceof ApiError && race.error.error.code === 'RATE_LIMITED'
      ? race.error.error.details.retryAfterSeconds
      : null;

  return (
    <>
      <header className="topbar">
        <p className="crumbs">
          <span className="brand">Team Finder</span> <span aria-hidden="true">▸</span> How it works
        </p>
        <h1 className="goal">Two managers, one person, the same second</h1>
      </header>
      <main className="org-page race-page">
        <p>
          Riley may work 8 h a day. Two proposals ask for 5 h each, on Apollo and on Borealis. Both get approved at the
          same moment: each approval reads Riley's capacity, sees 0 h booked, passes the check, then waits at a barrier
          so neither writes first. Then both write.
        </p>
        <p className="muted">
          Every approval also bumps a per-person version, so the second write conflicts. MongoDB aborts that
          transaction, the driver replays it, and the replay's re-check sees the first approval and refuses. This runs
          the same <code>approve()</code> production uses, in a throwaway sandbox org.
        </p>
        {session.org.isDemo ? (
          <button type="button" className="btn btn-primary" disabled={race.isPending} onClick={() => race.mutate()}>
            {race.isPending ? 'Racing…' : r ? 'Run it again' : 'Run the race'}
          </button>
        ) : (
          <p className="note">The race runs in demo sandboxes, or locally with pnpm demo:race.</p>
        )}
        {race.isError && (
          <p role="alert" className="inline-error" data-testid="race-error">
            {retryAfter !== null ? `Try again in ${retryAfter} s.` : toErrorMessage(race.error)}
            {errorCode(race.error) === 'INVARIANT_BROKEN' && ' INVARIANT BROKEN.'}
          </p>
        )}
        {r && loser && !race.isPending && (
          <section className="org-section" aria-labelledby="race-result" data-testid="race-result">
            <h2 id="race-result">
              ✓ {r.winner} committed · ✗ {loser.lane} refused ({loser.code}) · replays {r.replays}
            </h2>
            <Lanes result={r} />
            <ol className="race-text">
              {r.lanes.map((l) => (
                <li key={l.lane}>{sentence(l)}</li>
              ))}
            </ol>
            <p className="muted">
              Proof in code: <code>apps/api/test/race.test.ts</code> runs this 20 times and requires exactly one winner
              each time; <code>pnpm demo:race</code> prints it from a fresh clone.
            </p>
          </section>
        )}
      </main>
    </>
  );
}
