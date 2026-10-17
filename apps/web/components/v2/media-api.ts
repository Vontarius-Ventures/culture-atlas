/**
 * Browser client for the /v2 capture contract (specs/capture-platform-v2/
 * BACKEND-CONTRACTS.md, schemas in @culture-atlas/domain/schemas/capture-v2).
 *
 *  - Cookie session + CSRF from GET /v1/session (shared `api` client); every
 *    mutation sends `x-csrf-token`, `X-Atlas-Expected-Account` and a UUID
 *    `Idempotency-Key` (callers pass a persisted key when a retry must replay).
 *  - Responses are validated with the shared zod contracts; drift fails loudly.
 *  - Errors use the v2 envelope `{error:{code,message,retryable,request_id}}`.
 */
import { z } from 'zod';
import {
  AnalyzeMediaResponse,
  BatchDeleteMediaResponse,
  CaptureCapabilitiesResponse,
  CaptureDeviceResponse,
  MediaDetailResponse,
  MediaLibraryResponse,
  MediaUploadResponse,
  UploadPartInstruction,
  type CreateMediaUploadRequest,
} from '@culture-atlas/domain/schemas';
import { api, ApiError, CSRF_HEADER, newIdempotencyKey, type ApiErrorBody } from '@/lib/client/api';

export type MediaDetail = z.infer<typeof MediaDetailResponse>;
export type MediaLibrary = z.infer<typeof MediaLibraryResponse>;
export type UploadResponse = z.infer<typeof MediaUploadResponse>;
export type PartInstruction = z.infer<typeof UploadPartInstruction>;
export type Capabilities = z.infer<typeof CaptureCapabilitiesResponse>;
export type CaptureDevice = z.infer<typeof CaptureDeviceResponse>;
export type AnalysisResponse = z.infer<typeof AnalyzeMediaResponse>;

const OFFLINE: ApiErrorBody = {
  code: 'offline',
  message: 'You are offline. Your files stay on this device until you reconnect.',
  retryable: true,
  request_id: 'client',
};
const DRIFT: ApiErrorBody = {
  code: 'internal',
  message: 'Something went wrong.',
  retryable: true,
  request_id: 'client',
};

const AbortResponse = z.object({ upload_id: z.uuid(), state: z.literal('aborted') });
const PartsResponse = z.object({ parts: z.array(UploadPartInstruction) });
const DevicesResponse = z.object({
  items: z.array(CaptureDeviceResponse),
  next_cursor: z.string().nullable(),
});
const CollectionMediaResult = z.object({ collection_id: z.uuid(), asset_id: z.uuid() });

interface CallOptions<T> {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT';
  body?: unknown;
  idempotencyKey?: string;
  schema: z.ZodType<T> | null;
  signal?: AbortSignal;
}

export async function readV2Error(res: Response): Promise<ApiErrorBody> {
  try {
    const raw = (await res.json()) as { error?: Partial<ApiErrorBody> };
    const e = raw.error;
    if (e && typeof e.code === 'string' && typeof e.message === 'string')
      return {
        code: e.code,
        message: e.message,
        retryable: Boolean(e.retryable),
        request_id: typeof e.request_id === 'string' ? e.request_id : 'unknown',
      };
  } catch {
    // fall through
  }
  return {
    code: res.status >= 500 ? 'service_unavailable' : 'internal',
    message:
      res.status >= 500 ? 'The service is temporarily unavailable.' : 'Something went wrong.',
    retryable: res.status >= 500,
    request_id: 'unknown',
  };
}

export async function v2<T>(path: string, options: CallOptions<T>, retried = false): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json' };
  const session = await api.getSession().catch(() => null);
  if (method !== 'GET') {
    if (session) {
      headers[CSRF_HEADER] = session.csrf_token;
      if (session.principal.account_id)
        headers['X-Atlas-Expected-Account'] = session.principal.account_id;
    }
    headers['idempotency-key'] = options.idempotencyKey ?? newIdempotencyKey();
  }
  let body: string | undefined;
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(options.body);
  }
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      body,
      credentials: 'same-origin',
      signal: options.signal,
    });
  } catch (err) {
    if ((err as { name?: string })?.name === 'AbortError') throw err;
    throw new ApiError(0, OFFLINE);
  }
  if (!res.ok) {
    const e = await readV2Error(res);
    if (e.code === 'csrf_failed' && !retried) {
      await api.refreshSession();
      return v2(path, options, true);
    }
    throw new ApiError(res.status, e);
  }
  if (res.status === 204 || options.schema === null) return undefined as T;
  const data: unknown = await res.json().catch(() => undefined);
  const parsed = options.schema.safeParse(data);
  if (!parsed.success) {
    console.error(
      `[v2] ${method} ${path} response did not match the contract`,
      parsed.error.issues.slice(0, 5),
    );
    throw new ApiError(500, DRIFT);
  }
  return parsed.data;
}

