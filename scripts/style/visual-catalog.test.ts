import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { importMetCatalog, main, MET_LIMITS, trustedMetUrl } from './visual-catalog';
import { canonicalImage, sha256 } from './private-artifacts';

const sharp = createRequire(new URL('../../packages/domain/package.json', import.meta.url))(
  'sharp',
) as (input: {
  create: { width: number; height: number; channels: number; background: string };
}) => { png(): { toBuffer(): Promise<Buffer> } };
const roots: string[] = [];
async function temp() {
  const root = await realpath(await mkdtemp('/tmp/atlas-met-synthetic-'));
  roots.push(root);
  return root;
}
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/** Synthetic garment metadata; no live Met or Commons transport. */
async function apparelFixture(detailPatch: Record<string, unknown> = {}, queries: readonly string[] = ['jacket', 'shirt', 'ensemble', 'shoes']) {
  const f = await fixture();
  const calls: { url: URL; init?: RequestInit }[] = [];
  const fetch: typeof globalThis.fetch = vi.fn(async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    if (url.pathname.endsWith('/search')) {
      const start = queries.indexOf(url.searchParams.get('q')!) * 24 + 1;
      return json({ total: 24, objectIDs: Array.from({ length: 24 }, (_, n) => start + n) });
    }
    const match = url.pathname.match(/\/objects\/(\d+)$/);
    if (match) {
      const id = Number(match[1]);
      return json(detail(id, { title: `SYNTHETIC garment ${id}`, objectName: 'Evening ensemble', ...detailPatch }));
    }
    return new Response(new Uint8Array(f.png), { headers: { 'content-type': 'image/png' } });
  });
  return { ...f, fetch, calls };
}
describe('closed Met garments-household profile', () => {
  const queries = ['dress', 'suit', 'bed', 'mug'] as const;
  it('retrieves four static non-highlight classes with six-details/class and never substitutes query types', async () => {
    const f = await apparelFixture({ objectName: 'SYNTHETIC actual API type', title: 'SYNTHETIC actual API title' }, queries);
    const root = await temp();
    const result = await importMetCatalog({
      output: join(root, 'out'), catalogVersion: 'synthetic-household', profile: 'garments-household-v1',
      maxObjects: 24, maxRequests: 80, fetch: f.fetch, sleep: async () => {},
    });
    expect(result.acquisition_status).toBe('complete');
    expect(result.schema_version).toBe('atlas_visual_catalog_v1');
    expect(result.objects).toHaveLength(24);
    expect(result.objects.map(o => o.tags[0])).toEqual([
      ...Array(6).fill('Dresses'), ...Array(6).fill('Suits'), ...Array(6).fill('Beds'), ...Array(6).fill('Mugs'),
    ]);
    expect(result.objects.every(o => o.object_type === 'SYNTHETIC actual API type' &&
      o.title === 'SYNTHETIC actual API title' && o.is_public_domain === true && o.license === 'CC0')).toBe(true);
    const searches = f.calls.filter(c => c.url.pathname.endsWith('/search'));
    expect(searches.map(c => c.url.searchParams.get('q'))).toEqual(queries);
    expect(searches.every(c => c.url.search === `?q=${c.url.searchParams.get('q')}&hasImages=true&isPublicDomain=true&offset=0&limit=24`)).toBe(true);
    expect(f.calls.filter(c => c.url.pathname.includes('/objects/'))).toHaveLength(24);
    expect(f.calls.filter(c => c.url.hostname === 'images.metmuseum.org')).toHaveLength(24);
    expect(f.calls).toHaveLength(52);
    expect(JSON.parse(await readFile(join(root, 'out/acquisition.json'), 'utf8'))).toMatchObject({
      profile: 'garments-household-v1', highlights_only: false, max_details_per_class: 6,
      max_objects_per_class: 6, considered_objects: 24, image_attempts: 24, requests: 52,
      catalog_coverage: 'unknown', supply_coverage: 'unknown',
      object_queries: { Dresses: 'dress', Suits: 'suit', Beds: 'bed', Mugs: 'mug' },
    });
    expect((await stat(join(root, 'out'))).mode & 0o777).toBe(0o700);
    expect((await stat(join(root, 'out/catalog.json'))).mode & 0o777).toBe(0o600);
    const item = result.objects[0]!;
    expect(sha256(await readFile(join(result.asset_root, item.image_path)))).toBe(item.image_sha256);
  });
  it('retains accepted metadata and reports partial rather than filling a rejected class from another', async () => {
    const f = await apparelFixture({}, queries), root = await temp();
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const match = String(input).match(/\/objects\/(\d+)$/);
      if (match && Number(match[1]) <= 24) return json(detail(Number(match[1]), { isPublicDomain: false }));
      return f.fetch(input, init);
    };
    const result = await importMetCatalog({
      output: join(root, 'out'), catalogVersion: 'synthetic-household-partial', profile: 'garments-household-v1',
      maxObjects: 24, maxRequests: 80, fetch, sleep: async () => {},
    });
    expect(result.acquisition_status).toBe('partial');
    expect(result.objects).toHaveLength(18);
    expect(result.objects.every(o => o.object_type === 'Evening ensemble' && o.title === `SYNTHETIC garment ${o.id.slice(4)}`)).toBe(true);
    expect(result.objects.map(o => o.tags[0])).toEqual([...Array(6).fill('Suits'), ...Array(6).fill('Beds'), ...Array(6).fill('Mugs')]);
    expect(JSON.parse(await readFile(join(root, 'out/acquisition.json'), 'utf8'))).toMatchObject({
      considered_objects: 24, image_attempts: 18, catalog_coverage: 'unknown', supply_coverage: 'unknown',
    });
  });
  it.each([
    { isPublicDomain: undefined }, { isPublicDomain: 'true' }, { objectID: 999 },
    { objectURL: 'https://www.metmuseum.org/art/collection/search/999' },
    { primaryImageSmall: 'https://127.0.0.1/private-photo' },
    { objectName: '' }, { title: '' },
  ])('rejects incomplete/nonpublic/unbound actual metadata %j without inferred fallbacks', async patch => {
    const f = await apparelFixture(patch, queries), root = await temp();
    const result = await importMetCatalog({
      output: join(root, 'out'), catalogVersion: 'synthetic-household-reject', profile: 'garments-household-v1',
      maxObjects: 24, maxRequests: 80, fetch: f.fetch, sleep: async () => {},
    });
    expect(result.acquisition_status).toBe('partial');
    expect(result.objects).toEqual([]);
    expect(f.calls.filter(c => c.url.pathname.includes('/objects/'))).toHaveLength(24);
  });
  it.each([401, 403, 429, 503])('stops the new profile globally on HTTP %i with no retry', async status => {
    const root = await temp(), fetch = vi.fn(async () => new Response('', { status }));
    expect((await importMetCatalog({
      output: join(root, 'out'), catalogVersion: 'synthetic-household-stop', profile: 'garments-household-v1', fetch,
    })).acquisition_status).toBe('partial');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('accepts the explicit new CLI profile using injected transport only', async () => {
    const root = await temp(), f = await apparelFixture({}, queries);
    vi.stubGlobal('fetch', f.fetch);
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    // CLI production pacing is unchanged; avoid waits by advancing the clock for every start.
    let clock = 10_000;
    vi.spyOn(Date, 'now').mockImplementation(() => (clock += 1100));
    await main(['--acquire', 'official-met-public-domain', '--profile', 'garments-household-v1',
      '--out', join(root, 'out'), '--version', 'synthetic-household-cli', '--max-objects', '1', '--max-requests', '3']);
    expect(stdout).toHaveBeenCalledWith('{"status":"complete","objects":1}\n');
    expect(f.calls[0]!.url.searchParams.get('q')).toBe('dress');
  });
});
describe('opt-in closed Met apparel profile', () => {
  it('uses four non-highlight-only static queries and bounded per-class quotas, preserving actual metadata', async () => {
    const f = await apparelFixture(), root = await temp();
    const result = await importMetCatalog({
      output: join(root, 'out'), catalogVersion: 'synthetic-apparel', profile: 'apparel-v1',
      maxObjects: 24, maxRequests: 80, fetch: f.fetch, sleep: async () => {},
    });
    expect(result.schema_version).toBe('atlas_visual_catalog_v1');
    expect(result.acquisition_status).toBe('complete');
    expect(result.objects).toHaveLength(24);
    expect(result.objects.map(o => o.tags[0])).toEqual([
      ...Array(6).fill('Jackets'), ...Array(6).fill('Shirts'), ...Array(6).fill('Ensembles'), ...Array(6).fill('Shoes'),
    ]);
    expect(result.objects.every(o => o.object_type === 'Evening ensemble' && o.title.startsWith('SYNTHETIC garment ') &&
      o.is_public_domain === true && o.license === 'CC0')).toBe(true);
    const searches = f.calls.filter(c => c.url.pathname.endsWith('/search'));
    expect(searches.map(c => c.url.searchParams.get('q'))).toEqual(['jacket', 'shirt', 'ensemble', 'shoes']);
    expect(searches.every(c => !c.url.searchParams.has('isHighlight') &&
      c.url.searchParams.get('isPublicDomain') === 'true' && c.url.searchParams.get('hasImages') === 'true' &&
      c.url.searchParams.get('offset') === '0' && c.url.searchParams.get('limit') === '24')).toBe(true);
    expect(f.calls).toHaveLength(52);
    expect(f.calls.every(c => c.init?.redirect === 'manual' && c.init.credentials === 'omit')).toBe(true);
    const report = JSON.parse(await readFile(join(root, 'out/acquisition.json'), 'utf8')) as Record<string, unknown>;
    expect(report).toMatchObject({ profile: 'apparel-v1', highlights_only: false, max_details_per_class: 6,
      max_objects_per_class: 6, considered_objects: 24, image_attempts: 24,
      catalog_coverage: 'unknown', supply_coverage: 'unknown', retrieval_basis: 'static_query_class_hint_not_verified_identity' });
    expect((await stat(join(root, 'out/assets'))).mode & 0o777).toBe(0o700);
    const first = result.objects[0]!;
    const cached = join(result.asset_root, first.image_path);
    expect((await stat(cached)).mode & 0o777).toBe(0o600);
    expect(sha256(await readFile(cached))).toBe(first.image_sha256);
  });
  it('keeps omitted and explicit historical profiles identical', async () => {
    const root = await temp(), a = await fixture(), b = await fixture();
    for (const [output, fetch, profile] of [
      ['omitted', a.fetch, undefined], ['explicit', b.fetch, 'museumobjects-v1'],
    ] as const) {
      await importMetCatalog({ output: join(root, output), catalogVersion: 'synthetic', maxObjects: 1, fetch,
        profile, sleep: async () => {} });
    }
    expect(a.calls.map(c => c.url)).toEqual(b.calls.map(c => c.url));
    expect(a.calls[0]!.url).toContain('q=statuette&hasImages=true&isPublicDomain=true&isHighlight=true&offset=0&limit=24');
  });
  it('limits small samples per class without silently spending all details on jackets', async () => {
    const f = await apparelFixture(), root = await temp();
    const result = await importMetCatalog({
      output: join(root, 'out'), catalogVersion: 'synthetic-small', profile: 'apparel-v1', maxObjects: 8,
      fetch: f.fetch, sleep: async () => {},
    });
    expect(result.objects.map(o => o.tags[0])).toEqual(['Jackets', 'Jackets', 'Shirts', 'Shirts', 'Ensembles', 'Ensembles', 'Shoes', 'Shoes']);
  });
  it.each([false, undefined, null, 'true', 1])('requires explicit actual isPublicDomain true (%s rejected before photo download)', async isPublicDomain => {
    const f = await apparelFixture({ isPublicDomain }), root = await temp();
    const result = await importMetCatalog({
      output: join(root, 'out'), catalogVersion: 'synthetic-pd', profile: 'apparel-v1',
      maxObjects: 24, maxRequests: 80, fetch: f.fetch, sleep: async () => {},
    });
    expect(result.acquisition_status).toBe('partial');
    expect(result.objects).toEqual([]);
    expect(f.calls.filter(c => c.url.hostname === 'images.metmuseum.org')).toHaveLength(0);
    expect(f.calls.filter(c => c.url.pathname.includes('/objects/'))).toHaveLength(24);
  });
  it.each([
    { primaryImageSmall: '', primaryImage: '' }, { primaryImageSmall: 'https://127.0.0.1/private-photo' },
    { primaryImageSmall: 'https://images.metmuseum.org/image.jpg?private=1' },
    { objectName: '' }, { title: '' },
  ])('never invents identities/photos when apparel metadata is incomplete or unsafe: %j', async patch => {
    const f = await apparelFixture(patch), root = await temp();
    expect((await importMetCatalog({
      output: join(root, 'out'), catalogVersion: 'synthetic-missing', profile: 'apparel-v1',
      maxObjects: 1, fetch: f.fetch, sleep: async () => {},
    })).objects).toEqual([]);
  });
  it.each([401, 403, 429, 503])('globally stops apparel acquisition on HTTP %i, without retries', async status => {
    const root = await temp();
    const fetch = vi.fn(async () => new Response('', { status }));
    const result = await importMetCatalog({
      output: join(root, 'out'), catalogVersion: 'synthetic-stop', profile: 'apparel-v1', fetch,
    });
    expect(result.acquisition_status).toBe('partial');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('keeps the request cap and lower byte/pixel/format bounds for apparel photos', async () => {
    const root = await temp(), f = await apparelFixture();
    const limited = await importMetCatalog({
      output: join(root, 'limited'), catalogVersion: 'synthetic-limited', profile: 'apparel-v1',
      maxRequests: 1, fetch: f.fetch, sleep: async () => {},
    });
    expect(limited.acquisition_status).toBe('partial');
    expect(f.calls).toHaveLength(1);
    const huge = await sharp({ create: { width: 5000, height: 4001, channels: 3, background: 'blue' } }).png().toBuffer();
    for (const [name, response] of [
      ['declared', () => new Response('x', { headers: { 'content-type': 'image/png', 'content-length': String(MET_LIMITS.responseBytes + 1) } })],
      ['streamed', () => new Response(new Uint8Array(MET_LIMITS.responseBytes + 1), { headers: { 'content-type': 'image/png' } })],
      ['pixels', () => new Response(new Uint8Array(huge), { headers: { 'content-type': 'image/png' } })],
      ['fake', () => new Response('not a photograph', { headers: { 'content-type': 'image/png' } })],
      ['svg', () => new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } })],
    ] as const) {
      const g = await apparelFixture();
      const fetch: typeof globalThis.fetch = async (input, init) => String(input).includes('images.metmuseum.org') ? response() : g.fetch(input, init);
      const result = await importMetCatalog({
        output: join(root, name), catalogVersion: 'synthetic-photo-bounds', profile: 'apparel-v1',
        maxObjects: 1, fetch, sleep: async () => {},
      });
      expect(result.acquisition_status).toBe('partial');
      expect(result.objects).toEqual([]);
    }
  });
  it('stops globally at the aggregate 128MiB budget even across failed photo decodes', async () => {
    const root = await temp(), f = await apparelFixture();
    const bytes = new Uint8Array(MET_LIMITS.responseBytes);
    let images = 0;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      if (String(input).includes('images.metmuseum.org')) {
        images++;
        return new Response(bytes, { headers: { 'content-type': 'image/png' } });
      }
      return f.fetch(input, init);
    };
    const result = await importMetCatalog({
      output: join(root, 'out'), catalogVersion: 'synthetic-total', profile: 'apparel-v1',
      maxObjects: 24, maxRequests: 80, fetch, sleep: async () => {},
    });
    expect(result.objects).toEqual([]);
    expect(images).toBe(16);
    expect(await readFile(join(root, 'out/acquisition.json'), 'utf8')).toContain('total_byte_limit_reached');
  });
  it('paces apparel transport at least 1100ms between starts', async () => {
    const root = await temp(), f = await apparelFixture();
    vi.spyOn(Date, 'now').mockReturnValue(10_000);
    const sleep = vi.fn(async (_ms: number) => {});
    await importMetCatalog({
      output: join(root, 'out'), catalogVersion: 'synthetic-pacing', profile: 'apparel-v1',
      maxObjects: 1, fetch: f.fetch, sleep,
    });
    expect(sleep.mock.calls.map(c => c[0])).toEqual([1100, 1100]);
  });
  it('aborts apparel transport at its 20s deadline, with no retry', async () => {
    const root = await temp();
    vi.useFakeTimers();
    let started!: () => void;
    const ready = new Promise<void>(done => { started = done; });
    const fetch: typeof globalThis.fetch = vi.fn(async (_input, init) => {
      started();
      return new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject(new Error('synthetic_abort')), { once: true });
      });
    });
    const work = importMetCatalog({
      output: join(root, 'out'), catalogVersion: 'synthetic-deadline', profile: 'apparel-v1', maxRequests: 1,
      fetch, sleep: async () => {},
    });
    await ready;
    await vi.advanceTimersByTimeAsync(20_001);
    expect((await work).acquisition_status).toBe('partial');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('rejects unknown profiles and arbitrary query arguments before any network/output', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const root = await temp();
    await expect(importMetCatalog({
      output: join(root, 'out'), catalogVersion: 'synthetic-invalid',
      profile: 'private-query' as 'apparel-v1', fetch,
    })).rejects.toThrow('invalid_enum');
    await expect(main(['--acquire', 'official-met-public-domain', '--out', join(root, 'out'),
      '--version', 'synthetic-invalid', '--profile', 'private-query'])).rejects.toThrow('invalid_enum');
    await expect(main(['--acquire', 'official-met-public-domain', '--query', 'private photo'])).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    await expect(stat(join(root, 'out'))).rejects.toThrow();
  });
});
const json = (x: unknown) =>
  new Response(JSON.stringify(x), { headers: { 'content-type': 'application/json' } });
