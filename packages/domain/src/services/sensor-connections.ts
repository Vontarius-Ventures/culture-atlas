import type { ServiceContext } from '../context';
import { notImplemented } from '../errors';
import type {
  CreateSensorConnectionRequest,
  CreateSensorConnectionResponse,
  SensorConnectionsListResponse,
} from '../schemas/sensor-connections';

/**
 * World Sensor connections (account owner, browser only). Origins must be in
 * SENSOR_ALLOWED_ORIGINS; viewer credential encrypted at rest with
 * CREDENTIAL_ENCRYPTION_KEY (AES-256-GCM) and never returned. 'poll' mode
 * schedules sensor_poll jobs every SENSOR_POLL_INTERVAL_MS while enabled;
 * 'bridge' mode issues a restricted capture-write token
 * (agent_connections.purpose='sensor_bridge', scopes ['captures:write'],
 * library_access 'none', sensor_connection_id set). First connection imports
 * only import_existing_asset_ids; later polls import new photos without
 * treating them as liked.
 */

/** GET /v1/sensor-connections. TODO(sensor owner): implement. */
export async function listSensorConnections(ctx: ServiceContext): Promise<SensorConnectionsListResponse> {
  void ctx;
  notImplemented('sensorConnections.list');
}

/** POST /v1/sensor-connections (201). TODO(sensor owner): implement. */
export async function createSensorConnection(
  ctx: ServiceContext,
  body: CreateSensorConnectionRequest,
): Promise<CreateSensorConnectionResponse> {
  void ctx;
  void body;
  notImplemented('sensorConnections.create');
}

/** DELETE /v1/sensor-connections/{id} — disable import, delete credential, revoke bridge token. TODO(sensor owner). */
export async function deleteSensorConnection(ctx: ServiceContext, input: { id: string }): Promise<void> {
  void ctx;
  void input;
  notImplemented('sensorConnections.delete');
}
