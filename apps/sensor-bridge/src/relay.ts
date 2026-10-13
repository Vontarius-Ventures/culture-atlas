/**
 * World Sensor relay: contract, SSRF-safe client and the import sync algorithm.
 *
 * THIS FILE IS SHARED VERBATIM between the server-side poller
 * (packages/domain/src/sensor/relay.ts) and the outbound bridge
 * (apps/sensor-bridge/src/relay.ts). The bridge must not import the domain
 * package, so the file is copied; `relay-parity.test.ts` fails if the copies
 * differ. Edit one, then copy it over the other. It depends on Node built-ins
 * only.
 *
 * ASSUMPTION: route paths and field names come from the source review of
 * WorldCompilerSensor@8639b3b (Shared/Assets.swift, TestServer README; see
 * research/world-sensor-qloo-integration.md). They have not been exercised
 * against the real relay. Everything relay-specific lives in the "Contract"
 * section below, and the normalizer accepts snake_case and camelCase field
 * names, so a correction is a small change here.
 *
 * Guarantees of `syncOnce` (tested against fixtures/sensor/mock-relay.ts):
 *  - No duplicates: an asset is imported at most once per connection. The
 *    caller's ledger (`isKnown`) is the source of truth, and the server also
 *    dedupes on connection + asset_id.
 *  - No skipped new assets: the persisted cursor never moves past a page that
 *    still holds an unresolved photo (transient failure, or listed but not yet
 *    committed). Re-reading a page is safe because of the ledger.
 *  - First connection: existing photos are recorded as known-but-skipped
 *    unless explicitly selected. Imports are never likes; that is the caller's
 *    job, and neither caller records a preference.
 */
import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Contract (assumed; verify against the real relay)
// ---------------------------------------------------------------------------

export const RELAY_CONTRACT = 'wc-v2 asset viewer API (assumed from WorldCompilerSensor@8639b3b)';

export const RELAY_ROUTES = {
  /** Authenticated viewer list of assets. Query: kind, committed, cursor, limit. */
  listAssets: '/wc/v2/assets',
  /** Original content bytes for one asset. */
  assetContent: (assetId: string) => `/wc/v2/assets/${encodeURIComponent(assetId)}/content`,
} as const;

/** Viewer credential header (assumed bearer). */
export const relayAuthHeader = (credential: string): Record<string, string> => ({ authorization: `Bearer ${credential}` });

/** Content types accepted for photo bytes (the app re-sniffs the bytes anyway). */
export const RELAY_IMAGE_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'] as const;

export interface RelayAsset {
  asset_id: string;
  kind: string;
  committed: boolean;
  content_type: string | null;
  byte_size: number | null;
  /** Lowercase hex sha256 when the relay declares one; null when absent. */
  sha256: string | null;
  /** True when the relay declared a hash we cannot parse (treated as unverifiable). */
  sha256_invalid: boolean;
  captured_at: string | null;
  session_id: string | null;
}

export interface RelayAssetPage {
  assets: RelayAsset[];
  /** Entries that could not be read as assets (no id); ignored but counted. */
  invalid_entries: number;
  next_cursor: string | null;
  has_more: boolean;
}

function pick(obj: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  return undefined;
}

function asString(v: unknown): string | null {
  if (typeof v === 'string' && v.length > 0) return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

function asIsoTimestamp(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) {
    // Seconds or milliseconds since the epoch.
    const ms = v < 1e12 ? v * 1000 : v;
    return new Date(ms).toISOString();
  }
  if (typeof v !== 'string' || v.length === 0) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** Normalize one listed asset. Returns null when it has no usable id. */
export function normalizeRelayAsset(raw: unknown): RelayAsset | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const id = asString(pick(o, 'asset_id', 'assetId', 'assetID', 'id'));
  if (!id || id.length > 200) return null;
  const state = asString(pick(o, 'state', 'status'));
  const committedRaw = pick(o, 'committed', 'isCommitted');
  const committed = committedRaw === true || (committedRaw === undefined && state?.toLowerCase() === 'committed');
  const declared = asString(pick(o, 'sha256', 'sha_256', 'contentSHA256', 'contentSha256', 'content_sha256'));
  let sha256: string | null = null;
  let sha256Invalid = false;
  if (declared) {
    const hex = declared.toLowerCase().replace(/^sha256:/, '');
    if (/^[a-f0-9]{64}$/.test(hex)) sha256 = hex;
    else sha256Invalid = true;
  }
  const size = pick(o, 'byte_size', 'byteSize', 'size', 'content_length');
  return {
    asset_id: id,
    kind: (asString(pick(o, 'kind', 'type')) ?? 'unknown').toLowerCase(),
    committed,
    content_type: asString(pick(o, 'content_type', 'contentType', 'mime_type', 'mimeType'))?.toLowerCase() ?? null,
    byte_size: typeof size === 'number' && Number.isFinite(size) && size >= 0 ? size : null,
    sha256,
    sha256_invalid: sha256Invalid,
    captured_at: asIsoTimestamp(pick(o, 'captured_at', 'capturedAt', 'created_at', 'createdAt')),
    session_id: asString(pick(o, 'session_id', 'sessionId', 'sessionID')),
  };
}

