/**
 * Visibly synthetic UI fixtures, not acquired catalog records or live model evidence.
 * The URL shapes exercise the fixed wire contract only.
 */
export const VISUAL_FIXTURE_HASH = 'a'.repeat(64);
export const VISUAL_FIXTURE_CARD = {
  id: 'synthetic-visual-s1',
  catalog_id: 'met:1',
  subject_id: 's1',
  title: 'Synthetic museum reference',
  object_type: 'Sculpture',
  institution: 'The Metropolitan Museum of Art',
  image: {
    url: `/v1/visual-references/images/${VISUAL_FIXTURE_HASH}`,
    alt: 'Synthetic pictured sculpture for UI tests',
  },
  source_url: 'https://www.metmuseum.org/art/collection/search/1',
  explanation: 'The model suggested similar rounded forms in this synthetic comparison.',
  limitations: 'The silhouette differs. This synthetic fixture is not a live museum comparison.',
  comparison: 'model_suggested',
  experimental: true,
} as const;

export const COMMONS_FIXTURE_CARD = {
  ...VISUAL_FIXTURE_CARD,
  id: 'synthetic-commons-s1',
  catalog_id: 'commons:2',
  title: 'Synthetic Commons reference',
  limitations: 'The silhouette differs. This synthetic fixture is not a live reference comparison.',
  institution: 'Wikimedia Commons',
  source_url: 'https://commons.wikimedia.org/?curid=2',
  credit: {
    attribution: 'Synthetic creator <em>plain text, not HTML</em> via Wikimedia Commons',
    license: 'CC-BY-4.0',
    license_url: 'https://creativecommons.org/licenses/by/4.0/',
    changes: 'Resized for display; synthetic UI fixture.',
  },
} as const;
export const COMMONS_SA_FIXTURE_CARD = {
  ...COMMONS_FIXTURE_CARD,
  credit: {
    ...COMMONS_FIXTURE_CARD.credit,
    license: 'CC-BY-SA-4.0',
    license_url: 'https://creativecommons.org/licenses/by-sa/4.0/',
  },
} as const;

export type VisualFixtureMode =
  | 'unavailable'
  | 'pending'
  | 'running'
  | 'ready'
  | 'commons-by'
  | 'commons-sa'
  | 'commons-missing-credit'
  | 'commons-invalid-credit'
  | 'empty'
  | 'failed'
  | 'missing-image'
  | 'missing-profile'
  | 'malformed';

export function discoveryIntentsFixture(mode: VisualFixtureMode = 'ready') {
  const status =
    mode === 'missing-image' || mode.startsWith('commons-')
      ? 'ready'
      : mode === 'missing-profile'
        ? 'unavailable'
        : mode === 'malformed'
          ? 'ready'
          : mode;
  return {
    version: mode === 'malformed' ? 'unknown-version' : 'atlas_discovery_intents_v1',
    default_intent: 'connections',
    visual: {
      status,
      reason:
        mode === 'missing-profile'
          ? 'provider_unavailable'
          : mode === 'failed'
            ? 'comparison_failed'
            : null,
      cards:
        mode === 'commons-by'
          ? [{ ...COMMONS_FIXTURE_CARD }]
          : mode === 'commons-sa'
            ? [{ ...COMMONS_SA_FIXTURE_CARD }]
            : mode === 'commons-missing-credit'
              ? [{ ...COMMONS_FIXTURE_CARD, credit: undefined }]
              : mode === 'commons-invalid-credit'
                ? [
                    {
                      ...COMMONS_FIXTURE_CARD,
                      credit: {
                        ...COMMONS_FIXTURE_CARD.credit,
                        license_url: 'https://evil.example/license',
                      },
                    },
                    { ...VISUAL_FIXTURE_CARD },
                  ]
                : mode === 'ready'
                  ? [{ ...VISUAL_FIXTURE_CARD }]
                  : mode === 'missing-image'
                    ? [{ ...VISUAL_FIXTURE_CARD, image: null }]
                    : [],
    },
    connections: { rails: [] },
  };
}

export function capturePayload(intents: unknown = discoveryIntentsFixture()) {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    source: 'upload',
    status: 'ready',
    received_at: '2026-10-27T12:00:00.000Z',
    captured_at: null,
    image: null,
    focus: { kind: 'whole' },
    is_example: false,
    discovery_item_id: null,
    saved: false,
    job_id: null,
    analysis: {
      id: '00000000-0000-4000-8000-000000000002',
      version: 1,
      title: 'Synthetic photo reading',
      interpretation: null,
      sections: { observations: 'complete', wear: 'complete' },
      question: null,
      warnings: [],
      created_at: '2026-10-27T12:00:00.000Z',
    },
    references: [],
    recommendations: [],
    available_categories: [],
    discovery_intents: intents,
  };
}
