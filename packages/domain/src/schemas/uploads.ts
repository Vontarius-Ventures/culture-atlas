import { z } from 'zod';
import { Timestamp, Uuid } from './common';

/**
 * POST /v1/uploads (multipart/form-data, field `image`). Extension to the spec
 * REST table: agents and the bridge upload bytes here, then pass upload_id to
 * POST /v1/captures (MCP analyze_capture accepts only owned upload ids).
 */
export const UploadMultipartFields = z.object({
  /** Original filename is informational only; content is sniffed from bytes. */
  filename: z.string().max(255).optional(),
});

export const UploadResponse = z.object({
  upload_id: Uuid,
  content_type: z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/avif']),
  byte_size: z.number().int().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  expires_at: Timestamp,
});
export type UploadResponse = z.infer<typeof UploadResponse>;
