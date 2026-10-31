/** Opt-in, bounded public licensed-reference acquisition. Importing never fetches. */
import { mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  COMMONS_LICENSES, CommonsVisualCatalogObjectSchema, VisualCatalogV2Schema,
  officialCommonsImageUrl, type CommonsVisualCatalogObject,
} from '../../packages/domain/src/style/visual-catalog';
import { canonicalImage, cliError, enumValue, fail, integer, privateDirectory, record, token, writeExclusive } from './private-artifacts';

export const COMMONS_LIMITS = Object.freeze({
  requests: 80, details: 24, images: 24, imageBytes: 8 * 1024 * 1024,
  jsonBytes: 1024 * 1024, totalBytes: 128 * 1024 * 1024, pixels: 20_000_000,
  intervalMs: 1100, deadlineMs: 20_000, redirects: 2,
});
/** Closed public queries. No user photo, private text, keys or arbitrary query arguments. */
export const COMMONS_PROFILES = {
  'generic-scenes-objects-v1': [
    ['outfit', 'outfit ensemble photograph'], ['jacket', 'jacket photograph'],
    ['shirt', 'shirt photograph'], ['shoes', 'shoes photograph'],
    ['bedroom', 'bedroom interior photograph'], ['interior', 'room interior photograph'],
    ['bed', 'bed furniture photograph'], ['mug', 'mug photograph'],
    ['vase', 'vase photograph'], ['sculpture', 'sculpture photograph'],
  ],
  'scenes-v1': [['bedroom', 'bedroom interior photograph'], ['interior', 'room interior photograph']],
  'apparel-v1': [['outfit', 'outfit ensemble photograph'], ['jacket', 'jacket photograph'], ['shirt', 'shirt photograph'], ['shoes', 'shoes photograph']],
  'objects-v1': [['bed', 'bed furniture photograph'], ['mug', 'mug photograph'], ['vase', 'vase photograph'], ['sculpture', 'sculpture photograph']],
} as const;
export type CommonsProfile = keyof typeof COMMONS_PROFILES;
export function trustedCommonsUrl(value: string, kind: 'api' | 'image'): URL {
  let u: URL;
  try { u = new URL(value); } catch { return fail('untrusted_commons_url'); }
  if (value.length > 2048 || /[\\\s]/.test(value) || u.protocol !== 'https:' || u.port ||
    u.username || u.password || u.hash || (kind === 'image' ? !officialCommonsImageUrl(value) :
      u.hostname !== 'commons.wikimedia.org' || u.pathname !== '/w/api.php'))
    fail('untrusted_commons_url');
  return u;
}
/** Strip metadata markup, not render it; refuse unrecognized entities/control text. */
export function commonsPlainText(value: unknown, max = 1000): string {
  if (typeof value !== 'string' || value.length > 8000) return fail('invalid_commons_text');
  const decoded = value.replace(/<[^>]*>/g, ' ').replace(/&(?:amp|quot|apos|lt|gt|nbsp|#\d+|#x[a-f0-9]+);/gi, entity => {
    const named: Record<string, string> = { '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>', '&nbsp;': ' ' };
    if (named[entity.toLowerCase()] !== undefined) return named[entity.toLowerCase()]!;
    const code = entity.toLowerCase().startsWith('&#x') ? parseInt(entity.slice(3, -1), 16) : Number(entity.slice(2, -1));
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : fail('invalid_commons_text');
  });
  if (/[<>]/.test(decoded) || [...decoded].some(c => c.charCodeAt(0) < 32 ||
    (c.charCodeAt(0) >= 127 && c.charCodeAt(0) <= 159)) || /&[a-z#][^;\s]*;/i.test(decoded)) fail('invalid_commons_text');
  const result = decoded.replace(/\s+/g, ' ').trim();
  if (!result || result.length > max) fail('invalid_commons_text');
  return result;
}
const apiUrl = (params: Record<string, string>) => {
  const u = new URL('https://commons.wikimedia.org/w/api.php');
  for (const [k, v] of Object.entries({ action: 'query', format: 'json', formatversion: '2', ...params })) u.searchParams.set(k, v);
  return u;
};
export interface CommonsImportOptions {
  output: string;
  catalogVersion: string;
  profile?: CommonsProfile;
  maxImages?: number;
  maxRequests?: number;
  fetch: typeof globalThis.fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}
export async function importCommonsCatalog(options: CommonsImportOptions) {
  const maximum = integer(options.maxImages ?? 24, 1, COMMONS_LIMITS.images);
  const requestLimit = integer(options.maxRequests ?? 80, 1, COMMONS_LIMITS.requests);
  const version = token(options.catalogVersion);
  const profile = enumValue(options.profile ?? 'generic-scenes-objects-v1', Object.keys(COMMONS_PROFILES) as CommonsProfile[]);
  await privateDirectory(options.output);
  const assetRoot = join(options.output, 'assets');
  await mkdir(assetRoot, { mode: 0o700 });
  const sleep = options.sleep ?? (ms => new Promise(done => setTimeout(done, ms)));
  const now = options.now ?? (() => new Date());
  let requests = 0, details = 0, images = 0, totalBytes = 0, lastRequest: number | undefined, stopped = false;
  const failures: { stage: string; pageid?: number; code: string }[] = [];
  const objects: CommonsVisualCatalogObject[] = [];
  const seen = new Set<number>();
  async function request(initial: URL, kind: 'api' | 'image', expectedMime?: string): Promise<Buffer> {
    let url = initial;
    const controller = new AbortController();
    // One total wall-clock deadline includes redirect chain and streaming.
    const timer = setTimeout(() => controller.abort(), COMMONS_LIMITS.deadlineMs);
    try {
      for (let redirects = 0; ; redirects++) {
        trustedCommonsUrl(url.href, kind);
        if (requests >= requestLimit) { stopped = true; fail('request_limit_reached'); }
        if (lastRequest !== undefined) await sleep(Math.max(0, COMMONS_LIMITS.intervalMs - (Date.now() - lastRequest)));
        if (controller.signal.aborted) fail('request_deadline');
        requests++; lastRequest = Date.now();
        const response = await options.fetch(url.href, {
          redirect: 'manual', credentials: 'omit', referrerPolicy: 'no-referrer',
          headers: { Accept: kind === 'api' ? 'application/json' : 'image/jpeg,image/png,image/webp',
            'User-Agent': 'CultureAtlasLicensedReferenceImporter/1.0 (bounded operator opt-in)' },
          signal: controller.signal,
        });
        try {
          if ([429, 503, 401, 403].includes(response.status)) { stopped = true; fail(`stopped_http_${response.status}`); }
          if (response.status >= 300 && response.status < 400) {
            if (redirects >= COMMONS_LIMITS.redirects) fail('redirect_limit_exceeded');
            const location = response.headers.get('location');
            if (!location) fail('invalid_redirect');
            const next = trustedCommonsUrl(new URL(location, url).href, kind);
            if (kind === 'api' && (next.pathname !== url.pathname || next.search !== url.search)) fail('untrusted_redirect');
            url = next; continue;
          }
          if (!response.ok) fail('http_error');
          const mime = response.headers.get('content-type')?.split(';')[0]?.trim();
          if (kind === 'api' ? mime !== 'application/json' : !['image/jpeg', 'image/png', 'image/webp'].includes(mime ?? '')) fail('invalid_content_type');
          if (expectedMime && mime !== expectedMime) fail('original_mime_mismatch');
          const cap = kind === 'api' ? COMMONS_LIMITS.jsonBytes : COMMONS_LIMITS.imageBytes;
          const length = response.headers.get('content-length');
          if (length && (!/^\d+$/.test(length) || Number(length) > cap)) fail('response_limit_exceeded');
          const reader = response.body?.getReader();
          if (!reader) fail('empty_response');
          let bytes = 0;
          const chunks: Uint8Array[] = [];
          try {
            while (true) {
              const chunk = await reader.read();
              if (chunk.done) break;
              bytes += chunk.value.length; totalBytes += chunk.value.length;
              if (totalBytes > COMMONS_LIMITS.totalBytes) { stopped = true; fail('total_byte_limit_reached'); }
              if (bytes > cap) fail('response_limit_exceeded');
              chunks.push(chunk.value);
            }
          } finally { await reader.cancel().catch(() => {}); }
          if (!bytes) fail('empty_response');
          return Buffer.concat(chunks);
        } finally { if (!response.body?.locked) await response.body?.cancel().catch(() => {}); }
      }
    } finally { clearTimeout(timer); controller.abort(); }
  }
  async function json(url: URL) {
    const bytes = await request(url, 'api');
    let value: Record<string, unknown>;
    try { value = record(JSON.parse(bytes.toString('utf8'))); } catch { return fail('invalid_commons_json'); }
    if (value.error) { stopped = true; fail('commons_api_error'); }
    return record(value.query);
  }
  const queries = COMMONS_PROFILES[profile];
  const perClass = Math.ceil(maximum / queries.length);
  const perClassDetails = Math.floor(COMMONS_LIMITS.details / queries.length);
  for (const [queryClass, query] of queries) {
    if (stopped || objects.length >= maximum || details >= COMMONS_LIMITS.details || images >= COMMONS_LIMITS.images) break;
    let hits: unknown[];
    try {
      const result = await json(apiUrl({ list: 'search', srsearch: query, srnamespace: '6', srlimit: '24', srwhat: 'text' }));
      if (!Array.isArray(result.search) || result.search.length > 24) fail('invalid_search_envelope');
      hits = result.search;
    } catch (e) { failures.push({ stage: 'search', code: cliError(e) }); continue; }
    let classDetails = 0, classImages = 0;
    for (const hit of hits) {
      if (stopped || objects.length >= maximum || details >= COMMONS_LIMITS.details || images >= COMMONS_LIMITS.images || classDetails >= perClassDetails || classImages >= perClass) break;
      let id: number | undefined;
      try {
        const summary = record(hit);
        id = integer(summary.pageid, 1, Number.MAX_SAFE_INTEGER);
        if (summary.ns !== 6) fail('invalid_namespace');
        const title = commonsPlainText(summary.title, 300);
        if (!title.startsWith('File:')) fail('invalid_file_title');
        if (seen.has(id)) continue;
        seen.add(id); details++; classDetails++;
        const result = await json(apiUrl({ pageids: String(id), prop: 'imageinfo', iiprop: 'url|size|mime|sha1|extmetadata' }));
        if (!Array.isArray(result.pages) || result.pages.length !== 1) fail('invalid_detail_envelope');
        const page = record(result.pages[0]);
        if (page.pageid !== id || page.ns !== 6 || page.title !== title || page.missing !== undefined) fail('page_identity_mismatch');
        if (!Array.isArray(page.imageinfo) || page.imageinfo.length !== 1) fail('invalid_imageinfo');
        const info = record(page.imageinfo[0]);
        const meta = record(info.extmetadata);
        const field = (name: string) => record(meta[name]).value;
        const short = field('LicenseShortName');
        const license = short === 'CC0' ? 'CC0' : short === 'CC BY 4.0' ? 'CC-BY-4.0' : short === 'CC BY-SA 4.0' ? 'CC-BY-SA-4.0' : fail('unsupported_license');
        if (field('LicenseUrl') !== COMMONS_LICENSES[license]) fail('license_tuple_mismatch');
        if (meta.Copyrighted && field('Copyrighted') !== (license === 'CC0' ? 'False' : 'True')) fail('contradictory_copyright');
        const creator = commonsPlainText(field('Artist'));
        const attribution = meta.Attribution ? commonsPlainText(field('Attribution')) : creator;
        const width = integer(info.width, 1, 8192), height = integer(info.height, 1, 8192);
        if (width * height > COMMONS_LIMITS.pixels) fail('image_pixel_limit');
        const size = integer(info.size, 1, COMMONS_LIMITS.imageBytes);
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(String(info.mime))) fail('invalid_image_format');
        if (typeof info.sha1 !== 'string' || !/^[a-f0-9]{40}$/.test(info.sha1)) fail('invalid_original_hash');
        const imageUrl = trustedCommonsUrl(String(info.url), 'image');
        if (decodeURIComponent(imageUrl.pathname.split('/').at(-1)!).replace(/_/g, ' ') !== title.slice(5).replace(/_/g, ' '))
          fail('original_title_mismatch');
        images++; // Includes failed image attempts; never exceed the download bound.
        const original = await request(imageUrl, 'image', String(info.mime));
        if (original.length !== size) fail('original_size_mismatch');
        if (createHash('sha1').update(original).digest('hex') !== info.sha1) fail('original_hash_mismatch');
        const detectedMime = original.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png' :
          original[0] === 255 && original[1] === 216 && original[2] === 255 ? 'image/jpeg' :
            original.subarray(0, 4).toString() === 'RIFF' && original.subarray(8, 12).toString() === 'WEBP' ? 'image/webp' : null;
        if (detectedMime !== info.mime) fail('original_mime_mismatch');
        const image = await canonicalImage(original);
        if (image.width !== width || image.height !== height) fail('original_dimensions_mismatch');
        const object = CommonsVisualCatalogObjectSchema.parse({
          id: `commons:${id}`, institution: 'Wikimedia Commons', title: title.slice(5).trim(),
          object_type: queryClass, medium: '', object_date: '', source_title: title,
          source_url: `https://commons.wikimedia.org/?curid=${id}`, image_url: imageUrl.href,
          license, license_url: COMMONS_LICENSES[license], is_public_domain: license === 'CC0',
          creator, attribution, image_path: `${id}-${image.hash}.jpg`, image_sha256: image.hash,
          width: image.width, height: image.height, tags: [queryClass],
          retrieval: { basis: 'static_query_hint_not_verified_identity', query_class: queryClass,
            depiction: ['bedroom', 'interior'].includes(queryClass) ? 'scene' : 'object' },
          retrieved_at: now().toISOString(),
        });
        await writeExclusive(join(assetRoot, object.image_path), image.bytes);
        objects.push(object); classImages++;
      } catch (e) { failures.push({ stage: 'detail_or_image', ...(id ? { pageid: id } : {}), code: cliError(e) }); }
    }
  }
  const catalog = VisualCatalogV2Schema.parse({
    schema_version: 'atlas_visual_catalog_v2', catalog_version: version, generated_at: now().toISOString(),
    asset_root: assetRoot, acquisition_status: failures.length || objects.length < maximum ? 'partial' : 'complete', objects,
  });
  await writeExclusive(join(options.output, 'catalog.json'), `${JSON.stringify(catalog)}\n`);
  await writeExclusive(join(options.output, 'acquisition.json'), `${JSON.stringify({
    schema_version: 'atlas_commons_acquisition_v1', profile, requested_images: maximum,
    acquired_images: objects.length, considered_details: details, image_attempts: images, requests,
    downloaded_bytes: totalBytes, stopped, catalog_coverage: 'unknown',
    scope: 'bounded_licensed_inspiration_not_verified_identity_or_commercial_supply',
    retrieval_basis: 'static_query_hint_not_verified_identity', max_details_per_class: perClassDetails,
    max_images_per_class: perClass, queries, failures,
  })}\n`);
  return catalog;
}
export async function main(args: string[]) {
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = enumValue(args[i], ['--out', '--version', '--profile', '--max-images', '--max-requests', '--acquire'] as const);
    const value = args[i + 1];
    if (!value || value.startsWith('--') || flags.has(key)) fail('invalid_arguments');
    flags.set(key, value);
  }
  if (flags.get('--acquire') !== 'official-commons-licensed-references' || !flags.get('--out') || !flags.get('--version'))
    fail('explicit_acquisition_arguments_required');
  const result = await importCommonsCatalog({
    output: flags.get('--out')!, catalogVersion: flags.get('--version')!,
    profile: flags.has('--profile') ? enumValue(flags.get('--profile'), Object.keys(COMMONS_PROFILES) as CommonsProfile[]) : undefined,
    maxImages: flags.has('--max-images') ? Number(flags.get('--max-images')) : undefined,
    maxRequests: flags.has('--max-requests') ? Number(flags.get('--max-requests')) : undefined,
    fetch: globalThis.fetch,
  });
  process.stdout.write(`${JSON.stringify({ status: result.acquisition_status, objects: result.objects.length })}\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main(process.argv.slice(2)).catch((e: unknown) => { process.stderr.write(`Commons acquisition: ${cliError(e)}\n`); process.exitCode = 1; });
