import { z } from 'zod';
import {
  GraphEvidenceKind,
  GraphExternalProvider,
  GraphNodeDomain,
  GraphNodeKind,
  GraphPredicate,
} from './schema';
import corpusJson from '../../../../fixtures/graph-corpus/pilot-manifest.json';

/**
 * Schema of the reviewed pilot evidence corpus manifest
 * (fixtures/graph-corpus/pilot-manifest.json).
 *
 * The manifest is the reviewed, rights-documented art/sculpture/ceramics/
 * interiors corpus: every entry carries canonical identity, a public source
 * with attribution, license and applicable expiry, and evidence whose content
 * was verified against the cited source. The schema is deliberately STRICT:
 * anything else — a photo-candidate inventory entry (image urls, HEAD checks,
 * license-evidence blobs), an unreviewed machine extraction, a manifest
 * without a review record — is not corpus data and cannot even parse
 * (VAL-EVID-001). The candidate photo inventory is evaluation-planning
 * material, not a qualified holdout and never graph evidence.
 */

export const CorpusReviewSchema = z.strictObject({
  reviewed_by: z.string().min(1).max(200),
  reviewed_at: z.string().min(1),
  basis: z.string().min(1),
  notes: z.string().optional(),
});
export type CorpusReview = z.infer<typeof CorpusReviewSchema>;

export const CorpusPhotoInventorySchema = z.strictObject({
  location: z.string().min(1),
  /** The candidate photo inventory is never a qualified holdout. */
  status: z.literal('not_a_qualified_holdout'),
  note: z.string().min(1),
});

export const CorpusIdentitySchema = z.strictObject({
  key: z.string().min(3).max(300),
  name: z.string().min(1).max(200),
  kind: GraphNodeKind,
  domain: GraphNodeDomain,
  sense: z.string().min(1).max(60),
  aliases: z.array(z.string().min(1).max(200)).optional(),
});
export type CorpusIdentity = z.infer<typeof CorpusIdentitySchema>;

export const CorpusExternalIdSchema = z.strictObject({
  identity: z.string().min(3).max(300),
  provider: GraphExternalProvider,
  external_id: z.string().min(1).max(255),
  /** Documented provenance of the mapping (what lookup confirmed it). */
  provenance: z.string().min(1).max(200),
});
export type CorpusExternalId = z.infer<typeof CorpusExternalIdSchema>;

export const CorpusRightsSchema = z.strictObject({
  license: z.string().min(1).max(200),
  license_url: z.string().optional(),
  permitted_use: z.array(z.string().min(1)).min(1),
  /** 'none' means no rights expiry applies; 'date' requires expires_at. */
  expiry: z.enum(['none', 'date']),
  expires_at: z.string().optional(),
  basis: z.string().min(1).max(1000),
}).refine((r) => r.expiry === 'none' || r.expires_at !== undefined, {
  message: 'rights.expiry "date" requires rights.expires_at',
  path: ['expires_at'],
});
export type CorpusRights = z.infer<typeof CorpusRightsSchema>;

export const CorpusSourceSchema = z.strictObject({
  key: z.string().min(3).max(300),
  /** Provider rights policy key (must exist in provider_rights_policies). */
  provider: z.string().min(1).max(100),
  url: z.string().url().max(2000),
  /** Mirrors and re-crawls of one source family count once for support. */
  family_key: z.string().min(1).max(300),
  title: z.string().min(1).max(300),
  publisher: z.string().min(1).max(300),
  attribution: z.string().min(1).max(300),
  locator: z.string().max(300).optional(),
  retrieved_at: z.string().min(1),
  rights: CorpusRightsSchema,
  retention: z.strictObject({ content: z.string().min(1).max(300), basis: z.string().min(1).max(1000) }),
});
export type CorpusSource = z.infer<typeof CorpusSourceSchema>;

/**
 * Reviewed corpus evidence never comes from machine extraction: the validation
 * enum is closed over provider_metadata/curated_passage only.
 */
export const CorpusEvidenceSchema = z.strictObject({
  source: z.string().min(3).max(300),
  kind: GraphEvidenceKind,
  derivation: z.enum(['primary', 'mirror', 'refresh', 'reextraction']),
  validation: z.strictObject({
    method: z.enum(['provider_metadata', 'curated_passage']),
    version: z.string().min(1).max(64),
  }),
  locator: z.string().max(300).optional(),
  excerpt: z.string().max(2000).optional(),
  structured_value: z.unknown().optional(),
}).refine((e) => e.excerpt !== undefined || e.structured_value !== undefined, {
  message: 'evidence carries a permitted excerpt or a structured value',
});
export type CorpusEvidence = z.infer<typeof CorpusEvidenceSchema>;

