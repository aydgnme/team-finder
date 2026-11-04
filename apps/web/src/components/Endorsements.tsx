import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MAX_ENDORSEMENTS, type Endorsement, type EndorsementKind } from '@team-finder/domain';
import { useState } from 'react';
import { api, toErrorMessage } from '../lib/api.ts';
import { useAnnounce } from '../lib/announce.tsx';

// Skill-03: evidence attached to a skill (trainings, courses, certifications, past projects). The
// owner edits it under My skills; their department manager sees it next to a claim.

const KIND: Record<EndorsementKind, string> = {
  training: 'Training',
  course: 'Course',
  certification: 'Certification',
  project: 'Project',
};

export function EndorsementList({
  items,
  onRemove,
  skillName,
}: {
  items: Endorsement[];
  onRemove?: (id: string) => void;
  skillName: string;
}) {
  if (items.length === 0) return null;
  return (
    <ul className="endorsements" aria-label={`Evidence for ${skillName}`}>
      {items.map((e) => (
        <li key={e.id} className="endorsement">
          <span className="endorsement-kind">{KIND[e.kind]}</span>{' '}
          {e.url ? (
            <a href={e.url} target="_blank" rel="noopener noreferrer">
              {e.title}
            </a>
          ) : (
            e.title
          )}
          {onRemove && (
            <button
              type="button"
              className="btn-link"
              aria-label={`Remove ${e.title} from ${skillName}`}
              onClick={() => onRemove(e.id)}
            >
              ×
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

export function MyEvidence({
  userId,
  skillId,
  skillName,
  items,
}: {
  userId: string;
  skillId: string;
  skillName: string;
  items: Endorsement[];
}) {
  const queryClient = useQueryClient();
  const announce = useAnnounce();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<EndorsementKind>('certification');
  const [title, setTitle] = useState('');
  const [url, setUrl] = useState('');
  const [projectId, setProjectId] = useState('');
  const projects = useQuery({
    queryKey: ['person-projects', userId],
    queryFn: () => api.personProjects(userId),
    enabled: open && kind === 'project',
  });
  const worked = [...(projects.data?.current ?? []), ...(projects.data?.past ?? [])].filter(
    (p, i, all) =>
      p.status !== 'proposed' &&
      all.findIndex((q) => q.projectId === p.projectId) === i &&
      !items.some((e) => e.projectId === p.projectId),
  );
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['skills'] });
  const add = useMutation({
    mutationFn: () =>
      api.addEndorsement(
        skillId,
        kind === 'project' ? { kind, projectId } : { kind, title, url: url.trim() === '' ? null : url.trim() },
      ),
    onSuccess: (e) => {
      announce(`${e.title} added to ${skillName}.`);
      setTitle('');
      setUrl('');
      setProjectId('');
      setOpen(false);
      refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.removeEndorsement(skillId, id),
    onSuccess: () => {
      announce(`Evidence removed from ${skillName}.`);
      refresh();
    },
  });
  const full = items.length >= MAX_ENDORSEMENTS;

  return (
    <div className="evidence">
      <EndorsementList items={items} skillName={skillName} onRemove={(id) => remove.mutate(id)} />
      {!open ? (
        !full && (
          <button type="button" className="btn-link" onClick={() => setOpen(true)}>
            Add evidence
          </button>
        )
      ) : (
        <form
          className="team-role-add"
          aria-label={`Add evidence for ${skillName}`}
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate();
          }}
        >
          <select
            aria-label="Kind of evidence"
            value={kind}
            onChange={(e) => setKind(e.target.value as EndorsementKind)}
          >
            {(Object.keys(KIND) as EndorsementKind[]).map((k) => (
              <option key={k} value={k}>
                {k === 'project' ? 'Past project' : KIND[k]}
              </option>
            ))}
          </select>
          {kind === 'project' ? (
            <select aria-label="Project" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">{projects.isPending ? 'Loading…' : 'A project you worked on…'}</option>
              {worked.map((p) => (
                <option key={p.projectId} value={p.projectId}>
                  {p.projectName}
                </option>
              ))}
            </select>
          ) : (
            <>
              <input aria-label="Title" placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
              <input
                aria-label="Link (optional)"
                placeholder="https://… (optional)"
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
            </>
          )}
          <button
            type="submit"
            className="btn btn-small"
            disabled={add.isPending || (kind === 'project' ? !projectId : title.trim().length < 2)}
          >
            Add
          </button>
          <button type="button" className="btn btn-small btn-ghost" onClick={() => setOpen(false)}>
            Cancel
          </button>
        </form>
      )}
      {(add.error ?? remove.error) && (
        <p role="alert" className="inline-error">
          {toErrorMessage(add.error ?? remove.error)}
        </p>
      )}
    </div>
  );
}
