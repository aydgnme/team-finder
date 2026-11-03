import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Experience, SKILL_LEVELS, type SessionInfo, type SkillsResponse } from '@team-finder/domain';
import { useState } from 'react';
import { api, toErrorMessage } from '../lib/api.ts';
import { useAnnounce } from '../lib/announce.tsx';
import { OrgTabs } from './OrgTabs.tsx';

// Skill-01/02 (M3a). Everyone keeps their own skills (they feed the matching engine); department
// managers and admins add categories and skills; only a skill's author edits or deletes it.

const EXPERIENCES = Experience.options;

export function SkillsPage({ session }: { session: SessionInfo }) {
  const skills = useQuery({ queryKey: ['skills'], queryFn: api.skills });
  return (
    <>
      <header className="topbar">
        <p className="crumbs">
          <span className="brand">Team Finder</span> <span aria-hidden="true">▸</span> Organization
        </p>
        <h1 className="goal">{session.org.name}</h1>
        <OrgTabs />
      </header>
      <main className="org-page">
        {skills.isError && <p role="alert">{toErrorMessage(skills.error)}</p>}
        {skills.data && <MySkills data={skills.data} />}
        {skills.data && <Catalog data={skills.data} />}
      </main>
    </>
  );
}

function useRefresh() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ['skills'] });
    void queryClient.invalidateQueries({ queryKey: ['candidates'] });
  };
}

