/**
 * Stateful mock of the /v2 capture contract for browser tests (the backend is
 * built in parallel). Every response is validated with the shared zod
 * schemas from @culture-atlas/domain/schemas, so UI tests fail on contract
 * drift. Media bytes come from e2e/v2/fixtures (crops of the design package's
 * generated references). This is not a provider simulation and produces no
 * analysis results.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Page, Route } from '@playwright/test';
import { type z } from 'zod';
import {
  AnalyzeMediaResponse,
  BatchDeleteMediaRequest,
  BatchDeleteMediaResponse,
  CaptureCapabilitiesResponse,
  CaptureDeviceResponse,
  CompleteMediaUploadRequest,
  CreateMediaUploadRequest,
  DeleteMediaRequest,
  MediaDetailResponse,
  MediaLibraryResponse,
  MediaUploadResponse,
  UploadPartsRequest,
} from '@culture-atlas/domain/schemas';
import { installMockApi, type MockApi, type MockOptions } from '../mock/api';

export const FIXTURES = path.join(import.meta.dirname, 'fixtures');
const PART_SIZE = 8_388_608;

type Detail = z.infer<typeof MediaDetailResponse>;
type Device = z.infer<typeof CaptureDeviceResponse>;

export interface SeedMedia {
  title: string | null;
  kind: 'photo' | 'video';
  source: 'browser_camera' | 'phone_camera' | 'meta_glasses' | 'upload';
  status?: Detail['media']['status'];
  image?: string;
  video?: string;
  duration_ms?: number;
  frames?: Array<{ ms: number; image: string }>;
  minutesAgo?: number;
  audio?: boolean;
}

/** Reference 01 fixtures (titles and subjects are design fixtures, not real data). */
export const LIBRARY_SEED: SeedMedia[] = [
  { title: 'Quiet corners', kind: 'photo', source: 'meta_glasses', image: 'quiet-corners.jpg' },
  { title: 'A slow morning', kind: 'photo', source: 'phone_camera', image: 'slow-morning.jpg' },
  { title: 'Olive layers', kind: 'photo', source: 'upload', image: 'olive-layers.jpg' },
  {
    title: 'Along the coast',
    kind: 'video',
    source: 'meta_glasses',
    image: 'along-the-coast.jpg',
    video: 'slower-afternoon.webm',
    duration_ms: 42_000,
  },
  { title: 'Record shop', kind: 'photo', source: 'phone_camera', image: 'record-shop.jpg' },
  {
    title: 'Afternoon walk',
    kind: 'video',
    source: 'phone_camera',
    image: 'afternoon-walk.jpg',
    video: 'slower-afternoon.webm',
    duration_ms: 18_000,
  },
  { title: 'Made by hand', kind: 'photo', source: 'upload', image: 'made-by-hand.jpg' },
  { title: 'Green spaces', kind: 'photo', source: 'phone_camera', image: 'green-spaces.jpg' },
];

export const VIDEO_SEED: SeedMedia = {
  title: 'A slower afternoon',
  kind: 'video',
  source: 'meta_glasses',
  image: 'slower-afternoon.jpg',
  video: 'slower-afternoon.webm',
  duration_ms: 42_000,
  audio: false,
  frames: [
    { ms: 3_000, image: 'moment-1.jpg' },
    { ms: 12_000, image: 'moment-2.jpg' },
    { ms: 24_000, image: 'moment-3.jpg' },
    { ms: 36_000, image: 'moment-4.jpg' },
  ],
};

export interface V2Options extends MockOptions {
  media?: SeedMedia[];
  /** 'blocked' = server's current kill-switched evaluation (reference 09); 'device' = only device-local reasons (04). */
  glasses?: 'blocked' | 'device';
  analysis?: boolean;
  /**
   * Successive GET /v2/media/{id}/analysis/{aid} answers (fields over a queued
   * default); the last one repeats. DELETE always answers cancelled.
   */
  analysisStates?: Array<{
    state: 'queued' | 'running' | 'partial' | 'complete' | 'failed' | 'cancelled';
    result_url?: string | null;
    capture_id?: string | null;
    waiting_reason?: string | null;
    error_code?: string | null;
  }>;
  videoUploads?: boolean;
  devices?: Array<Partial<Device> & { platform: 'ios' | 'android' }>;
  /** GET /v2/library fails with 503 the first N times. */
  libraryFailures?: number;
  /** Delay before the library answers (ms). */
  libraryDelay?: number;
  /** POST /v2/uploads/{id}/parts never answers (holds a resumed transfer mid-way). */
  holdParts?: boolean;
  /** Part PUTs fail like a dropped connection. */
  failParts?: boolean;
  /** Media stays in `processing` after upload. */
  holdPreparation?: boolean;
}

