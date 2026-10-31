# Hybrid catalog and intent evaluation handoff

2026-10-27. Catalog/evaluation track only. No live network requests, paid calls,
database access, acquisition, human labeling, commits or deployment performed.
All added test imagery/metadata are synthetic. Frozen artifacts were not changed.

## Added files

Under `/Users/vontariusfalls/culture-atlas-worktrees/factory6-integration/`:

- `scripts/style/visual-catalog.ts`: opt-in bounded official Met importer;
  consumes the domain-owned `VisualCatalogSchema` and object schema.
- `scripts/style/private-artifacts.ts`: bounded no-follow reads, canonical image
  decoding/transcoding/hash, safe errors and exclusive private output.
- `scripts/style/intent-recommendation-audit.ts`: offline per-intent funnels,
  private review packet, explicit human judgment validation.
- `scripts/style/visual-catalog.test.ts`
- `scripts/style/intent-recommendation-audit.test.ts`
- `scripts/style/catalog-evaluation.vitest.config.ts`: no database global setup.

Existing `qloo-native-audit.ts` and its unknown/completeness/privacy guarantees
are unchanged. No domain/provider/web/package source was edited by this track.

## Validation actually run

From the repository above:

```sh
pnpm exec vitest run --config scripts/style/catalog-evaluation.vitest.config.ts
pnpm exec tsc -p tsconfig.scripts.json --noEmit
pnpm exec eslint scripts/style/visual-catalog.ts scripts/style/visual-catalog.test.ts scripts/style/private-artifacts.ts scripts/style/intent-recommendation-audit.ts scripts/style/intent-recommendation-audit.test.ts scripts/style/catalog-evaluation.vitest.config.ts
```

Results: **33 tests passed, two files; TypeScript passed; ESLint passed.**
Tests inject fetch; no tests invoke global live fetch. Tests use exclusively
created temporary directories and remove only their own fixtures. The root
Vitest database setup is intentionally not used.

Coverage includes partial and unknown pools, all 24 photos, provider errors and
empty/unavailable retrieval, missing/hash-mismatched/nonimage/symlink assets,
URL-versus-cached-image distinction, manual defaults/tie/neither/unknown,
duplicate/reversed pairs and judgments, image/input hash binding, invalid input,
public report privacy, trusted redirects, streamed and declared byte limits,
image dimensions, unsafe hosts/credentials/query strings, exclusive writes,
Git/symlink output exclusion, request caps and global stop on HTTP429.

## Acquisition readiness and exact coordinator command

The CLI fetches **only** when explicitly supplied:

```sh
cd /Users/vontariusfalls/culture-atlas-worktrees/factory6-integration
pnpm exec tsx scripts/style/visual-catalog.ts \
  --acquire official-met-public-domain \
  --out /Users/vontariusfalls/atlas-private/met-20261027-v1 \
  --version met-20261027-v1 \
  --max-objects 12 \
  --max-requests 40
```

**Not executed by this worker.** Coordinator must first:

1. Review authorization, current official API documentation and the passing
   tests; no credentials or user-photo/private query inputs are needed.
2. Have an existing canonical, nonsymlink private parent directory outside every
   Git checkout, e.g. `/Users/vontariusfalls/atlas-private` with mode0700.
   The child `met-20261027-v1` must **not exist**. Use a fresh version/path for a
   different acquisition, not a favorable overwrite/retry. On macOS `/tmp` is a
   symlink: use canonical `/private/tmp` if choosing temporary storage.
3. Keep `.git` ancestor checks intact; do not point acquisition at this repo.
4. Inspect both private outputs before configuring the domain. The manifest is
   `.../met-20261027-v1/catalog.json`, assets are in its `assets/` directory, and
   `acquisition.json` records request counts/bytes/failures/scope. All directories
   created here use0700; files use0600 and exclusive creation.
5. Independently load/validate the resulting manifest and asset hashes using the
   domain loader, then set `VISUAL_REFERENCE_CATALOG_FILE` to that manifest only
   in the coordinator-owned runtime. Comparison privacy/profile/spend gates and
   feature enablement remain separate requirements.

