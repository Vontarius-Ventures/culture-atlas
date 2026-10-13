/**
 * Browser copies of the spec limits the UI enforces before submitting (the
 * domain package root is server-only at runtime). limits.test.ts asserts these
 * stay equal to LIMITS in @culture-atlas/domain.
 */
export const UI_LIMITS = {
  collectionNameMax: 80,
  collectionDescriptionMax: 500,
  planMinItems: 2,
  planMaxItems: 5,
  instructionMaxChars: 280,
  dietaryExclusionsMax: 12,
  dietaryExclusionMaxChars: 40,
  initialRenderedRecommendations: 6,
  feedPageDefault: 12,
} as const;
