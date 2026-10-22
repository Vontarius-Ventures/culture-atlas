import { describe, expect, it } from 'vitest';
import { PINNED_CONCENTRATE_ROUTES } from './concentrate/catalog';
import { ProviderError } from './errors';
import { createProviderRegistry } from './registry';
import { FakeQloo } from './testing';

describe('provider registry', () => {
  it('reports Qloo unavailable (not_configured) without QLOO_API_KEY and never fabricates results', async () => {
    const reg = createProviderRegistry({ STORAGE_DRIVER: 'memory' });
    const matrix = reg.capabilities();
    expect(matrix['qloo.search']).toMatchObject({ status: 'unavailable', reason: 'not_configured' });
    expect(matrix['qloo.insights'].status).toBe('unavailable');
    expect(matrix['vlm.analyze_image']).toMatchObject({ status: 'unavailable', reason: 'not_configured' });
    expect(matrix['storage.objects'].status).toBe('available');
    await expect(reg.qloo.searchEntities({ query: 'Levi’s' })).rejects.toBeInstanceOf(ProviderError);
  });

  it('uses the configured base URL and model defaults', () => {
    const reg = createProviderRegistry({ QLOO_API_URL: 'https://qloo.example.test' });
    expect(reg.config.QLOO_API_URL).toBe('https://qloo.example.test');
    // Concentrate is the default gateway and has no baked-in dispatch model: profiles pin qualified IDs.
    expect(reg.config.LLM_PROVIDER).toBe('concentrate');
    expect(reg.config.VLM_MODEL).toBe('');
    expect(reg.modelGateway).toBeDefined();
    // Explicit operational rollback options keep their defaults.
    expect(createProviderRegistry({ LLM_PROVIDER: 'featherless' }).config.VLM_MODEL).toBe('google/gemma-3-27b-it');
    expect(createProviderRegistry({ LLM_PROVIDER: 'anthropic' }).config.VLM_MODEL).toBe('claude-sonnet-5-5');
    const rollback = createProviderRegistry({
      LLM_PROVIDER: 'featherless',
      FEATHERLESS_API_KEY: 'fk',
      STORAGE_DRIVER: 'memory',
    });
    expect(rollback.vlm.capability()).toMatchObject({
      status: 'unverified',
      provider: 'featherless:google/gemma-3-27b-it',
    });
    expect(rollback.modelGateway).toBeUndefined();
  });

  it('never falls back to Featherless when Concentrate is the default but unconfigured', () => {
    const unconfigured = createProviderRegistry({
      STORAGE_DRIVER: 'memory',
      FEATHERLESS_API_KEY: 'configured-for-rollback-only',
    });
    expect(unconfigured.vlm.id).not.toContain('featherless');
    expect(unconfigured.vlm.capability()).toMatchObject({ status: 'unavailable', reason: 'not_configured' });
    expect(unconfigured.text.capability()).toMatchObject({ status: 'unavailable', reason: 'not_configured' });
    const bothKeys = createProviderRegistry({
      STORAGE_DRIVER: 'memory',
      CONCENTRATE_API_KEY: 'synthetic',
      FEATHERLESS_API_KEY: 'configured-for-rollback-only',
    });
    expect(bothKeys.vlm.id).not.toContain('featherless');
    expect(bothKeys.vlm.capability()).toMatchObject({
      status: 'unverified',
      provider: `concentrate:${PINNED_CONCENTRATE_ROUTES.vision.model}`,
    });
  });

  it('reports vlm/text/qloo unverified when Concentrate and Qloo keys are present, without dispatching', async () => {
    const reg = createProviderRegistry({
      STORAGE_DRIVER: 'memory',
      CONCENTRATE_API_KEY: 'synthetic',
      QLOO_API_KEY: 'synthetic-qloo',
    });
    expect(reg.capabilities()['vlm.analyze_image']).toMatchObject({
      status: 'unverified',
      reason: 'probe_pending',
      provider: `concentrate:${PINNED_CONCENTRATE_ROUTES.vision.model}`,
    });
    expect(reg.capabilities()['text.generate']).toMatchObject({
      status: 'unverified',
      reason: 'probe_pending',
      provider: `concentrate:${PINNED_CONCENTRATE_ROUTES.text.model}`,
    });
    expect(reg.capabilities()['qloo.search']).toMatchObject({ status: 'unverified', reason: 'probe_pending' });
    await expect(
      reg.vlm.analyzeImage({ image: { bytes: new Uint8Array([0xff, 0xd8, 0xff]), mediaType: 'image/jpeg' } }),
    ).rejects.toBeInstanceOf(ProviderError);
  });

  it('exposes music recognition as unavailable and never fabricates a match', async () => {
    const reg = createProviderRegistry({ STORAGE_DRIVER: 'memory' });
    expect(reg.music.capability()).toMatchObject({ status: 'unavailable', reason: 'not_implemented' });
    expect(reg.capabilities()['music.recognize']).toMatchObject({
      status: 'unavailable',
      reason: 'not_implemented',
    });
    await expect(
      reg.music.recognize({ audio: { bytes: new Uint8Array([1, 2, 3]), mediaType: 'audio/mpeg' } }),
    ).rejects.toMatchObject({ kind: 'unavailable' });
  });

  it('accepts overrides; fake Qloo results are marked as replays unless live', async () => {
    const qloo = new FakeQloo({ search: () => [{ entity_id: 'E1', name: 'Brand', types: ['urn:entity:brand'], properties: {}, tags: [] }] });
    const reg = createProviderRegistry({ STORAGE_DRIVER: 'memory' }, { qloo });
    const res = await reg.qloo.searchEntities({ query: 'brand' });
    expect(res.is_replay).toBe(true);
    expect(res.data[0]?.entity_id).toBe('E1');
    expect(reg.capabilities()['qloo.search'].status).toBe('available');
  });
});