The importer uses `/public/collection/v1.1/search` with offset0/limit24 and
static statuette/vase/chair queries with `isHighlight=true`, retaining
Sculpture/Ceramics/Furniture retrieval tags. Details remain
`/public/collection/v1/objects/<positive-id>`. It never falls back to retired
`/v1/search`. One page per class; at most24 unique object details considered,
24 objects admitted and80 requests, with lower CLI bounds allowed. Defaults
are12 objects/40 requests. Coordinator subsequently added bounded per-class
object quotas (`ceil(maximum/3)`) and eight detail attempts per class, so the
first class cannot consume the entire detail allowance. These quotas do not
guarantee balanced successful acquisition or catalog coverage.

Requests are sequential, at least1100ms between starts in production, with
20-second abort deadlines and at most two manually validated redirects per
request. HTTP429/503 stop the entire acquisition; HTTP401/403 also stop it.
There are no automatic retries. API redirects cannot alter path or query;
image redirects remain on the exact HTTPS image host, without query,
credentials or fragment. API requests only target
`collectionapi.metmuseum.org`, image requests only `images.metmuseum.org`.
There is no custom DNS resolution, arbitrary proxy URL, auth or cookie input.

Response bounds: JSON1MiB, image8MiB, cumulative downloaded128MiB. Decode only
single-frame JPEG/PNG/WebP, max8192 pixels per side and20million pixels, then
strip metadata by canonical JPEG transcoding; canonical assets max8,000,000
bytes. The stored hash/dimensions describe those exact cached canonical bytes.

Each admitted record requires `isPublicDomain === true`, an actual decoded
image, matching positive object ID/source URL, explicit object name/title and
the exact fixed catalog schema. No public-domain assumption from a search
filter alone. The institution is The Metropolitan Museum of Art; licenseCC0,
official source/image URLs, retrieval timestamp and canonical hash are stored.
Tags identify the static retrieval class, not visual matching or independently
verified object taxonomy. Detail bounds/schema failures are recorded and do
not invalidate already acquired objects.

`acquisition_status=complete` means only that the requested bounded sample was
acquired with no recorded failures. It is **never** full museum/catalog recall.
Any shortage or recorded failure produces `partial`. Partial objects are
retained; acquisition diagnostics always say `catalog_coverage=unknown`.
Unsupported current search response envelopes fail closed with
`unsupported_search_envelope`; no guessing or old-endpoint fallback. Real
v1.1 response compatibility was not live-verified by this worker; the coordinator
subsequently checked the documented endpoint and completed the acquisitions below.

A filesystem/disk failure can leave a private incomplete directory without
finished manifests; it is not a ready catalog. Do not reuse it or treat it as
coverage. Local checks reject preexisting symlink components and final-file
symlinks and use exclusive creation; run in a trusted operator-owned directory,
not one concurrently manipulated by another process with the same OS identity.

This is a bounded public-domain **museum reference** source, not commercial
shopping inventory, availability evidence or proof of broad recommendation
supply.

## Coordinator acquisition and cached-input follow-up

These later operations are separate from the original offline worker handoff.
The expanded catalog/evaluation suite passed **34 tests**. Official Met API
documentation and terms were checked before public acquisition. No user-photo
queries, credentials or model calls were needed for acquisition.

- Original private acquisition `hybrid/met-20261027-v1`: seven admitted objects,
  34 requests, 24 detail attempts and 17 non-public-domain rejections. Its
  unhelpful molds/fragments and print remain recorded, not overwritten.
- A new, pre-model-evaluation acquisition using the concrete queries above,
  `hybrid/met-20261027-object-query-v2`, admitted **16 images** from 43 requests
  and 24 detail attempts; eight objects failed the public-domain requirement.
  Seven sculptural records, five vases and four chair/part records passed
  independent domain hash/dimension/format validation. Acquisition is **partial**,
  catalog recall remains unknown, and not every record pictures a whole object.
- Catalog SHA-256:
  `003f6811c5da86d750299ccfef2bc484aae14f82f7ce32a3e76a90afe5a34e1a`.
- The owned image route served exact cached JPEG bytes (200) and rejected an
  unknown hash (404), with comparison maximum still zero.
