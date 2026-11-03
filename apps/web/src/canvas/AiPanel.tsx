import { useMutation, useQuery } from '@tanstack/react-query';
import { AI_REQUEST_MAX_CHARS, type AiDraftItem, type AiDraftResponse } from '@team-finder/domain';
import { useState } from 'react';
import { api, toErrorMessage } from '../lib/api.ts';
import { formatDay } from '../lib/format.ts';

const REJECTED_TEXT = {
  duplicate: 'not added: picked twice',
  slotFull: 'not added: no open slot',
  noApprover: 'not added: no approver',
} as const;

function verdictText(item: AiDraftItem): string {
  const v = item.verdict;
  if (v.kind === 'fits') return `✓ fits at ${item.hoursPerDay} h/day`;
  if (v.kind === 'conflict') return `⚠ overbooked from ${formatDay(v.date)} (${v.used} h booked; max ${v.maxHours} h)`;
  return `✕ ${REJECTED_TEXT[v.reason]}`;
}

/**
 * "Draft with AI" (AI-01). The model drafts from the engine's shortlist; the server checks every
 * pick; accepted picks (fits or conflict, never rejected) become the draft, at the suggested start,
 * where the scrubber, the verdict line and Remove work as for a hand-made draft. Nothing is sent
 * until the PM commits.
 */
export function AiPanel({
  projectId,
  roleName,
  onDraft,
}: {
  projectId: string;
  roleName: (id: string) => string;
  onDraft: (result: AiDraftResponse) => void;
}) {
  const [text, setText] = useState('');
  const status = useQuery({ queryKey: ['ai-status'], queryFn: api.aiStatus, staleTime: Infinity });
  const search = useMutation({
    mutationFn: () => api.aiSearch({ projectId, text }),
    onSuccess: (result) => {
      // SRS: the model's raw JSON is visible to the curious, in the console only.
      console.info('[AI draft] raw model output', result.raw);
      onDraft(result);
    },
  });

  if (!status.data) return null;
  if (!status.data.enabled) {
    return (
      <section className="ai-panel ai-panel-off" aria-label="Draft with AI" data-testid="ai-panel">
        <p className="muted">AI drafts are off: set LLM_API_KEY on the server to enable them.</p>
      </section>
    );
  }

  const result = search.data;
  const tooShort = text.trim().length < 3;
  return (
    <section className="ai-panel" aria-labelledby="ai-title" data-testid="ai-panel">
      <form
        className="ai-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!tooShort && !search.isPending) search.mutate();
        }}
      >
        <label htmlFor="ai-text" id="ai-title" className="ai-title">
          Draft with AI
        </label>
        <input
          id="ai-text"
          type="text"
          aria-label="Describe the team you need"
          aria-describedby="ai-privacy"
          maxLength={AI_REQUEST_MAX_CHARS}
          placeholder="a backend dev with AWS, two weeks later"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button type="submit" className="btn btn-small btn-primary" disabled={tooShort || search.isPending}>
          {search.isPending ? 'Drafting…' : 'Draft team'}
        </button>
        <span id="ai-privacy" className="sr-only">
          Candidates are sent to the model as c1, c2 and so on, never by name.
        </span>
      </form>
      {search.isError && (
        <p role="alert" className="inline-error" data-testid="ai-error">
          {toErrorMessage(search.error)}
        </p>
      )}
      {result && !search.isPending && (
        <div className="ai-result" data-testid="ai-result">
          {result.items.length === 0 ? (
            <p className="muted">No picks. Try naming roles, e.g. “a backend dev and a QA”.</p>
          ) : (
            <ul className="ai-items">
              {result.items.map((item) => (
                <li
                  key={`${item.candidate.userId}-${item.slotRoleId}`}
                  className={`ai-item ai-item-${item.verdict.kind}`}
                  data-testid={`ai-item-${item.candidate.name}`}
                >
                  <span className="ai-item-name">{item.candidate.name}</span> → {roleName(item.slotRoleId)}
                  <span className="ai-item-verdict mono">{verdictText(item)}</span>
                </li>
              ))}
            </ul>
          )}
          {result.dropped > 0 && (
            <p className="muted">
              {result.dropped} pick{result.dropped === 1 ? '' : 's'} named someone or a role not on the shortlist and
              {result.dropped === 1 ? ' was' : ' were'} ignored.
            </p>
          )}
          {result.rationale.length > 0 && (
            <ul className="ai-rationale" aria-label="Why">
              {result.rationale.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          )}
          <p className="muted ai-note">
            Checked by the engine · drafted by {result.provider} · candidates sent as c1, c2…, never by name
          </p>
        </div>
      )}
    </section>
  );
}
