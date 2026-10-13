/**
 * Browser API client conventions (implemented by the web UI owner):
 *  - call GET /v1/session once on load; keep `csrf_token` in memory and send it
 *    as `x-csrf-token` on every mutation; send `Idempotency-Key` (crypto.randomUUID())
 *    on mutations that may be retried;
 *  - poll GET /v1/jobs/{id} every `poll_after_ms` (1.5 s, backing off after 15 s),
 *    stop when terminal or when the tab is hidden;
 *  - errors are {code, message, retryable, request_id}.
 */
export const CSRF_HEADER = 'x-csrf-token';

export interface ApiErrorBody {
  code: string;
  message: string;
  retryable: boolean;
  request_id: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiErrorBody,
  ) {
    super(body.message);
  }
}
