# Hybrid DOMAIN/API handoff — 2026-10-27

Implemented only the owned domain, migration and catalog-image route track.
Preserved existing dirty/untracked work; no provider/client/component/script edits,
external/paid calls, servers, builds, ambient DB migrations, commits or deployments.
All test database writes/migrations were isolated.

## Contracts and defaults

- Fixed catalog fields/names unchanged. Exports `VisualCatalogSchema`,
  `VisualCatalogObjectSchema`, `VisualCatalog`, `VisualCatalogObject` from
  `packages/domain/src/style/visual-catalog.ts`, also through the domain barrel.
- Catalog bounds: 500 objects, 2,000,000 manifest bytes, 8,000,000 image bytes,
  20,000,000 decoded pixels; images JPEG/PNG/WebP only, single-page, exact declared
  dimensions/hash. HTTPS official Met hosts, exact object-ID/source-URL binding,
  public-domain=true/CC0 required. Local absolute manifest, canonical asset-root
  containment, no traversal/symlink escape, bounded nonblocking/no-follow reads.
  Missing/invalid local configuration fails closed; no fetch/SSRF route.
- Default compiler/cache version is
  `compiler-2026-10-27-intent-visual-v7`; regression explicitly rejects v6 reuse.
  Explicit deployment override remains honored. Existing style wire untouched.
- `VISUAL_REFERENCE_CATALOG_FILE` optional absolute local manifest;
  `VISUAL_MAX_COMPARISONS_PER_CAPTURE` integer 0..2, default **0** (off).
  Catalog + configured comparison provider + account-owned active guarded style
  subject required. Reads/mode switching never enqueue additional work.
- Exact provider `visualSimilarity.isConfigured()` / `compare(request, options)`
  contract unchanged. Uses provider's exported closed-feature wire schema,
  semantic validator and pinned `atlas_visual_similarity_v1`; labels <=160.
  Source/candidate/region bindings checked independently. Gateway binds the
  comparison profile/schema/contact sheet into its final idempotency key.
- Optional `discovery_intents` emitted for v7 analyses only, version
  `atlas_discovery_intents_v1`, default `connections`, connections retain existing
  rails. Legacy capture fields/recommendations/RailDto kinds unchanged; visual
  jobs are specifically excluded from legacy capture `job_id` and sensor reuse.
- External museum cards only: genuine catalog source link, owned image URL,
  model-suggested comparison and fixed cautious limitations. No DiscoveryItem,
  forged Qloo/query provenance, Save/Buy action, raw provider prose/errors,
  internal model/profile/hash/path metadata in consumer copy.

## Processing/persistence

Migration `210_visual_references.sql` creates private `visual_reference_runs` and
extends both inference/gateway ledger role checks with `vision_similarity`.
Provider worker must not duplicate that migration. One allocation per capture
retains the lifetime maximum two comparison attempts across re-analysis.
Job `visual_reference_discovery` uses maxAttempts=1, provider retries=0,
Qloo/research budgets=0, deadline=30,000ms, comparison timeout=20,000ms.
Attempts commit before comparison dispatch; no favorable automatic retries.

Scheduling occurs after final compiler publication or successful style retry.
Only active, visibly evidenced, non-held/non-retracted supported object families
are shortlisted by catalog object-type metadata; this is not a visual judgment.
At most one slot per subject first, then fill the second slot. Sequential work per
capture plus two database advisory slots bounds cross-worker comparisons to two.
Busy slots fail conservatively without retry/spend. Kill switches checked at
admission and immediately before each dispatch; existing provider gateway gates
remain authoritative.

Private evidence includes analysis/owner/source-asset/source-byte/catalog/reading
bindings, candidates, attempt markers and actual comparison hashes/profile/schema.
Publication rechecks owner/current analysis/reading/region/lease/cancellation,
source bytes and cached candidate bytes; projection rechecks active bindings and
asset availability. Retraction or revision conservatively invalidates the run.
Deletion cancels jobs and cascades private evidence. Re-analysis cannot replenish
the comparison allowance. API images are read-only:
`/v1/visual-references/images/<lowercase-sha256>`; no path/URL/storage-key input.