const detail = (id = 1, extra = {}) => ({
  objectID: id,
  isPublicDomain: true,
  title: 'SYNTHETIC test object',
  objectName: 'Sculpture',
  medium: 'Synthetic',
  objectDate: 'Synthetic date',
  objectURL: `https://www.metmuseum.org/art/collection/search/${id}`,
  primaryImageSmall: `https://images.metmuseum.org/synthetic-${id}.png`,
  ...extra,
});
async function fixture(extra: Record<string, unknown> = {}) {
  const png = await sharp({ create: { width: 8, height: 6, channels: 3, background: 'blue' } })
    .png()
    .toBuffer();
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes('/v1.1/search')) return json({ total: 1, objectIDs: [1] });
    if (url.includes('/objects/1')) return json(detail(1, extra));
    return new Response(new Uint8Array(png), { headers: { 'content-type': 'image/png' } });
  }) as unknown as typeof globalThis.fetch;
  return { png, calls, fetch };
}
describe('hermetic official Met acquisition', () => {
  it('uses v1.1 static search, v1 details, real canonical bytes and fixed schema', async () => {
    const f = await fixture(),
      root = await temp();
    const sleep = vi.fn(async (_ms: number) => {});
    const result = await importMetCatalog({
      output: join(root, 'out'),
      catalogVersion: 'synthetic-only',
      maxObjects: 1,
      fetch: f.fetch,
      sleep,
      now: () => new Date('2026-10-27T00:00:00Z'),
    });
    expect(result.acquisition_status).toBe('complete');
    expect(result.objects[0]).toMatchObject({
      id: 'met:1',
      width: 8,
      height: 6,
      is_public_domain: true,
      license: 'CC0',
    });
    expect(f.calls[0]!.url).toContain(
      '/public/collection/v1.1/search?q=statuette&hasImages=true&isPublicDomain=true&isHighlight=true&offset=0&limit=24',
    );
    expect(f.calls[1]!.url).toBe(
      'https://collectionapi.metmuseum.org/public/collection/v1/objects/1',
    );
    expect(
      f.calls.every((c) => c.init?.redirect === 'manual' && c.init.credentials === 'omit'),
    ).toBe(true);
    expect(sleep).toHaveBeenCalledTimes(2);
    const object = result.objects[0]!;
    const bytes = await readFile(join(result.asset_root, object.image_path));
    expect(object.image_sha256).toBe(sha256(bytes));
    expect(bytes).not.toEqual(f.png);
    expect((await stat(join(root, 'out'))).mode & 0o777).toBe(0o700);
    expect((await stat(join(root, 'out/catalog.json'))).mode & 0o777).toBe(0o600);
  });
  it('reserves the bounded sample for every static class instead of filling it from the first', async () => {
    const f = await fixture();
    const root = await temp();
    const calls: string[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('/v1.1/search')) {
        const objectClass = new URL(url).searchParams.get('q');
        const start = objectClass === 'statuette' ? 1 : objectClass === 'vase' ? 9 : 17;
        return json({ total: 8, objectIDs: Array.from({ length: 8 }, (_, i) => start + i) });
      }
      const match = url.match(/\/objects\/(\d+)$/);
      if (match) return json(detail(Number(match[1])));
      return f.fetch(input, init);
    };
    const result = await importMetCatalog({
      output: join(root, 'out'),
      catalogVersion: 'synthetic-balanced',
      maxObjects: 6,
      fetch,
      sleep: async () => {},
    });
    expect(result.acquisition_status).toBe('complete');
    expect(result.objects.map((object) => object.tags[0])).toEqual([
      'Sculpture', 'Sculpture', 'Ceramics', 'Ceramics', 'Furniture', 'Furniture',
    ]);
    expect(calls.filter((url) => url.includes('/v1.1/search'))).toHaveLength(3);
    expect(calls.filter((url) => url.includes('/objects/'))).toHaveLength(6);
  });
  it.each([
    { isPublicDomain: false },
    { primaryImageSmall: '', primaryImage: '' },
    { objectID: 2 },
    { objectURL: 'https://www.metmuseum.org/art/collection/search/2' },
    { primaryImageSmall: 'https://127.0.0.1/private' },
    { title: 'x'.repeat(301) },
  ])('retains partial failures without admitting an invalid object: %j', async (extra) => {
    const f = await fixture(extra),
      root = await temp();
    const result = await importMetCatalog({
      output: join(root, 'out'),
      catalogVersion: 'synthetic',
      maxObjects: 1,
      fetch: f.fetch,
      sleep: async () => {},
    });
    expect(result.acquisition_status).toBe('partial');
    expect(result.objects).toEqual([]);
    const acquisition = JSON.parse(await readFile(join(root, 'out/acquisition.json'), 'utf8')) as {
      failures: unknown[];
      catalog_coverage: string;
    };
    expect(acquisition.failures.length).toBeGreaterThan(0);
    expect(acquisition.catalog_coverage).toBe('unknown');
  });
  it('stops globally on 429 with no retries or next query bypass', async () => {
    const root = await temp();
    const fetch = vi.fn(async () => new Response('throttled', { status: 429 }));
    const result = await importMetCatalog({
      output: join(root, 'out'),
      catalogVersion: 'synthetic',
      fetch,
    });
    expect(result.acquisition_status).toBe('partial');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await readFile(join(root, 'out/acquisition.json'), 'utf8')).toContain('rate_limited');
  });
  it('records late 429 while preserving acquired objects', async () => {
    const f = await fixture(),
      root = await temp();
    let images = 0;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes('search?')) return json({ total: 2, objectIDs: [1, 2] });
      if (url.includes('/objects/2')) return json(detail(2));
      if (url.includes('images.metmuseum.org') && ++images === 2)
        return new Response('', { status: 429 });
      return f.fetch(input, init);
    };
    const result = await importMetCatalog({
      output: join(root, 'out'),
      catalogVersion: 'synthetic',
      maxObjects: 2,
      fetch,
      sleep: async () => {},
    });
    expect(result.acquisition_status).toBe('partial');
    expect(result.objects).toHaveLength(1);
  });
  it('validates redirects before fetching the next location', async () => {
    const root = await temp();
    const fetch = vi.fn(
      async () =>
        new Response('', { status: 302, headers: { location: 'https://127.0.0.1/secret' } }),
    );
    await importMetCatalog({
      output: join(root, 'out'),
      catalogVersion: 'synthetic',
      fetch,
      sleep: async () => {},
    });
    expect(fetch.mock.calls.length).toBe(3); // one per static class, never redirected target
    expect(await readFile(join(root, 'out/acquisition.json'), 'utf8')).not.toContain('secret');
  });
  it('enforces request and response byte bounds and rejects nonimages', async () => {
    const root = await temp();
    const f = await fixture();
    const result = await importMetCatalog({
      output: join(root, 'requests'),
      catalogVersion: 'synthetic',
      maxRequests: 1,
      fetch: f.fetch,
      sleep: async () => {},
    });
    expect(f.calls).toHaveLength(1);
    expect(result.acquisition_status).toBe('partial');
    const oversized = vi.fn(
      async () =>
        new Response('{}', {
          headers: {
            'content-type': 'application/json',
            'content-length': String(MET_LIMITS.jsonBytes + 1),
          },
        }),
    );
    await importMetCatalog({
      output: join(root, 'bytes'),
      catalogVersion: 'synthetic',
      fetch: oversized,
      sleep: async () => {},
    });
    expect(await readFile(join(root, 'bytes/acquisition.json'), 'utf8')).toContain(
      'response_limit_exceeded',
    );
    await expect(canonicalImage(Buffer.from('not an image'))).rejects.toThrow();
  });
  it.each([
    'http://images.metmuseum.org/x',
    'https://images.metmuseum.org.evil.test/x',
    'https://user:private@images.metmuseum.org/x',
    'https://images.metmuseum.org/x?cookie=private',
    'https://images.metmuseum.org:444/x',
    'https://[::1]/x',
    'https://images.metmuseum.org/x#private',
  ])('rejects unsafe image URL %s', (url) =>
    expect(() => trustedMetUrl(url, 'image')).toThrow('untrusted_met_url'),
  );
  it('rejects streamed oversized JSON, excessive dimensions and legacy search envelopes', async () => {
    const root = await temp();
    const fetch = vi.fn(
      async () =>
        new Response(new Uint8Array(MET_LIMITS.jsonBytes + 1), {
          headers: { 'content-type': 'application/json' },
        }),
    );
    const result = await importMetCatalog({
      output: join(root, 'stream'),
      catalogVersion: 'synthetic',
      fetch,
      sleep: async () => {},
    });
    expect(result.acquisition_status).toBe('partial');
    expect(await readFile(join(root, 'stream/acquisition.json'), 'utf8')).toContain(
      'response_limit_exceeded',
    );
    const huge = await sharp({
      create: { width: 8193, height: 1, channels: 3, background: 'blue' },
    })
      .png()
      .toBuffer();
    await expect(canonicalImage(huge)).rejects.toThrow('invalid_image');
    const unsupported = vi.fn(async () => json({ results: [detail()] }));
    await importMetCatalog({
      output: join(root, 'envelope'),
      catalogVersion: 'synthetic',
      fetch: unsupported,
      sleep: async () => {},
    });
    expect(await readFile(join(root, 'envelope/acquisition.json'), 'utf8')).toContain(
      'unsupported_search_envelope',
    );
  });
  it('never forwards changed API query parameters across redirects', async () => {
    const root = await temp();
    const fetch = vi.fn(
      async () =>
        new Response('', {
          status: 302,
          headers: {
            location: 'https://collectionapi.metmuseum.org/public/collection/v1.1/search?q=private',
          },
        }),
    );
    await importMetCatalog({
      output: join(root, 'out'),
      catalogVersion: 'synthetic',
      fetch,
      sleep: async () => {},
    });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(await readFile(join(root, 'out/acquisition.json'), 'utf8')).toContain(
      'untrusted_redirect',
    );
  });
  it('never overwrites and rejects symlink ancestors and Git output', async () => {
    const f = await fixture(),
      root = await temp();
    await mkdir(join(root, 'existing'));
    await expect(
      importMetCatalog({
        output: join(root, 'existing'),
        catalogVersion: 'synthetic',
        fetch: f.fetch,
      }),
    ).rejects.toThrow();
    await mkdir(join(root, 'git'));
    await writeFile(join(root, 'git/.git'), 'synthetic worktree marker');
    await expect(
      importMetCatalog({
        output: join(root, 'git/out'),
        catalogVersion: 'synthetic',
        fetch: f.fetch,
      }),
    ).rejects.toThrow('private_output_inside_git');
    await symlink(join(root, 'existing'), join(root, 'link'));
    await expect(
      importMetCatalog({
        output: join(root, 'link/out'),
        catalogVersion: 'synthetic',
        fetch: f.fetch,
      }),
    ).rejects.toThrow('symlink_not_allowed');
    expect(f.calls).toHaveLength(0);
  });
  it('requires explicit CLI acquisition authorization before network', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(main([])).rejects.toThrow('explicit_acquisition_arguments_required');
    await expect(
      main(['--out', '/tmp/unused', '--version', 'synthetic', '--query', 'private']),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