/** Normalize a list page. Throws RelayError('bad_response') when it is not a page. */
export function normalizeRelayPage(raw: unknown): RelayAssetPage {
  if (!raw || typeof raw !== 'object') throw new RelayError('bad_response', 'The relay did not return an asset page.');
  const o = raw as Record<string, unknown>;
  const list = pick(o, 'assets', 'items', 'data');
  if (!Array.isArray(list)) throw new RelayError('bad_response', 'The relay page has no asset list.');
  const assets: RelayAsset[] = [];
  let invalid = 0;
  for (const entry of list) {
    const a = normalizeRelayAsset(entry);
    if (a) assets.push(a);
    else invalid++;
  }
  const next = asString(pick(o, 'next_cursor', 'nextCursor', 'cursor'));
  const hasMoreRaw = pick(o, 'has_more', 'hasMore');
  return {
    assets,
    invalid_entries: invalid,
    next_cursor: next,
    has_more: typeof hasMoreRaw === 'boolean' ? hasMoreRaw : next !== null && list.length > 0,
  };
}

/** A photo the importer should consider. */
export function isPhoto(asset: RelayAsset): boolean {
  return asset.kind === 'photo';
}

// ---------------------------------------------------------------------------
// Origins
// ---------------------------------------------------------------------------

/**
 * Canonical origin (scheme://host[:port]) of an http(s) URL with no
 * credentials, query or fragment and at most a "/" path. Returns null for
 * anything else.
 */
export function canonicalOrigin(value: string): string | null {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password || u.search || u.hash) return null;
  if (u.pathname !== '/' && u.pathname !== '') return null;
  return u.origin;
}

