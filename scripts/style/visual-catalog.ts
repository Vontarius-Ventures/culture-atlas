/** Bounded, public-domain museum acquisition. Importing this module never fetches. */
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  VisualCatalogSchema,
  VisualCatalogObjectSchema,
  type VisualCatalogObject,
} from '../../packages/domain/src/style/visual-catalog';
import {
  canonicalImage,
  cliError,
  enumValue,
  fail,
  integer,
  privateDirectory,
  record,
  token,
  writeExclusive,
} from './private-artifacts';

export const MET_LIMITS = Object.freeze({
  objects: 24,
  requests: 80,
  responseBytes: 8 * 1024 * 1024,
  jsonBytes: 1024 * 1024,
  totalBytes: 128 * 1024 * 1024,
  intervalMs: 1100,
  requestTimeoutMs: 20_000,
  redirects: 2,
  searchPageSize: 24,
});
export const MET_CLASSES = ['Sculpture', 'Ceramics', 'Furniture'] as const;
const MET_OBJECT_QUERIES = { Sculpture: 'statuette', Ceramics: 'vase', Furniture: 'chair' } as const;
/** Closed retrieval profiles; classes/queries are hints, never replacement object identities. */
const MET_APPAREL_CLASSES = ['Jackets', 'Shirts', 'Ensembles', 'Shoes'] as const;
const MET_APPAREL_QUERIES = { Jackets: 'jacket', Shirts: 'shirt', Ensembles: 'ensemble', Shoes: 'shoes' } as const;
const MET_GARMENTS_HOUSEHOLD_CLASSES = ['Dresses', 'Suits', 'Beds', 'Mugs'] as const;
const MET_GARMENTS_HOUSEHOLD_QUERIES = { Dresses: 'dress', Suits: 'suit', Beds: 'bed', Mugs: 'mug' } as const;
export const MET_PROFILES = ['museumobjects-v1', 'apparel-v1', 'garments-household-v1'] as const;
export type MetProfile = typeof MET_PROFILES[number];
const API = 'collectionapi.metmuseum.org';
const IMAGES = 'images.metmuseum.org';
const WEB = 'www.metmuseum.org';

