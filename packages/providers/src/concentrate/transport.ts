import { z } from 'zod';
import { ProviderError, type ProviderErrorKind } from '../errors';
import { parseRetryAfter } from '../http/resilience';
import type { GatewayRequest, GatewayResponse, StructuredTransport } from '../model-gateway/types';

const Envelope = z
  .object({
    id: z.string().nullable().optional(),
    model: z.string().nullable().optional(),
    status: z.string().optional(),
    error: z.unknown().optional(),
    incomplete_details: z.unknown().optional(),
    output: z
      .array(
        z
          .object({
            type: z.string(),
            status: z.string().optional(),
            content: z
              .array(
                z
                  .object({
                    type: z.string(),
                    text: z.string().optional(),
                    refusal: z.string().optional(),
                  })
                  .loose(),
              )
              .optional(),
          })
          .loose(),
      )
      .default([]),
    usage: z
      .object({
        input_tokens: z.number().int().nonnegative().nullable().optional(),
        output_tokens: z.number().int().nonnegative().nullable().optional(),
      })
      .loose()
      .nullable()
      .optional(),
  })
  .loose();

/** Documented request-correlation headers, read only when present. */
const REQUEST_ID_HEADERS = ['x-request-id', 'request-id'];
function requestIdFrom(headers: Headers): string | null {
  for (const name of REQUEST_ID_HEADERS) {
    const value = headers.get(name);
    if (value && /^[\w.:-]{1,200}$/.test(value)) return value;
  }
  return null;
}

export function parseResponse(value: unknown, requestId: string | null = null): GatewayResponse {
  const parsed = Envelope.safeParse(value);
  if (!parsed.success)
    throw new ProviderError('concentrate', 'invalid_response', 'Invalid Responses envelope');
  const response = parsed.data;
  const messages = response.output.filter((item) => item.type === 'message');
  const blocks = messages.flatMap((item) => item.content ?? []);
  const refusal =
    response.output.some((item) => item.type === 'refusal') ||
    blocks.some((block) => block.type === 'refusal');
  // A nonstreaming call that is still queued/in progress is not a completed result.
  const incomplete =
    response.incomplete_details != null ||
    response.status === 'incomplete' ||
    response.status === 'in_progress' ||
    response.status === 'queued' ||
    messages.some((item) => item.status === 'incomplete');
  const usage = response.usage;
  return {
    id: response.id ?? null,
    requestId,
    model: response.model ?? null,
    // No documented upstream-provider response field. Never infer execution from requested route.
    actualProvider: null,
    text: blocks
      .filter((block) => block.type === 'output_text')
      .map((block) => block.text ?? '')
      .join(''),
    outcome:
      response.error != null || response.status === 'failed' || response.status === 'cancelled'
        ? 'error'
        : refusal
          ? 'refusal'
          : incomplete
            ? 'incomplete'
            : 'complete',
    // Partial or missing counts are unknown usage, never zero.
    usage:
      usage && typeof usage.input_tokens === 'number' && typeof usage.output_tokens === 'number'
        ? { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens }
        : null,
  };
}

export function buildResponsesRequest(request: GatewayRequest): Record<string, unknown> {
  return {
    model: request.model,
    stream: false,
    max_output_tokens: request.maxOutputTokens,
    // FAST-03: only a qualified profile's explicit effort is ever sent.
    ...(request.reasoningEffort ? { reasoning: { effort: request.reasoningEffort } } : {}),
    instructions: request.system,
    input: [
      {
        role: 'user',
        content: request.content.map((block) =>
          block.type === 'text'
            ? { type: 'input_text', text: block.text }
            : { type: 'input_image', image_url: `data:image/jpeg;base64,${block.base64}` },
        ),
      },
    ],
    text: {
      format: {
        type: 'json_schema',
        name: request.schemaName,
        strict: true,
        schema: request.jsonSchema,
      },
    },
  };
}

/**
 * Vendor status -> Atlas kind (CONCENTRATE.md failure table). The runner owns
 * policy: 401/403 and 404/422 open a durable role circuit, 402 pauses all AI,
 * 429 pauses dispatch until Retry-After, 424/5xx allow one bounded retry.
 */
export function errorKind(status: number): ProviderErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 402) return 'budget_exhausted';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  if (status === 424 || status >= 500) return 'server';
  return 'bad_request';
}

export function createConcentrateTransport(config: {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}): StructuredTransport {
  const base = config.baseUrl ?? 'https://api.concentrate.ai/v1';
  // Do not send this bearer key to a configurable third-party origin or HTTP proxy.
  if (base.replace(/\/+$/, '') !== 'https://api.concentrate.ai/v1')
    throw new Error('Unapproved Concentrate endpoint');
  const doFetch = config.fetch ?? fetch;
  return async (request, options) => {
    const response = await doFetch(`${base.replace(/\/+$/, '')}/responses`, {
      method: 'POST',
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(buildResponsesRequest(request)),
      signal: options.signal,
    });
    const requestId = requestIdFrom(response.headers);
    if (!response.ok) {
      // Never read the error body: it may echo prompts, media or credentials.
      await response.body?.cancel().catch(() => undefined);
      throw new ProviderError(
        'concentrate',
        errorKind(response.status),
        `Concentrate HTTP ${response.status}`,
        {
          status: response.status,
          retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
          requestId: requestId ?? undefined,
        },
      );
    }
    // Bound unexpected response bodies; never retain raw payload in errors or logs.
    if (!response.body)
      throw new ProviderError('concentrate', 'invalid_response', 'Empty Responses envelope');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 1_000_000) {
          await reader.cancel();
          throw new ProviderError(
            'concentrate',
            'invalid_response',
            'Responses envelope exceeds limit',
          );
        }
        chunks.push(chunk.value);
      }
      return parseResponse(JSON.parse(Buffer.concat(chunks).toString('utf8')), requestId);
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (options.signal.aborted) throw error;
      throw new ProviderError('concentrate', 'invalid_response', 'Invalid Responses JSON');
    } finally {
      reader.releaseLock();
    }
  };
}