export function isAllowedOrigin(origin: string, allowed: readonly string[]): boolean {
  const c = canonicalOrigin(origin);
  if (!c) return false;
  return allowed.some((a) => canonicalOrigin(a) === c);
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type RelayErrorCode =
  | 'origin_not_allowed'
  | 'unreachable'
  | 'timeout'
  | 'unauthorized'
  | 'redirect_blocked'
  | 'rate_limited'
  | 'server_error'
  | 'not_found'
  | 'bad_response'
  | 'too_large'
  | 'bad_content_type'
  | 'hash_mismatch'
  | 'hash_unverifiable';

/** Errors that concern one asset only; the asset is recorded as failed and never retried. */
const ASSET_ERRORS: ReadonlySet<RelayErrorCode> = new Set(['not_found', 'too_large', 'bad_content_type', 'hash_mismatch', 'hash_unverifiable']);

export class RelayError extends Error {
  readonly scope: 'asset' | 'connection';
  constructor(
    readonly code: RelayErrorCode,
    message: string,
    readonly options: { status?: number; retryAfterMs?: number; assetScoped?: boolean } = {},
  ) {
    super(message);
    this.name = 'RelayError';
    this.scope = (options.assetScoped ?? ASSET_ERRORS.has(code)) ? 'asset' : 'connection';
  }
  get retryAfterMs(): number | undefined {
    return this.options.retryAfterMs;
  }
}

/**
 * Failure reported by the import sink (the app). `asset` failures are
 * recorded and skipped; `connection` failures stop the sync and keep the
 * cursor. `fatal` means retrying cannot help (revoked token, disabled
 * connection) and the caller should stop polling.
 */
export class SinkError extends Error {
  constructor(
    readonly scope: 'asset' | 'connection',
    readonly code: string,
    message: string,
    readonly options: { fatal?: boolean; retryAfterMs?: number } = {},
  ) {
    super(message);
    this.name = 'SinkError';
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface RelayClientOptions {
  /** Relay origin; must be in `allowedOrigins`. */
  origin: string;
  /** Operator allowlist. Requests and redirects never leave these origins. */
  allowedOrigins: readonly string[];
  credential: string;
  /** Largest accepted asset body. */
  maxAssetBytes: number;
  /** Largest accepted list page body (default 2 MiB). */
  maxPageBytes?: number;
  /** Per-request timeout (default 15 s). */
  timeoutMs?: number;
  /** Redirects are followed only within the same origin, at most this many (default 2). */
  maxRedirects?: number;
  fetch?: typeof fetch;
}

export interface RelayContent {
  bytes: Uint8Array;
  content_type: string;
  /** sha256 of the received bytes (lowercase hex). */
  sha256: string;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function retryAfterMs(res: Response): number | undefined {
  const h = res.headers.get('retry-after');
  if (!h) return undefined;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const t = Date.parse(h);
  return Number.isNaN(t) ? undefined : Math.max(0, t - Date.now());
}

async function readLimited(res: Response, max: number, what: string): Promise<Uint8Array> {
  const declared = Number(res.headers.get('content-length') ?? 'NaN');
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => undefined);
    throw new RelayError('too_large', `The relay ${what} is larger than ${max} bytes.`);
  }
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw new RelayError('too_large', `The relay ${what} is larger than ${max} bytes.`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

function mediaType(res: Response): string {
  return (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
}

export class RelayClient {
  readonly origin: string;
  private readonly allowed: readonly string[];
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: RelayClientOptions) {
    const origin = canonicalOrigin(opts.origin);
    if (!origin || !isAllowedOrigin(origin, opts.allowedOrigins)) {
      throw new RelayError('origin_not_allowed', 'This relay origin is not in the configured allowlist.');
    }
    this.origin = origin;
    this.allowed = opts.allowedOrigins.map((a) => canonicalOrigin(a)).filter((a): a is string => a !== null);
    this.fetchImpl = opts.fetch ?? fetch;
  }

  /** GET within the configured origin; redirects only to the same origin. */
  private async get(pathAndQuery: string, accept: string, signal?: AbortSignal): Promise<Response> {
    let url = new URL(pathAndQuery, this.origin);
    const maxRedirects = this.opts.maxRedirects ?? 2;
    for (let hop = 0; ; hop++) {
      if (url.origin !== this.origin || !this.allowed.includes(url.origin)) {
        throw new RelayError('redirect_blocked', 'The relay redirected to a host that is not allowed.');
      }
      const timeout = AbortSignal.timeout(this.opts.timeoutMs ?? 15_000);
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method: 'GET',
          headers: { ...relayAuthHeader(this.opts.credential), accept },
          redirect: 'manual',
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
      } catch (err) {
        if (signal?.aborted) throw err;
        if (timeout.aborted || (err as Error).name === 'TimeoutError') {
          throw new RelayError('timeout', 'The relay did not respond in time.');
        }
        throw new RelayError('unreachable', 'The relay could not be reached.');
      }
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel().catch(() => undefined);
        const location = res.headers.get('location');
        if (!location || hop >= maxRedirects) {
          throw new RelayError('redirect_blocked', 'The relay redirected too many times.', { status: res.status });
        }
        let next: URL;
        try {
          next = new URL(location, url);
        } catch {
          throw new RelayError('redirect_blocked', 'The relay sent an invalid redirect.', { status: res.status });
        }
        url = next;
        continue;
      }
      if (res.ok) return res;
      await res.body?.cancel().catch(() => undefined);
      const status = res.status;
      if (status === 401 || status === 403) throw new RelayError('unauthorized', 'The relay rejected the viewer credential.', { status });
      if (status === 404) throw new RelayError('not_found', 'The relay has no such resource.', { status });
      if (status === 429) throw new RelayError('rate_limited', 'The relay is rate limiting requests.', { status, retryAfterMs: retryAfterMs(res) });
      if (status >= 500) throw new RelayError('server_error', `The relay returned HTTP ${status}.`, { status, retryAfterMs: retryAfterMs(res) });
      throw new RelayError('bad_response', `The relay returned HTTP ${status}.`, { status });
    }
  }

  /** One page of committed photos after `cursor`. */
  async listPage(cursor: string | null, limit: number, signal?: AbortSignal): Promise<RelayAssetPage> {
    const q = new URLSearchParams({ kind: 'photo', committed: 'true', limit: String(limit) });
    if (cursor) q.set('cursor', cursor);
    const res = await this.get(`${RELAY_ROUTES.listAssets}?${q.toString()}`, 'application/json', signal);
    if (mediaType(res) !== 'application/json') {
      await res.body?.cancel().catch(() => undefined);
      throw new RelayError('bad_response', 'The relay asset list is not JSON.');
    }
    const body = await readLimited(res, this.opts.maxPageBytes ?? 2 * 1024 * 1024, 'asset list');
    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder().decode(body));
    } catch {
      throw new RelayError('bad_response', 'The relay asset list is not valid JSON.');
    }
    return normalizeRelayPage(json);
  }

  /** Original bytes of one photo, size-limited, type-checked and hash-verified. */
  async fetchContent(asset: RelayAsset, signal?: AbortSignal): Promise<RelayContent> {
    if (asset.sha256_invalid) throw new RelayError('hash_unverifiable', 'The relay declared a hash that cannot be read.');
    if (asset.byte_size !== null && asset.byte_size > this.opts.maxAssetBytes) {
      throw new RelayError('too_large', `The photo is larger than ${this.opts.maxAssetBytes} bytes.`);
    }
    let res: Response;
    try {
      res = await this.get(RELAY_ROUTES.assetContent(asset.asset_id), RELAY_IMAGE_CONTENT_TYPES.join(', '), signal);
    } catch (err) {
      // A permanent 4xx for one asset (gone, invalid) must not block the others.
      const s = err instanceof RelayError ? err.options.status : undefined;
      if (err instanceof RelayError && err.code === 'bad_response' && s !== undefined && s >= 400 && s < 500 && s !== 408) {
        throw new RelayError('not_found', err.message, { status: s, assetScoped: true });
      }
      throw err;
    }
    const type = mediaType(res);
    if (!(RELAY_IMAGE_CONTENT_TYPES as readonly string[]).includes(type)) {
      await res.body?.cancel().catch(() => undefined);
      throw new RelayError('bad_content_type', `Unexpected content type "${type || 'none'}" for a photo.`);
    }
    const bytes = await readLimited(res, this.opts.maxAssetBytes, 'photo');
    if (bytes.byteLength === 0) throw new RelayError('bad_response', 'The relay returned an empty photo.', { assetScoped: true });
    const sha256 = sha256Hex(bytes);
    if (asset.sha256 && asset.sha256 !== sha256) {
      throw new RelayError('hash_mismatch', 'The photo bytes do not match the hash the relay declared.');
    }
    return { bytes, content_type: type, sha256 };
  }
}