## Validation

Final focused run: **11 files, 88 tests passed**:

```
pnpm exec vitest run \
 packages/domain/src/style/visual-catalog.test.ts \
 packages/domain/src/style/visual-references.test.ts \
 packages/domain/src/config.test.ts \
 'apps/web/app/v1/visual-references/images/[hash]/route.test.ts' \
 packages/domain/src/services/captures.test.ts \
 packages/domain/src/compiler/style-stage.test.ts \
 packages/domain/src/jobs/queue.test.ts \
 packages/domain/src/db/migrations.test.ts \
 packages/domain/src/db/migration-reconcile.test.ts \
 apps/worker/src/pipeline.test.ts \
 apps/worker/src/style-analysis.test.ts
```

Domain typecheck, worker typecheck and owned-file ESLint passed.
Visual integration tests explicitly use `createIsolatedDatabase('visual')`;
all providers/assets are visibly synthetic. Coverage includes global concurrency,
duplicate attempts, lifetime cap, held/context/person admission, unsupported
claims, unavailable/empty/timeout/failure, hash/region/schema binding, late owner/
analysis/retraction/source/cancel/lease changes, deletion cascade, legacy v6
omission and hash-only image route security.

## Exact files changed by this track (relative to repository root)

```
packages/domain/src/config.ts
packages/domain/src/config.test.ts
packages/domain/src/enums.ts
packages/domain/src/index.ts
packages/domain/src/jobs/types.ts
packages/domain/src/pipeline/index.ts
packages/domain/src/pipeline/style-retry.ts
packages/domain/src/compiler/analyze.ts
packages/domain/src/services/captures.ts
packages/domain/src/schemas/captures.ts
packages/domain/src/schemas/discovery-intents.ts
packages/domain/src/style/visual-catalog.ts
packages/domain/src/style/visual-catalog.test.ts
packages/domain/src/style/visual-reference-image.ts
packages/domain/src/style/visual-references.ts
packages/domain/src/style/visual-references.test.ts
packages/domain/src/style/visual-test-support.ts
db/migrations/210_visual_references.sql
apps/web/app/v1/visual-references/images/[hash]/route.ts
apps/web/app/v1/visual-references/images/[hash]/route.test.ts
prp/2026-10-23-style-analysis/hybrid-domain.md
```

## Coordinator follow-up / genuine limits

No domain implementation blocker remains. Coordinator owns full-suite/web/native
validation and genuine catalog acquisition, role qualification/operator-permitted
trial and spend accounting. Feature intentionally stays unavailable without those
real prerequisites and explicit max>0. Update deployment compiler override and
environment documentation as appropriate; this worker did not edit ambient env
or `.env.example`. Existing v6 captures are not retroactively upgraded or billed.
The initial shortlist covers vessels, sculpture and selected furniture only,
not general shopping, calibrated similarity, authentication or maker attribution.
No live quality, recall, latency or qualification claim follows from synthetic
tests. No running process or test DB remains owned by this worker.

## Renewed selection iteration — conservative retrieval policy v2

Read the integration checkpoint before changing selection. Owned changes only:

- Added `packages/domain/src/style/visual-candidate-selection.ts` and its
  adjacent `.test.ts`.
- Updated `packages/domain/src/style/visual-references.ts` to delegate its
  existing `shortlistVisualCandidates(reading, loadedCatalog, limit)` to the pure
  selector, preserving the exact candidate array shape.
- Updated this handoff; no provider/web/script/catalog/config/compiler-version
  changes, network or paid calls, runtime/profile/ambient-DB writes, services,
  qualification, commits or deployments. Existing dirty work was preserved.

### Exported API for coordinator's frozen offline evaluation

