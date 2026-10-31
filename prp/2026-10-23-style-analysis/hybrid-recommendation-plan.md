# Intent-based visual and cultural recommendations

2026-10-27. User requested this plan and immediate team implementation.
Budget: $45 cumulative, not $45 additional. Verified counted reservations
$22.253631, remaining $22.746369; zero active reservations/jobs. Daily Qloo
quota remains 1,500 with 262 admitted at preflight. No reset or bypass.

## Product promises

- Visual references: attributable pictured objects, with bounded model
  comparison to an admitted photo subject. Experimental similarity suggestions,
  never authentication, maker attribution, buying availability or guaranteed matches.
- Connections: existing evidence-backed brand/taste/subject relationships.
  Do not call these matching products or verified visual similarity.
- Default is connections. Never backfill the visual mode with contextual cards.
- Existing capture fields, RailDto kinds, legacy recommendations and native
  parsing remain compatible. No new native UI or physical qualification claimed.
- No commits, pushes, deployment, new outside-platform writes, privilege changes
  or discarding existing work. Only explicitly isolated test DB migrations.

## Architecture and fixed cross-agent contracts

### Catalog (domain owns schema, importer consumes it)

Export `VisualCatalogSchema` and types from
`packages/domain/src/style/visual-catalog.ts`. Document schema:
```
{
  schema_version: "atlas_visual_catalog_v1",
  catalog_version: string,
  generated_at: ISODate,
  asset_root: absolutePath,
  acquisition_status: "complete" | "partial",
  objects: [{
    id: "met:<positive integer>",
    institution: string,
    title: string,
    object_type: string,
    medium: string,
    object_date: string,
    source_url: HTTPSMetObjectURL,
    image_url: HTTPSMetImageURL,
    license: "CC0",
    is_public_domain: true,
    image_path: relativePathWithinAssetRoot,
    image_sha256: lowercaseHexSHA256,
    width: positiveInteger,
    height: positiveInteger,
    tags: string[],
    retrieved_at: ISODate
  }]
}
```
Bounds, real-path containment, file type/size/hash checks, image dimensions and
safe host checks are required. Reject traversal, symlink escape, private/source
images, non-public-domain records and arbitrary external URLs. Metadata cannot
establish a visual match. Catalog version/hash participates in cache keys.

Initially use a bounded public-domain Met catalog of sculpture, ceramics and
selected furnishings, not a general shopping catalog. Current official docs
https://metmuseum.github.io/ say old `/v1/search` retired October 1, 2026;
use `/public/collection/v1.1/search` with offset/limit, then the documented
`/public/collection/v1/objects/<id>`. Public API requires no key. Conservative
single-request concurrency/rate, maximum object/download/byte counts, no retry
through HTTP429 or other throttling. Only official HTTPS API/image hosts,
validate redirects; no user photos, auth data or private query text sent.
Actual acquisition is coordinator-owned after importer tests pass.
Data/assets stay private outside Git, sample fixtures visibly synthetic.

### Comparison provider (provider worker owns)

Add `ProviderRegistry.visualSimilarity`, using a dedicated `vision_similarity`
model role, schema and adapter, not the existing textual-claim verifier.
Keep the existing single-image cardinality/security bounds. Prepare one clearly
labeled source/candidate contact sheet using bounded Sharp processing. Qualify
this new prompt/schema independently; do not reuse a qualification ID to imply
the new task passed.

Public TypeScript interface exported by providers:
```
interface VisualSimilarityRequest {
  sourceImage: Uint8Array;
  candidateImage: Uint8Array;
  sourceRegion: { x: number; y: number; w: number; h: number };
  subjectLabel: string;
  candidateLabel: string;
}
interface VisualSimilarityResult {
  sameObjectType: boolean;
  similarity: "strong" | "moderate" | "weak" | "none";
  matchedFeatures: string[];
  differences: string[];
  sourceImageSha256: string;
  candidateImageSha256: string;
  contactSheetSha256: string;
  sourceRegion: { x: number; y: number; w: number; h: number };
  model: string;
  profileVersion: string;
  schemaVersion: string;
  experimental: boolean;
}
interface VisualSimilarityProvider {
  isConfigured(): boolean;
  compare(input: VisualSimilarityRequest, options: GatewayOptions):
    Promise<VisualSimilarityResult>;
}
```
Server computes hashes and binds metadata; model cannot choose identities,
catalog IDs, paths, URLs or ownership. Validate structured output and bounded
text; never infer protected traits, maker, date or material chemistry. Source
and candidate text is untrusted data, never instructions. Exact/source echoes
and incompatible types rejected. Similarity scores are not calibrated truth.
Default unavailable provider, identity binding, privacy/ZDR, pinned provider,
spend reservations, pauses/circuits, deadline/cancellation and idempotency all
apply. No provider worker network/paid calls. Coordinator may qualify or run a
clearly labeled operator-permitted experimental trial only with genuine
privacy/pricing records and the existing gateway policy, never fake metadata.

### Domain processing and additive wire response (domain worker owns)

Feature is off/unavailable without configured local catalog and comparison
provider. Add bounded optional configuration, e.g.
`VISUAL_REFERENCE_CATALOG_FILE` and `VISUAL_MAX_COMPARISONS_PER_CAPTURE` (0..2).
Never run extra paid work for configuration absence or user mode switching.

