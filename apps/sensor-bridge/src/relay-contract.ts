import { z } from 'zod';

/**
 * World Sensor relay asset contract, as consumed by the bridge and by the
 * server-side poller (packages/domain/src/pipeline/sensor-poll.ts).
 *
 * ASSUMPTION: route paths and field names below are taken from the research
 * review of WorldCompilerSensor@8639b3b (Shared/Assets.swift, TestServer README)
 * and must be verified against the real relay before the demo. Keep every
 * relay-specific detail in this file so a correction is a one-file change.
 * The relay is the user's machine; it is unreachable from CI, so tests run
 * against src/mock-relay.ts.
 */
export const RELAY_ROUTES = {
  /** Authenticated viewer list of committed assets (paginated). */
  listAssets: '/wc/v2/assets',
  /** Original content bytes for one asset. */
  assetContent: (assetId: string) => `/wc/v2/assets/${encodeURIComponent(assetId)}/content`,
} as const;

export const RelayAsset = z.object({
  asset_id: z.string().min(1),
  kind: z.string(),
  committed: z.boolean(),
  content_type: z.string(),
  byte_size: z.number().int().nonnegative().optional(),
  /** Hex sha256 when the relay declares one; bytes are verified against it. */
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  captured_at: z.string().optional(),
  session_id: z.string().optional(),
});
export type RelayAsset = z.infer<typeof RelayAsset>;

export const RelayAssetPage = z.object({
  assets: z.array(RelayAsset),
  next_cursor: z.string().nullable().optional(),
});
export type RelayAssetPage = z.infer<typeof RelayAssetPage>;

/** Viewer credential header (assumed bearer). */
export const relayAuthHeader = (credential: string) => ({ authorization: `Bearer ${credential}` });
