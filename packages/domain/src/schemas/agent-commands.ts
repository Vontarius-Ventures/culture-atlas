import { z } from 'zod';
import { Timestamp, Uuid } from './common';

export const CaptureCommandRequest = z.strictObject({
  session_id: Uuid, generation: z.number().int().positive(),
  action: z.enum(['capture_photo', 'start_video', 'stop_video']),
  capture_client_id: Uuid, duration_seconds: z.number().int().min(1).max(60).optional(),
  expires_in_seconds: z.number().int().min(1).max(30).default(30),
});
export const CommandAck = z.strictObject({
  sequence: z.number().int().nonnegative(),
  state: z.enum(['awaiting_user', 'executing', 'succeeded', 'failed', 'unknown']),
  result_asset_id: Uuid.optional(),
  safe_error: z.enum(['device_unavailable', 'permission_denied', 'interrupted', 'storage_full', 'outcome_unknown']).optional(),
});
export const CaptureCommandResponse = z.object({
  command_id: Uuid, session_id: Uuid, generation: z.number().int(), action: z.string(),
  delivery_sequence: z.number().int(),
  duration_seconds: z.number().nullable(), capture_client_id: Uuid, authorization_version: z.number().int(),
  state: z.string(), expires_at: Timestamp, result_asset_id: Uuid.nullable(), error_code: z.string().nullable(),
});
export const NativeCommandQuery = z.object({
  after_sequence: z.coerce.number().int().nonnegative().default(0),
  wait: z.coerce.number().int().min(0).max(25).default(0),
});
export const NativeCommandBatch = z.object({
  schema_version: z.literal('2.1'), request_id: z.string(),
  items: z.array(CaptureCommandResponse), next_sequence: z.number().int().nonnegative(),
});
