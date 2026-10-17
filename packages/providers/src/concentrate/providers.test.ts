import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { loadProviderConfig } from '../config';
import { createProviderRegistry } from '../registry';
import { MemorySpendStore, ModelSpendLedger } from '../model-gateway/budget';
import { StructuredResponseRunner } from '../model-gateway/runner';
import { strictJsonSchema, validateStrictShape } from '../model-gateway/schema';
import { VlmAnalysis } from '../vlm/types';
import { analyzeVideoFrames, ConcentrateVlm, validateVision } from './providers';
import { createModelGateway } from './gateway';
import { ModelProfileSchema } from './profiles';
import { identity, limits, profile, response, validVision, visionProfile } from './test-fixtures';

describe('role profiles and adapters, offline', () => {
  it.each([
    { model: 'auto' },
    { model: 'bare-model' },
    { provider: 'different' },
    { requireZdr: false },
    { providerZdrEligible: false },
    { contentLoggingEnabled: true },
    { allowedFallbackProviders: ['other'] },
    { qualificationArtifactId: '' },
    { timeoutMs: 15_001 },
  ])('fails closed on unqualified routing/privacy profile %j', (changes) => {
    expect(ModelProfileSchema.safeParse({ ...profile, ...changes }).success).toBe(false);
  });
  it('defaults to Concentrate, never falls back to Featherless, and keeps Qloo independent without durable dependencies', () => {
    const reg = createProviderRegistry({
      LLM_PROVIDER: 'concentrate',
      CONCENTRATE_API_KEY: 'synthetic',
      FEATHERLESS_API_KEY: 'configured-other',
      STORAGE_DRIVER: 'memory',
    });
    expect(loadProviderConfig({}).LLM_PROVIDER).toBe('concentrate');
    expect(loadProviderConfig({ LLM_PROVIDER: 'featherless' }).LLM_PROVIDER).toBe('featherless');
    expect(reg.vlm.capability().status).toBe('unavailable');
    expect(reg.text.capability().status).toBe('unavailable');
    expect(reg.storage.capability().objects.status).toBe('available');
    expect(reg.qloo.id).not.toContain('concentrate');
  });
  it('independently disables a missing composer profile without borrowing research credentials', () => {
    const gateway = createModelGateway(
      loadProviderConfig({ LLM_PROVIDER: 'concentrate', CONCENTRATE_API_KEY: 'synthetic' }),
      {
        ledger: new ModelSpendLedger(new MemorySpendStore(), limits),
        profiles: { research_text: profile },
        identity,
        transport: vi.fn(async () => response),
        qualification: () => 'qualified',
        allowTestStore: true,
      },
    );
    expect(gateway.text.capability().status).toBe('unverified');
    expect(gateway.composer.capability().status).toBe('unavailable');
    expect(gateway.vlm.capability().status).toBe('unavailable');
  });
  it('requires explicit environment privacy assertions and no gateway fallback', () => {
    const config = loadProviderConfig({
      LLM_PROVIDER: 'concentrate',
      CONCENTRATE_API_KEY: 'synthetic',
      CONCENTRATE_REQUIRE_ZDR: 'false',
    });
    expect(createModelGateway(config).text.capability().status).toBe('unavailable');
    expect(() => loadProviderConfig({ CONCENTRATE_GATEWAY_FALLBACKS_ENABLED: 'true' })).toThrow();
  });
  it('transforms actual VLM and nullable composer-style schemas without allowing extra keys/default omissions', () => {
    const json = strictJsonSchema(VlmAnalysis);
    expect(() => validateStrictShape(validVision, json)).not.toThrow();
    expect(() => validateStrictShape({ ...validVision, quality: { usable: true } }, json)).toThrow(
      'Missing',
    );
    expect(() =>
      validateStrictShape(
        { ...validVision, quality: { usable: true, issue: null, injected: true } },
        json,
      ),
    ).toThrow('Unknown');
    const optional = z.object({ year: z.number().nullable().optional() });
    expect(() => validateStrictShape({ year: null }, strictJsonSchema(optional))).not.toThrow();
    expect(() => validateStrictShape({}, strictJsonSchema(optional))).toThrow();
  });
  it.each([
    { observations: [{ id: 'o1', text: 'table', kind: 'object', region_ids: ['missing'] }] },
    { regions: [...validVision.regions, ...validVision.regions] },
    { regions: [{ ...validVision.regions[0], box: { x: 0.9, y: 0, w: 0.5, h: 0.5 } }] },
  ])('rejects invalid VLM references/geometry', (changes) => {
    expect(() => validateVision(VlmAnalysis.parse({ ...validVision, ...changes }), 8)).toThrow();
  });
  it('reads a real normalized JPEG derivative and validates the full VLM output', async () => {
    const bytes = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#fff' } })
      .jpeg()
      .toBuffer();
    const transport = vi.fn(async () => ({ ...response, text: JSON.stringify(validVision) }));
    const runner = new StructuredResponseRunner(
      visionProfile,
      transport,
      new ModelSpendLedger(new MemorySpendStore(), limits),
      { identity, allowTestStore: true },
    );
    const vlm = new ConcentrateVlm(runner);
    expect(
      (await vlm.analyzeImage({ image: { bytes, mediaType: 'image/jpeg' } })).analysis.title,
    ).toBe('Table');
    expect(transport.mock.calls).toHaveLength(1);
    await expect(
      vlm.analyzeImage({ image: { bytes: new Uint8Array([1, 2]), mediaType: 'image/jpeg' } }),
    ).rejects.toMatchObject({ kind: 'bad_request' });
  });
  it('caps videos at eight frames before any call and preserves server-owned timestamps on partial outcomes', async () => {
    const analyzeImage = vi
      .fn()
      .mockResolvedValueOnce({ analysis: validVision, model: profile.model, durationMs: 1 })
      .mockRejectedValueOnce(new Error('safe'));
    const provider = {
      id: 'fake',
      capability: () => ({ status: 'available' as const }),
      analyzeImage,
    };
    const image = { bytes: new Uint8Array([1]), mediaType: 'image/jpeg' as const };
    const frames = [
      { derivativeId: 'f1', timestampMs: 0, image },
      { derivativeId: 'f2', timestampMs: 1000, image },
    ];
    const out = await analyzeVideoFrames(provider, frames, 2000, { modelIdentity: identity });
    expect(out).toMatchObject({
      status: 'partial',
      frames: [
        { derivativeId: 'f1', timestampMs: 0 },
        { derivativeId: 'f2', timestampMs: 1000, error: 'unavailable' },
      ],
    });
    expect(analyzeImage.mock.calls[0]![1]).toMatchObject({
      modelIdentity: { ...identity, attemptKey: `${identity.attemptKey}:frame:f1` },
    });
    await expect(
      analyzeVideoFrames(provider, Array(9).fill(frames[0]), 2000, { modelIdentity: identity }),
    ).rejects.toMatchObject({ kind: 'bad_request' });
    await expect(
      analyzeVideoFrames(provider, frames.reverse(), 2000, { modelIdentity: identity }),
    ).rejects.toMatchObject({ kind: 'bad_request' });
    expect(analyzeImage).toHaveBeenCalledTimes(2);
  });
});