// ---------------------------------------------------------------------------
// Sync algorithm
// ---------------------------------------------------------------------------

export interface SyncState {
  /** Safe resume point: every photo before it is resolved. */
  cursor: string | null;
  /** True once existing photos at connection time have been classified. */
  baselineDone: boolean;
  /** Existing photos explicitly selected for import on first connection. */
  selection: string[];
}

export type ImportOutcome = 'imported' | 'duplicate';

export interface SyncSink {
  /** True when the asset already has a ledger entry (imported, failed or skipped). */
  isKnown(assetId: string): Promise<boolean>;
  /** Import one photo. Throw SinkError for failures. */
  importAsset(asset: RelayAsset, content: RelayContent): Promise<ImportOutcome>;
  /** Record a terminal outcome so the asset is never fetched again. */
  recordSkipped(asset: RelayAsset, status: 'failed' | 'skipped', code: string): Promise<void>;
  /** Persist progress; called after each page whose photos are all resolved. */
  saveState(state: SyncState): Promise<void>;
}

export interface SyncOptions {
  pageSize?: number;
  /** Pages read per sync (default 20); `more` is true when stopped early. */
  maxPages?: number;
  /** Imports per sync (default 50). */
  maxImports?: number;
  signal?: AbortSignal;
}

export interface SyncResult {
  state: SyncState;
  imported: string[];
  duplicates: string[];
  failed: { asset_id: string; code: string }[];
  /** Existing photos recorded as skipped during the first-connection baseline. */
  baselineSkipped: number;
  /** Selected ids not found among committed photos during the baseline. */
  selectionNotFound: string[];
  /** Listed photos not yet committed (held back, retried next sync). */
  pendingUncommitted: number;
  pagesRead: number;
  /** True when limits stopped the sync with more listing left. */
  more: boolean;
  /** Connection-level failure that stopped the sync (cursor kept). */
  error: RelayError | SinkError | null;
}

