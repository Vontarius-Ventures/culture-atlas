/**
 * Redaction for agent tool-call traces shown in the demo inspector. Tool
 * arguments are user/agent data: keep ids and short values, drop anything that
 * looks like a credential, and bound text so private instructions are not
 * stored in full.
 */

const SECRET_KEYS = /token|credential|authorization|password|secret|api[_-]?key|cookie/i;
const TOKEN_PATTERN = /\b(cat_[a-z0-9]+_[A-Za-z0-9_-]{8,}|Bearer\s+\S+|sk-[A-Za-z0-9_-]{8,})/g;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TEXT = 120;
const MAX_ARRAY = 20;
const MAX_DEPTH = 4;

export function redactText(text: string): string {
  const scrubbed = text.replace(TOKEN_PATTERN, '[redacted]');
  return scrubbed.length > MAX_TEXT ? `${scrubbed.slice(0, MAX_TEXT)}…` : scrubbed;
}

export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'string') return redactText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= MAX_DEPTH) return '[…]';
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY).map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEYS.test(k) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  return '[unsupported]';
}

/** Collect UUIDs in a value (ids a call read or produced), for linking calls to inspector traces. */
export function collectIds(value: unknown, out: Set<string> = new Set(), depth = 0): Set<string> {
  if (depth > 6 || out.size >= 200) return out;
  if (typeof value === 'string') {
    if (UUID_PATTERN.test(value)) out.add(value.toLowerCase());
  } else if (Array.isArray(value)) {
    for (const v of value) collectIds(v, out, depth + 1);
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) collectIds(v, out, depth + 1);
  }
  return out;
}

/** One-line description of a tool result for the inspector's call list. */
export function summarizeResult(tool: string, result: unknown): string {
  const r = (result ?? {}) as Record<string, unknown>;
  if (typeof r.job_id === 'string') {
    const extra = typeof r.plan_id === 'string' ? ` for plan ${r.plan_id}` : '';
    return `started job ${r.job_id}${extra}${r.reused === true ? ' (reused)' : ''}`;
  }
  if (Array.isArray(r.collections)) return `${r.collections.length} collection(s)`;
  if (tool === 'get_collection' && Array.isArray(r.items)) return `${r.items.length} item(s)`;
  if (tool === 'get_job' && typeof r.state === 'string') return `job ${r.state}${typeof r.stage === 'string' ? ` (${r.stage})` : ''}`;
  if (tool === 'get_plan' && typeof r.status === 'string') return `plan ${r.status}`;
  if (typeof r.id === 'string') return `ok ${r.id}`;
  return 'ok';
}