export function trustedMetUrl(value: unknown, kind: 'api' | 'image' | 'object'): URL {
  if (typeof value !== 'string' || value.length > 2048) return fail('untrusted_met_url');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail('untrusted_met_url');
  }
  const host = kind === 'api' ? API : kind === 'image' ? IMAGES : WEB;
  if (
    url.protocol !== 'https:' ||
    url.hostname !== host ||
    url.port ||
    url.username ||
    url.password ||
    url.hash ||
    /[\\\s]/.test(value)
  )
    fail('untrusted_met_url');
  if (kind !== 'api' && url.search) fail('untrusted_met_url');
  if (
    kind === 'api' &&
    !(
      /^\/public\/collection\/v1\/objects\/[1-9]\d*$/.test(url.pathname) ||
      url.pathname === '/public/collection/v1.1/search'
    )
  )
    fail('untrusted_met_url');
  if (kind === 'object' && !/^\/art\/collection\/search\/[1-9]\d*\/?$/.test(url.pathname))
    fail('untrusted_met_url');
  if (kind === 'image' && !/^\/[^?#]+$/.test(url.pathname)) fail('untrusted_met_url');
  return url;
}
export interface ImportOptions {
  output: string;
  catalogVersion: string;
  /** Omission preserves the historical highlighted statuette/vase/chair acquisition. */
  profile?: MetProfile;
  maxObjects?: number;
  maxRequests?: number;
  fetch: typeof globalThis.fetch;
  /** Injectable only for hermetic tests. Production defaults enforce conservative pacing. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}
const textField = (value: unknown, required = false): string => {
  if (value === undefined && !required) return '';
  if (
    typeof value !== 'string' ||
    value.length > 1000 ||
    [...value].some((c) => c.charCodeAt(0) < 32) ||
    (required && !value.trim())
  )
    return fail('invalid_met_metadata');
  return value.trim();
};

/** A complete acquisition means the requested bounded sample completed, NOT catalogue recall. */
export async function importMetCatalog(options: ImportOptions) {
  const maximum = integer(options.maxObjects ?? 12, 1, MET_LIMITS.objects);
  const requestLimit = integer(options.maxRequests ?? 40, 1, MET_LIMITS.requests);
  const version = token(options.catalogVersion);
  const profile = enumValue(options.profile ?? 'museumobjects-v1', MET_PROFILES);
  const classes = profile === 'garments-household-v1' ? MET_GARMENTS_HOUSEHOLD_CLASSES :
    profile === 'apparel-v1' ? MET_APPAREL_CLASSES : MET_CLASSES;
  const queries: Readonly<Record<string, string>> = profile === 'garments-household-v1' ? MET_GARMENTS_HOUSEHOLD_QUERIES :
    profile === 'apparel-v1' ? MET_APPAREL_QUERIES : MET_OBJECT_QUERIES;
  const highlightsOnly = profile === 'museumobjects-v1';
  await privateDirectory(options.output);
  const assetRoot = join(options.output, 'assets');
  await mkdir(assetRoot, { mode: 0o700 });
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
  let requests = 0,
    totalBytes = 0,
    imageAttempts = 0,
    lastRequest = 0,
    stopped = false;
  const failures: { stage: string; object_id?: number; code: string }[] = [];
  const objects: VisualCatalogObject[] = [];
  const seen = new Set<number>();
  async function request(url: URL, kind: 'api' | 'image'): Promise<Buffer> {
    for (let redirect = 0; ; redirect++) {
      trustedMetUrl(url.href, kind);
      if (requests >= requestLimit) {
        stopped = true;
        fail('request_limit_reached');
      }
      if (lastRequest) await sleep(Math.max(0, MET_LIMITS.intervalMs - (Date.now() - lastRequest)));
      requests++;
      lastRequest = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), MET_LIMITS.requestTimeoutMs);
      try {
        const response = await options.fetch(url.href, {
          redirect: 'manual',
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          headers: {
            Accept: kind === 'api' ? 'application/json' : 'image/jpeg,image/png,image/webp',
          },
          signal: controller.signal,
        });
        if ([429, 503].includes(response.status)) {
          stopped = true;
          fail('rate_limited');
        }
        if ([401, 403].includes(response.status)) {
          stopped = true;
          fail('public_api_unavailable');
        }
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel();
          if (redirect >= MET_LIMITS.redirects) fail('redirect_limit_exceeded');
          const location = response.headers.get('location');
          if (!location) fail('invalid_redirect');
          const next = trustedMetUrl(new URL(location, url).href, kind);
          // API redirects may not change path/query, preventing query forwarding.
          if (kind === 'api' && (next.pathname !== url.pathname || next.search !== url.search))
            fail('untrusted_redirect');
          url = next;
          continue;
        }
        if (!response.ok) {
          await response.body?.cancel();
          fail('http_error');
        }
        const contentType = response.headers.get('content-type')?.split(';')[0]?.trim();
        if (
          kind === 'api'
            ? contentType !== 'application/json'
            : !['image/jpeg', 'image/png', 'image/webp'].includes(contentType ?? '')
        )
          fail('invalid_content_type');
        const cap = kind === 'api' ? MET_LIMITS.jsonBytes : MET_LIMITS.responseBytes;
        const length = response.headers.get('content-length');
        if (length && (!/^\d+$/.test(length) || Number(length) > cap))
          fail('response_limit_exceeded');
        const reader = response.body?.getReader();
        if (!reader) fail('empty_response');
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        try {
          while (true) {
            const next = await reader.read();
            if (next.done) break;
            bytes += next.value.length;
            totalBytes += next.value.length;
            if (totalBytes > MET_LIMITS.totalBytes) {
              stopped = true;
              fail('total_byte_limit_reached');
            }
            if (bytes > cap) fail('response_limit_exceeded');
            chunks.push(next.value);
          }
        } finally {
          await reader.cancel().catch(() => {});
        }
        return Buffer.concat(chunks);
      } finally {
        clearTimeout(timer);
        controller.abort();
      }
    }
  }
  async function json(url: URL) {
    const bytes = await request(url, 'api');
    try {
      return record(JSON.parse(bytes.toString('utf8')));
    } catch {
      return fail('invalid_met_json');
    }
  }
  let considered = 0;
  const classObjectLimit = Math.ceil(maximum / classes.length);
  const classDetailLimit = Math.floor(MET_LIMITS.objects / classes.length);
  // Only static object-class queries: never accepts a user/private query.
  for (const objectClass of classes) {
    if (objects.length >= maximum || stopped) break;
    let ids: unknown[];
    try {
      const url = new URL(`https://${API}/public/collection/v1.1/search`);
      url.searchParams.set('q', queries[objectClass]!);
      url.searchParams.set('hasImages', 'true');
      url.searchParams.set('isPublicDomain', 'true');
      if (highlightsOnly) url.searchParams.set('isHighlight', 'true');
      url.searchParams.set('offset', '0');
      url.searchParams.set('limit', String(MET_LIMITS.searchPageSize));
      const result = await json(url);
      if (result.objectIDs === null && result.total === 0) ids = [];
      else if (
        Array.isArray(result.objectIDs) &&
        result.objectIDs.length <= MET_LIMITS.searchPageSize
      )
        ids = result.objectIDs;
      else fail('unsupported_search_envelope');
    } catch (error) {
      failures.push({ stage: 'search', code: cliError(error) });
      continue;
    }
    const classStartCount = objects.length;
    let classConsidered = 0;
    for (const value of ids) {
      if (
        objects.length >= maximum ||
        objects.length - classStartCount >= classObjectLimit ||
        classConsidered >= classDetailLimit ||
        stopped ||
        imageAttempts >= MET_LIMITS.objects ||
        considered >= MET_LIMITS.objects
      )
        break;
      let id: number;
      try {
        id = integer(value, 1, Number.MAX_SAFE_INTEGER);
      } catch {
        failures.push({ stage: 'search', code: 'invalid_object_id' });
        continue;
      }
      if (seen.has(id)) continue;
      seen.add(id);
      considered++;
      classConsidered++;
      try {
        const detail = await json(new URL(`https://${API}/public/collection/v1/objects/${id}`));
        if (detail.objectID !== id) fail('object_identity_mismatch');
        if (detail.isPublicDomain !== true) fail('not_public_domain');
        const imageUrl = trustedMetUrl(detail.primaryImageSmall || detail.primaryImage, 'image');
        const sourceUrl = trustedMetUrl(detail.objectURL, 'object');
        if (!new RegExp(`/art/collection/search/${id}/?$`).test(sourceUrl.pathname))
          fail('object_identity_mismatch');
        imageAttempts++;
        const image = await canonicalImage(await request(imageUrl, 'image'));
        const acquired = now().toISOString();
        const object = VisualCatalogObjectSchema.parse({
          id: `met:${id}`,
          institution: 'The Metropolitan Museum of Art',
          title: textField(detail.title, true),
          object_type: textField(detail.objectName, true),
          medium: textField(detail.medium),
          object_date: textField(detail.objectDate),
          source_url: sourceUrl.href,
          image_url: imageUrl.href,
          license: 'CC0',
          is_public_domain: true,
          image_path: `${id}-${image.hash}.jpg`,
          image_sha256: image.hash,
          width: image.width,
          height: image.height,
          tags: [objectClass],
          retrieved_at: acquired,
        });
        await writeExclusive(join(assetRoot, object.image_path), image.bytes);
        objects.push(object);
      } catch (error) {
        failures.push({ stage: 'object', object_id: id, code: cliError(error) });
      }
    }
  }
  const manifest = {
    schema_version: 'atlas_visual_catalog_v1' as const,
    catalog_version: version,
    generated_at: now().toISOString(),
    asset_root: assetRoot,
    acquisition_status:
      failures.length || objects.length < maximum ? ('partial' as const) : ('complete' as const),
    objects,
  };
  // Schema validation at the handoff boundary; domain owns its implementation.
  VisualCatalogSchema.parse(manifest);
  await writeExclusive(join(options.output, 'catalog.json'), `${JSON.stringify(manifest)}\n`);
  await writeExclusive(
    join(options.output, 'acquisition.json'),
    `${JSON.stringify({
      schema_version: 'atlas_met_acquisition_v1',
      profile,
      requested_objects: maximum,
      acquired_objects: objects.length,
      considered_objects: considered,
      image_attempts: imageAttempts,
      requests,
      downloaded_bytes: totalBytes,
      scope: 'bounded_public_domain_museum_sample_not_commercial_supply',
      catalog_coverage: 'unknown',
      search_pages_per_class: 1,
      sample_policy: 'bounded_per_class',
      max_objects_per_class: classObjectLimit,
      max_details_per_class: classDetailLimit,
      object_queries: queries,
      highlights_only: highlightsOnly,
      retrieval_basis: 'static_query_class_hint_not_verified_identity',
      supply_coverage: 'unknown',
      failures,
    })}\n`,
  );
  return manifest;
}

