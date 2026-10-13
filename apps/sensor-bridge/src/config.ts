import { z } from 'zod';

/** apps/sensor-bridge configuration (documented in .env.example). Runs beside the relay. */
export const BridgeConfigSchema = z.object({
  /** Private relay origin reachable from the bridge host only (e.g. http://127.0.0.1:8787). */
  BRIDGE_RELAY_ORIGIN: z.url(),
  /** Relay viewer credential. Stays on the bridge host; never sent to the app. */
  BRIDGE_VIEWER_CREDENTIAL: z.string().min(1),
  /** Public culture atlas base URL (e.g. https://culture-atlas.example). */
  BRIDGE_APP_URL: z.url(),
  /** Restricted capture-write token from POST /v1/sensor-connections (mode 'bridge'). */
  BRIDGE_CAPTURE_TOKEN: z.string().min(1),
  /** Sensor connection id that token belongs to (dedupe key = connection + asset). */
  BRIDGE_CONNECTION_ID: z.uuid(),
  BRIDGE_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(10_000),
  /** Local JSON file holding the cursor + imported asset ids across restarts. */
  BRIDGE_STATE_FILE: z.string().default('.data/sensor-bridge-state.json'),
  BRIDGE_MAX_ASSET_BYTES: z.coerce.number().int().positive().default(15 * 1024 * 1024),
});
export type BridgeConfig = z.infer<typeof BridgeConfigSchema>;

export function loadBridgeConfig(env: Record<string, string | undefined> = process.env): BridgeConfig {
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ''));
  return BridgeConfigSchema.parse(cleaned);
}