Use a separate bounded `visual_reference_discovery` job, at most two comparisons
per capture, starting after a guarded styled subject exists. Prefer source-
subject compatible catalog items by attributable object/material metadata;
metadata shortlist is not a visual judgment. Parallelism at most two; no
automatic favorable retries. Account/job identity and exact source/candidate
hashes, subject/region, catalog, profile and schema versions form idempotency.
Keep records bound to analysis and active owner; cancellation, retraction,
re-analysis and asset replacement must not publish stale results.

Domain worker chooses a compatible persistence design (new migration 210 if
required) without forging Qloo origins/query IDs or promoting sample items.
Visual references are external museum cards, not pretend saved/for-sale items.
Serve only validated public catalog image bytes by hash through an owned
read-only route, no private source-image leakage or filesystem paths.

Add optional `discovery_intents` to capture response:
```
{
  version: "atlas_discovery_intents_v1",
  default_intent: "connections",
  visual: {
    status: "unavailable"|"pending"|"running"|"ready"|"empty"|"failed",
    reason: string|null, // bounded stable public reason code, never raw errors
    cards: [{
      id: string, catalog_id: string, subject_id: "s1"|"s2",
      title: string, object_type: string, institution: string,
      image: {url: string, alt: string},
      source_url: string,
      explanation: string, limitations: string,
      comparison: "model_suggested", experimental: boolean
    }]
  },
  connections: { rails: RailDto[] }
}
```
Field optional for older analyses/clients. Preserve legacy fields exactly.
Never interpret absence as visual verification. Preserve per-intent relation
identity before any new grouping; existing legacy dedupe is not silently changed.
Private comparison hashes/profile metadata persist for audit, not consumer copy.
Guarded/held/retracted subjects cannot create visual jobs or candidates.
Candidate missing-image/profile/provider outcomes stay unavailable/failed, not
imagined success. Keep parent research failures/partial status honest.

### Web (web worker owns)

Read apps/web/AGENTS.md and installed Next guides before editing. Parse the
optional additive structure separately from legacy fields, preserving lenient
fallback. Two accessible controls: Connections (default), Visual references.
Switching modes uses existing captured results, not another paid request.
Support visual pending/unavailable/empty/failed/ready states and display
experimental comparison limits, museum attribution, and actual source link.
No Save/Buy button for external museum objects unless a real supported action
exists. Render visual images only through owned validated asset route.
Continue polling pending visual work even if parent capture becomes terminal,
with bounded/cancellable lifecycle and no auth/ownership leakage. Retain
connections' evidence, placeholders/status honesty and existing list semantics.
Test 320/390/1440 widths, keyboard/accessibility and legacy payloads.

### Diagnostic workflow (catalog/evaluation worker owns)

Extend/reuse existing qloo-native-audit where suitable; do not weaken its
unknown/completeness/privacy guarantees. Add per-intent cached funnel diagnostic
and local review packet for supplied human pairwise labels with ties/neither/
unknown. Track source/subject failure, retrieval, admission/strength, display,
candidate image availability and missing cached assets. A URL is not cached
image evidence. Do not fabricate human judgments or infer catalog-wide recall.
Keep rejected candidates diagnostic-only, never auto-promote them.
Human review can later distinguish intent, supply and ranking problems.

## Ownership

1. Domain worker: packages/domain schemas/config/services/compiler/style/jobs,
   migration210 if needed, owned public catalog-image API route; domain exports.
   Does not edit providers, web components/client parser or scripts.
2. Provider worker: packages/providers, new role/adapter/types/tests and
   scripts/qualify-concentrate.ts if needed. No domain/web/catalog script edits.
3. Web worker: web client parser, components, mocks, DOM/E2E tests only; no
   server route, domain/provider schema, .next build/server ownership.
4. Catalog/evaluation worker: new scripts/style catalog importer/diagnostic/
   review tools/tests/docs, consuming fixed catalog schema. No package edits.
5. Coordinator: reconcile contracts, imports and versioning, native compatibility,
   isolated runtimes, real acquisitions, profile trials, budget and final checks.

Workers announce any required contract deviation before changing shared fields.
Each reports exact edits, focused validation and genuine gaps. No paid/network
calls, service starts, builds that race .next, commits, deployments or resets.

## Validation and spend gates

- Focused pure/unit/integration tests per track; synthetic fixtures never pass
  as live catalogue/provider evidence. New global-ledger tests use isolated DB.
- Coordinator runs full backend/typecheck/lint/build and browser regression,
  production HTTPS real/fidelity paths, additive native decoder checks.
- Read actual ledger/quota before every paid stage. New cap45 includes all
  historical unknown reservations. Keep Qloo1500 unchanged; no UTC-reset tricks.
- First qualification/diagnostic paid increment ceiling $3; first frozen
  capture/comparison evaluation increment ceiling $8 more. Preserve remaining
  allowance and stop if qualification/data cannot support the experiment.
- Frozen inputs/denominator/source/catalog/profile; retain errors/empties, no
  favorable retries. Record parent/readable, visual and end-to-end latencies.
  Existing first-readable5s and complete30s targets remain measured.
- Report old overall quality gates unchanged and separate intent-specific
  results; new modes cannot be used to relabel a failed gate as passed.
- AI judgments supplement, not invent, human/full-card labels. New generalization
  claims require a genuinely fresh holdout; reused24 remain diagnostic.
- End with actual spend/reservations, quality/coverage/latency and missing-data
  limits, all owned runtime cleanup, no deployment or unsupported qualification.
