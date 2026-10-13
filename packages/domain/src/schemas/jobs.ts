import { z } from 'zod';
import { JobState, JobType } from '../enums';
import { ErrorCodeSchema } from '../errors';
import { Timestamp, Uuid } from './common';

/** GET /v1/jobs/{id} */
export const JobResponse = z.object({
  id: Uuid,
  type: JobType,
  state: JobState,
  /** Public progress stage, e.g. observing | resolving | researching | recommending | composing. */
  stage: z.string().nullable(),
  /** Completed/partial sections published so far. */
  sections: z.array(
    z.object({
      name: z.string(),
      status: z.enum(['pending', 'running', 'complete', 'partial', 'failed', 'skipped', 'unavailable']),
    }),
  ),
  error: z
    .object({ code: ErrorCodeSchema, message: z.string(), retryable: z.boolean() })
    .nullable(),
  result: z
    .object({
      type: z.enum(['capture', 'analysis', 'plan', 'discovery_job', 'sensor_connection']),
      id: Uuid,
    })
    .nullable(),
  /** Suggested client poll delay; null when the job is terminal. */
  poll_after_ms: z.number().int().nullable(),
  created_at: Timestamp,
  updated_at: Timestamp,
});
export type JobResponse = z.infer<typeof JobResponse>;
