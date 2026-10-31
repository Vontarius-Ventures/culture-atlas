import { z } from 'zod';
import { RailDto } from './style';

/** Exact public license destinations; never use arbitrary catalog-provided links. */
export const VISUAL_REFERENCE_LICENSE_URLS = {
  CC0: 'https://creativecommons.org/publicdomain/zero/1.0/',
  'CC-BY-4.0': 'https://creativecommons.org/licenses/by/4.0/',
  'CC-BY-SA-4.0': 'https://creativecommons.org/licenses/by-sa/4.0/',
} as const;

export const VisualReferenceCreditSchema = z
  .object({
    attribution: z.string().trim().min(1).max(600),
    license: z.enum(['CC0', 'CC-BY-4.0', 'CC-BY-SA-4.0']),
    license_url: z.string(),
    changes: z.string().trim().min(1).max(200),
  })
  .refine((credit) => credit.license_url === VISUAL_REFERENCE_LICENSE_URLS[credit.license], {
    path: ['license_url'],
    message: 'License URL must be the canonical URL for the declared license',
  });
export type VisualReferenceCredit = z.infer<typeof VisualReferenceCreditSchema>;

/** External attributed references are deliberately NOT DiscoveryCards or saveable items. */
export const VisualReferenceCardSchema = z
  .object({
    id: z.string().min(1).max(200),
    // Strict end-of-input also rejects a final newline (unlike JavaScript `$`).
    catalog_id: z.string().regex(/^(met|commons):[1-9]\d*(?![\s\S])/),
    subject_id: z.enum(['s1', 's2']),
    title: z.string().max(300),
    object_type: z.string().max(300),
    institution: z.string().max(300),
    image: z.object({
      url: z.string().regex(/^\/v1\/visual-references\/images\/[a-f0-9]{64}(?![\s\S])/),
      alt: z.string().max(300),
    }),
    // Validate by exact allowed URL below; z.url() trims the input before checks.
    source_url: z.string().max(1000),
    credit: VisualReferenceCreditSchema.optional(),
    explanation: z.string().max(400),
    limitations: z.string().max(500),
    comparison: z.literal('model_suggested'),
    experimental: z.boolean(),
  })
  .superRefine((card, ctx) => {
    const [namespace, id] = card.catalog_id.split(':');
    // Compare the original string, not a normalized URL: no ports, userinfo,
    // fragments, duplicate queries, encoded IDs, or parser normalization aliases.
    const sources =
      namespace === 'met'
        ? [
            `https://www.metmuseum.org/art/collection/search/${id}`,
            `https://metmuseum.org/art/collection/search/${id}`,
          ].flatMap((url) => [url, `${url}/`])
        : [`https://commons.wikimedia.org/?curid=${id}`];
    if (!sources.includes(card.source_url)) {
      ctx.addIssue({
        code: 'custom',
        path: ['source_url'],
        message: 'Source must match the catalog namespace and exact ID',
      });
    }
    if (namespace === 'commons' && !card.credit) {
      ctx.addIssue({
        code: 'custom',
        path: ['credit'],
        message: 'Commons references require valid credit',
      });
    }
  });
export type VisualReferenceCard = z.infer<typeof VisualReferenceCardSchema>;
export const VisualReferenceStateSchema = z.object({
  status: z.enum(['unavailable', 'pending', 'running', 'ready', 'empty', 'failed']),
  reason: z
    .enum([
      'not_configured',
      'catalog_unavailable',
      'provider_unavailable',
      'no_supported_subject',
      'no_compatible_candidates',
      'no_visual_matches',
      'comparison_failed',
      'comparison_timeout',
      'asset_unavailable',
      'stale_analysis',
      'cancelled',
      'comparison_limit',
    ])
    .nullable(),
  cards: z.array(VisualReferenceCardSchema).max(2),
});
export type VisualReferenceState = z.infer<typeof VisualReferenceStateSchema>;
export const DiscoveryIntentsSchema = z.object({
  version: z.literal('atlas_discovery_intents_v1'),
  default_intent: z.literal('connections'),
  visual: VisualReferenceStateSchema,
  connections: z.object({ rails: z.array(RailDto) }),
});
export type DiscoveryIntents = z.infer<typeof DiscoveryIntentsSchema>;