interface UploadRec {
  id: string;
  assetId: string;
  clientCaptureId: string;
  request: z.infer<typeof CreateMediaUploadRequest>;
  state: z.infer<typeof MediaUploadResponse>['state'];
  receipts: Array<{ part_number: number; etag: string }>;
  expiresAt: string;
}

let seq = 0;
const uuid = () => {
  seq += 1;
  const hex = seq.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${hex}`;
};

export class MockV2 {
  readonly log: Array<{ method: string; path: string; body?: unknown }> = [];
  media = new Map<string, Detail>();
  files = new Map<string, string>();
  uploads = new Map<string, UploadRec>();
  devices: Device[] = [];
  libraryFailures: number;
  partPuts = 0;
  partLog: string[] = [];

  constructor(
    readonly page: Page,
    readonly v1: MockApi,
    readonly opts: V2Options,
    readonly baseURL: string,
  ) {
    seq = 0x5000;
    this.libraryFailures = opts.libraryFailures ?? 0;
    (opts.media ?? []).forEach((m, i) => this.addMedia(m, i));
    for (const d of opts.devices ?? [])
      this.devices.push(
        CaptureDeviceResponse.parse({
          id: uuid(),
          app_version: '2.0.0 (12)',
          revision: 1,
          last_seen_at: new Date().toISOString(),
          revoked_at: null,
          capabilities: { photo: true, video: true, meta_glasses: true },
          readiness: 'ready',
          app_state: 'foreground',
          ...d,
        }),
      );
  }

  get accountId() {
    return this.v1.session.account_id;
  }

  addMedia(seed: SeedMedia, index = 0): Detail {
    const id = uuid();
    const link = (variant: string, file?: string) => {
      if (!file) return null;
      const url = `/v2/media/${id}/content/${variant}`;
      this.files.set(url, file);
      return url;
    };
    const status = seed.status ?? 'ready';
    const ready = status === 'ready';
    const createdAt = new Date(
      Date.now() - ((seed.minutesAgo ?? 5) + index) * 60_000,
    ).toISOString();
    const detail = MediaDetailResponse.parse({
      media: {
        schema_version: 1,
        id,
        kind: seed.kind,
        source: seed.source,
        status,
        analysis_status: 'not_requested',
        created_at: createdAt,
        title: seed.title,
        width: 1600,
        height: 1200,
        ...(seed.kind === 'video' && seed.duration_ms
          ? { duration_ms: seed.duration_ms, audio_present: seed.audio ?? false }
          : {}),
      },
      generation: 1,
      revision: 1,
      error_code: null,
      links: {
        original: ['processing', 'ready', 'failed'].includes(status)
          ? link('original', seed.video ?? seed.image)
          : null,
        playback: ready
          ? link(
              seed.kind === 'photo' ? 'normalized' : 'playback',
              seed.kind === 'photo' ? seed.image : seed.video,
            )
          : null,
        poster: seed.kind === 'video' ? link('poster', seed.image) : null,
        analysis: null,
      },
      frames: (seed.frames ?? []).map((f, i) => ({
        id: uuid(),
        timestamp_ms: f.ms,
        extraction_version: 'frames-v1',
        thumbnail_url: link(`frame-${i}`, f.image)!,
      })),
    });
    this.media.set(id, detail);
    return detail;
  }

  capabilities() {
    const glasses =
      this.opts.glasses === 'device'
        ? ['build_unsupported', 'device_unsupported', 'permission_required', 'user_action_required']
        : [
            'build_unsupported',
            'release_channel_ineligible',
            'rollout_unavailable',
            'device_unsupported',
            'permission_required',
            'user_action_required',
            'temporarily_disabled',
          ];
    const video = this.opts.videoUploads !== false;
    return CaptureCapabilitiesResponse.parse({
      contract_version: '2026-10-15.1',
      flags: {
        media_library: true,
        camera_photo: true,
        camera_video: video,
        file_photo_upload: true,
        file_video_upload: video,
        meta_glasses_entry_visible: true,
        meta_glasses_capture_enabled: false,
        concentrate_analysis_enabled: Boolean(this.opts.analysis),
        automatic_analysis: false,
      },
      limits: {
        photo_max_bytes: 15 * 1024 * 1024,
        photo_max_pixels: 40_000_000,
        video_max_bytes: 250 * 1024 * 1024,
        video_max_duration_ms: 120_000,
        capture_video_max_duration_ms: 60_000,
        account_quota_bytes: 5 * 1024 ** 3,
        batch_max_files: 20,
        concurrent_transfers: 2,
        analysis_daily_limit: 50,
        video_analysis_max_frames: 8,
      },
      availability: {
        meta_glasses: { available: false, reasons: glasses },
        analysis: {
          available: Boolean(this.opts.analysis),
          reasons: this.opts.analysis ? [] : ['provider_unavailable'],
        },
        video: { available: video, reasons: video ? [] : ['decoder_unqualified'] },
      },
    });
  }

  private uploadResponse(u: UploadRec, sign: boolean) {
    const count = Math.ceil(u.request.byte_size / PART_SIZE);
    return MediaUploadResponse.parse({
      asset_id: u.assetId,
      upload_id: u.id,
      state: u.state,
      expires_at: u.expiresAt,
      part_size: PART_SIZE,
      part_count: count,
      parts: sign
        ? Array.from({ length: Math.min(count, 100) }, (_, i) => this.partInstruction(u, i + 1))
        : [],
      verified_parts: u.receipts,
      error_code: null,
      pause_reason: null,
    });
  }

  private partInstruction(u: UploadRec, n: number) {
    return {
      part_number: n,
      method: 'PUT' as const,
      url: `${this.baseURL}/__mock_storage/parts/${u.id}/${n}`,
      headers: {},
      expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
    };
  }

  /** Server-side seed of an upload already in progress (for resume tests). */
  seedUpload(
    clientCaptureId: string,
    request: z.infer<typeof CreateMediaUploadRequest>,
    receipts: number[],
    minutesAgo = 5,
  ) {
    const id = uuid();
    const detail = this.addMedia({
      title: null,
      kind: request.kind,
      source: request.source,
      status: 'pending_upload',
      minutesAgo,
    });
    const rec: UploadRec = {
      id,
      assetId: detail.media.id,
      clientCaptureId,
      request,
      state: receipts.length ? 'uploading' : 'created',
      receipts: receipts.map((n) => ({ part_number: n, etag: `"etag-${n}"` })),
      expiresAt: new Date(Date.now() + 24 * 3600_000).toISOString(),
    };
    this.uploads.set(id, rec);
    return rec;
  }

  private json(route: Route, status: number, body: unknown) {
    return route.fulfill({
      status,
      contentType: 'application/json',
      headers: { 'cache-control': 'private, no-store' },
      body: body === undefined ? '' : JSON.stringify(body),
    });
  }

  private error(route: Route, status: number, code: string, message: string, retryable = false) {
    return this.json(route, status, { error: { code, message, retryable, request_id: 'mock' } });
  }

  async handle(route: Route) {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();
    const p = url.pathname;
    let body: unknown;
    try {
      body = req.postData() ? JSON.parse(req.postData()!) : undefined;
    } catch {
      body = undefined;
    }
    this.log.push({ method, path: p, body });

    const file = this.files.get(p);
    if (method === 'GET' && file) {
      const bytes = readFileSync(path.join(FIXTURES, file));
      const type = file.endsWith('.webm')
        ? 'video/webm'
        : file.endsWith('.mp4')
          ? 'video/mp4'
          : 'image/jpeg';
      return route.fulfill({
        status: 200,
        body: bytes,
        headers: { 'content-type': type, 'accept-ranges': 'bytes' },
      });
    }

    if (this.v1.session.kind !== 'account')
      return this.error(route, 401, 'unauthenticated', 'Sign in to continue.');
    if (method !== 'GET') {
      if (req.headers()['x-csrf-token'] !== this.v1.session.csrf)
        return this.error(route, 403, 'csrf_failed', 'The request could not be verified.');
      if (!/^[0-9a-f-]{36}$/.test(req.headers()['idempotency-key'] ?? ''))
        return this.error(route, 400, 'invalid_input', 'Idempotency-Key must be a UUID.');
      if (req.headers()['x-atlas-expected-account'] !== this.accountId)
        return this.error(route, 409, 'account_mismatch', 'The signed-in account changed.');
    }

    let m: RegExpExecArray | null;
    if (p === '/v2/capabilities') return this.json(route, 200, this.capabilities());

    if (p === '/v2/library' && method === 'GET') {
      if (this.opts.libraryDelay) await new Promise((r) => setTimeout(r, this.opts.libraryDelay));
      if (this.libraryFailures > 0) {
        this.libraryFailures -= 1;
        return this.error(
          route,
          503,
          'service_unavailable',
          'The service is temporarily unavailable.',
          true,
        );
      }
      const kind = url.searchParams.get('kind');
      const status = url.searchParams.get('status');
      const limit = Number(url.searchParams.get('limit') ?? 30);
      const items = [...this.media.values()]
        .filter((d) => d.media.status !== 'deleted')
        .filter((d) => !kind || d.media.kind === kind)
        .filter((d) => !status || d.media.status === status)
        .sort((a, b) => b.media.created_at.localeCompare(a.media.created_at));
      const cursor = Number(url.searchParams.get('cursor') ?? 0);
      const page = items.slice(cursor, cursor + limit);
      return this.json(
        route,
        200,
        MediaLibraryResponse.parse({
          items: page,
          next_cursor: cursor + limit < items.length ? String(cursor + limit) : null,
        }),
      );
    }

    if (p === '/v2/media/batch-delete' && method === 'POST') {
      const input = BatchDeleteMediaRequest.parse(body);
      const items = input.items.map((i) => {
        const d = this.media.get(i.id);
        if (!d) return { id: i.id, deleted: false, error_code: 'not_found' };
        if (d.generation !== i.expected_generation)
          return { id: i.id, deleted: false, error_code: 'conflict' };
        this.media.delete(i.id);
        return { id: i.id, deleted: true, error_code: null };
      });
      return this.json(route, 200, BatchDeleteMediaResponse.parse({ items }));
    }

    if ((m = /^\/v2\/media\/([^/]+)\/analysis(?:\/([^/]+))?$/.exec(p))) {
      const d = this.media.get(m[1]!);
      if (!d) return this.error(route, 404, 'not_found', 'Not found.');
      if (!this.opts.analysis)
        return this.error(route, 503, 'provider_unavailable', 'Analysis is unavailable.', true);
      const base = {
        analysis_id: m[2] ?? uuid(),
        job_id: uuid(),
        state: 'queued' as const,
        reused: false,
        result_url: null,
        capture_id: null,
      };
      if (m[2] && method === 'DELETE')
        return this.json(route, 200, AnalyzeMediaResponse.parse({ ...base, state: 'cancelled' }));
      if (m[2] && method === 'GET' && this.opts.analysisStates?.length) {
        const states = this.opts.analysisStates;
        const next = states.length > 1 ? states.shift()! : states[0]!;
        return this.json(route, 200, AnalyzeMediaResponse.parse({ ...base, ...next }));
      }
      return this.json(route, 202, AnalyzeMediaResponse.parse(base));
    }

    if ((m = /^\/v2\/media\/([^/]+)$/.exec(p))) {
      const d = this.media.get(m[1]!);
      if (!d) return this.error(route, 404, 'not_found', 'Not found.');
      if (method === 'GET') return this.json(route, 200, MediaDetailResponse.parse(d));
      if (method === 'DELETE') {
        const input = DeleteMediaRequest.parse(body);
        if (input.expected_generation !== d.generation)
          return this.error(route, 409, 'conflict', 'Changed.');
        this.media.delete(d.media.id);
        return this.json(route, 202, { id: d.media.id, deleted: true });
      }
    }

    if (p === '/v2/uploads' && method === 'POST') {
      const input = CreateMediaUploadRequest.parse(body);
      if (input.kind === 'video' && this.opts.videoUploads === false)
        return this.error(
          route,
          503,
          'service_unavailable',
          'Video uploads are not qualified on this server.',
          true,
        );
      const existing = [...this.uploads.values()].find(
        (u) => u.clientCaptureId === input.client_capture_id,
      );
      if (existing) return this.json(route, 201, this.uploadResponse(existing, true));
      const detail = this.addMedia({
        title: null,
        kind: input.kind,
        source: input.source,
        status: 'pending_upload',
        minutesAgo: 0,
      });
      const rec: UploadRec = {
        id: uuid(),
        assetId: detail.media.id,
        clientCaptureId: input.client_capture_id,
        request: input,
        state: 'created',
        receipts: [],
        expiresAt: new Date(Date.now() + 24 * 3600_000).toISOString(),
      };
      this.uploads.set(rec.id, rec);
      return this.json(route, 201, this.uploadResponse(rec, true));
    }

    if ((m = /^\/v2\/uploads\/([^/]+)(?:\/(parts|complete|resume))?$/.exec(p))) {
      const u = this.uploads.get(m[1]!);
      if (!u) return this.error(route, 404, 'not_found', 'Not found.');
      if (!m[2] && method === 'GET') return this.json(route, 200, this.uploadResponse(u, false));
      if (!m[2] && method === 'DELETE') {
        u.state = 'aborted';
        this.media.delete(u.assetId);
        return this.json(route, 202, { upload_id: u.id, state: 'aborted' });
      }
      if (m[2] === 'parts') {
        if (this.opts.holdParts) return; // never answers: transfer stays mid-way
        const input = UploadPartsRequest.parse(body);
        u.state = 'uploading';
        return this.json(route, 200, {
          parts: input.part_numbers.map((n) => this.partInstruction(u, n)),
        });
      }
      if (m[2] === 'complete') {
        const input = CompleteMediaUploadRequest.parse(body);
        const count = Math.ceil(u.request.byte_size / PART_SIZE);
        if (input.parts.length !== count)
          return this.error(route, 400, 'invalid_input', 'Missing parts.');
        u.state = 'verifying';
        u.receipts = input.parts;
        const d = this.media.get(u.assetId)!;
        d.media.status = this.opts.holdPreparation ? 'processing' : 'ready';
        if (!this.opts.holdPreparation) {
          const fixture = u.request.kind === 'photo' ? 'pottery-table.jpg' : 'along-the-coast.jpg';
          d.links.playback =
            u.request.kind === 'photo' ? `/v2/media/${d.media.id}/content/normalized` : null;
          d.links.poster = `/v2/media/${d.media.id}/content/poster`;
          this.files.set(`/v2/media/${d.media.id}/content/normalized`, fixture);
          this.files.set(`/v2/media/${d.media.id}/content/poster`, fixture);
        }
        return this.json(route, 202, this.uploadResponse(u, false));
      }
    }

    if (p === '/v2/devices' && method === 'GET')
      return this.json(route, 200, { items: this.devices, next_cursor: null });
    if ((m = /^\/v2\/devices\/([^/]+)$/.exec(p)) && method === 'DELETE') {
      const d = this.devices.find((x) => x.id === m![1]);
      if (!d) return this.error(route, 404, 'not_found', 'Not found.');
      d.revoked_at = new Date().toISOString();
      return this.json(route, 202, { id: d.id, revoked_at: d.revoked_at });
    }
    if ((m = /^\/v2\/collections\/([^/]+)\/media\/([^/]+)$/.exec(p)) && method === 'PUT')
      return this.json(route, 200, { collection_id: m[1], asset_id: m[2] });

    return this.error(route, 404, 'not_found', `No mock for ${method} ${p}`);
  }

  async handleStorage(route: Route) {
    const req = route.request();
    const m = /\/__mock_storage\/parts\/([^/]+)\/(\d+)$/.exec(new URL(req.url()).pathname);
    if (!m || req.method() !== 'PUT') return route.fulfill({ status: 404 });
    this.partPuts += 1;
    this.partLog.push(`${m[1]}/${m[2]}`);
    if (this.opts.failParts) return route.abort('connectionreset');
    // Like S3 ListParts: a stored part is reported by GET /v2/uploads/{id} even if the client lost the ETag.
    const u = this.uploads.get(m[1]!);
    const n = Number(m[2]);
    if (u && !u.receipts.some((r) => r.part_number === n))
      u.receipts = [...u.receipts, { part_number: n, etag: `"etag-${n}"` }].sort(
        (a, b) => a.part_number - b.part_number,
      );
    return route.fulfill({
      status: 200,
      headers: { etag: `"etag-${m[2]}"`, 'access-control-expose-headers': 'ETag' },
      body: '',
    });
  }

  async handleHandoff(route: Route) {
    const req = route.request();
    if (req.method() === 'POST')
      return this.json(route, 201, {
        url: `${this.baseURL}/capture/glasses?handoff=h1.mock-token.signature`,
        expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
      });
    const token = new URL(req.url()).searchParams.get('token');
    return this.json(route, 200, {
      status: token === 'expired' ? 'expired' : token?.startsWith('h1.') ? 'valid' : 'invalid',
      expires_at: null,
      same_account: token?.startsWith('h1.') ? true : null,
    });
  }
}

/** Mock /v1 (session, collections) and /v2, then open `url`. */
export async function openV2(
  page: Page,
  url: string,
  opts: V2Options = {},
  baseURL = `http://localhost:${process.env.E2E_PORT ?? 3000}`,
): Promise<MockV2> {
  const v1 = await installMockApi(page, { account: true, ...opts });
  const v2 = new MockV2(page, v1, opts, baseURL);
  await page.route(
    (u) => u.pathname.startsWith('/v2/'),
    (route) => v2.handle(route),
  );
  await page.route('**/__mock_storage/**', (route) => v2.handleStorage(route));
  await page.route(
    (u) => u.pathname === '/capture/handoff',
    (route) => v2.handleHandoff(route),
  );
  await page.route('**/__fixtures/**', (route) => {
    const name = new URL(route.request().url()).pathname.split('/').pop()!;
    return route.fulfill({
      status: 200,
      body: readFileSync(path.join(FIXTURES, name)),
      contentType: name.endsWith('.webm')
        ? 'video/webm'
        : name.endsWith('.mp4')
          ? 'video/mp4'
          : 'image/jpeg',
    });
  });
  if (url) await page.goto(url);
  return v2;
}

