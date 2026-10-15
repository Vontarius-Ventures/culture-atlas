import { z } from 'zod';
import { CreateMediaUploadRequest, MediaLibraryQuery } from './capture-v2';
import { Uuid } from './common';
export const AgentUploadRequest = CreateMediaUploadRequest.extend({ destination_collection_id: Uuid.optional() });
export const AgentMediaQuery = MediaLibraryQuery.extend({ search: z.string().trim().max(200).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) });
export const AgentOperationResponse = z.object({
  schema_version: z.literal('2.1'), request_id: z.string(), id: Uuid,
  kind: z.enum(['command', 'upload', 'analysis']), state: z.string(), result_id: Uuid.nullable(), error_code: z.string().nullable(),
});
