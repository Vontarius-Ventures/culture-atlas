import { describe, expect, it } from 'vitest';
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
    expect(reg.config.VLM_MODEL).toBe('claude-sonnet-5-5');
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