Direct module exports (also re-exported by `visual-references.ts`):

- `VISUAL_CANDIDATE_SELECTION_POLICY_VERSION` =
  `atlas_visual_candidate_selection_v2`.
- `selectVisualCandidates(reading, loadedCatalog, limit)` returns
  `{ policy_version, retrieval_only: true, limit, candidates, subjects,
  diagnostics }`. `subjects` records eligibility reason, normalized object kind
  and active feature keys. Per-subject/per-catalog diagnostics record
  `admitted`, `reason`, exclusion field/term, object kind, metadata rank,
  matched feature keys and `selected`. Excluded candidates have null rank and
  no matched features. Diagnostic order is canonical subject-ID/catalog-ID.
- `eligibleVisualSubjects(reading)` retains the old public signature.
- Types: `VisualCandidate`, `VisualCandidateDiagnostic`,
  `VisualCandidateSelection`, `VisualCandidateReason`, `VisualSubjectReason`.

### Rules and rationale

Catalog admission now requires a closed actual-object noun/alias, not an
unanchored family word. Known singular/plural vessel, sculpture, seating, table
and cabinet nouns are supported; side/dining chair normalize to chair and
arm chair to armchair. A short explicit material/size prefix allowlist is
permitted only before a known noun. Ceramic/pottery alone is unknown;
ceramic sculpture is sculpture, never vessel. Unknown/compound taxonomy abstains,
even when title, medium or tags mention a familiar object. Source labels must
have exactly one normalized kind; original first-two-subject, ID, category,
person, region, subject hold/retraction and visible-certainty >=0.35 guards
remain. Explicit part/representation labels also abstain.

Either `object_type` OR title can exclude an object: explicit fragment/part/
component/portion/section/shard/sherd/incomplete/fragmentary nouns or markers,
mold/mould production tools, named chair/table/vase parts, and explicit
back/leg/seat/arm/foot/lid/handle/base/cover-of/for/from-object phrases. Prints,
engravings, drawings, paintings, photos and other explicit representation nouns,
models/studies/designs of/for/depicting, and miniature/toy/dollhouse furniture
also exclude. These are deliberately narrow lexical rules, not proof of
completeness. `molded`, `cast` and `painted` do not themselves exclude a whole
object. Unknown taxonomy is not repaired by guessing from an image or title.

After admission only, rank is lexicographic: exact normalized kind (0/1), then
`min(3, distinct closed-feature agreements)`, then codepoint catalog-ID.
Agreements use active visible material `name/texture`, construction `name/kind`
and detail `name/text`, compared only with candidate title/medium. The explicit
feature allowlist covers common physical materials, carved/cast/turned/molded/
woven/upholstered construction and fluted/ribbed/pierced/incised/painted/glazed/
gilded/inlaid/floral/geometric details. Held, retracted, context/read-text or
certainty <0.35 claims contribute nothing. No source label, display, aesthetic,
era, lineage, mood, brand/entity/Qloo link or candidate tags/date/institution
contributes agreement. Negated/comparative/attribution/style-containing feature
text conservatively contributes nothing. No broad cultural/maker/style token
matching, unbounded keyword score or metadata-to-visual verification claim.

Reading subject order and round-robin are unchanged: one slot for each eligible
subject before a second candidate for either. Limits floor/clamp to 0..2 (NaN
fails closed); per-subject relation identity is retained even for the same item/
image. Existing durable per-capture allocation/attempt guards still enforce the
lifetime maximum two; a selector revision cannot replenish it.

Coordinator follow-up: include this policy version in frozen evaluation/input
bindings and any future selection-policy-aware runtime/cache identity. The
current runtime keys bind the selected candidates, but do not independently bind
the selection-policy version when those candidates happen to be unchanged.
No identity/compiler/cache version was changed by this worker; decide that
integration before activation, without replaying/replenishing existing capture
allocations. No network/model evaluation or catalog artifact was modified.

