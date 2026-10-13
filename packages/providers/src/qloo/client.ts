import type { ProviderConfig } from '../config';
import { UnavailableQloo } from '../unavailable';
import type { QlooProvider } from './types';

/**
 * HTTP Qloo adapter.
 * TODO(qloo owner): implement QlooProvider over fetch against config.QLOO_API_URL
 * with header `X-Api-Key: config.QLOO_API_KEY`; timeouts (QLOO_TIMEOUT_MS);
 * map 401/403 -> auth, 404 -> not_found, 429 -> rate_limited (Retry-After),
 * 5xx -> server; validate responses with zod; return sanitized requests (no key).
 * Capability: 'unverified/probe_pending' until scripts/probe-qloo.ts records
 * results in docs/capability-matrix.md. Contract tests use recorded-shape
 * fixtures in fixtures/qloo/. With no key this MUST stay UnavailableQloo.
 */
export function createQlooProvider(config: ProviderConfig): QlooProvider {
  if (!config.QLOO_API_KEY) return new UnavailableQloo('not_configured');
  return new UnavailableQloo('not_implemented');
}
