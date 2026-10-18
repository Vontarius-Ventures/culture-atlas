import { z } from 'zod';
import { Category, ItemKind, LIMITS } from '../enums';
import { Timestamp, Uuid } from './common';

/**
 * Taste onboarding (spec amendment 2.2, specs/onboarding-and-fast-analysis.md):
 * the sign-up questionnaire (screen 14), the building-feed interstitial
 * (screen 15) and Settings → Taste (screen 18).
 *
 * Shared contract for the parallel packages (A onboarding backend, B taste
 * seed job, D web UI, E native). Additive only; change it together with the
 * route table in routes.ts.
 *
 * Rules the services enforce (not expressible in zod):
 *  - every pick is an explicit save of a real Qloo tag or entity, written
 *    through the preferences save path with source `onboarding`; it appears in
 *    Saved for later and can be unsaved like any save;
 *  - an image that maps to several Qloo tags is ONE pick (one OnboardingPick,
 *    several saved items) and counts once toward ONBOARDING_MIN_PICKS;
 *  - exclusions are preferences, not taste: they never count as picks and are
 *    never sent to providers as identity data;
 *  - consumer DTOs carry no Qloo ids or provider names (the catalog FILE does).
 */

/** Minimum picks to complete onboarding (Settings → Taste may go below it). */
export const ONBOARDING_MIN_PICKS = 3;
/** Picks one account can hold through onboarding and Settings → Taste. */
export const ONBOARDING_MAX_PICKS = 60;
/** Upper bound of tags a single catalog image may stand for. */
export const ONBOARDING_IMAGE_TAGS_MAX = 3;

export const ONBOARDING_ITEM_KINDS = ['image', 'chip'] as const;
export const OnboardingItemKind = z.enum(ONBOARDING_ITEM_KINDS);
export type OnboardingItemKind = z.infer<typeof OnboardingItemKind>;

/** Where a pick came from. `pending_save` is the save that triggered sign-up. */
export const ONBOARDING_PICK_SOURCES = ['catalog', 'search', 'pending_save'] as const;
export const OnboardingPickSource = z.enum(ONBOARDING_PICK_SOURCES);
export type OnboardingPickSource = z.infer<typeof OnboardingPickSource>;

/**
 * A real Qloo id resolved ahead of time (catalog) or returned live (search).
 * `subtype` is Qloo's urn type ("urn:tag:style:qloo", "urn:entity:artist"),
 * used to pick the DiscoveryItem kind; ids are never invented.
 */
export const QlooRef = z.object({
  type: z.enum(['tag', 'entity']),
  id: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(120),
  subtype: z
    .string()
    .regex(/^urn:[a-z0-9:_-]+$/i)
    .max(120)
    .optional(),
});
export type QlooRef = z.infer<typeof QlooRef>;

/** Licensed image for an image pick. `credit`/`license` are shown on hover/alt-detail. */
export const OnboardingImage = z.object({
  /** Public asset path ("/onboarding/<file>") or absolute https URL. */
  url: z.string().min(1).max(500),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  alt: z.string().min(1).max(200),
  credit: z.string().max(200).optional(),
  license: z.string().max(120).optional(),
});
export type OnboardingImage = z.infer<typeof OnboardingImage>;

/** Stable catalog item id, e.g. "img-tea-ritual" or "chip-wear-japandi". */
export const OnboardingCatalogItemId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{1,63}$/);

/**
 * One entry of fixtures/onboarding/catalog.json (server-side; includes the
 * Qloo ids). Images map to 1-3 tags; chips map to exactly one tag.
 */
export const OnboardingCatalogItem = z
  .object({
    id: OnboardingCatalogItemId,
    kind: OnboardingItemKind,
    category: Category,
    label: z.string().trim().min(1).max(80),
    qloo: z.array(QlooRef).min(1).max(ONBOARDING_IMAGE_TAGS_MAX),
    image: OnboardingImage.optional(),
    /** When the Qloo ids were retrieved by scripts/build-onboarding-catalog.ts. */
    retrieved_at: Timestamp,
  })
  .superRefine((item, ctx) => {
    if (item.kind === 'image' && !item.image)
      ctx.addIssue({ code: 'custom', path: ['image'], message: 'Image picks need an image' });
    if (item.kind === 'chip' && item.image)
      ctx.addIssue({ code: 'custom', path: ['image'], message: 'Chips have no image' });
    if (item.kind === 'chip' && item.qloo.length !== 1)
      ctx.addIssue({ code: 'custom', path: ['qloo'], message: 'A chip is exactly one Qloo tag or entity' });
  });
export type OnboardingCatalogItem = z.infer<typeof OnboardingCatalogItem>;

/** fixtures/onboarding/catalog.json. */
export const OnboardingCatalogFile = z
  .object({
    kind: z.literal('onboarding-catalog'),
    /** Changes whenever items or ids change; stored on onboarding state. */
    catalog_version: z.string().regex(/^[a-zA-Z0-9._-]{1,64}$/),
    retrieved_at: Timestamp,
    items: z.array(OnboardingCatalogItem).min(1),
  })
  .superRefine((file, ctx) => {
    const ids = new Set<string>();
    for (const [i, item] of file.items.entries()) {
      if (ids.has(item.id))
        ctx.addIssue({ code: 'custom', path: ['items', i, 'id'], message: 'Duplicate catalog id' });
      ids.add(item.id);
    }
  });