### Focused checks

`pnpm exec vitest run packages/domain/src/style/visual-candidate-selection.test.ts
packages/domain/src/style/visual-references.test.ts
packages/domain/src/style/visual-catalog.test.ts --maxWorkers=2`:
**80 passed, 3 files, exit0** (isolated test DB setup/teardown only).
Domain TypeScript and owned-file ESLint passed, exit0. Earlier pre-final focused
selection/reference run also passed68 tests; final adds part-phrase coverage and
catalog regressions. Coverage includes lower-ID part displacement, ceramic
sculpture, title/type mold/print exclusions, unknown/all-reject pools, guarded
physical-evidence ranking, excluded/contextual evidence invariance, exact-kind
precedence, bounded agreement, deterministic ties/permutations/nonmutation,
one/two subjects, limits0/1/2, round-robin and existing lifetime-allocation tests.

This establishes implementation behavior on synthetic fixtures, not improved
human usefulness, visual quality, calibration, catalog recall or production
qualification. Feature maximum and all quality gates remain unchanged.

## Expanded inspiration supply support — selection policy v3

The latest policy is `atlas_visual_candidate_selection_v3`, superseding v2
above. This follow-up changed ONLY
`packages/domain/src/style/visual-candidate-selection.ts`, its adjacent test,
and this handoff. Main's new selection-policy binding in `visualReadingHash`
was left untouched; the prior v2 identity follow-up is now addressed by main.
No references/provider/schema/catalog/web/config/script edits, network/paid
calls, DB writes, services, qualification, commits or deployments in this pass.

### Explicit eligible taxonomy and category guards

Retains all v2 object kinds; additionally supports:

- Outfit/clothing ensemble (including singular/plural ensemble aliases).
- Upperwear: jacket/blazer; coat/overcoat/trench coat; shirt/T-shirt/tee shirt/
  button-down shirt/blouse; sweater/jumper/pullover/cardigan/sweatshirt/hoodie.
- Footwear: shoe/shoes/footwear; boot/ankle boot; sneaker/trainer/athletic shoe.
- Bed/bedstead/single bed/double bed/four-poster bed.
- Bedroom/bedroom interior/scene/photo/photograph, and interior/room/living-room
  scene/photo/photograph aliases.
- Mug/coffee mug and cup/teacup/tea cup/coffee cup, in the existing vessel family.

Fashion subjects must name supported clothing/footwear/outfit kinds, not merely
have category fashion or a clothing/aesthetic claim. Interior subjects must
name supported non-clothing kinds. Existing other/media categories remain
supported. `styleTextAboutPerson`, first-two-subject/ID, subject hold/retraction
paths, region validity and active visible certainty >=0.35 checks are unchanged.
Person-labelled clothing subjects remain excluded; unsupported kinds abstain.
Longest explicit aliases normalize deterministically. An explicit scene alias
at the start followed by with/containing/featuring scopes its contents to that
scene; arbitrary mixed nouns such as "bed in bedroom" still abstain.

Catalog type classification remains a closed noun/alias lookup, with bounded
material/size prefixes extended for common textiles. No namespace-specific
behavior: Met and Commons IDs receive the same rules. Retrieval-query tags,
title, medium, licenses and institution do not establish an unknown actual
type. In particular, neither an unknown Photograph classification nor a
bedroom/jacket search tag can repair missing taxonomy. Catalog licenses and
asset/provenance validation remain the catalog worker's responsibility.

### Output and safety contract

The candidate array and existing API exports remain unchanged. Policy/version
output is v3. Subject and per-candidate diagnostics add
`reference_kind: 'physical_object' | 'scene' | null`; `object_kind` includes the
new normalized kinds. Candidate reasons add `reference_kind_mismatch`, separating
a room/bedroom scene from any physical-object candidate before family ranking.

