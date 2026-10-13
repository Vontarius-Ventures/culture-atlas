import { SinkError, sha256Hex } from './relay';

/**
 * Client for the public culture atlas API, limited to what the restricted
 * capture-write token may call: POST /v1/uploads, POST /v1/captures and
 * GET /v1/jobs/{id}. Errors are mapped to the sync's scopes: per-photo
 * problems (unsupported or oversized image, hash mismatch) are recorded and
 * skipped; outages and rate limits stop the sync and keep the cursor; a
 * revoked, expired or wrong token is fatal and stops the bridge.
 */

export interface AppClientOptions {
  appUrl: string;
  token: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export interface UploadResult {
  upload_id: string;
  expires_at: string;
}

export interface CaptureResult {
  capture_id: string;
  job_id: string;
  reused: boolean;
}

export interface SensorRef {
  connection_id: string;
  asset_id: string;
  captured_at?: string;
  declared_sha256?: string;
}

interface ErrorBody {
  code?: string;
  message?: string;
  retryable?: boolean;
}

/**
 * Idempotency keys allow [A-Za-z0-9_-:.] only, while relay asset ids may hold
 * any character, so the asset id is hashed.
 */
export function captureIdempotencyKey(sensor: Pick<SensorRef, 'connection_id' | 'asset_id'>, uploadId: string): string {
  return `sensor:${sensor.connection_id}:${sha256Hex(new TextEncoder().encode(sensor.asset_id)).slice(0, 32)}:${uploadId}`;
}

export class AppClient {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: AppClientOptions) {
    this.base = opts.appUrl.replace(/\/+$/, '');
    this.fetchImpl = opts.fetch ?? fetch;
  }

  private async call(path: string, init: RequestInit & { headers?: Record<string, string> }): Promise<Response> {
    const timeout = AbortSignal.timeout(this.opts.timeoutMs ?? 60_000);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${this.opts.token}`, accept: 'application/json', ...init.headers },
        redirect: 'manual',
        signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
      });
    } catch (err) {
      if (init.signal?.aborted) throw err;
      throw new SinkError('connection', timeout.aborted ? 'app_timeout' : 'app_unreachable', 'The culture atlas app could not be reached.');
    }
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => undefined);
      throw new SinkError('connection', 'app_redirect', `The app redirected (HTTP ${res.status}); set BRIDGE_APP_URL to the final https URL.`, { fatal: true });
    }
    return res;
  }

  private async fail(res: Response): Promise<never> {
    let body: ErrorBody = {};
    try {
      body = (await res.json()) as ErrorBody;
    } catch {
      // not JSON
    }
    const code = body.code ?? `http_${res.status}`;
    const message = body.message ?? `HTTP ${res.status}`;
    const retryAfter = Number(res.headers.get('retry-after'));
    const retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined;
    if (res.status === 401 || res.status === 403) throw new SinkError('connection', code, message, { fatal: true });
    if (res.status === 409 && code === 'conflict') throw new SinkError('asset', 'already_imported', message);
    if (res.status === 400 || res.status === 413) throw new SinkError('asset', code, message);
    if (res.status === 404) throw new SinkError('connection', code === 'not_found' ? 'not_found' : code, message);
    throw new SinkError('connection', code, message, { retryAfterMs });
  }

  /** POST /v1/uploads (multipart). The bytes are re-validated by the app. */
  async upload(bytes: Uint8Array, contentType: string, filename: string, signal?: AbortSignal): Promise<UploadResult> {
    const form = new FormData();
    form.append('image', new Blob([bytes], { type: contentType }), filename);
    const res = await this.call('/v1/uploads', { method: 'POST', body: form, signal });
    if (res.status !== 201 && res.status !== 200) return this.fail(res);
    return (await res.json()) as UploadResult;
  }

  /**
   * POST /v1/captures with the sensor reference. The Idempotency-Key covers
   * retries of the same upload; the app's (connection, asset_id) ledger
   * covers everything else, so a repeat returns the existing capture.
   */
  async createCapture(uploadId: string, sensor: SensorRef, signal?: AbortSignal): Promise<CaptureResult> {
    const res = await this.call('/v1/captures', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': captureIdempotencyKey(sensor, uploadId) },
      body: JSON.stringify({ upload_id: uploadId, sensor }),
      signal,
    });
    if (res.status !== 202 && res.status !== 200 && res.status !== 201) return this.fail(res);
    return (await res.json()) as CaptureResult;
  }
}