- The retained 24-photo v6 export contains **1567 candidate/relation occurrences**:
  143 known admitted/shown and 1424 admission-unknown/hidden. All pools have
  unknown completeness/strength. All source image hashes were checked, but
  candidate cached-image evaluability is **zero**. URLs are not image evidence.
- The private packet has **20 review pairs**, all human dimensions still
  `not_evaluated`. No human preference, ranking regret, broad catalog recall,
  fresh holdout or retrospective visual-mode success is claimed.

## Offline cached input contract

The audit does not guess how new domain traces encode fields and does not fetch
missing images. Coordinator must create a **new private projection** of the
frozen cached 24-photo run, preserving every photo including errors, empties
and partials. Do not modify original capture artifacts. This explicit export
step is required; there is no automatic raw-trace migration in this track.

Root:

```ts
{
  schema_version: "atlas_intent_cached_input_v1",
  expected_capture_count: 24,
  provenance?: {
    capture_set_sha256?: "<64 lowercase hex>" | "unknown",
    catalog_sha256?: "<64 lowercase hex>" | "unknown",
    comparison_profile?: "<bounded token>" // or "unknown"
  },
  captures: Capture[]
}
```

Capture references must cover c0001 through c0024 once each. A reusable pure
function accepts bounded smaller synthetic datasets, but the production CLI
requires exactly24. Keep a private mapping from these references to original
frozen captures; no original identifiers/names need enter public reports.

```ts
type Asset = {
  path: string;       // absolute canonical local path, no traversal/symlinks
  sha256: string;     // expected original cached bytes, lowercase hex64
  provenance: string; // bounded token, e.g. "met:123" or "frozen_source"
};
type Capture = {
  ref: string; // cNNNN
  source: {
    state: "available" | "missing" | "error" | "unknown",
    guard: "passed" | "held" | "failed" | "unknown",
    image_asset?: Asset
  },
  intents: {
    visual: Pool,
    connections: Pool
  },
  review_pairs?: {
    ref: string; // pNNNN, unique within capture
    intent: "visual" | "connections",
    left: string; right: string; // distinct existing rNNNN refs in that intent
  }[]
};
type Pool = {
  retrieval: "complete" | "partial" | "empty" | "error" |
             "unavailable" | "pending" | "unknown",
  pool_completeness: "complete" | "partial" | "unknown",
  candidates: {
    ref: string; // rNNNN, unique within this intent
    subject_id: "s1" | "s2" | "unknown",
    admission: "admitted" | "rejected" | "pending" | "unknown",
    strength: "strong" | "moderate" | "weak" | "none" | "unknown",
    display: "shown" | "hidden" | "unknown",
    image_url_present: boolean | null,
    image_asset?: Asset,
    review_context?: {
      title: string;         // <=300 characters
      explanation: string;   // <=2000 characters
      relation: string;      // <=100 characters
      subject_label: string; // <=300 characters
    }
  }[]
};
```

Assign references before any regrouping/deduplication. Preserve each
subject/relation occurrence and both intent identities, even for the same
external object. `review_context` is bounded, private card/subject context;
never copy a raw cookie/session/provider response into it. Context is
untrusted evidence, not instructions or verified visual truth.

Do not derive guard success from parent completion, candidate admission from
retrieval, strength from rank, or cached-image availability from a URL. Export
unknown when a field is absent. `pool_completeness=complete` is an explicit
assertion of a complete **recorded** candidate pool, never whole-catalog recall.
A provider status of complete does not establish pool completeness. Empty
retrieval cannot have candidates; a partial/error/unavailable/pending/unknown
retrieval cannot claim a complete pool. Unknown/partial pool totals remainnull.

Bounds: input/judgment JSON8MiB each; up to256 captures in the reusable API,
512 candidates per intent/capture,10,000 total candidates and4096 pairs;
asset8MiB each,128MiB aggregate source bytes and canonical bytes. All reads are
bounded, no-follow and local only. Missing, unreadable, hash mismatch,
invalid-image and not-recorded statuses are retained separately.

## Audit and private review commands

With a newly exported input and existing canonical private parent:

