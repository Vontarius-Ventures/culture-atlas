import { z } from 'zod';
import { Category, Exploration, ItemKind, ReferenceType } from '../enums';

/**
 * Stored shapes for plans. plan_versions.input_snapshot freezes the selected
 * items, their anchors (with revisions), constraints and the collection
 * revision, so later collection edits never silently change a plan. The
 * section columns (film/food/music) hold StoredFilm/StoredFood/StoredMusic;
 * GET /v1/plans/{id} maps them to the public DTOs (resolving images at read).
 */

export const SnapshotAnchor = z.object({
  reference_id: z.string(),
  name: z.string(),
  type: ReferenceType,
  revision: z.number().int(),
  external_ids: z.record(z.string(), z.unknown()).default({}),
  user_selected: z.boolean().default(false),
});
export type SnapshotAnchor = z.infer<typeof SnapshotAnchor>;

export const SnapshotItem = z.object({
  item_id: z.string(),
  saved_item_id: z.string().nullable(),
  kind: ItemKind,
  category: Category.nullable(),
  title: z.string(),
  canonical_key: z.string(),
  external_ids: z.record(z.string(), z.unknown()).default({}),
  subtitle: z.string().nullable().default(null),
  year: z.number().int().nullable().default(null),
  detail: z.string().nullable().default(null),
  anchors: z.array(SnapshotAnchor).default([]),
  capture: z
    .object({
      capture_id: z.string(),
      analysis_id: z.string().nullable(),
      analysis_version: z.number().int().nullable(),
      title: z.string().nullable(),
      interpretation: z.string().nullable(),
    })
    .nullable()
    .default(null),
});
export type SnapshotItem = z.infer<typeof SnapshotItem>;

export const PlanSnapshot = z.object({
  template: z.literal('movie_night'),
  collection: z
    .object({ id: z.string(), name: z.string(), description: z.string().nullable(), revision: z.number().int() })
    .nullable(),
  items: z.array(SnapshotItem),
  constraints: z.object({
    dietary_exclusions: z.array(z.string()).default([]),
    instruction: z.string().nullable().default(null),
  }),
  exploration: Exploration,
  fixed_film_item_id: z.string().nullable().default(null),
});
export type PlanSnapshot = z.infer<typeof PlanSnapshot>;

/** A composed pick before persistence (also the stage output format). */
export const ComposedPick = z.object({
  key: z.string(),
  kind: ItemKind,
  category: Category.nullable(),
  title: z.string(),
  year: z.number().int().nullable().default(null),
  detail: z.string().nullable().default(null),
  description: z.string().nullable().default(null),
  qloo_id: z.string().nullable().default(null),
  /** Existing discovery item (fixed film / selected dish). */
  existing_item_id: z.string().nullable().default(null),
  origin: z.enum(['qloo', 'replay', 'vlm_creative', 'sample', 'catalog', 'research']),
  provider_query_ids: z.array(z.string()).default([]),
  /** Selected input item ids this pick draws from (attribution). */
  contributing_input_ids: z.array(z.string()).default([]),
  /** Anchor reference ids this pick draws from. */
  contributing_reference_ids: z.array(z.string()).default([]),
  reason: z.string().nullable().default(null),
  is_fixed: z.boolean().default(false),
});
export type ComposedPick = z.infer<typeof ComposedPick>;

export const StoredPick = z.object({
  item_id: z.string().nullable(),
  kind: ItemKind,
  title: z.string(),
  year: z.number().int().nullable().default(null),
  detail: z.string().nullable().default(null),
  description: z.string().nullable().default(null),
  reason: z.string().nullable().default(null),
  is_fixed: z.boolean().default(false),
  key: z.string(),
  contributing_input_ids: z.array(z.string()).default([]),
  /** Where the pick came from (absent on versions stored before this field existed). */
  origin: ComposedPick.shape.origin.optional(),
});
export type StoredPick = z.infer<typeof StoredPick>;

export const StoredFilm = z.object({ feature: StoredPick.nullable(), alternates: z.array(StoredPick) });
export const StoredFood = z.object({ dishes: z.array(StoredPick) });
export const StoredMusic = z.object({ before: z.array(StoredPick), after: z.array(StoredPick) });
export type StoredFilm = z.infer<typeof StoredFilm>;
export type StoredFood = z.infer<typeof StoredFood>;
export type StoredMusic = z.infer<typeof StoredMusic>;

export const InputContribution = z.object({
  item_id: z.string(),
  contribution: z.enum(['strong', 'weak', 'none']),
  note: z.string().nullable(),
});
export type InputContribution = z.infer<typeof InputContribution>;
