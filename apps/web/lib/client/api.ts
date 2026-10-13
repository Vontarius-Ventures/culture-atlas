/**
 * Typed browser client for the REST /v1 API, derived from the shared route
 * contract (`ROUTES` in @culture-atlas/domain/schemas):
 *  - GET /v1/session is called once (lazily) before the first request; the
 *    `csrf_token` is kept in memory and sent as `x-csrf-token` on mutations;
 *  - mutations may carry an `Idempotency-Key` (callers pass one per logical action);
 *  - request bodies are validated with the contract's zod schema before sending,
 *    responses are validated against the response schema (contract drift fails loudly);
 *  - errors are thrown as ApiError with the standard {code, message, retryable, request_id}.
 * Polling of GET /v1/jobs/{id} lives in ./jobs.ts.
 */
import type { z } from 'zod';
import { ROUTES, type RouteName, type SessionResponse } from '@culture-atlas/domain/schemas';

export const CSRF_HEADER = 'x-csrf-token';

export interface ApiErrorBody {
  code: string;
  message: string;
  retryable: boolean;
  request_id: string;
  details?: unknown;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiErrorBody,
  ) {
    super(body.message);
    this.name = 'ApiError';
  }
  get code() {
    return this.body.code;
  }
  get retryable() {
    return this.body.retryable;
  }
}

export function isApiError(err: unknown, code?: string): err is ApiError {
  return err instanceof ApiError && (code === undefined || err.body.code === code);
}

type Contract<N extends RouteName> = (typeof ROUTES)[N];
type Schema = z.ZodType;

export type ResponseOf<N extends RouteName> = Contract<N>['response'] extends infer R
  ? R extends Schema
    ? z.output<R>
    : void
  : never;

type ParamsOf<N extends RouteName> =
  Contract<N> extends { params: infer P } ? (P extends Schema ? z.input<P> : never) : never;
type QueryOf<N extends RouteName> =
  Contract<N> extends { query: infer Q } ? (Q extends Schema ? Partial<z.input<Q>> : never) : never;
type BodyOf<N extends RouteName> =
  Contract<N> extends { body: infer B }
    ? B extends Schema
      ? z.input<B>
      : B extends 'multipart'
        ? FormData
        : B extends 'json_or_multipart'
          ? FormData | Record<string, unknown>
          : never
    : never;

export type RequestOptions<N extends RouteName> = ([ParamsOf<N>] extends [never]
  ? { params?: undefined }
  : { params: ParamsOf<N> }) &
  ([QueryOf<N>] extends [never] ? { query?: undefined } : { query?: QueryOf<N> }) &
  ([BodyOf<N>] extends [never] ? { body?: undefined } : { body?: BodyOf<N> }) & {
    idempotencyKey?: string;
    signal?: AbortSignal;
  };

export function newIdempotencyKey(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c?.randomUUID) return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Builds `/v1/...` from a contract path template and params. */
export function buildPath(
  template: string,
  params?: Record<string, unknown>,
  query?: Record<string, unknown>,
): string {
  const path = template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = params?.[key];
    if (value === undefined || value === null || value === '')
      throw new Error(`Missing path param ${key}`);
    return encodeURIComponent(String(value));
  });
  if (!query) return path;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `${path}?${qs}` : path;
}

const OFFLINE: ApiErrorBody = {
  code: 'service_unavailable',
  message: 'We could not reach culture atlas. Check your connection and try again.',
  retryable: true,
  request_id: 'client',
};

const CONTRACT_DRIFT: ApiErrorBody = {
  code: 'internal',
  message: 'Something went wrong.',
  retryable: true,
  request_id: 'client',
};

export type SessionInfo = SessionResponse;

export interface ApiClientOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
}

export class ApiClient {
  private session: Promise<SessionInfo> | null = null;
  private readonly listeners = new Set<(s: SessionInfo) => void>();
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ApiClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? '';
    this.fetchImpl = options.fetch ?? ((...args) => globalThis.fetch(...args));
  }

  /** Current session (GET /v1/session once; creates the anonymous session cookie). */
  getSession(): Promise<SessionInfo> {
    if (!this.session) {
      this.session = this.request('getSession', {} as RequestOptions<'getSession'>).then((s) => {
        this.listeners.forEach((l) => l(s));
        return s;
      });
      this.session.catch(() => {
        this.session = null;
      });
    }
    return this.session;
  }

  /** Re-reads the session (after account creation or a CSRF failure). */
  refreshSession(): Promise<SessionInfo> {
    this.session = null;
    return this.getSession();
  }

  onSession(listener: (s: SessionInfo) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async request<N extends RouteName>(
    name: N,
    options: RequestOptions<N>,
    retriedCsrf = false,
  ): Promise<ResponseOf<N>> {
    const contract = ROUTES[name] as Contract<N> & {
      params?: Schema;
      query?: Schema;
      body?: Schema | string;
      response: Schema | null;
    };
    const headers: Record<string, string> = { accept: 'application/json' };
    const isMutation = contract.method !== 'GET';
    if (isMutation) {
      const session = await this.getSession();
      headers[CSRF_HEADER] = session.csrf_token;
      if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;
    }

    let body: BodyInit | undefined;
    const raw = options.body as unknown;
    if (raw !== undefined) {
      if (typeof FormData !== 'undefined' && raw instanceof FormData) {
        body = raw;
      } else {
        let json: unknown = raw;
        if (contract.body && typeof contract.body !== 'string') {
          const parsed = contract.body.safeParse(raw);
          if (!parsed.success) {
            throw new ApiError(400, {
              code: 'invalid_input',
              message: parsed.error.issues[0]?.message ?? 'The request is not valid.',
              retryable: false,
              request_id: 'client',
            });
          }
          json = parsed.data;
        }
        headers['content-type'] = 'application/json';
        body = JSON.stringify(json);
      }
    }

    const url =
      this.baseUrl +
      buildPath(
        contract.path,
        options.params as Record<string, unknown> | undefined,
        options.query as Record<string, unknown> | undefined,
      );
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: contract.method,
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
      const errBody = await readError(res);
      if (errBody.code === 'csrf_failed' && !retriedCsrf) {
        await this.refreshSession();
        return this.request(name, options, true);
      }
      throw new ApiError(res.status, errBody);
    }
    if (res.status === 204 || contract.response === null) return undefined as ResponseOf<N>;
    const data: unknown = await res.json().catch(() => undefined);
    const parsed = (contract.response as Schema).safeParse(data);
    if (!parsed.success) {
      console.error(
        `[api] ${contract.method} ${contract.path} response did not match the contract`,
        parsed.error.issues.slice(0, 5),
      );
      throw new ApiError(500, CONTRACT_DRIFT);
    }
    return parsed.data as ResponseOf<N>;
  }
}

async function readError(res: Response): Promise<ApiErrorBody> {
  try {
    const body = (await res.json()) as Partial<ApiErrorBody>;
    if (body && typeof body.code === 'string' && typeof body.message === 'string') {
      return {
        code: body.code,
        message: body.message,
        retryable: Boolean(body.retryable),
        request_id: typeof body.request_id === 'string' ? body.request_id : 'unknown',
        details: body.details,
      };
    }
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

/** The shared browser client. */
export const api = new ApiClient();