Room/bedroom references may use explicit actual-photo taxonomy. This exception
does NOT admit printed/painted/drawn scenes or waive photographic/print
representation exclusions for physical-object retrieval. Garment sleeves/
collars/cuffs, shoe soles/heels/uppers and explicit sewing/knitting/dressmaking
patterns also exclude. The literal four-poster-bed furniture phrase is not a
printed poster; a separate poster mention still rejects.

After admission, existing exact-kind precedence, max-three closed feature
agreement rank, codepoint ID ties, subject round-robin, 0..2 bounds and durable
lifetime maximum remain unchanged. Mug therefore precedes a coarse-family cup/
vase when the source is a mug. Ensembles, upperwear, footwear, beds and rooms
have separate families; a garment cannot consume a bed or room slot.

Active visible physical-feature credit expands only to textile materials
(cotton, denim, linen, wool, silk, leather, suede, canvas), knitted/sewn/quilted/
pleated construction and striped/checked/plaid/embroidered/buttoned/hooded
details. Held/retracted/context/read-text/low-certainty evidence, maker/culture/
style/era/lineage metadata and retrieval tags still earn no credit.
`retrieval_only: true` is unchanged. Even admitted object/scene metadata is not
proof of actual contents or resemblance: the comparison model must verify pixels.

### Scoped checks and limits

Pure selector tests: **98 passed, 1 file, exit0**, using a temporary no-global-DB
Vitest config (removed afterward). Domain typecheck and owned-file ESLint both
passed. No test DB was created or accessed. The first check retained96 passes/
one failure: the old poster noun exclusion rejected the legitimate four-poster
bed alias. Added the narrow furniture-phrase exception and a separate poster-of-
four-poster-bed rejection test; the final98 include both. An initial typecheck
also exposed the concurrent catalog v1/v2 union in the synthetic builder; the
fixture now explicitly narrows its v1 object shape, with no catalog/schema edit.

Tests retain all v2 part/mold/representation, unknown-pool, permutation, guard
and bounds coverage, plus clothing/person rejection, bed/garment mismatch,
scene/physical separation, mug exact-kind preference, new guarded feature
credit and Commons-ID-independent round-robin/ties.

This is supply support only, not improved frozen24 benchmark quality. Main owns
separate blinded AI gates for BOTH visual inspiration and cultural connections.
Human usefulness remains unverified. No model evaluation, human label, recall,
qualification or activation success follows from these synthetic checks.

## Iteration 3 — explicit nouns and bounded scene supply, selection policy v4

Read `hybrid-iteration-v3.md`. The prior visual preflight is retained unchanged:
23 real Met assets, 10 selected comparisons across6/24 photos, structurally
unable to reach the unchanged10/24 useful-photo gate. Main skipped ALL paid
visual calls and retained the unrun outcomes. This worker did not reinterpret
that structural failure as a benchmark pass or rerun it.

Latest policy: `atlas_visual_candidate_selection_v4`. Only the selector, its
adjacent tests and this handoff changed. No references/compiler/domain-content/
catalog/provider/schema/web/config/script edits, network/paid calls, DB access,
services, agents, qualification, commits or deployments. Main's existing
`visualReadingHash` selection-policy binding is untouched and will consume the
new exported version.

### Explicit taxonomy and functional compatibility

- Tee/tees/cropped tee normalize to shirt; top/cropped top are an additional
  upperwear kind. No inference from the fashion category or an aesthetic.
- Dress/gown, suit/trouser suit/pantsuit, trousers/pants/jeans, and bag/handbag/
  crossbody bag are explicit known kinds in distinct dress, suit, trousers and
  bag compatibility families. Ensembles remain their own family, not a waiver
  to compare arbitrary clothing components. Longest literal aliases consume
  compound nouns before shorter aliases.
- Sneaker-shoe/sneaker-shoes is a narrow sneaker alias. Boots-and-sneakers,
  shoes-and-sneakers and other arbitrary mixed footwear still abstain.
