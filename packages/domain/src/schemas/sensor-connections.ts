import { z } from 'zod';
import { SensorMode } from '../enums';
import { Timestamp, Uuid } from './common';

/**
 * POST /v1/sensor-connections — operator setup. The origin must be in
 * SENSOR_ALLOWED_ORIGINS. The viewer credential is encrypted at rest and is
 * never returned. In 'bridge' mode the response includes a restricted
 * capture-write token (shown once) for apps/sensor-bridge.
 */
export const CreateSensorConnectionRequest = z.strictObject({
  origin: z.url().max(500),
  viewer_credential: z.string().min(1).max(4096),
  mode: SensorMode.default('poll'),
  /** First connection imports only explicitly selected existing photos. */
  import_existing_asset_ids: z.array(z.string().min(1).max(200)).max(100).default([]),
});
export type CreateSensorConnectionRequest = z.infer<typeof CreateSensorConnectionRequest>;

export const SensorConnectionDto = z.object({
  id: Uuid,
  origin: z.string(),
  mode: SensorMode,
  enabled: z.boolean(),
  last_success_at: Timestamp.nullable(),
  last_attempt_at: Timestamp.nullable(),
  last_error_code: z.string().nullable(),
  created_at: Timestamp,
});
export type SensorConnectionDto = z.infer<typeof SensorConnectionDto>;

export const CreateSensorConnectionResponse = z.object({
  connection: SensorConnectionDto,
  bridge_token: z.string().nullable(),
});
export type CreateSensorConnectionResponse = z.infer<typeof CreateSensorConnectionResponse>;

/** GET /v1/sensor-connections (extension: connection settings / last import status). */
export const SensorConnectionsListResponse = z.object({ connections: z.array(SensorConnectionDto) });
export type SensorConnectionsListResponse = z.infer<typeof SensorConnectionsListResponse>;