function qs(query: Record<string, string | number | undefined | null>): string {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(query))
    if (v !== undefined && v !== null && v !== '') s.set(k, String(v));
  const out = s.toString();
  return out ? `?${out}` : '';
}

export const mediaApi = {
  capabilities: (signal?: AbortSignal) =>
    v2('/v2/capabilities', { schema: CaptureCapabilitiesResponse, signal }),
  library: (
    query: {
      kind?: 'photo' | 'video';
      status?: string;
      source?: string;
      cursor?: string | null;
      limit?: number;
    },
    signal?: AbortSignal,
  ) => v2(`/v2/library${qs(query)}`, { schema: MediaLibraryResponse, signal }),
  media: (id: string, signal?: AbortSignal) =>
    v2(`/v2/media/${encodeURIComponent(id)}`, { schema: MediaDetailResponse, signal }),
  deleteMedia: (id: string, expectedGeneration: number, idempotencyKey?: string) =>
    v2(`/v2/media/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      body: { expected_generation: expectedGeneration },
      idempotencyKey,
      schema: null,
    }),
  batchDelete: (items: Array<{ id: string; expected_generation: number }>) =>
    v2('/v2/media/batch-delete', {
      method: 'POST',
      body: { items },
      schema: BatchDeleteMediaResponse,
    }),
  analyze: (
    id: string,
    body: {
      focus?: string;
      mode: 'photo' | 'selected_frame' | 'sampled_video';
      frame_id?: string;
      timestamp_ms?: number;
      expected_generation: number;
    },
    idempotencyKey?: string,
  ) =>
    v2(`/v2/media/${encodeURIComponent(id)}/analysis`, {
      method: 'POST',
      body: body,
      idempotencyKey,
      schema: AnalyzeMediaResponse,
    }),
  analysis: (id: string, analysisId: string, signal?: AbortSignal) =>
    v2(`/v2/media/${encodeURIComponent(id)}/analysis/${encodeURIComponent(analysisId)}`, {
      schema: AnalyzeMediaResponse,
      signal,
    }),
  createUpload: (body: CreateMediaUploadRequest, idempotencyKey: string) =>
    v2('/v2/uploads', { method: 'POST', body, idempotencyKey, schema: MediaUploadResponse }),
  getUpload: (id: string, signal?: AbortSignal) =>
    v2(`/v2/uploads/${encodeURIComponent(id)}`, { schema: MediaUploadResponse, signal }),
  resumeUpload: (id: string) =>
    v2(`/v2/uploads/${encodeURIComponent(id)}/resume`, {
      method: 'POST',
      body: {},
      schema: MediaUploadResponse,
    }),
  parts: (id: string, partNumbers: number[]) =>
    v2(`/v2/uploads/${encodeURIComponent(id)}/parts`, {
      method: 'POST',
      body: { part_numbers: partNumbers },
      schema: PartsResponse,
    }),
  completeUpload: (
    id: string,
    parts: Array<{ part_number: number; etag: string }>,
    idempotencyKey: string,
  ) =>
    v2(`/v2/uploads/${encodeURIComponent(id)}/complete`, {
      method: 'POST',
      body: { parts },
      idempotencyKey,
      schema: MediaUploadResponse,
    }),
  abortUpload: (id: string) =>
    v2(`/v2/uploads/${encodeURIComponent(id)}`, { method: 'DELETE', schema: AbortResponse }),
  devices: (signal?: AbortSignal) => v2('/v2/devices', { schema: DevicesResponse, signal }),
  revokeDevice: (id: string, expectedRevision: number) =>
    v2(`/v2/devices/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      body: { expected_revision: expectedRevision },
      schema: null,
    }),
  addToCollection: (collectionId: string, assetId: string) =>
    v2(`/v2/collections/${encodeURIComponent(collectionId)}/media/${encodeURIComponent(assetId)}`, {
      method: 'PUT',
      schema: CollectionMediaResult,
    }),
};

/** Words for errors the media screens explain explicitly. */
export function mediaErrorMessage(
  err: unknown,
  fallback = 'Something went wrong. Try again.',
): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case 'offline':
        return 'You are offline. Check your connection and try again.';
      case 'unauthenticated':
      case 'scope_denied':
        return 'Sign in to your account to see your library.';
      case 'not_found':
        return 'This item is not in your library.';
      case 'account_mismatch':
        return 'You signed in to a different account. Return to the original account to continue.';
      default:
        return err.message || fallback;
    }
  }
  return fallback;
}

export function isSignedOutError(err: unknown): boolean {
  return err instanceof ApiError && (err.code === 'unauthenticated' || err.code === 'scope_denied');
}