export type OnboardingCatalogFile = z.infer<typeof OnboardingCatalogFile>;

/** Consumer projection of a catalog item: no Qloo ids, no retrieval metadata. */
export const OnboardingCatalogEntry = z.object({
  id: OnboardingCatalogItemId,
  kind: OnboardingItemKind,
  category: Category,
  label: z.string(),
  image: OnboardingImage.nullable(),
  /** True when this account already holds this pick. */
  picked: z.boolean(),
  pick_id: Uuid.nullable(),
});
export type OnboardingCatalogEntry = z.infer<typeof OnboardingCatalogEntry>;

/**
 * Suggested dietary exclusions. These are the plan-constraint terms the
 * movie-night composer expands (composer/dietary.ts); free text with the same
 * limits as PlanConstraints.dietary_exclusions is also accepted. Exactly
 * LIMITS.dietaryExclusionsMax of them, so choosing every suggestion still fits.
 */
export const FOOD_EXCLUSION_SUGGESTIONS = [
  'peanuts',
  'tree nuts',
  'dairy',
  'eggs',
  'gluten',
  'shellfish',
  'fish',
  'soy',
  'sesame',
  'pork',
  'vegetarian',
  'alcohol',
] as const satisfies readonly string[] & { length: typeof LIMITS.dietaryExclusionsMax };

/** Same shape and limits as PlanConstraints.dietary_exclusions. */
export const FoodExclusions = z
  .array(z.string().trim().min(1).max(LIMITS.dietaryExclusionMaxChars))
  .max(LIMITS.dietaryExclusionsMax);
export type FoodExclusions = z.infer<typeof FoodExclusions>;

/** GET /v1/onboarding/catalog */
export const OnboardingCatalogResponse = z.object({
  catalog_version: z.string(),
  /** Images first ("Pick what catches your eye."), 12-16 of them. */
  images: z.array(OnboardingCatalogEntry),
  /** Chips grouped by Wear, Play, Watch, Eat ("Choose a few favorites."), 6-10 each. */
  chips: z.object({
    wear: z.array(OnboardingCatalogEntry),
    play: z.array(OnboardingCatalogEntry),
    watch: z.array(OnboardingCatalogEntry),
    eat: z.array(OnboardingCatalogEntry),
  }),
  exclusion_suggestions: z.array(z.string()),
  min_picks: z.literal(ONBOARDING_MIN_PICKS),
});
export type OnboardingCatalogResponse = z.infer<typeof OnboardingCatalogResponse>;

/** GET /v1/onboarding/search?q= — live Qloo entity search. */
export const OnboardingSearchQuery = z.object({
  q: z.string().trim().min(2).max(80),
  category: Category.optional(),
});
export type OnboardingSearchQuery = z.infer<typeof OnboardingSearchQuery>;

/**
 * Results show name and type only. `result_id` is an opaque, short-lived,
 * server-signed token binding the Qloo id, name and type for this account, so
 * a search pick can only save what Qloo actually returned.
 */
export const OnboardingSearchResult = z.object({
  result_id: z.string().min(16).max(600),
  name: z.string(),
  /** Plain-language type: "Artist", "Film", "Brand", "Place", "Cuisine"... */
  type_label: z.string(),
  category: Category.nullable(),
  picked: z.boolean(),
});
export type OnboardingSearchResult = z.infer<typeof OnboardingSearchResult>;

export const OnboardingSearchResponse = z.object({
  /** 'unavailable' when Qloo is down or throttled: UI shows "Search is taking a break…". */
  status: z.enum(['ok', 'unavailable']),
  results: z.array(OnboardingSearchResult).max(10),
});
export type OnboardingSearchResponse = z.infer<typeof OnboardingSearchResponse>;

/** POST /v1/onboarding/picks and POST /v1/taste/picks */
export const CreatePickRequest = z.discriminatedUnion('source', [
  z.strictObject({ source: z.literal('catalog'), catalog_item_id: OnboardingCatalogItemId }),
  z.strictObject({ source: z.literal('search'), result_id: z.string().min(16).max(600) }),
]);
export type CreatePickRequest = z.infer<typeof CreatePickRequest>;

/** One pick: one counted choice, backed by one or more explicit saves. */
export const OnboardingPick = z.object({
  id: Uuid,
  source: OnboardingPickSource,
  catalog_item_id: OnboardingCatalogItemId.nullable(),
  label: z.string(),
  category: Category.nullable(),
  /** DiscoveryItem kind of the primary save (style, reference, artist, film, brand or food). */
  item_kind: ItemKind,
  /** The explicit saves this pick created (several for a multi-tag image). */
  saved_item_ids: z.array(Uuid).min(1),
  discovery_item_ids: z.array(Uuid).min(1),
  image: OnboardingImage.nullable(),
  created_at: Timestamp,
});
export type OnboardingPick = z.infer<typeof OnboardingPick>;

