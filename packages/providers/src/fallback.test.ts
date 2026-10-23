import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { loadProviderConfig } from './config';
import { ProviderError } from './errors';
import { FallbackTextModel, createElorianVlm, elorianEnabled, shouldFallBack, withModelFallback } from './fallback';
import { createProviderRegistry } from './registry';
import type { TextModelProvider } from './text/types';
import { UnavailableTextModel } from './unavailable';

const ok = { title: 't', interpretation: 'i', observations: [], visible_text: [], candidates: [], regions: [], uncertainty: { overall: 'low' }, quality: { usable: true } };

function chatFetch(content: string, calls: Array<{ url: string; body: Record<string, unknown>; auth: string }>) {
  return (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(init.body as string), auth: (init.headers as Record<string, string>).Authorization! });
    return new Response(JSON.stringify({ model: 'elorian-1-agent', choices: [{ finish_reason: 'stop', message: { content } }], usage: { prompt_tokens: 5, completion_tokens: 5 } }), { status: 200 });
  }) as unknown as typeof fetch;
}

const failing = (kind: ConstructorParameters<typeof ProviderError>[1]): TextModelProvider => ({
  id: 'text:primary',
  capability: () => ({ status: 'available' }),
  generateStructured: async () => {
    throw new ProviderError('concentrate', kind, `primary ${kind}`);
  },
});

describe('Elorian model fallback', () => {
  it('is off unless MODEL_FALLBACK=elorian and ELORIAN_API_KEY are both set', () => {
    expect(elorianEnabled(loadProviderConfig({ ELORIAN_API_KEY: 'k' }))).toBe(false);
    expect(elorianEnabled(loadProviderConfig({ MODEL_FALLBACK: 'elorian' }))).toBe(false);
    expect(elorianEnabled(loadProviderConfig({ MODEL_FALLBACK: 'elorian', ELORIAN_API_KEY: 'k' }))).toBe(true);
    const reg = createProviderRegistry({ STORAGE_DRIVER: 'memory', ELORIAN_API_KEY: 'k' });
    expect(reg.fallbackVlm).toBeUndefined();
    expect(reg.vlm.id).not.toContain('elorian');
  });

  it('wires Elorian behind the primary models in the registry', () => {
    const reg = createProviderRegistry({ STORAGE_DRIVER: 'memory', MODEL_FALLBACK: 'elorian', ELORIAN_API_KEY: 'k' });
    expect(reg.vlm.id).toContain('fallback:vlm:elorian:elorian-1-agent');
    expect(reg.text.id).toContain('fallback:text:elorian');
    expect(reg.fallbackVlm?.id).toBe('vlm:elorian:elorian-1-agent');
    // Concentrate is unconfigured here, so the combined capability reports the fallback.
    expect(reg.capabilities()['vlm.analyze_image'].status).toBe('unverified');
  });

  it('falls through only on provider-side failures', () => {
    for (const kind of ['unavailable', 'timeout', 'incomplete_response', 'invalid_response', 'rate_limited', 'server'] as const)
      expect(shouldFallBack(new ProviderError('x', kind, kind))).toBe(true);
    for (const kind of ['bad_request', 'content_rejected', 'aborted', 'budget_exhausted'] as const)
      expect(shouldFallBack(new ProviderError('x', kind, kind))).toBe(false);
    expect(shouldFallBack(new Error('local bug'))).toBe(false);
  });

  it('sends an OpenAI-style request to Elorian with max_completion_tokens and validates the reply', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown>; auth: string }> = [];
    const config = loadProviderConfig({ MODEL_FALLBACK: 'elorian', ELORIAN_API_KEY: 'elor_test' });
    const vlm = createElorianVlm(config, chatFetch(JSON.stringify(ok), calls));
    const res = await vlm.analyzeImage({ image: { bytes: new Uint8Array([0xff, 0xd8, 0xff]), mediaType: 'image/jpeg' } });
    expect(res.analysis.title).toBe('t');
    expect(calls[0]!.url).toBe('https://api.elorian.ai/v1/chat/completions');
    expect(calls[0]!.auth).toBe('Bearer elor_test');
    expect(calls[0]!.body.model).toBe('elorian-1-agent');
    expect(calls[0]!.body.max_completion_tokens).toBeGreaterThan(0);
    expect(calls[0]!.body.max_tokens).toBeUndefined();
  });

  it('uses Elorian after a primary timeout, and reports the primary error when both fail', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown>; auth: string }> = [];
    const config = loadProviderConfig({ MODEL_FALLBACK: 'elorian', ELORIAN_API_KEY: 'k' });
    const wrapped = withModelFallback(
      config,
      { vlm: createElorianVlm(config, chatFetch('{}', [])), text: failing('timeout'), composer: new UnavailableTextModel() },
      chatFetch(JSON.stringify({ ok: true }), calls),
    );
    const req = { system: 's', prompt: 'p', schema: z.object({ ok: z.boolean() }), schemaName: 'x' };
    expect((await wrapped.text.generateStructured(req)).data.ok).toBe(true);
    expect(calls).toHaveLength(1);

    const bothFail = new FallbackTextModel(failing('server'), failing('unavailable'));
    await expect(bothFail.generateStructured(req)).rejects.toMatchObject({ kind: 'server', message: 'primary server' });
  });

  it('never falls back on a refusal or our own bad request', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown>; auth: string }> = [];
    const config = loadProviderConfig({ MODEL_FALLBACK: 'elorian', ELORIAN_API_KEY: 'k' });
    const req = { system: 's', prompt: 'p', schema: z.object({ ok: z.boolean() }), schemaName: 'x' };
    for (const kind of ['content_rejected', 'bad_request'] as const) {
      const wrapped = withModelFallback(
        config,
        { vlm: createElorianVlm(config, chatFetch('{}', [])), text: failing(kind), composer: new UnavailableTextModel() },
        chatFetch(JSON.stringify({ ok: true }), calls),
      );
      await expect(wrapped.text.generateStructured(req)).rejects.toMatchObject({ kind });
    }
    expect(calls).toHaveLength(0);
  });
});