export async function main(args: string[]) {
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = enumValue(args[i], [
      '--out',
      '--version',
      '--profile',
      '--max-objects',
      '--max-requests',
      '--acquire',
    ] as const);
    const value = args[i + 1];
    if (!value || value.startsWith('--') || flags.has(key)) fail('invalid_arguments');
    flags.set(key, value);
  }
  if (
    flags.get('--acquire') !== 'official-met-public-domain' ||
    !flags.get('--out') ||
    !flags.get('--version')
  )
    fail('explicit_acquisition_arguments_required');
  const manifest = await importMetCatalog({
    output: flags.get('--out')!,
    catalogVersion: flags.get('--version')!,
    profile: flags.has('--profile') ? enumValue(flags.get('--profile'), MET_PROFILES) : undefined,
    maxObjects: flags.has('--max-objects') ? Number(flags.get('--max-objects')) : undefined,
    maxRequests: flags.has('--max-requests') ? Number(flags.get('--max-requests')) : undefined,
    fetch: globalThis.fetch,
  });
  // No URLs, input paths or response content in stdout.
  process.stdout.write(
    `${JSON.stringify({ status: manifest.acquisition_status, objects: manifest.objects.length })}\n`,
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main(process.argv.slice(2)).catch((e: unknown) => {
    process.stderr.write(`Met acquisition: ${cliError(e)}\n`);
    process.exitCode = 1;
  });
