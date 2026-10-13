import { z } from 'zod';

const list = z
  .string()
  .default('')
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

/**
 * apps/sensor-bridge configuration (documented in .env.example and
 * docs/sensor.md). The bridge runs beside the relay: it reads the relay with
 * the viewer credential locally and pushes photos to the public app with the
 * restricted capture-write token. Neither the relay nor the viewer credential
 * is ever exposed to the app.
 */
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
  /** Local JSON file holding the cursor and known asset ids across restarts. */
  BRIDGE_STATE_FILE: z.string().default('.data/sensor-bridge-state.json'),
  BRIDGE_MAX_ASSET_BYTES: z.coerce.number().int().positive().default(15 * 1024 * 1024),
  /**
   * First run only: existing photos to import (comma-separated relay asset
   * ids; see `pnpm sensor-bridge list`). Every other photo that already exists
   * is skipped. Later runs import new photos only.
   */
  BRIDGE_IMPORT_EXISTING: list,
});
export type BridgeConfig = z.infer<typeof BridgeConfigSchema>;

export function loadBridgeConfig(env: Record<string, string | undefined> = process.env): BridgeConfig {
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ''));
  return BridgeConfigSchema.parse(cleaned);
}

/** Only what `list` needs (relay access, no app token). */
export const RelayOnlyConfigSchema = BridgeConfigSchema.pick({
  BRIDGE_RELAY_ORIGIN: true,
  BRIDGE_VIEWER_CREDENTIAL: true,
  BRIDGE_MAX_ASSET_BYTES: true,
});
