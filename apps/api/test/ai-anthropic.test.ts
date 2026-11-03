import { describe, expect, it } from 'vitest';
import { anthropicProvider, DEFAULT_MODEL } from '../src/ai/anthropic.ts';
import { renderPrompt } from '../src/ai/prompt.ts';
import type { PromptInput } from '../src/ai/provider.ts';

// The real provider, against a scripted transport: no network, no cost. Pins the request we send
// (model, structured output schema, refusal fallbacks, effort) and how each failure maps to a
// reason the panel can show.

const input: PromptInput = {
  today: '2026-03-02',
  project: {
    name: 'Atlas',
    startDate: '2026-03-09',
    deadline: '2026-06-01',
    scrub: { from: '2026-03-09', to: '2026-04-20' },
  },
  slots: [{ roleId: 'r-backend', roleName: 'Backend Developer', count: 2, open: 1 }],
  targets: [{ name: 'AWS', minLevel: 3 }],
  coveredByTeam: ['Node.js'],
  candidates: [
    {
      ref: 'c1',
      title: 'Senior Backend Developer',
      skills: [{ name: 'AWS', level: 4 }],
      hoursFree: 0,
      availableFrom: '2026-03-23',
    },
  ],
  text: 'a backend dev, two weeks later',
};
const answer = {
  start: '2026-03-23',
  assignments: [{ candidateRef: 'c1', slotRoleId: 'r-backend', hoursPerDay: 8 }],
  rationale: ['c1 covers AWS.'],
};

function message(over: Record<string, unknown> = {}, text = JSON.stringify(answer)) {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: DEFAULT_MODEL,
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 },
    ...over,
  };
}

function transport(status: number, body: unknown) {
  const requests: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  const fetch = (async (url: string | URL, init?: RequestInit) => {
    requests.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}

describe('anthropicProvider', () => {
  it('sends a schema-constrained, low-effort request with refusal fallbacks and returns the parsed draft', async () => {
    const t = transport(200, message());
    const provider = anthropicProvider({ apiKey: 'test-key', fetch: t.fetch });
    expect(provider.name).toBe('claude-opus-5-5');
    await expect(provider.draft(input, renderPrompt(input))).resolves.toEqual(answer);

    const req = t.requests[0]!;
    expect(req.url).toContain('/v1/messages');
    expect(req.headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01');
    expect(req.body).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: 4096,
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema' } },
    });
    expect(JSON.stringify((req.body.output_config as { format: { schema: unknown } }).format.schema)).toContain(
      'candidateRef',
    );
    expect(req.body.messages).toEqual([{ role: 'user', content: renderPrompt(input).user }]);
    expect(String(req.body.system)).toContain('pseudonymous');
    expect(req.body).not.toHaveProperty('thinking');
  });

  it.each([
    [
      'a refusal that survived the fallbacks',
      200,
      message({ stop_reason: 'refusal', content: [] }),
      'the model declined this request',
    ],
    ['a cut-off answer', 200, message({ stop_reason: 'max_tokens' }, '{"start":'), 'the answer was cut off'],
    [
      'rate limiting',
      429,
      { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } },
      'the model is busy, retry shortly',
    ],
    [
      'a bad key',
      401,
      { type: 'error', error: { type: 'authentication_error', message: 'no' } },
      'the server is not configured for the model',
    ],
    ['an unreadable answer', 200, message({}, 'not json'), 'the answer could not be read'],
    [
      'a server error',
      500,
      { type: 'error', error: { type: 'api_error', message: 'oops' } },
      'the model provider returned an error',
    ],
  ])('maps %s to a reason', async (_name, status, body, reason) => {
    const provider = anthropicProvider({ apiKey: 'test-key', fetch: transport(status, body).fetch });
    await expect(provider.draft(input, renderPrompt(input))).rejects.toMatchObject({ name: 'AiUnavailable', reason });
  });
});