function MySkills({ data }: { data: SkillsResponse }) {
  const announce = useAnnounce();
  const refresh = useRefresh();
  const name = (id: string) => data.skills.find((s) => s.id === id)?.name ?? 'Skill';
  const [pick, setPick] = useState({ skillId: '', level: 3, experience: '1-2y' as Experience });
  const set = useMutation({
    mutationFn: (v: { skillId: string; level: number; experience: Experience }) =>
      api.setMySkill(v.skillId, v.level, v.experience),
    onSuccess: (_r, v) => {
      announce(`${name(v.skillId)} saved.`);
      refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (skillId: string) => api.removeMySkill(skillId),
    onSuccess: (_r, skillId) => {
      announce(`${name(skillId)} removed.`);
      refresh();
    },
  });
  const notMine = data.skills.filter((s) => !data.mine.some((m) => m.skillId === s.id));
  const error = set.error ?? remove.error;

  return (
    <section className="org-section" aria-labelledby="my-skills-title">
      <h2 id="my-skills-title">My skills</h2>
      <p className="muted">They decide which projects you are suggested for.</p>
      <ul className="plain-list" data-testid="my-skills">
        {data.mine.map((m) => (
          <li key={m.skillId} className="team-role" data-testid={`my-skill-${name(m.skillId)}`}>
            <span className="team-role-name">{name(m.skillId)}</span>
            <select
              aria-label={`Level in ${name(m.skillId)}`}
              value={m.level}
              onChange={(e) =>
                set.mutate({ skillId: m.skillId, level: Number(e.target.value), experience: m.experience })
              }
            >
              {SKILL_LEVELS.map((l, i) => (
                <option key={l} value={i + 1}>
                  {i + 1} {l}
                </option>
              ))}
            </select>
            <select
              aria-label={`Experience with ${name(m.skillId)}`}
              value={m.experience}
              onChange={(e) =>
                set.mutate({ skillId: m.skillId, level: m.level, experience: e.target.value as Experience })
              }
            >
              {EXPERIENCES.map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
            <span className="team-role-actions">
              <button type="button" className="btn btn-small btn-ghost" onClick={() => remove.mutate(m.skillId)}>
                Remove
              </button>
            </span>
          </li>
        ))}
      </ul>
      {notMine.length > 0 && (
        <form
          className="team-role-add"
          onSubmit={(e) => {
            e.preventDefault();
            if (pick.skillId) set.mutate(pick, { onSuccess: () => setPick((p) => ({ ...p, skillId: '' })) });
          }}
        >
          <select
            aria-label="Skill to add"
            value={pick.skillId}
            onChange={(e) => setPick((p) => ({ ...p, skillId: e.target.value }))}
          >
            <option value="">Add a skill…</option>
            {notMine.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <select
            aria-label="Level"
            value={pick.level}
            onChange={(e) => setPick((p) => ({ ...p, level: Number(e.target.value) }))}
          >
            {SKILL_LEVELS.map((l, i) => (
              <option key={l} value={i + 1}>
                {i + 1} {l}
              </option>
            ))}
          </select>
          <select
            aria-label="Experience"
            value={pick.experience}
            onChange={(e) => setPick((p) => ({ ...p, experience: e.target.value as Experience }))}
          >
            {EXPERIENCES.map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
          <button type="submit" className="btn btn-small" disabled={!pick.skillId || set.isPending}>
            Add
          </button>
        </form>
      )}
      {error && (
        <p role="alert" className="inline-error">
          {toErrorMessage(error)}
        </p>
      )}
    </section>
  );
}

function Catalog({ data }: { data: SkillsResponse }) {
  const announce = useAnnounce();
  const refresh = useRefresh();
  const [category, setCategory] = useState('');
  const [skill, setSkill] = useState({ name: '', categoryId: '', description: '' });
  const act = useMutation({ mutationFn: (fn: () => Promise<unknown>) => fn() });
  const run = (fn: () => Promise<unknown>, text: string, after?: () => void) =>
    act.mutate(fn, {
      onSuccess: () => {
        announce(text);
        after?.();
        refresh();
      },
    });

  return (
    <section className="org-section" aria-labelledby="catalog-title">
      <h2 id="catalog-title">Skills in {data.categories.length ? 'this organization' : 'use'}</h2>
      {data.categories.map((c) => {
        const inCat = data.skills.filter((s) => s.categoryId === c.id);
        return (
          <div key={c.id} className="skill-category" data-testid={`category-${c.name}`}>
            <h3 className="role-name">
              {c.name}
              {data.canCreate && !c.inUse && (
                <button
                  type="button"
                  className="btn btn-small btn-ghost"
                  onClick={() => run(() => api.deleteCategory(c.id), `Category ${c.name} deleted.`)}
                >
                  Delete category
                </button>
              )}
            </h3>
            <ul className="plain-list">
              {inCat.map((s) => (
                <li key={s.id} className="team-role" data-testid={`skill-${s.name}`}>
                  <span className="team-role-name">{s.name}</span>
                  {s.description && <span className="muted">{s.description}</span>}
                  <span className="muted team-role-use">{s.author ? `by ${s.author.name}` : 'built in'}</span>
                  {s.canEdit && (
                    <span className="team-role-actions">
                      <button
                        type="button"
                        className="btn btn-small btn-ghost"
                        disabled={s.inUse}
                        title={s.inUse ? 'Someone holds it or a project uses it' : undefined}
                        onClick={() => run(() => api.deleteSkill(s.id), `${s.name} deleted.`)}
                      >
                        Delete
                      </button>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
      {data.canCreate && (
        <>
          <form
            className="team-role-add"
            onSubmit={(e) => {
              e.preventDefault();
              run(
                () => api.createSkill({ ...skill, departmentIds: [] }),
                `${skill.name} added.`,
                () => setSkill((x) => ({ ...x, name: '', description: '' })),
              );
            }}
          >
            <input
              aria-label="New skill"
              placeholder="New skill"
              value={skill.name}
              onChange={(e) => setSkill((x) => ({ ...x, name: e.target.value }))}
            />
            <select
              aria-label="Category"
              value={skill.categoryId}
              onChange={(e) => setSkill((x) => ({ ...x, categoryId: e.target.value }))}
            >
              <option value="">Category…</option>
              {data.categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <input
              aria-label="Description"
              placeholder="Description (optional)"
              value={skill.description}
              onChange={(e) => setSkill((x) => ({ ...x, description: e.target.value }))}
            />
            <button
              type="submit"
              className="btn btn-small"
              disabled={skill.name.trim().length < 2 || !skill.categoryId}
            >
              Add skill
            </button>
          </form>
          <form
            className="team-role-add"
            onSubmit={(e) => {
              e.preventDefault();
              run(
                () => api.createCategory(category),
                `Category ${category} added.`,
                () => setCategory(''),
              );
            }}
          >
            <input
              aria-label="New category"
              placeholder="New category"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            />
            <button type="submit" className="btn btn-small" disabled={category.trim().length < 2}>
              Add category
            </button>
          </form>
        </>
      )}
      {act.isError && (
        <p role="alert" className="inline-error">
          {toErrorMessage(act.error)}
        </p>
      )}
    </section>
  );
}