export async function syncOnce(client: Pick<RelayClient, 'listPage' | 'fetchContent'>, initial: SyncState, sink: SyncSink, opts: SyncOptions = {}): Promise<SyncResult> {
  const pageSize = opts.pageSize ?? 50;
  const maxPages = opts.maxPages ?? 20;
  const maxImports = opts.maxImports ?? 50;
  const state: SyncState = { cursor: initial.cursor, baselineDone: initial.baselineDone, selection: [...initial.selection] };
  const selected = new Set(state.selection);
  // Selected ids leave state.selection once resolved, so whatever remains when
  // the baseline completes was not found among committed photos.
  const resolveSelected = (id: string) => {
    if (selected.has(id)) state.selection = state.selection.filter((s) => s !== id);
  };
  const result: SyncResult = {
    state,
    imported: [],
    duplicates: [],
    failed: [],
    baselineSkipped: 0,
    selectionNotFound: [],
    pendingUncommitted: 0,
    pagesRead: 0,
    more: false,
    error: null,
  };

  let listCursor = state.cursor;
  // Once a page holds an unresolved photo, the persisted cursor stays put for
  // the rest of this sync; later pages are still processed (the ledger
  // dedupes the re-read next time).
  let heldBack = false;
  let reachedEnd = false;

  const importOne = async (asset: RelayAsset): Promise<'resolved' | 'unresolved' | 'stop'> => {
    try {
      const content = await client.fetchContent(asset, opts.signal);
      const outcome = await sink.importAsset(asset, content);
      (outcome === 'imported' ? result.imported : result.duplicates).push(asset.asset_id);
      resolveSelected(asset.asset_id);
      return 'resolved';
    } catch (err) {
      if ((err instanceof RelayError || err instanceof SinkError) && err.scope === 'asset') {
        await sink.recordSkipped(asset, 'failed', err.code);
        result.failed.push({ asset_id: asset.asset_id, code: err.code });
        resolveSelected(asset.asset_id);
        return 'resolved';
      }
      if (err instanceof RelayError || err instanceof SinkError) {
        result.error = err;
        return 'stop';
      }
      throw err;
    }
  };

  pages: while (result.pagesRead < maxPages) {
    let page: RelayAssetPage;
    try {
      page = await client.listPage(listCursor, pageSize, opts.signal);
    } catch (err) {
      if (err instanceof RelayError) {
        result.error = err;
        break;
      }
      throw err;
    }
    result.pagesRead++;
    let pageUnresolved = false;

    for (const asset of page.assets) {
      if (!isPhoto(asset)) continue;
      if (!asset.committed) {
        // Listed but not committed yet: it becomes importable later.
        result.pendingUncommitted++;
        pageUnresolved = true;
        continue;
      }
      if (await sink.isKnown(asset.asset_id)) {
        resolveSelected(asset.asset_id);
        continue;
      }
      if (!state.baselineDone && !selected.has(asset.asset_id)) {
        // Existed before the connection and was not selected: never import.
        await sink.recordSkipped(asset, 'skipped', 'existing_not_selected');
        result.baselineSkipped++;
        continue;
      }
      // Leaving mid-page skips the cursor update below, so this page is re-read next time.
      if (result.imported.length >= maxImports) {
        result.more = true;
        break pages;
      }
      if ((await importOne(asset)) === 'stop') break pages;
    }

    if (pageUnresolved) heldBack = true;
    const advanced = page.next_cursor !== null && page.next_cursor !== listCursor;
    if (advanced) listCursor = page.next_cursor;
    if (!heldBack && advanced) {
      state.cursor = listCursor;
      await sink.saveState(state);
    }
    if (!page.has_more || !advanced || (page.assets.length === 0 && page.invalid_entries === 0)) {
      reachedEnd = true;
      break;
    }
  }
  if (!reachedEnd && !result.error && result.pagesRead >= maxPages) result.more = true;

  if (!state.baselineDone && reachedEnd && !result.error) {
    // Every existing photo has now been classified; selected photos that
    // failed transiently stay unknown and import on a later sync.
    state.baselineDone = true;
    result.selectionNotFound = [...state.selection];
    state.selection = [];
    await sink.saveState(state);
  }
  return result;
}