- Physical platform/canopy/loft beds and four-poster canopy beds normalize to
  bed. The literal `four poster [canopy] bed` phrase is not a printed poster;
  a separate `Poster of ...` mention remains excluded.
- Kitchen/galley kitchen, dining room/nook and sunroom/sunroom dining nook
  provide explicit scene nouns. The bounded scene qualifier list is loft,
  airy, bright, small, large, cozy/cosy, compact and spacious. Only known scene
  aliases can use these prefixes for catalog admission. At the start of a
  source label, a qualified scene alias followed by with/containing/featuring
  scopes named contents to the scene. Thus "Loft bedroom with platform bed"
  is a scene; a separately labelled platform-bed subject remains physical.
  Arbitrary mixed nouns, unknown qualifiers, or "bed in bedroom" do not gain
  a scope waiver.
- V4 deliberately separates mug/cup into a closed drinkware compatibility
  family. They remain mutually compatible, with exact kind preferred, but
  cannot consume vase/urn/bowl/generic-vessel slots, nor vice versa. Such
  rejects use the existing `family_mismatch` reason with null rank. This is
  functional retrieval policy, NOT a declaration of visual dissimilarity.
  Previous v3 broad-vessel behavior/history above is retained, not relabelled.

New garments still require whole objects: explicit sleeve/collar/cuff/bodice,
trouser-leg/waistband, bag-strap/handle/lining and reverse of/for/from-part
phrases exclude, as do explicit production patterns, molds and representations.
"Sequined bodice dress" is a whole dress label, not "Dress bodice". Existing
scene-vs-physical separation and print/photo/painting rules remain unchanged.

The candidate array, pure API exports, diagnostic fields/reasons, active-only
feature rank and deterministic ID ties remain unchanged; `object_kind` simply
gains the explicit kinds above. `retrieval_only` remains true. Unknown catalog
taxonomy is not repaired by title/material/query hints. Category, person,
subject hold/retraction paths, region checks and visible-certainty >=0.35 are
unchanged. In particular Tennis outfit with no active visible evidence is
still rejected, as are food/place/person/unknown subjects. The provider person
guard also conservatively rejects hyphenated "Cross-body bag" (standalone body);
unhyphenated "Tan leather crossbody bag" is supported. No guard was relaxed.
Round-robin, per-subject relation identity, limit0..2 and durable lifetime-two
enforcement remain unchanged.

### Scoped validation and genuine limits

- Pure selector suite: **150 passed, 1 file, exit0**, using a temporary
  no-global-DB Vitest config removed afterward. All98 earlier tests remain;
  added52 explicit-noun/scene/compatibility/guard/part tests.
- Standalone selector TypeScript with strict/noUncheckedIndexedAccess and the
  repository target/module settings passed, exit0.
- Owned selector/test ESLint passed, exit0.
- Full domain typecheck was attempted twice during concurrent integration.
  It is NOT reported passing: latest failure is outside owned files at
  `packages/domain/src/compiler/analyze.ts:1934` (`tags`/`cards` on `never`).
  Earlier errors in analyze/style-stage/discovery-evidence were also outside
  this track. No owned selector/test TypeScript error was reported.
- Initial pure run retained146 passes/one failure: a positive test expected the
  hyphenated cross-body label to bypass the unchanged person guard. Positive
  coverage now uses the requested unhyphenated source form, and the guarded
  hyphenated form is explicitly tested as a rejection; no guard exception.

All11 supplied positive source labels are covered by visibly synthetic guarded
claim fixtures and corresponding explicit catalog types. These are NOT
projections of frozen actual source guard/evidence states or real catalog
supply. No new frozen24 source projection, image evaluation or coverage result
was computed by this worker. Broader explicit support cannot by itself satisfy
either benchmark gate. Main continues the separate blinded AI gates for BOTH
modes; human usefulness remains unverified, and all quality/activation gates
remain unchanged.
