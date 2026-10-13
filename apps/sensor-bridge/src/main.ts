import { loadBridgeConfig } from './config';

/**
 * Outbound World Sensor bridge.
 * TODO(sensor owner): loop every BRIDGE_POLL_INTERVAL_MS:
 *  1. list committed kind=photo assets from the relay (RELAY_ROUTES.listAssets,
 *     paginate with the stored cursor; first run imports only explicitly selected ids);
 *  2. skip asset ids already imported (state file) — the server also dedupes on
 *     connection_id + asset_id, so retries never duplicate;
 *  3. download content (reject redirects, unexpected content types, oversized
 *     bodies), verify declared sha256;
 *  4. POST bytes to {BRIDGE_APP_URL}/v1/uploads, then POST /v1/captures with
 *     {upload_id, source:'sensor', sensor:{connection_id, asset_id, captured_at, declared_sha256}}
 *     using `Authorization: Bearer BRIDGE_CAPTURE_TOKEN` and an Idempotency-Key
 *     of `${connection_id}:${asset_id}`;
 *  5. persist cursor/imported ids; on failure back off and retry without skipping.
 * Imports never mark a photo as liked.
 */
const config = loadBridgeConfig();
console.log(`[sensor-bridge] configured for connection ${config.BRIDGE_CONNECTION_ID}; not implemented yet.`);
process.exitCode = 1;