export interface SeedUploadRow {
  filename: string;
  kind: 'photo' | 'video';
  content_type: string;
  byte_size: number;
  phase:
    | 'queued'
    | 'uploading'
    | 'paused'
    | 'verifying'
    | 'processing'
    | 'ready'
    | 'failed'
    | 'rejected';
  duration_ms?: number | null;
  thumb?: string;
  /** Real bytes kept on the device (zero-filled) for resumable rows. */
  withBlob?: boolean;
  upload_id?: string | null;
  asset_id?: string | null;
  receipts?: number[];
  pause_reason?: 'offline' | 'user' | 'error' | null;
  error?: string | null;
  client_capture_id?: string;
  account_id?: string;
  sha256?: string | null;
  minutesAgo?: number;
}

/** Writes rows into the browser's durable upload queue (IndexedDB), then reloads. */
export async function seedUploadQueue(page: Page, accountId: string, rows: SeedUploadRow[]) {
  await page.evaluate(
    async ({ rows, accountId }) => {
      const db: IDBDatabase = await new Promise((resolve, reject) => {
        const req = indexedDB.open('culture-atlas-uploads', 1);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains('uploads'))
            req.result.createObjectStore('uploads', { keyPath: 'client_capture_id' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      let n = 0;
      for (const r of rows) {
        n += 1;
        const thumb = r.thumb ? await fetch(`/__fixtures/${r.thumb}`).then((x) => x.blob()) : null;
        const blob = r.withBlob
          ? new Blob([new Uint8Array(r.byte_size)], { type: r.content_type })
          : null;
        const at = new Date(Date.now() - (r.minutesAgo ?? 10 - n) * 60_000).toISOString();
        const id = r.client_capture_id ?? `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
        const entry = {
          client_capture_id: id,
          account_id: r.account_id ?? accountId,
          filename: r.filename,
          kind: r.kind,
          content_type: r.content_type,
          source: 'upload',
          byte_size: r.byte_size,
          sha256: r.sha256 ?? 'a'.repeat(64),
          captured_at: at,
          duration_ms: r.duration_ms ?? null,
          width: null,
          height: null,
          added_at: at,
          updated_at: at,
          blob,
          thumb,
          create_key: `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
          complete_key: `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
          upload_id: r.upload_id ?? null,
          asset_id: r.asset_id ?? null,
          part_size: r.upload_id ? 8_388_608 : null,
          part_count: r.upload_id ? Math.ceil(r.byte_size / 8_388_608) : null,
          receipts: (r.receipts ?? []).map((p) => ({ part_number: p, etag: `"etag-${p}"` })),
          phase: r.phase,
          pause_reason: r.pause_reason ?? null,
          error: r.error ?? null,
          media_status:
            r.phase === 'ready' ? 'ready' : r.phase === 'processing' ? 'processing' : null,
        };
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction('uploads', 'readwrite');
          tx.objectStore('uploads').put(entry);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      }
      db.close();
    },
    { rows, accountId },
  );
}
