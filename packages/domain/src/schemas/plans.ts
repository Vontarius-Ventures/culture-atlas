import { z } from 'zod';
import { Exploration, ItemKind, LIMITS, PlanSection, PlanTemplate, SectionStatus } from '../enums';
import { Cursor, Image, PageQuery, Timestamp, Uuid } from './common';

export const PlanConstraints = z.strictObject({
  dietary_exclusions: z
    .array(z.string().trim().min(1).max(LIMITS.dietaryExclusionMaxChars))
    .max(LIMITS.dietaryExclusionsMax)
    .optional(),
  /** Short optional instruction. Treated as user data, never executed. */
  instruction: z.string().trim().max(LIMITS.instructionMaxChars).optional(),
});
export type PlanConstraints = z.infer<typeof PlanConstraints>;

/**
 * POST /v1/plans — returns 202. Example:
 * {collection_id, expected_revision: 3, item_ids: [photo, artist], template: "movie_night",
 *  constraints: {dietary_exclusions: ["peanuts"], instruction: "A relaxed evening"}, exploration: "balanced"}
 * Stale collection revision -> 409 revision_conflict.
 */
export const CreatePlanRequest = z
  .strictObject({
    collection_id: Uuid,
    expected_revision: z.number().int().positive(),
    item_ids: z.array(Uuid).min(LIMITS.planMinItems).max(LIMITS.planMaxItems),
    template: PlanTemplate,
    fixed_film_item_id: Uuid.optional(),
    constraints: PlanConstraints.optional(),
    exploration: Exploration.default('balanced'),
  })
  .refine((v) => new Set(v.item_ids).size === v.item_ids.length, {
    message: 'item_ids must be unique',
    path: ['item_ids'],
  })
  .refine((v) => !v.fixed_film_item_id || v.item_ids.includes(v.fixed_film_item_id), {
    message: 'fixed_film_item_id must be one of the selected items',
    path: ['fixed_film_item_id'],
  });
export type CreatePlanRequest = z.infer<typeof CreatePlanRequest>;

export const CreatePlanResponse = z.object({ plan_id: Uuid, job_id: Uuid });
export type CreatePlanResponse = z.infer<typeof CreatePlanResponse>;

export const FilmPick = z.object({
  item_id: Uuid,
  title: z.string(),
  year: z.number().int().nullable(),
  image: Image.nullable(),
  reason: z.string().nullable(),
  destination_url: z.url().nullable(),
  /** True when this is the user's "Use this movie" choice. */
  is_fixed: z.boolean(),
  /** Replayed or sample provider data: shown with an "Example result" label. */
  is_example: z.boolean().default(false),
});
export type FilmPick = z.infer<typeof FilmPick>;

export const DishIdea = z.object({
  item_id: Uuid.nullable(),
  title: z.string(),
  description: z.string(),
  cuisine: z.string().nullable(),
  reason: z.string().nullable(),
  image: Image.nullable(),
  /** Replayed or sample provider data: shown with an "Example result" label. */
  is_example: z.boolean().default(false),
});
export type DishIdea = z.infer<typeof DishIdea>;

export const MusicPick = z.object({
  item_id: Uuid.nullable(),
  kind: z.enum(['artist', 'track']),
  title: z.string(),
  artist: z.string().nullable(),
  image: Image.nullable(),
  reason: z.string().nullable(),
  /** Tracks only when verified through a catalog adapter. */
  verified: z.boolean(),
  destination_url: z.url().nullable(),
  /** Replayed or sample provider data: shown with an "Example result" label. */
  is_example: z.boolean().default(false),
});
export type MusicPick = z.infer<typeof MusicPick>;

export const PlanVersionDto = z.object({
  version: z.number().int().positive(),
  title: z.string().nullable(),
  /** One sentence about the combination. */
  summary: z.string().nullable(),
  sections: z.record(PlanSection, SectionStatus),
  film: z.object({ feature: FilmPick.nullable(), alternates: z.array(FilmPick).max(2) }).nullable(),
  food: z.object({ dishes: z.array(DishIdea).max(3) }).nullable(),
  music: z.object({ before: z.array(MusicPick), after: z.array(MusicPick) }).nullable(),
  /** Optional rationale; discloses weak inputs. */
  rationale: z.string().nullable(),
  inputs: z.array(
    z.object({
      item_id: Uuid,
      title: z.string(),
      kind: ItemKind,
      contribution: z.enum(['strong', 'weak', 'none']),
      note: z.string().nullable(),
    }),
  ),
  collection_revision: z.number().int().nullable(),
  created_at: Timestamp,
});
export type PlanVersionDto = z.infer<typeof PlanVersionDto>;

/** GET /v1/plans/{id} */
export const PlanResponse = z.object({
  id: Uuid,
  template: PlanTemplate,
  status: z.enum(['queued', 'running', 'partial', 'complete', 'failed', 'cancelled']),
  source_collection_id: Uuid.nullable(),
  selected_item_ids: z.array(Uuid),
  fixed_film_item_id: Uuid.nullable(),
  constraints: PlanConstraints,
  exploration: Exploration,
  active_version: PlanVersionDto.nullable(),
  versions: z.array(z.object({ version: z.number().int(), created_at: Timestamp })),
  job_id: Uuid.nullable(),
  created_at: Timestamp,
  updated_at: Timestamp,
});
export type PlanResponse = z.infer<typeof PlanResponse>;

/** GET /v1/plans (extension: Plans destination list). */
export const PlansQuery = PageQuery;
export const PlansListResponse = z.object({
  plans: z.array(
    z.object({
      id: Uuid,
      template: PlanTemplate,
      title: z.string().nullable(),
      status: PlanResponse.shape.status,
      cover: Image.nullable(),
      created_at: Timestamp,
    }),
  ),
  next_cursor: Cursor.nullable(),
});
export type PlansListResponse = z.infer<typeof PlansListResponse>;

/** POST /v1/plans/{id}/replacements — replaces one section, preserving others. Returns 202. */
export const PlanReplacementRequest = z.strictObject({
  section: PlanSection,
  instruction: z.string().trim().max(LIMITS.instructionMaxChars).optional(),
});
export type PlanReplacementRequest = z.infer<typeof PlanReplacementRequest>;

export const PlanReplacementResponse = z.object({
  plan_id: Uuid,
  job_id: Uuid,
  section: PlanSection,
});
export type PlanReplacementResponse = z.infer<typeof PlanReplacementResponse>;
