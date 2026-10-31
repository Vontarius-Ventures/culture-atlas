import { afterEach, describe, expect, it } from 'vitest';
import { setDomainConfigForTesting } from '@culture-atlas/domain';
import { testConfig } from '@culture-atlas/domain/testing';
import { syntheticVisualCatalog } from '../../../../../../../packages/domain/src/style/visual-test-support';
import { GET } from './route';

afterEach(() => setDomainConfigForTesting(undefined));
describe('read-only public catalog image route', () => {
  it('returns bounded image bytes only for validated cached CC0 hash and denies paths/URLs', async () => {
    const fixture = await syntheticVisualCatalog();
    try {
      setDomainConfigForTesting(testConfig({ VISUAL_REFERENCE_CATALOG_FILE: fixture.file }));
      const hash = fixture.catalog.objects[0]!.image_sha256;
      const response = await GET(new Request('https://atlas.test/v1/visual-references/images/' + hash), { params: Promise.resolve({ hash }) });
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('image/jpeg');
      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(response.headers.get('ETag')).toBe(`"${hash}"`);
      expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
      for (const invalid of ['../../private/photo.jpg', 'https://127.0.0.1/private.jpg', 'a'.repeat(64)]) {
        const denied = await GET(new Request('https://atlas.test/v1/visual-references/images/test'), { params: Promise.resolve({ hash: invalid }) });
        expect(denied.status).toBe(404);
        expect(await denied.text()).toBe('');
        expect(denied.headers.get('Cache-Control')).toBe('no-store');
      }
    } finally { await fixture.cleanup(); }
  });
});
