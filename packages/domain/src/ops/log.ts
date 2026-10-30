/**
 * Structured, redacting operational logs.
 *
 * Rules (IDENTITY-CONTRACT, capture-v2 operations, BUILD-AND-ACCEPTANCE):
 * log IDs, codes, counts and elapsed times only; never request bodies,
 * tokens, cookies, signed URLs, callback fragments, email addresses,
 * filenames, images or model text. `logEvent` enforces this twice: fields
 * are allowlisted by key, and every string value is scrubbed of
 * credential-shaped content before it is written.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFieldValue = string | number | boolean | null;

/** Keys that may appear in operational logs. Anything else is dropped. */
export const LOG_FIELD_ALLOWLIST = new Set([
  'request_id',
  'trace_id',
  'job_id',
  'work_id',
  'run_id',
  'command_id',
  'asset_id',
  'upload_id',
  'installation_id',
  'account_id',
  'connection_id',
  'route',
  'method',
  'status',
  'code',
  'outcome',
  'reason',
  'kind',
  'flag',
  'count',
  'revision',
  'published',
  'elapsed_ms',
  'attempt',
  'worker_id',
  'provider',
  'metric',
  'value',
  'unit',
]);

const PATTERNS: [RegExp, string][] = [
  // First-party opaque credentials: native access/refresh, enrollment grants, agent tokens.
  [/\b(cna|cnr|cne|cat|car|cac)_[A-Za-z0-9_-]{16,}/g, '$1_[redacted]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]'],
  [/\b(eyJ[A-Za-z0-9_-]{8,})\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted-jwt]'],
  // Signed URL query parameters and URL fragments (identity callbacks).
  [
    /([?&](?:signature|X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token|token|code|state|nonce)=)[^&#\s]+/gi,
    '$1[redacted]',
  ],
  [/(https?:\/\/[^\s#]+)#[^\s]*/gi, '$1#[redacted]'],
  [/(cultureatlas:\/\/[^\s#]+)#[^\s]*/gi, '$1#[redacted]'],
  [/\b(ca_session|ca_share[a-z_]*)=[^;\s]+/gi, '$1=[redacted]'],
  // Connection strings with credentials.
  [/(postgres(?:ql)?:\/\/[^:\s/]+):[^@\s]+@/gi, '$1:[redacted]@'],
  // Email addresses.
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[redacted-email]'],
  // Long hex strings (APNs device tokens, raw secrets); UUIDs are kept.
  [/\b[0-9a-f]{48,}\b/gi, '[redacted-hex]'],
  // AWS access key ids.
  [/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, '[redacted-aws-key]'],
];

export function redactSecrets(value: string): string {
  let out = value;
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return out.length > 500 ? `${out.slice(0, 500)}…` : out;
}

export function safeLogFields(fields: Record<string, unknown>): Record<string, LogFieldValue> {
  const out: Record<string, LogFieldValue> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!LOG_FIELD_ALLOWLIST.has(key)) continue;
    if (typeof value === 'string') out[key] = redactSecrets(value);
    else if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    else if (typeof value === 'boolean' || value === null) out[key] = value;
  }
  return out;
}

export type LogSink = (line: string, level: LogLevel) => void;
const defaultSink: LogSink = (line, level) =>
  (level === 'error' || level === 'warn' ? console.error : console.log)(line);
let sink: LogSink = defaultSink;
export function setLogSink(next: LogSink | undefined): void {
  sink = next ?? defaultSink;
}

/** One JSON line per event: {time, level, event, ...allowlisted fields}. */
export function logEvent(
  level: LogLevel,
  event: string,
  fields: Record<string, unknown> = {},
  now: Date = new Date(),
): void {
  const name = /^[a-z][a-z0-9_.]{0,63}$/.test(event) ? event : 'invalid_event_name';
  sink(
    JSON.stringify({ time: now.toISOString(), level, event: name, ...safeLogFields(fields) }),
    level,
  );
}
