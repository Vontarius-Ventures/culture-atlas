import { z } from 'zod';
import type { MessagesTransport, TransportRequest } from '../anthropic/transport';
import { ProviderError, type ProviderErrorKind } from '../errors';
import { parseRetryAfter } from '../http/resilience';

/**
 * Featherless (https://featherless.ai) transport. Featherless exposes an
 * OpenAI-compatible Chat Completions API (`POST {base}/chat/completions`,
 * `Authorization: Bearer <key>`); vision is supported on Gemma/Mistral-class
 * models with images sent as base64 data URLs after the text prompt.
 *
 * It plugs into the same runner as the Anthropic SDK transport, so retries,
 * budgets, the circuit breaker and zod validation are shared. The model gets
 * no tools. The JSON Schema of the expected output is appended to the system
 * prompt and, depending on FEATHERLESS_JSON_MODE, also requested through
 * `response_format`; the reply is always re-validated with zod by the runner.
 */

export type FeatherlessJsonMode = 'json_schema' | 'json_object' | 'none';

export interface FeatherlessTransportConfig {
  apiKey: string;
  baseUrl: string;
  jsonMode: FeatherlessJsonMode;
  fetch?: typeof fetch;
  /** Provider label for errors and logs (default "featherless"); also used for Elorian. */
  providerName?: string;
  /** Output cap field: OpenAI-style APIs differ (default max_tokens). */
  tokenParam?: 'max_tokens' | 'max_completion_tokens';
}

type ChatContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

interface ChatCompletionResponse {
  model?: string;
  choices?: Array<{ finish_reason?: string | null; message?: { content?: string | null; refusal?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function schemaInstructions(schema: z.ZodType): string {
  let jsonSchema: unknown;
  try {
    jsonSchema = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
  } catch {
    jsonSchema = { type: 'object' };
  }
  return [
    'Output format (highest priority after the security rules):',
    'Reply with a single JSON object that validates against this JSON Schema. No markdown fences, no commentary.',
    JSON.stringify(jsonSchema),
  ].join('\n');
}

export function buildChatRequest(
  req: TransportRequest,
  jsonMode: FeatherlessJsonMode,
  tokenParam: 'max_tokens' | 'max_completion_tokens' = 'max_tokens',
): Record<string, unknown> {
  // Featherless recommends text before images in the content array.
  const texts: ChatContentPart[] = [];
  const images: ChatContentPart[] = [];
  for (const block of req.content) {
    if (block.type === 'text') texts.push({ type: 'text', text: block.text });
    else images.push({ type: 'image_url', image_url: { url: `data:${block.mediaType};base64,${block.base64}` } });
  }
  const userContent = images.length === 0 && texts.length === 1 ? (texts[0] as { text: string }).text : [...texts, ...images];
  const body: Record<string, unknown> = {
    model: req.model,
    [tokenParam]: req.maxTokens,
    temperature: 0.2,
    messages: [
      { role: 'system', content: `${req.system}\n\n${schemaInstructions(req.schema)}` },
      { role: 'user', content: userContent },
    ],
  };
  if (jsonMode === 'json_object') body.response_format = { type: 'json_object' };
  if (jsonMode === 'json_schema') {
    body.response_format = {
      type: 'json_schema',
      json_schema: { name: 'output', strict: false, schema: z.toJSONSchema(req.schema, { io: 'input', unrepresentable: 'any' }) },
    };
  }
  return body;
}

/** Strips ```json fences some open models add despite instructions. */
export function extractJsonText(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  if (fenced) return fenced[1]!.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  return start > 0 && end > start ? trimmed.slice(start, end + 1) : trimmed;
}

function kindForStatus(status: number): ProviderErrorKind {
  if (status === 429) return 'rate_limited';
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'not_found';
  if (status >= 500) return 'server';
  return 'bad_request';
}

export function createFeatherlessTransport(config: FeatherlessTransportConfig): MessagesTransport {
  const doFetch = config.fetch ?? fetch;
  const name = config.providerName ?? 'featherless';
  const url = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  return async (req, options) => {
    const res = await doFetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(buildChatRequest(req, config.jsonMode, config.tokenParam)),
      signal: options.signal,
    });
    if (!res.ok) {
      // Never include the response body: it may echo the request.
      throw new ProviderError(name, kindForStatus(res.status), `${name} API error ${res.status}`, {
        status: res.status,
        retryAfterMs: parseRetryAfter(res.headers.get('retry-after')),
      });
    }
    let json: ChatCompletionResponse;
    try {
      json = (await res.json()) as ChatCompletionResponse;
    } catch (err) {
      throw new ProviderError(name, 'invalid_response', `${name} returned non-JSON`, { cause: err });
    }
    const choice = json.choices?.[0];
    const content = choice?.message?.content ?? '';
    const finish = choice?.finish_reason ?? null;
    const stopReason = choice?.message?.refusal ? 'refusal' : finish === 'length' ? 'max_tokens' : finish === 'content_filter' ? 'refusal' : finish;
    return {
      parsed: null,
      text: extractJsonText(content),
      stopReason,
      model: json.model ?? req.model,
      usage: { inputTokens: json.usage?.prompt_tokens, outputTokens: json.usage?.completion_tokens },
    };
  };
}