/** Onboarding state: account data, deleted with the account. */
export const OnboardingState = z.object({
  /** True while this account must finish the questionnaire before its personal feed. */
  required: z.boolean(),
  /** Counted picks (a multi-tag image counts once). Exclusions never count. */
  picks_count: z.number().int().nonnegative(),
  min_picks: z.literal(ONBOARDING_MIN_PICKS),
  started_at: Timestamp.nullable(),
  completed_at: Timestamp.nullable(),
  /** Catalog version the account last saw (null before the first catalog read). */
  catalog_version: z.string().nullable(),
});
export type OnboardingState = z.infer<typeof OnboardingState>;

export const CreatePickResponse = z.object({
  pick: OnboardingPick,
  state: OnboardingState,
  taste_revision: z.number().int().nonnegative(),
  /** True when this choice was already picked (idempotent; nothing new saved). */
  already_picked: z.boolean(),
});
export type CreatePickResponse = z.infer<typeof CreatePickResponse>;

export const PickParams = z.object({ id: Uuid });
export type PickParams = z.infer<typeof PickParams>;

/** DELETE /v1/onboarding/picks/{id} and /v1/taste/picks/{id}: unsaves every save of the pick. */
export const DeletePickResponse = z.object({
  removed_pick_id: Uuid,
  state: OnboardingState,
  taste_revision: z.number().int().nonnegative(),
});
export type DeletePickResponse = z.infer<typeof DeletePickResponse>;

/** PUT /v1/onboarding/exclusions — replaces the account's food exclusions (preferences `food.exclusions`). */
export const PutExclusionsRequest = z.strictObject({ food_exclusions: FoodExclusions });
export type PutExclusionsRequest = z.infer<typeof PutExclusionsRequest>;
export const ExclusionsResponse = z.object({ food_exclusions: FoodExclusions });
export type ExclusionsResponse = z.infer<typeof ExclusionsResponse>;

/** Per-category progress of the taste seed job (screen 15 auto-advances on the first `ready`). */
export const SEED_CATEGORY_STATES = ['pending', 'ready', 'empty', 'unavailable'] as const;
export const SeedCategoryState = z.enum(SEED_CATEGORY_STATES);
export type SeedCategoryState = z.infer<typeof SeedCategoryState>;

export const SEED_STATES = ['not_started', 'queued', 'running', 'retrying', 'partial', 'complete', 'failed'] as const;
export const SeedState = z.enum(SEED_STATES);
export type SeedState = z.infer<typeof SeedState>;

/**
 * GET /v1/onboarding/seed. `empty`: Qloo returned nothing for that category
 * (labeled examples fill the gap); `unavailable`: Qloo could not be reached
 * and the job will retry ("We'll keep building in the background.").
 * Never fabricated: `card_count` counts real Qloo-backed recommendations only.
 */
export const TasteSeedStatus = z.object({
  job_id: Uuid.nullable(),
  state: SeedState,
  categories: z.array(
    z.object({
      category: Category,
      state: SeedCategoryState,
      card_count: z.number().int().nonnegative(),
      ready_at: Timestamp.nullable(),
    }),
  ),
  first_ready_at: Timestamp.nullable(),
  /** Suggested poll interval while the job is active; null when terminal or not started. */
  poll_after_ms: z.number().int().positive().nullable(),
});
export type TasteSeedStatus = z.infer<typeof TasteSeedStatus>;

/** GET /v1/onboarding/state */
export const OnboardingStateResponse = z.object({
  state: OnboardingState,
  picks: z.array(OnboardingPick),
  food_exclusions: FoodExclusions,
  seed: TasteSeedStatus,
});
export type OnboardingStateResponse = z.infer<typeof OnboardingStateResponse>;

/** POST /v1/onboarding/complete — fails with 409 conflict below ONBOARDING_MIN_PICKS. */
export const CompleteOnboardingRequest = z.strictObject({});
export type CompleteOnboardingRequest = z.infer<typeof CompleteOnboardingRequest>;
export const CompleteOnboardingResponse = z.object({
  state: OnboardingState,
  seed: TasteSeedStatus,
});
export type CompleteOnboardingResponse = z.infer<typeof CompleteOnboardingResponse>;

/** GET /v1/taste/picks — Settings → Taste: current picks grouped by category, plus exclusions. */
export const TastePicksResponse = z.object({
  picks: z.object({
    wear: z.array(OnboardingPick),
    play: z.array(OnboardingPick),
    watch: z.array(OnboardingPick),
    eat: z.array(OnboardingPick),
    /** Picks without a consumer category (kind `reference`). */
    other: z.array(OnboardingPick),
  }),
  picks_count: z.number().int().nonnegative(),
  /** Exclusions are preferences: null for an agent without `preferences:read`. */
  food_exclusions: FoodExclusions.nullable(),
});
export type TastePicksResponse = z.infer<typeof TastePicksResponse>;
