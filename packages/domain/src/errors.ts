import { z } from 'zod';

/**
 * Stable error codes. HTTP mapping follows the build spec:
 * 400 invalid input, 401 unauthenticated, 403 scope denied, 404 missing/not-owned,
 * 409 conflict, 413 upload limit, 429 quota, 503 temporary outage.
 * Never use 403 to reveal that a private record exists: not-owned is 404.
 */
export const ERROR_CODES = {
  invalid_input: 400,
  unsupported_image: 400,
  unsupported_media: 400,
  duration_exceeded: 400,
  csrf_failed: 403,
  unauthenticated: 401,
  token_expired: 401,
  token_revoked: 401,
  scope_denied: 403,
  account_required: 403,
  not_found: 404,
  conflict: 409,
  account_mismatch: 409,
  revision_conflict: 409,
  precondition_failed: 412,
  precondition_required: 428,
  action_required: 409,
  /** Amendment 2.2 (ONB-01): the account still owes the taste questionnaire. */
  onboarding_required: 409,
  cursor_expired: 410,
  idempotency_conflict: 409,
  idempotency_in_progress: 409,
  payload_too_large: 413,
  rate_limited: 429,
  quota_exceeded: 429,
  provider_unavailable: 503,
  service_unavailable: 503,
  not_implemented: 501,
  internal: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;
export const ErrorCodeSchema = z.enum(Object.keys(ERROR_CODES) as [ErrorCode, ...ErrorCode[]]);

const DEFAULT_RETRYABLE: Partial<Record<ErrorCode, boolean>> = {
  idempotency_in_progress: true,
  rate_limited: true,
  provider_unavailable: true,
  service_unavailable: true,
  internal: true,
};

const DEFAULT_MESSAGES: Record<ErrorCode, string> = {
  invalid_input: 'The request is not valid.',
  unsupported_image: 'Use a JPEG, PNG or WebP photo.',
  unsupported_media: 'This file could not be decoded. Use an MP4, MOV or WebM video with a supported codec.',
  duration_exceeded: 'This video is longer than the allowed duration.',
  csrf_failed: 'The request could not be verified. Refresh and try again.',
  unauthenticated: 'Sign in to continue.',
  token_expired: 'This connection has expired.',
  token_revoked: 'This connection was revoked.',
  scope_denied: 'This connection is not allowed to do that.',
  account_required: 'Create an account to continue.',
  not_found: 'Not found.',
  conflict: 'This changed since you last loaded it.',
  account_mismatch: 'The signed-in account changed. Return to the original account before retrying.',
  revision_conflict: 'This collection changed. Review the latest version and try again.',
  precondition_failed: 'Preferences changed. Reload before saving.',
  precondition_required: 'An If-Match version is required.',
  action_required: 'Allow this action on the selected phone first.',
  onboarding_required: 'Pick at least 3 things you love to start your feed.',
  cursor_expired: 'This cursor expired. Resync the current state.',
  idempotency_conflict: 'This idempotency key was already used with a different request.',
  idempotency_in_progress: 'The original request is still being processed.',
  payload_too_large: 'Photos can be up to 15 MB.',
  rate_limited: 'Too many requests. Try again shortly.',
  quota_exceeded: 'You have reached today’s limit.',
  provider_unavailable: 'Related discoveries are taking longer.',
  service_unavailable: 'The service is temporarily unavailable.',
  not_implemented: 'This feature is not available yet.',
  internal: 'Something went wrong.',
};

export interface AppErrorOptions {
  message?: string;
  retryable?: boolean;
  /** Safe, structured details for clients (e.g. field issues). Never secrets. */
  details?: unknown;
  cause?: unknown;
  /** Seconds, surfaced as Retry-After for 429/503. */
  retryAfter?: number;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly details?: unknown;
  readonly retryAfter?: number;

  constructor(code: ErrorCode, options: AppErrorOptions = {}) {
    super(options.message ?? DEFAULT_MESSAGES[code], { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.status = ERROR_CODES[code];
    this.retryable = options.retryable ?? DEFAULT_RETRYABLE[code] ?? false;
    this.details = options.details;
    this.retryAfter = options.retryAfter;
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

export function httpStatusFor(code: ErrorCode): number {
  return ERROR_CODES[code];
}

/** Standard error body: {code, message, retryable, request_id} (+ optional retry_after_ms, details). */
export const ErrorBody = z.object({
  code: ErrorCodeSchema,
  message: z.string(),
  retryable: z.boolean(),
  request_id: z.string(),
  /** Backoff hint (BACKEND-CONTRACTS standard error); mirrors the Retry-After header. */
  retry_after_ms: z.number().int().nonnegative().optional(),
  details: z.unknown().optional(),
});
export type ErrorBody = z.infer<typeof ErrorBody>;

/** Converts any thrown value into a safe error body. Unknown errors become `internal`. */
export function toErrorBody(err: unknown, requestId: string): { status: number; body: ErrorBody } {
  const appErr = isAppError(err) ? err : new AppError('internal', { cause: err });
  const body: ErrorBody = {
    code: appErr.code,
    message: appErr.message,
    retryable: appErr.retryable,
    request_id: requestId,
  };
  if (appErr.retryAfter !== undefined && Number.isFinite(appErr.retryAfter) && appErr.retryAfter >= 0)
    body.retry_after_ms = Math.round(appErr.retryAfter * 1000);
  if (appErr.details !== undefined) body.details = appErr.details;
  return { status: appErr.status, body };
}

/** Throw from service stubs that parallel work has not implemented yet. */
export function notImplemented(what: string): never {
  throw new AppError('not_implemented', { message: `${what} is not implemented yet.` });
}

/** Convert a zod error into an invalid_input AppError with field issues. */
export function invalidInput(error: z.ZodError, message = 'The request is not valid.'): AppError {
  return new AppError('invalid_input', {
    message,
    details: {
      issues: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message, code: i.code })),
    },
  });
}
