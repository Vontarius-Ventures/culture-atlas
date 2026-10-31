import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { COMMONS_LIMITS, COMMONS_PROFILES, commonsPlainText, importCommonsCatalog, main, trustedCommonsUrl } from './commons-visual-catalog';
import { COMMONS_LICENSES, loadVisualCatalog, readVisualCatalogImage } from '../../packages/domain/src/style/visual-catalog';

const sharp = createRequire(new URL('../../packages/domain/package.json', import.meta.url))('sharp') as
  (input: { create: { width: number; height: number; channels: number; background: string } }) => { png(): { toBuffer(): Promise<Buffer> } };
const roots: string[] = [];
async function temp() { const root = await realpath(await mkdtemp('/tmp/atlas-commons-synthetic-')); roots.push(root); return root; }
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
const json = (query: unknown) => new Response(JSON.stringify({ query }), { headers: { 'content-type': 'application/json' } });
async function fixture(patch: Record<string, unknown> = {}, metaPatch: Record<string, unknown> = {}) {
  const bytes = await sharp({ create: { width: 8, height: 6, channels: 3, background: 'blue' } }).png().toBuffer();
  const meta = {
    LicenseShortName: { value: 'CC BY-SA 4.0' }, LicenseUrl: { value: COMMONS_LICENSES['CC-BY-SA-4.0'] },
    Artist: { value: '<a href="https://example.invalid">Synthetic creator</a>' }, Copyrighted: { value: 'True' }, ...metaPatch,
  };
  const page = (id: number) => ({ pageid: id, ns: 6, title: `File:SYNTHETIC ${id}.png`,
    imageinfo: [{ url: `https://upload.wikimedia.org/wikipedia/commons/a/ab/SYNTHETIC_${id}.png`,
      width: 8, height: 6, size: bytes.length, mime: 'image/png', sha1: createHash('sha1').update(bytes).digest('hex'), extmetadata: meta, ...patch }] });
  const calls: { url: URL; init?: RequestInit }[] = [];
  const fetch: typeof globalThis.fetch = vi.fn(async (input, init) => {
    const url = new URL(String(input)); calls.push({ url, init });
    if (url.hostname === 'upload.wikimedia.org') return new Response(new Uint8Array(bytes), { headers: { 'content-type': 'image/png' } });
    if (url.searchParams.has('srsearch')) return json({ search: Array.from({ length: 24 }, (_, i) => ({ pageid: i + 1, ns: 6, title: `File:SYNTHETIC ${i + 1}.png` })) });
    return json({ pages: [page(Number(url.searchParams.get('pageids')))] });
  });
  return { bytes, fetch, calls, page };
}
async function run(f: Awaited<ReturnType<typeof fixture>>, extra = {}) {
  return importCommonsCatalog({ output: join(await temp(), 'out'), catalogVersion: 'synthetic-only', maxImages: 1, fetch: f.fetch, sleep: async () => {}, ...extra });
}
describe('hermetic Commons licensed reference acquisition', () => {
  it.each([
    ['CC0', 'CC0', 'False'], ['CC BY 4.0', 'CC-BY-4.0', 'True'], ['CC BY-SA 4.0', 'CC-BY-SA-4.0', 'True'],
  ] as const)('admits only exact tested license tuple %s and canonical local images', async (short, license, copyrighted) => {
    const f = await fixture({}, { LicenseShortName: { value: short }, LicenseUrl: { value: COMMONS_LICENSES[license] }, Copyrighted: { value: copyrighted } });
    const sleep = vi.fn(async (_ms: number) => {});
    const catalog = await run(f, { sleep });
    expect(catalog.schema_version).toBe('atlas_visual_catalog_v2');
    expect(catalog.acquisition_status).toBe('complete');
    expect(catalog.objects[0]).toMatchObject({
      id: 'commons:1', license, is_public_domain: license === 'CC0', creator: 'Synthetic creator', attribution: 'Synthetic creator',
      source_url: 'https://commons.wikimedia.org/?curid=1', object_type: 'outfit',
      retrieval: { basis: 'static_query_hint_not_verified_identity', depiction: 'object' },
    });
    expect(f.calls).toHaveLength(3);
    expect(f.calls[0]!.url.searchParams.get('srsearch')).toBe(COMMONS_PROFILES['generic-scenes-objects-v1'][0][1]);
    expect(f.calls[1]!.url.searchParams.get('iiprop')).toBe('url|size|mime|sha1|extmetadata');
    expect(f.calls.every(c => c.init?.credentials === 'omit' && c.init.redirect === 'manual' && !!c.init.signal)).toBe(true);
    expect(sleep).toHaveBeenCalledTimes(2);
    const dir = join(catalog.asset_root, '..');
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, 'catalog.json'))).mode & 0o777).toBe(0o600);
    const loaded = await loadVisualCatalog(join(catalog.asset_root.replace(/\/assets$/, ''), 'catalog.json'));
    expect(loaded).not.toBeNull();
    const image = await readVisualCatalogImage(catalog, catalog.objects[0]!);
    expect(image.contentType).toBe('image/jpeg');
    expect(image.bytes).not.toEqual(f.bytes);
  });
  it('marks bedroom/interior query results as scenes, never museum-object identity', async () => {
    const catalog = await run(await fixture(), { profile: 'scenes-v1' });
    expect(catalog.objects[0]).toMatchObject({ object_type: 'bedroom', retrieval: { depiction: 'scene', basis: 'static_query_hint_not_verified_identity' } });
  });
  it.each([
    { LicenseShortName: { value: 'Public domain' } },
    { LicenseShortName: { value: 'CC BY-SA 3.0' } },
    { LicenseUrl: { value: 'http://creativecommons.org/licenses/by-sa/4.0/' } },
    { LicenseUrl: { value: 'https://evil.invalid/license' } },
    { Artist: { value: '' } }, { Artist: { value: 'x'.repeat(1001) } },
    { Copyrighted: { value: 'False' } }, { Attribution: { value: '&lt;script&gt;' } },
  ])('rejects unsupported/contradictory/incomplete license metadata %j before images', async meta => {
    const f = await fixture({}, meta);
    expect((await run(f)).objects).toHaveLength(0);
    expect(f.calls.every(c => c.url.hostname === 'commons.wikimedia.org')).toBe(true);
  });
  it.each([
    { url: 'https://127.0.0.1/photo.jpg' }, { url: 'https://upload.wikimedia.org.evil.invalid/wikipedia/commons/a/ab/a.jpg' },
    { width: 8193 }, { width: 8000, height: 8000 }, { size: COMMONS_LIMITS.imageBytes + 1 }, { mime: 'image/svg+xml' },
    { size: 1 }, { width: 9 }, { sha1: '0'.repeat(40) }, { sha1: undefined },
    { url: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Wrong_title.png' },
  ])('rejects unsafe originals or mismatched originals %j', async patch => {
    const f = await fixture(patch);
    expect((await run(f)).objects).toHaveLength(0);
  });
  it('binds API pageid/title exactly, without downloading mismatched originals', async () => {
    for (const patch of [{ pageid: 999 }, { title: 'File:wrong.png' }, { ns: 0 }, { missing: true }]) {
      const f = await fixture();
      const fetch: typeof globalThis.fetch = async (input, init) => {
        const u = new URL(String(input));
        if (u.searchParams.has('pageids')) return json({ pages: [{ ...f.page(Number(u.searchParams.get('pageids'))), ...patch }] });
        return f.fetch(input, init);
      };
      expect((await run(f, { fetch })).objects).toEqual([]);
      expect(f.calls.every(c => c.url.hostname !== 'upload.wikimedia.org')).toBe(true);
    }
  });
  it.each([429, 503, 401, 403])('stops globally on HTTP %i with no retries', async status => {
    const f = await fixture();
    const fetch = vi.fn(async () => new Response('', { status }));
    const catalog = await run(f, { fetch });
    expect(catalog.acquisition_status).toBe('partial');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('stops on a late throttle and preserves earlier acquired records', async () => {
    const f = await fixture();
    let n = 0;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      if (String(input).includes('upload.wikimedia.org') && ++n === 2) return new Response('', { status: 503 });
      return f.fetch(input, init);
    };
    const catalog = await run(f, { maxImages: 4, profile: 'scenes-v1', fetch });
    expect(catalog.objects).toHaveLength(1);
    expect(catalog.acquisition_status).toBe('partial');
    expect(n).toBe(2);
  });
  it('caps detail/image attempts, enforces request budgets and keeps coverage unknown', async () => {
    const f = await fixture();
    const catalog = await run(f, { maxImages: 24, profile: 'scenes-v1' });
    const report = JSON.parse(await readFile(join(catalog.asset_root, '../acquisition.json'), 'utf8')) as Record<string, unknown>;
    expect(report.considered_details).toBeLessThanOrEqual(24);
    expect(report.image_attempts).toBeLessThanOrEqual(24);
    expect(report.requests).toBeLessThanOrEqual(80);
    expect(report.catalog_coverage).toBe('unknown');
    const g = await fixture();
    expect((await run(g, { maxRequests: 1 })).objects).toEqual([]);
    expect(g.calls).toHaveLength(1);
  });
  it('validates redirects before following, never forwards changed API queries', async () => {
    for (const location of ['https://127.0.0.1/private', 'https://commons.wikimedia.org/w/api.php?srsearch=private']) {
      const f = await fixture();
      const fetch = vi.fn(async () => new Response('', { status: 302, headers: { location } }));
      await run(f, { fetch });
      expect(fetch).toHaveBeenCalledTimes(10); // one failed request for each fixed query, no redirected target
    }
  });
  it('paces all requests sequentially by at least 1100ms', async () => {
    const f = await fixture();
    vi.spyOn(Date, 'now').mockReturnValue(10_000);
    const sleep = vi.fn(async (_ms: number) => {});
    await run(f, { sleep });
    expect(sleep.mock.calls.map(c => c[0])).toEqual([1100, 1100]);
  });
  it('aborts an injected slow fetch at the 20s deadline without retry', async () => {
    const f = await fixture();
    vi.useFakeTimers();
    let started!: () => void;
    const ready = new Promise<void>(done => { started = done; });
    const fetch: typeof globalThis.fetch = vi.fn(async (_input, init) => {
      started();
      return new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject(new Error('synthetic_abort')), { once: true });
      });
    });
    const work = run(f, { fetch, maxRequests: 1 });
    await ready;
    await vi.advanceTimersByTimeAsync(20_001);
    expect((await work).acquisition_status).toBe('partial');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('stops globally at the aggregate 128MiB streamed-byte bound', async () => {
    const bytes = Buffer.alloc(COMMONS_LIMITS.imageBytes);
    const hash = createHash('sha1').update(bytes).digest('hex');
    const f = await fixture({ size: bytes.length, sha1: hash });
    let searches = 0, imageCalls = 0;
    const fetch: typeof globalThis.fetch = async (input) => {
      const u = new URL(String(input));
      if (u.hostname === 'upload.wikimedia.org') {
        imageCalls++;
        return new Response(new Uint8Array(bytes), { headers: { 'content-type': 'image/png' } });
      }
      if (u.searchParams.has('srsearch')) {
        const offset = searches++ * 12;
        return json({ search: Array.from({ length: 12 }, (_, n) => ({ pageid: offset + n + 1, ns: 6, title: `File:SYNTHETIC ${offset + n + 1}.png` })) });
      }
      return json({ pages: [f.page(Number(u.searchParams.get('pageids')))] });
    };
    const catalog = await run(f, { fetch, maxImages: 24, profile: 'scenes-v1' });
    const report = JSON.parse(await readFile(join(catalog.asset_root, '../acquisition.json'), 'utf8')) as { stopped: boolean; failures: { code: string }[] };
    expect(report.stopped).toBe(true);
    expect(report.failures.some(v => v.code === 'total_byte_limit_reached')).toBe(true);
    expect(imageCalls).toBe(16);
    expect(catalog.objects).toEqual([]);
  });
  it('allows at most two validated official redirects per request', async () => {
    const f = await fixture();
    const counts = new Map<string, number>();
    const fetch: typeof globalThis.fetch = vi.fn(async (input) => {
      const key = String(input), n = (counts.get(key) ?? 0) + 1; counts.set(key, n);
      return new Response('', { status: 302, headers: { location: key } });
    });
    await run(f, { fetch, profile: 'scenes-v1' });
    expect([...counts.values()]).toEqual([3, 3]);
  });
  it('rejects declared/streamed excessive responses and invalid image payloads', async () => {
    for (const response of [
      () => new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': String(COMMONS_LIMITS.jsonBytes + 1) } }),
      () => new Response(new Uint8Array(COMMONS_LIMITS.jsonBytes + 1), { headers: { 'content-type': 'application/json' } }),
      () => new Response('<html>error</html>', { headers: { 'content-type': 'text/html' } }),
    ]) expect((await run(await fixture(), { fetch: vi.fn(async () => response()) })).objects).toEqual([]);
    const f = await fixture({ size: 4 });
    const fetch: typeof globalThis.fetch = async (input, init) => String(input).includes('upload.wikimedia.org') ?
      new Response('fake', { headers: { 'content-type': 'image/png' } }) : f.fetch(input, init);
    expect((await run(f, { fetch })).objects).toEqual([]);
  });
  it('requires exclusive private outside-Git output and no symlink ancestors', async () => {
    const root = await temp(), f = await fixture();
    await mkdir(join(root, 'existing'));
    await mkdir(join(root, 'git'));
    await writeFile(join(root, 'git/.git'), 'synthetic marker');
    await symlink(join(root, 'existing'), join(root, 'link'));
    for (const output of [join(root, 'existing'), join(root, 'git/out'), join(root, 'link/out')])
      await expect(run(f, { output })).rejects.toThrow();
    expect(f.calls).toEqual([]);
  });
  it('requires explicit CLI opt-in and rejects arbitrary profiles/queries before network', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(main([])).rejects.toThrow('explicit_acquisition_arguments_required');
    await expect(main(['--query', 'private photo'])).rejects.toThrow();
    await expect(main(['--acquire', 'official-commons-licensed-references', '--out', '/tmp/not-created', '--version', 'synthetic', '--profile', 'private'])).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['https://upload.wikimedia.org:444/wikipedia/commons/a/ab/a.jpg', 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/a.jpg/300px-a.jpg',
    'https://upload.wikimedia.org/wikipedia/commons/a/ab/a.jpg?q=private', 'http://upload.wikimedia.org/wikipedia/commons/a/ab/a.jpg'])('rejects unsafe/nonoriginal image URL %s', value => {
    expect(() => trustedCommonsUrl(value, 'image')).toThrow();
  });
  it('converts bounded attribution markup to text, not executable HTML', () => {
    expect(commonsPlainText('<b>A &amp; B</b>')).toBe('A & B');
    for (const value of ['&#0;', '&lt;script&gt;', 'x\nsecret', '&unknown;', 'x'.repeat(8001)]) expect(() => commonsPlainText(value)).toThrow();
  });
});