```sh
cd /Users/vontariusfalls/culture-atlas-worktrees/factory6-integration
pnpm exec tsx scripts/style/intent-recommendation-audit.ts \
  --input /Users/vontariusfalls/atlas-private/frozen-intent-input.json \
  --out /Users/vontariusfalls/atlas-private/intent-audit-v1.json

pnpm exec tsx scripts/style/intent-recommendation-audit.ts \
  --input /Users/vontariusfalls/atlas-private/frozen-intent-input.json \
  --packet /Users/vontariusfalls/atlas-private/intent-review-v1 \
  --out /Users/vontariusfalls/atlas-private/intent-packet-audit-v1.json
```

These illustrative operator commands were not run on live artifacts. Output
files and packet directory must not exist. Without `--out`, only the allowlisted
public audit JSON goes to stdout. There is no fetch flag or image URL resolver.

The packet contains `packet.json`, `judgments-template.json`, `audit.json`
and privately copied canonical `assets/<hash>.jpg`. The private packet includes
explicit original and cached paths/hashes/provenance, bounded review context
and declared catalog/profile/capture-set provenance. Do not publish it.
The public audit includes only surrogates, safe states/counts, input fingerprint
and provenance availability, not URLs, paths, raw errors, names, secrets,
cookie/session responses or raw provider payloads.

Per-capture and aggregate intent funnels distinguish source/guard state,
retrieval, declared pool completeness, admission, strength, display and actual
candidate-image evaluability. They flag rejected/guard-conflicting display
without fixing it. `catalog_recall` is alwaysunknown. These diagnostics do not
claim full-card usefulness, exhaustive relevance, calibrated similarity,
end-to-end quality or a passed legacy gate.

## Human judgment workflow

1. Freeze the new input, catalog/profile and source set. Populate optional
   provenance with genuine hashes/profile, otherwise leaveunknown. The tool
   fingerprints its normalized accepted input/provenance; it does not fabricate
   missing provenance. Changing accepted context/order/assets requires review
   against the new fingerprint.
2. Review the actual private source/candidate images for the explicitly named
   pair. Use private subject/card context; chooseunknown if subject identification
   or cultural evidence is insufficient. An image being evaluable means only
   its bytes were checked, not that a match or cultural relation is established.
3. Copy the judgment template into a **new private judgment file**. Keep its
   `schema_version`, `input_sha256`, capture/pair refs and original
   `asset_hashes.source/left/right`. Replace reviewer `not_evaluated` with an
   operator-chosen bounded human reviewer token when supplying labels.
4. Independently label all three dimensions:
   `visual_alternative`, `subject_understanding`, `cultural_connection`.
   Allowed values: `left`, `right`, `tie`, `neither`, `unknown`,
   `not_evaluated`. These are relative human preferences, not automatic model
   scores. Default all fields remain `not_evaluated`; none are invented.
5. For nonunknown/nondefault preferences, both candidates and the source must
   have verified cached images, source available, guard passed, and all three
   original image hashes must match. Any supplied nondefault label also needs
   the exact input fingerprint and a nonplaceholder reviewer. A suppliedunknown
   can honestly record insufficient evidence even if an image is missing.
6. Run, with a fresh output file:

```sh
pnpm exec tsx scripts/style/intent-recommendation-audit.ts \
  --input /Users/vontariusfalls/atlas-private/frozen-intent-input.json \
  --judgments /Users/vontariusfalls/atlas-private/human-judgments-v1.json \
  --out /Users/vontariusfalls/atlas-private/intent-human-audit-v1.json
```

Duplicate judgments or reversed duplicate pairs are errors, not silent
last-write wins. One consolidated human judgment per pair per run is supported;
multiple independent raters need separate runs and an explicit reconciliation
outside this tool. All-default supplied templates remain `not_evaluated`.
Judgment counts summarize only supplied pairs. Rejected candidates remain
diagnostic-only under every label; no promotion, publication or reranking occurs.

## Remaining limitations/follow-ups

- Coordinator still owns actual acquisition and inspection of partial failures.
- No real catalog data or actual 24-photo intent export was acquired/generated
  here; no real human labels, quality/coverage metrics, latency or spend results
  are claimed. Worker network/paid spend iszero.
