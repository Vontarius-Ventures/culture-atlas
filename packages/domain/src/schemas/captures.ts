import { z } from 'zod';
import { AnalysisSection, CaptureSource, CaptureStatus, Category, ReferenceType, SectionStatus } from '../enums';
import { DiscoveryCard, Focus, Image, ReferenceSummary, Timestamp, Uuid } from './common';

/**
 * POST /v1/captures
 *  - multipart/form-data: field `image` (file) + optional fields `source`
 *    (upload|camera), `focus` (JSON string of Focus), `captured_at`.
 *  - application/json: CreateCaptureJsonRequest (upload_id or sample_id).
 * Returns 202 CreateCaptureResponse.
 */
export const CreateCaptureMultipartFields = z.object({
  source: z.enum(['upload', 'camera']).default('upload'),
  focus: z
    .string()
    .max(2000)
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v === '') return undefined;
      try {
        return Focus.parse(JSON.parse(v));
      } catch {
        ctx.addIssue({ code: 'custom', message: 'focus must be JSON matching Focus' });
        return z.NEVER;
      }
    }),
  captured_at: z.iso.datetime({ offset: true }).optional(),
});
export type CreateCaptureMultipartFields = z.infer<typeof CreateCaptureMultipartFields>;

/** Sensor import metadata (bridge or poller). Dedupe key = connection_id + asset_id. */
export const SensorAssetRef = z.strictObject({
  connection_id: Uuid,
  asset_id: z.string().min(1).max(200),
  captured_at: z.iso.datetime({ offset: true }).optional(),
  /** Hex sha256 declared by the relay; bytes are verified when present. */
  declared_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});
export type SensorAssetRef = z.infer<typeof SensorAssetRef>;

export const CreateCaptureJsonRequest = z
  .strictObject({
    upload_id: Uuid.optional(),
    /** One of the supplied example photos ("Try an example"). */
    sample_id: z.string().min(1).max(64).optional(),
    source: CaptureSource.optional(),
    focus: Focus.optional(),
    captured_at: z.iso.datetime({ offset: true }).optional(),
    sensor: SensorAssetRef.optional(),
  })
  .refine((v) => (v.upload_id ? 1 : 0) + (v.sample_id ? 1 : 0) === 1, {
    message: 'Provide exactly one of upload_id or sample_id',
  })
  .refine((v) => !v.sensor || v.upload_id, { message: 'sensor imports require upload_id' });
export type CreateCaptureJsonRequest = z.infer<typeof CreateCaptureJsonRequest>;

export const CreateCaptureResponse = z.object({
  capture_id: Uuid,
  job_id: Uuid,
  /** True when the same owner+image+focus+compiler version reused an existing job. */
  reused: z.boolean(),
});
export type CreateCaptureResponse = z.infer<typeof CreateCaptureResponse>;

export const ClarifyingQuestion = z.object({
  prompt: z.string(),
  choices: z.array(z.object({ id: z.string(), label: z.string() })).max(3),
  /** Always offered: "The whole photo". */
  whole_photo_choice_id: z.literal('whole'),
});

export const AnalysisSummary = z.object({
  id: Uuid,
  version: z.number().int().positive(),
  title: z.string().nullable(),
  interpretation: z.string().nullable(),
  sections: z.partialRecord(AnalysisSection, SectionStatus),
  question: ClarifyingQuestion.nullable(),
  warnings: z.array(z.object({ code: z.string(), message: z.string() })),
  created_at: Timestamp,
});
export type AnalysisSummary = z.infer<typeof AnalysisSummary>;

/** GET /v1/captures/{id} */
export const CaptureResponse = z.object({
  id: Uuid,
  source: CaptureSource,
  status: CaptureStatus,
  received_at: Timestamp,
  captured_at: Timestamp.nullable(),
  image: Image.nullable(),
  focus: Focus,
  is_example: z.boolean(),
  /** The capture's own DiscoveryItem (for "Save this inspiration"). */
  discovery_item_id: Uuid.nullable(),
  saved: z.boolean(),
  analysis: AnalysisSummary.nullable(),
  references: z.array(ReferenceSummary),
  /** Up to 12, ordered; the UI renders 6 then "Load more". */
  recommendations: z.array(DiscoveryCard),
  /** Categories with at least one result (render only these filters). */
  available_categories: z.array(Category),
  /** Active job for this capture, if any (poll GET /v1/jobs/{id}). */
  job_id: Uuid.nullable(),
});
export type CaptureResponse = z.infer<typeof CaptureResponse>;

/** POST /v1/captures/{id}/corrections — "Something else?" / focus update. Returns 202. */
export const CorrectionRequest = z
  .strictObject({
    /** Active analysis version the user was looking at (stale -> 409). */
    expected_analysis_version: z.number().int().positive(),
    reject_reference_ids: z.array(Uuid).max(8).optional(),
    confirm_reference_id: Uuid.optional(),
    /** User-named replacement, e.g. "It's a Bauhaus chair". Treated as data, never instructions. */
    replacement: z
      .strictObject({ name: z.string().trim().min(1).max(120), type: ReferenceType.optional() })
      .optional(),
    focus: Focus.optional(),
  })
  .refine(
    (v) => Boolean(v.reject_reference_ids?.length || v.confirm_reference_id || v.replacement || v.focus),
    { message: 'Provide at least one correction' },
  );
export type CorrectionRequest = z.infer<typeof CorrectionRequest>;

export const CorrectionResponse = z.object({
  capture_id: Uuid,
  job_id: Uuid,
  /** Version number the queued analysis will get once active. */
  pending_analysis_version: z.number().int().positive(),
});
export type CorrectionResponse = z.infer<typeof CorrectionResponse>;
