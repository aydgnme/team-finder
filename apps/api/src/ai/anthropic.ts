import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { AiDraftOutput } from '@team-finder/domain';
import { AiUnavailable, type DraftProvider } from './provider.ts';

export const DEFAULT_MODEL = 'claude-opus-5-5';

/**
 * Claude through the Messages API with structured outputs: the response is constrained to the
 * AiDraftOutput JSON schema and parsed by the SDK. Low effort (a short selection task), bounded
 * output, one retry, 30 s timeout. Server-side refusal fallbacks are on; a refusal that survives
 * them, a cut-off or an unreadable answer is AI_UNAVAILABLE, never a partial draft.
 */
export function anthropicProvider(options: { apiKey: string; model?: string | undefined }): DraftProvider {
  const client = new Anthropic({ apiKey: options.apiKey, timeout: 30_000, maxRetries: 1 });
  const model = options.model ?? DEFAULT_MODEL;
  return {
    name: model,
    async draft(_input, prompt) {
      let response;
      try {
        response = await client.beta.messages.parse({
          model,
          max_tokens: 4096,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          output_config: { effort: 'low', format: betaZodOutputFormat(AiDraftOutput) },
          system: prompt.system,
          messages: [{ role: 'user', content: prompt.user }],
        });
      } catch (error) {
        if (error instanceof Anthropic.APIConnectionTimeoutError) throw new AiUnavailable('the model timed out');
        if (error instanceof Anthropic.RateLimitError) throw new AiUnavailable('the model is busy, retry shortly');
        if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
          throw new AiUnavailable('the server is not configured for the model');
        }
        if (error instanceof Anthropic.APIError) throw new AiUnavailable('the model provider returned an error');
        throw new AiUnavailable('the model could not be reached');
      }
      if (response.stop_reason === 'refusal') throw new AiUnavailable('the model declined this request');
      if (response.stop_reason === 'max_tokens') throw new AiUnavailable('the answer was cut off');
      if (!response.parsed_output) throw new AiUnavailable('the answer could not be read');
      return response.parsed_output;
    },
  };
}
