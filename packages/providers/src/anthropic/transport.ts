import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { z } from 'zod';
import { ProviderError, type ProviderErrorKind } from '../errors';
import { parseRetryAfter } from '../http/resilience';

/**
 * Thin seam over the Anthropic SDK so adapters can be tested with a fake
 * transport. Structured output uses native structured outputs
 * (`output_config.format` via `zodOutputFormat` + `messages.parse`): current
 * models reject forced `tool_choice`, and the model gets NO tools at all — text
 * inside images or user data therefore cannot trigger any action.
 */

export type UserContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: 'image/jpeg' | 'image/png' | 'image/webp'; base64: string };

export interface TransportRequest {
  model: string;
  system: string;
  content: UserContentBlock[];
  schema: z.ZodType;
  maxTokens: number;
  effort: 'low' | 'medium' | 'high';
  /** Ask the API to re-run a policy-declined request on a fallback model. */
  refusalFallback: boolean;
}

export interface TransportResult {
  /** SDK-parsed structured output (null when it could not be parsed). */
  parsed: unknown;
  /** Concatenated text blocks (used when `parsed` is null). */
  text: string;
  stopReason: string | null;
  model: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export type MessagesTransport = (
  request: TransportRequest,
  options: { signal?: AbortSignal; timeoutMs: number },
) => Promise<TransportResult>;

/** Models that accept the server-side refusal fallback (`fallbacks: "default"`). */
const FALLBACK_MODELS = new Set(['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1']);

export function createSdkTransport(config: { apiKey: string; baseUrl?: string }): MessagesTransport {
  // SDK retries are disabled: retries happen in withRetries() so they are
  // charged to the per-job budget and bounded per stage.
  const client = new Anthropic({ apiKey: config.apiKey, baseURL: config.baseUrl, maxRetries: 0 });
  return async (req, options) => {
    const content: Anthropic.Beta.BetaContentBlockParam[] = req.content.map((b) =>
      b.type === 'text'
        ? { type: 'text', text: b.text }
        : { type: 'image', source: { type: 'base64', media_type: b.mediaType, data: b.base64 } },
    );
    const fallback = req.refusalFallback && FALLBACK_MODELS.has(req.model);
    const params = {
      model: req.model,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: [{ role: 'user' as const, content }],
      output_config: { format: zodOutputFormat(req.schema), effort: req.effort },
      ...(fallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
    };
    const res = await client.beta.messages.parse(params as Parameters<typeof client.beta.messages.parse>[0], {
      signal: options.signal,
      timeout: options.timeoutMs,
      maxRetries: 0,
    });
    const text = res.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    return {
      parsed: (res as { parsed_output?: unknown }).parsed_output ?? null,
      text,
      stopReason: res.stop_reason ?? null,
      model: res.model,
      usage: { inputTokens: res.usage?.input_tokens, outputTokens: res.usage?.output_tokens },
    };
  };
}

/** Maps SDK/transport errors to ProviderError (most specific first). */
export function mapAnthropicError(provider: string, err: unknown, timedOut: boolean, callerAborted: boolean): ProviderError {
  if (err instanceof ProviderError) return err;
  if (callerAborted) return new ProviderError(provider, 'aborted', `${provider} request aborted`, { cause: err });
  if (timedOut || err instanceof Anthropic.APIConnectionTimeoutError) {
    return new ProviderError(provider, 'timeout', `${provider} request timed out`, { cause: err });
  }
  if (err instanceof Anthropic.APIUserAbortError) return new ProviderError(provider, 'aborted', `${provider} request aborted`, { cause: err });
  if (err instanceof Anthropic.APIConnectionError) return new ProviderError(provider, 'server', `${provider} connection failed`, { cause: err });
  if (err instanceof Anthropic.APIError) {
    const status = err.status ?? 0;
    let kind: ProviderErrorKind;
    if (err instanceof Anthropic.RateLimitError || status === 429) kind = 'rate_limited';
    else if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) kind = 'auth';
    else if (err instanceof Anthropic.NotFoundError) kind = 'not_found';
    else if (err instanceof Anthropic.BadRequestError || err instanceof Anthropic.UnprocessableEntityError) kind = 'bad_request';
    else if (status >= 500 || status === 529) kind = 'server';
    else kind = 'bad_request';
    const headers = err.headers as Headers | undefined;
    const retryAfterMs = parseRetryAfter(headers?.get?.('retry-after') ?? null);
    return new ProviderError(provider, kind, `${provider} API error ${status}`, { status, retryAfterMs, cause: err });
  }
  return new ProviderError(provider, 'server', `${provider} request failed`, { cause: err });
}

/** Interpret a transport result: refusal / truncation / schema failure -> ProviderError. */
export function readStructured<T extends z.ZodType>(provider: string, schema: T, result: TransportResult): z.infer<T> {
  if (result.stopReason === 'refusal') throw new ProviderError(provider, 'content_rejected', `${provider} declined the request`);
  if (result.stopReason === 'max_tokens') throw new ProviderError(provider, 'invalid_response', `${provider} output was truncated`);
  let candidate = result.parsed;
  if (candidate === null || candidate === undefined) {
    try {
      candidate = JSON.parse(result.text);
    } catch {
      throw new ProviderError(provider, 'invalid_response', `${provider} returned no structured output`);
    }
  }
  const parsed = schema.safeParse(candidate);
  if (!parsed.success) throw new ProviderError(provider, 'invalid_response', `${provider} output failed schema validation`);
  return parsed.data;
}
