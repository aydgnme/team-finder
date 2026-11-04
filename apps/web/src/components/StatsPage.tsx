import { useQuery } from '@tanstack/react-query';
import { SKILL_LEVELS, type SkillStat } from '@team-finder/domain';
import { useState } from 'react';
import { api, toErrorMessage } from '../lib/api.ts';
import { href } from '../lib/route.ts';

// Stats-01 (M5): a department's skill landscape, validated skills only. One ranked bar per skill
// (holders of the department's head count, one hue) with a thin segmented bar under it for the
// level split (an ordinal one-hue ramp, validated with the dataviz validator). Every number is
// also in the table below, which is the accessible view and the chart's source.
//
// Design note: the SRS asks for pie charts. Holders per skill is not one whole (people hold several
// skills), and a level split is read more exactly on one baseline, so bars replace the pies.

/** Ordinal blue ramp, light -> dark, level 1 -> 5 (light end clears 2:1 on the white surface). */
const LEVEL_COLORS = ['#86b6ef', '#5598e7', '#2a78d6', '#1c5cab', '#104281'] as const;

const levelName = (i: number) => `Level ${i + 1} ${SKILL_LEVELS[i]}`;

interface Tip {
  x: number;
  y: number;
  text: string;
}

function SkillRow({ s, people, onTip }: { s: SkillStat; people: number; onTip: (t: Tip | null) => void }) {
  const share = people === 0 ? 0 : s.holders / people;
  const tip = (e: React.MouseEvent | React.FocusEvent, text: string) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    onTip({ x: r.left + r.width / 2, y: r.top, text });
  };
  return (
    <li className="stat-row" data-testid={`stat-${s.name}`}>
      <span className="stat-name">{s.name}</span>
      <div className="stat-bars">
        <div className="stat-track">
          <div
            className="stat-bar"
            style={{ width: `${share * 100}%` }}
            role="img"
            tabIndex={0}
            aria-label={`${s.name}: ${s.holders} of ${people} people`}
            onMouseEnter={(e) => tip(e, `${s.name}: ${s.holders} of ${people} people`)}
            onFocus={(e) => tip(e, `${s.name}: ${s.holders} of ${people} people`)}
            onMouseLeave={() => onTip(null)}
            onBlur={() => onTip(null)}
          />
        </div>
        <div className="stat-levels" aria-hidden="true" style={{ width: `${share * 100}%` }}>
          {s.levels.map((n, i) =>
            n === 0 ? null : (
              <span
                key={i}
                className="stat-level"
                style={{ flexGrow: n, background: LEVEL_COLORS[i] }}
                onMouseEnter={(e) => tip(e, `${s.name}, ${levelName(i)}: ${n} ${n === 1 ? 'person' : 'people'}`)}
                onMouseLeave={() => onTip(null)}
              />
            ),
          )}
        </div>
      </div>
      <span className="stat-value mono">
        {s.holders} <span className="muted">of {people}</span>
      </span>
    </li>
  );
}

export function StatsPage({ departmentId }: { departmentId: string }) {
  const stats = useQuery({
    queryKey: ['department-stats', departmentId],
    queryFn: () => api.departmentStats(departmentId),
  });
  const [tip, setTip] = useState<Tip | null>(null);
  const d = stats.data;
  return (
    <>
      <header className="topbar">
        <p className="crumbs">
          <span className="brand">Team Finder</span> <span aria-hidden="true">▸</span> Departments
        </p>
        <h1 className="goal" data-testid="stats-title">
          {d ? `${d.department.name} skills` : 'Department skills'}
        </h1>
      </header>
      <main className="org-page stats-page">
        {stats.isError && <p role="alert">{toErrorMessage(stats.error)}</p>}
        {stats.isPending && <div className="skeleton skeleton-row" aria-busy="true" />}
        {d && (
          <>
            <p className="muted" data-testid="stats-summary">
              {d.people} {d.people === 1 ? 'person' : 'people'}
              {d.withoutSkills > 0 ? `, ${d.withoutSkills} without a validated skill` : ''}. Validated skills only;
              claims waiting for validation are not counted.{' '}
              <a href={href.departmentProjects(d.department.id)}>Projects</a>
            </p>
            {d.skills.length === 0 ? (
              <p className="empty">No validated skills in {d.department.name} yet.</p>
            ) : (
              <>
                <figure className="stats-figure">
                  <figcaption>
                    <strong>People per skill</strong>, split by level
                  </figcaption>
                  <ul className="stat-legend" aria-label="Levels">
                    {LEVEL_COLORS.map((c, i) => (
                      <li key={c}>
                        <span className="stat-swatch" style={{ background: c }} aria-hidden="true" />
                        {levelName(i)}
                      </li>
                    ))}
                  </ul>
                  <ul className="stat-list">
                    {d.skills.map((s) => (
                      <SkillRow key={s.skillId} s={s} people={d.people} onTip={setTip} />
                    ))}
                  </ul>
                </figure>
                {tip && (
                  <div className="stat-tip" role="tooltip" style={{ left: tip.x, top: tip.y }}>
                    {tip.text}
                  </div>
                )}
                <div className="table-scroll">
                  <table className="table stats-table" data-testid="stats-table">
                    <caption className="sr-only">People per skill and level in {d.department.name}</caption>
                    <thead>
                      <tr>
                        <th scope="col">Skill</th>
                        <th scope="col">Category</th>
                        <th scope="col">People</th>
                        {SKILL_LEVELS.map((l, i) => (
                          <th scope="col" key={l}>
                            {i + 1} {l}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {d.skills.map((s) => (
                        <tr key={s.skillId}>
                          <th scope="row">{s.name}</th>
                          <td className="muted">{s.category}</td>
                          <td className="mono">{s.holders}</td>
                          {s.levels.map((n, i) => (
                            <td className="mono" key={i}>
                              {n === 0 ? <span className="muted">–</span> : n}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </>
        )}
      </main>
    </>
  );
}