- Coordinator must export the new private projection from actual cached trace
  evidence and retain its mapping. Missing pools/images/provenance stayunknown.
- No commercial-shopping breadth, full-catalog recall, holdout generalization,
  model qualification or native UI qualification follows from these tests.
- The domain schema's stricter title/medium/date and pixel bounds are honored
  per object; unexpected real metadata can yield a truthful partial sample.
- Existing global quality gates, provider privacy/spend rules and separate
  comparison qualification remain coordinator responsibilities.

## Iteration: independent Met apparel fallback (2026-10-27)

Coordinator reports retained Commons acquisition v1: zero objects,11 requests,
seven details,zero images, with `license_tuple_mismatch`/`unsupported_license`
failures followed by HTTP429 global stop. No cause is inferred here. That failed
artifact and the Commons license contract remain unchanged. This worker made
no live Commons or Met requests, retries, paid calls, DB writes, service starts
or commits.

The independent Met importer now accepts optional API `profile` and CLI
`--profile`, limited to:

- `museumobjects-v1` (default): exactly the existing Sculpture/statuette,
  Ceramics/vase, Furniture/chair searches, including `isHighlight=true`.
  Omitted and explicitly selected defaults have identical request URLs.
- `apparel-v1`: Jackets/jacket, Shirts/shirt, Ensembles/ensemble, Shoes/shoes;
  `isHighlight` is omitted, not changed to another arbitrary filter.

Both retain `hasImages=true`, `isPublicDomain=true`, offset0/limit24, the same
official v1.1 search and v1 detail endpoints, and actual detail-level
`isPublicDomain === true` admission. Stored `title`/`object_type` remain the real
API title/objectName, never the query or a fabricated garment identity. Tags
are retrieval hints only. All output catalogs remain strict
`atlas_visual_catalog_v1` with CC0 and explicit public-domain true.

For apparel, detail allowance is six unique objects per class (24 total);
successful-object quota is `ceil(requested_objects/4)`. A depleted or rejected
class does not spend its unused allowance on the first class. At most24 image
attempts/objects,80 requests,128MiB aggregate,8MiB downloaded image,20MP,
single-frame JPEG/PNG/WebP, sequential starts at least1100ms apart,20s abort
deadlines, two validated official redirects, global stops401/403/429/503 and no
retries remain enforced. Canonical JPEG bound stays8,000,000 bytes. Existing
exclusive0700/0600 private outside-Git I/O and URL/hash checks are reused.

`acquisition.json` adds `profile`, `image_attempts`,
`retrieval_basis=static_query_class_hint_not_verified_identity` and
`supply_coverage=unknown`; `catalog_coverage` remainsunknown. Any shortage or
recorded failure ispartial. Complete means only the bounded requested sample,
not apparel relevance, whole-object identity, catalog recall or usefulness.

Exact coordinator command (NOT executed by this worker; parent directory must
already be canonical/private/outside Git and child must not exist):

```sh
cd /Users/vontariusfalls/culture-atlas-worktrees/factory6-integration
pnpm exec tsx scripts/style/visual-catalog.ts \
  --acquire official-met-public-domain \
  --profile apparel-v1 \
  --out /Users/vontariusfalls/atlas-private/met-apparel-20261027-v1 \
  --version met-apparel-20261027-v1 \
  --max-objects 24 \
  --max-requests 80
```

Inspect `catalog.json`, `acquisition.json` and independently validated cached
assets before merging supply or configuring any runtime. Use a fresh exclusive
path/version; do not overwrite the Commons failure or an earlier acquisition.
No selector, schema, provider, web or runtime configuration changes were made
in this fallback iteration. Actual apparel supply and human usefulness remain
unverified.

Checks actually passed:

```sh
pnpm exec vitest run --config scripts/style/catalog-evaluation.vitest.config.ts scripts/style/visual-catalog.test.ts
# 45 passed, one file; injected transport only.
pnpm exec vitest run --config scripts/style/catalog-evaluation.vitest.config.ts
# 109 passed, four files; all transport hermetic/local.
pnpm exec tsc -p tsconfig.scripts.json --noEmit
pnpm exec eslint scripts/style/visual-catalog.ts scripts/style/visual-catalog.test.ts
```

