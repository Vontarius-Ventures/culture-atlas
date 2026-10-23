import { describe, expect, it, vi } from 'vitest';
import { buildResponsesRequest, createConcentrateTransport, parseResponse } from './transport';
import { profile, request } from './test-fixtures';
import { strictJsonSchema } from '../model-gateway/schema';

const gatewayRequest = {
  ...request,
  model: profile.model,
  jsonSchema: strictJsonSchema(request.schema),
  maxOutputTokens: 100,
};
const envelope = {
  id: 'res-1',
  model: profile.model,
  status: 'completed',
  usage: null,
  output: [
    { type: 'reasoning', content: [{ type: 'output_text', text: 'not output' }] },
    { type: 'message', content: [{ type: 'output_text', text: '{"ok":' }] },
    { type: 'message', content: [{ type: 'output_text', text: 'true}' }] },
  ],
};

describe('Concentrate Responses transport, offline', () => {
  it('uses Responses auth, instructions, strict schema and nonstreaming without optional vendor fields', async () => {
    const fake = vi.fn(
      async () => new Response(JSON.stringify(envelope)),
    ) as unknown as typeof fetch;
    const transport = createConcentrateTransport({ apiKey: 'synthetic-key', fetch: fake });
    const result = await transport(gatewayRequest, { signal: new AbortController().signal });
    expect(fake).toHaveBeenCalledWith(
      'https://api.concentrate.ai/v1/responses',
      expect.objectContaining({
        redirect: 'error',
        headers: expect.objectContaining({ Authorization: 'Bearer synthetic-key' }),
      }),
    );
    const body = JSON.parse(vi.mocked(fake).mock.calls[0]![1]!.body as string);
    expect(body).toMatchObject({
      stream: false,
      instructions: request.system,
      text: { format: { strict: true, type: 'json_schema' } },
    });
    for (const key of [
      'tools',
      'routing',
      'effort',
      'fallbacks',
      'temperature',
      'zdr',
      'content_logging',
    ])
      expect(body).not.toHaveProperty(key);
    expect(result).toMatchObject({
      id: 'res-1',
      model: profile.model,
      text: '{"ok":true}',
      usage: null,
      actualProvider: null,
    });
  });
  it('sends reasoning.effort only when the request carries a qualified effort (FAST-03)', () => {
    expect(buildResponsesRequest(gatewayRequest)).not.toHaveProperty('reasoning');
    for (const effort of ['none', 'minimal', 'low', 'medium', 'high'] as const)
      expect(buildResponsesRequest({ ...gatewayRequest, reasoningEffort: effort })).toMatchObject({
        reasoning: { effort },
      });
  });
  it('builds bounded JPEG data URI content, never a private URL or native video', () => {
    const body = buildResponsesRequest({
      ...gatewayRequest,
      content: [{ type: 'image', mediaType: 'image/jpeg', base64: '/9g=', width: 1, height: 1 }],
    });
    expect(JSON.stringify(body)).toContain('data:image/jpeg;base64,/9g=');
    expect(JSON.stringify(body)).not.toContain('input_video');
  });
  it.each([
    [400, 'bad_request'],
    [401, 'auth'],
    [402, 'budget_exhausted'],
    [404, 'not_found'],
    [422, 'bad_request'],
    [424, 'server'],
    [429, 'rate_limited'],
    [500, 'server'],
    [503, 'server'],
    [504, 'server'],
  ])('classifies HTTP %s and hides error bodies', async (status, kind) => {
    const fake = vi.fn(
      async () =>
        new Response('PRIVATE ECHO synthetic-key BASE64', {
          status: status as number,
          headers: { 'retry-after': '2' },
        }),
    ) as unknown as typeof fetch;
    const transport = createConcentrateTransport({ apiKey: 'synthetic-key', fetch: fake });
    await expect(
      transport(gatewayRequest, { signal: new AbortController().signal }),
    ).rejects.toMatchObject({
      kind,
      status,
      retryAfterMs: 2000,
      message: `Concentrate HTTP ${status}`,
    });
    expect(fake).toHaveBeenCalledTimes(1);
  });
  it.each([
    [{ ...envelope, error: { message: 'private' } }, 'error'],
    [{ ...envelope, incomplete_details: { reason: 'max_output_tokens' } }, 'incomplete'],
    [
      {
        ...envelope,
        output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'private' }] }],
      },
      'refusal',
    ],
  ])('handles refusal/incomplete/errors explicitly', (value, outcome) => {
    expect(parseResponse(value).outcome).toBe(outcome);
  });
  it('rejects malformed envelopes and token usage instead of treating them as zero', () => {
    expect(() => parseResponse({ output: 'bad' })).toThrow('Invalid Responses envelope');
    expect(() =>
      parseResponse({ ...envelope, usage: { input_tokens: -1, output_tokens: 1 } }),
    ).toThrow();
    expect(
      parseResponse({ ...envelope, usage: { input_tokens: 2, output_tokens: 3 } }).usage,
    ).toEqual({ inputTokens: 2, outputTokens: 3 });
  });
  it('rejects unapproved hosts before transmitting secrets', () => {
    expect(() =>
      createConcentrateTransport({ apiKey: 'x', baseUrl: 'https://other.test/v1' }),
    ).toThrow('Unapproved');
  });
  it.each(['not json', 'x'.repeat(1_000_001)])(
    'bounds and sanitizes invalid body failures',
    async (body) => {
      const fake = vi.fn(async () => new Response(body)) as unknown as typeof fetch;
      const transport = createConcentrateTransport({ apiKey: 'x', fetch: fake });
      await expect(
        transport(gatewayRequest, { signal: new AbortController().signal }),
      ).rejects.toMatchObject({ kind: 'invalid_response' });
    },
  );
});