export const CorpusAssertionSchema = z
  .strictObject({
    /**
     * Human-readable manifest label (unique within the manifest). Deliberately
     * not a reference key: nothing cross-references an assertion, and the
     * loader never persists it — the assertion's identity is its natural key
     * (subject, predicate, object, association_subtype).
     */
    label: z.string().regex(/^[a-z0-9][a-z0-9-]*$/u, 'assertion labels are lowercase slugs'),
    subject: z.string().min(3).max(300),
    object: z.string().min(3).max(300),
    predicate: GraphPredicate,
    /** Required for DOCUMENTED_ASSOCIATION (e.g. 'on_display_at'); forbidden otherwise. */
    association_subtype: z.string().min(1).max(100).optional(),
    evidence: z.array(CorpusEvidenceSchema).min(1),
  })
  .refine((a) => (a.predicate === 'DOCUMENTED_ASSOCIATION') === (a.association_subtype !== undefined), {
    message: 'DOCUMENTED_ASSOCIATION requires association_subtype; other predicates forbid it',
    path: ['association_subtype'],
  });
export type CorpusAssertion = z.infer<typeof CorpusAssertionSchema>;

export const CorpusManifestSchema = z
  .strictObject({
    manifest_version: z.literal(1),
    corpus_version: z.string().min(1).max(64),
    policy_version: z.string().min(1).max(64),
    domains: z.array(GraphNodeDomain).min(1),
    review: CorpusReviewSchema,
    photo_candidate_inventory: CorpusPhotoInventorySchema,
    provider_policy: z.strictObject({
      transient_providers: z.array(z.string().min(1)),
      note: z.string().min(1),
    }),
    identities: z.array(CorpusIdentitySchema).min(1),
    external_ids: z.array(CorpusExternalIdSchema).default([]),
    sources: z.array(CorpusSourceSchema).min(1),
    assertions: z.array(CorpusAssertionSchema).min(1),
  })
  .superRefine((manifest, ctx) => {
    const identityKeys = new Set(manifest.identities.map((i) => i.key));
    if (identityKeys.size !== manifest.identities.length) {
      ctx.addIssue({ code: 'custom', message: 'identity keys must be unique', path: ['identities'] });
    }
    const sourceKeys = new Set(manifest.sources.map((s) => s.key));
    if (sourceKeys.size !== manifest.sources.length) {
      ctx.addIssue({ code: 'custom', message: 'source keys must be unique', path: ['sources'] });
    }
    for (const external of manifest.external_ids) {
      if (!identityKeys.has(external.identity)) {
        ctx.addIssue({ code: 'custom', message: `external id names unknown identity ${external.identity}`, path: ['external_ids'] });
      }
    }
    const assertionLabels = new Set<string>();
    for (const [index, assertion] of manifest.assertions.entries()) {
      if (assertionLabels.has(assertion.label)) {
        ctx.addIssue({ code: 'custom', message: `assertion label ${assertion.label} is duplicated`, path: ['assertions', index] });
      }
      assertionLabels.add(assertion.label);
      for (const key of [assertion.subject, assertion.object]) {
        if (!identityKeys.has(key)) {
          ctx.addIssue({ code: 'custom', message: `assertion ${assertion.label} names unknown identity ${key}`, path: ['assertions', index] });
        }
      }
      for (const evidence of assertion.evidence) {
        if (!sourceKeys.has(evidence.source)) {
          ctx.addIssue({
            code: 'custom',
            message: `assertion ${assertion.label} cites unknown source ${evidence.source}`,
            path: ['assertions', index],
          });
        }
      }
    }
  });
export type CorpusManifest = z.infer<typeof CorpusManifestSchema>;

let cached: CorpusManifest | undefined;
let override: CorpusManifest | undefined;

/** The committed reviewed pilot corpus manifest (parsed once, cached). */
export function getCorpusManifestFile(): CorpusManifest {
  if (override) return override;
  cached ??= CorpusManifestSchema.parse(corpusJson);
  return cached;
}

/** Tests only: swap the corpus manifest (pass undefined to restore the committed one). */
export function setCorpusManifestForTesting(manifest: CorpusManifest | undefined): void {
  override = manifest ? CorpusManifestSchema.parse(manifest) : undefined;
}