Tests cover closed profiles/default compatibility, four class quotas, preserved
actual objectName/title, false/missing/nonboolean public-domain metadata,
missing/unsafe photos, original/canonical byte bounds,20MP/nonimage/SVG
rejection, aggregate128MiB stop, request budget, pacing/deadline, HTTP stop
statuses, existing trusted redirects and exclusive permissions/output safety.

## Iteration 3: bounded Met garments/household profile (2026-10-27)

Read `hybrid-iteration-v3.md`. Coordinator reports actual apparel-v1 supply:
seven records (five Shirts,one Ensemble,one Shoes),35 requests,24 details,
seven images; first jacket/suit results were not public domain. Retained
23-asset merged visual preflight reaches only6/24 photos and cannot meet the
unchanged10-photo useful-coverage gate. No paid visual dispatch or quality pass
is inferred. Existing artifacts/outcomes remain retained; human usefulness is
unverified.

Added closed `garments-household-v1` to the existing API `profile`/CLI
`--profile` enum:

| Retrieval class hint | Exact public query |
| --- | --- |
| Dresses | dress |
| Suits | suit |
| Beds | bed |
| Mugs | mug |

The new profile omits `isHighlight`; no department/type filter or arbitrary
query override was invented. Existing `museumobjects-v1` and `apparel-v1`
queries, URL parameters, order, quotas and default behavior are unchanged.
Actual Met detail `title` and `objectName` continue to populate title/object_type;
the search class never replaces object identity. Explicit detail-level
`isPublicDomain === true`, exact source-ID binding and existing Met CC0 tuple
remain required, with no copyright fallback.

Per-class detail ceiling is six (24 total); successful quota is
`ceil(requested_objects/4)`, at most six for the24-object maximum. All shared
limits remain:24 image attempts/objects,80 requests,128MiB downloaded aggregate,
8MiB downloaded image,20MP, sequential starts at least1100ms apart,20s deadlines,
two official validated redirects, global stop401/403/429/503, no retries.
Canonical JPEG stays at most8,000,000 bytes. Private exclusive0700 directories,
0600 files, outside-Git/no-follow paths, official URL checks and canonical
SHA256/dimension/format checks are reused unchanged. Any failure/shortage yields
partial; supply/catalog coverage remainsunknown. A successful bounded sample
still does not establish relevant whole-object supply or either AI gate.

Exact coordinator acquisition command, **not executed by this worker**:

```sh
cd /Users/vontariusfalls/culture-atlas-worktrees/factory6-integration
pnpm exec tsx scripts/style/visual-catalog.ts \
  --acquire official-met-public-domain \
  --profile garments-household-v1 \
  --out /Users/vontariusfalls/atlas-private/met-garments-household-20261027-v1 \
  --version met-garments-household-20261027-v1 \
  --max-objects 24 \
  --max-requests 80
```

Existing canonical/private/outside-Git parent and fresh nonexistent output
child are required. Independently inspect partial acquisition diagnostics and
validate every cached asset before a new merge/preflight; do not overwrite
previous supply or rerun model outcomes favorably.

Only `scripts/style/visual-catalog.ts`, its test and this append were changed.
No live requests, Commons requests/retries, Openverse asset acquisition,
network/paid/DB/service activity, commits or subagents. Commons429 stop remains
in force; index metadata is not primary license verification.

Validation passed:

```sh
pnpm exec vitest run --config scripts/style/catalog-evaluation.vitest.config.ts scripts/style/visual-catalog.test.ts
# 59 passed, one file; all transport injected, including new CLI acceptance.
pnpm exec tsc -p tsconfig.scripts.json --noEmit
pnpm exec eslint scripts/style/visual-catalog.ts scripts/style/visual-catalog.test.ts
```

New cases cover all four exact queries/absence of unapproved filters, per-class
and total detail/image quotas, retained actual metadata, partial rejected-class
supply, missing/nonboolean public-domain metadata, source/object identity
mismatches, unsafe/missing images, missing title/type, global stop statuses and
explicit CLI acceptance. Previous default/apparel compatibility and bounded
transport/photo/cache tests remain passing.
