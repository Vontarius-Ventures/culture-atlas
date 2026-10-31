# Hybrid provider handoff

Implemented provider/visual-engine track only. No network/paid calls, service starts,
builds, migrations, commits, deployment, privilege changes or live profile edits.
Existing unrelated Qloo/style/native/web/domain work was preserved.

## 2026-10-27 bounded shape details and prompt v3

Provider-only follow-up (plus this owned handoff). No network, paid calls, DB,
services, private profile/harness/runtime/artifact/evaluation-binding edits,
qualification, retries, commits or deployment. Earlier notes below are history.

### Evidence and proven findings

Coordinator supplied, not re-read from DB: prompt-v2 with the 8s mechanism-v3
profile timed out on p01 at 8.1s, reserving 7000 micros. The separately frozen
15s mechanism-v4 profile completed six same-broad-type weak comparisons with
valid type consensus, then p07 Chair/Vase failed at 1.358s with
`invalid_response` / `schema_shape`; seven attempted, seven unrun, 49000 micros
reserved. No raw response was retained. These outcomes are not overwritten or
reinterpreted as semantic failures, and no retry was attempted here.

Inspected `structuredOutputContract`, strict enum decoding, the visual adapter,
`buildResponsesRequest`, and the real Concentrate transport. An offline injected
fetch now captures the actual serialized request from the real visual adapter,
runner and transport. It proves the four required fields, boolean type, exact
similarity enum, all six matched descriptors and all ten difference descriptors
are sent under `text.format.type=json_schema`, `strict=true`, with
`additionalProperties=false`. No enum is omitted or normalized by this local
request path. The unchanged strict decoder rejects unknown enum strings.

No local transport/schema defect is proven. The provider-facing schema
intentionally omits `maxItems`, as before; the original Zod schema still enforces
six locally. This known superset is not evidence that p07 exceeded six.
`schema_shape` says parsing succeeded but strict decoding/original Zod rejected
the value before semantic validation. It does not identify a field, enum,
cardinality, returned type, or first decoder rule. Nor does sending `strict=true`
prove upstream enforcement. With no retained content or subdiagnostic from that
attempt, the precise violation and upstream cause remain unknown.

The v2 system text did not enumerate descriptor tokens, but the JSON Schema
already supplied all of them. Prompt v3 duplicates the exact arrays (generated
from the same closed constants), explicitly requires exact spelling/spaces, and
adds this locally validated negative example:

`{"sameObjectType":false,"similarity":"none","matchedFeatures":[],"differences":["different object type"]}`

It explicitly warns not to copy the example's judgment absent pixel support.
All previous consistency/safety instructions remain. This is a versioned
instruction-redundancy experiment, not a proven fix or retrospective cause.

### New bounded API and propagation

Root exports added:

- `getStructuredResponseShapeIssues(error: unknown):
  readonly StructuredResponseShapeIssue[] | undefined`
- `STRUCTURED_RESPONSE_SHAPE_DIAGNOSTIC_LIMIT = 8`
- Types `StructuredResponseShapeIssue`, `StructuredResponseShapeField`,
  `StructuredResponseShapeRule`, `StructuredResponseShapeIssueClass`.

Each issue has exactly `field`, `rule`, `issueClass`:

- Fields: `response`, `sameObjectType`, `similarity`, `matchedFeatures`, `differences`.
- Rules: `enum_mismatch`, `missing_field`, `wrong_type`, `unknown_fields`, `array_bounds`.
- Zod issue classes: `invalid_value`, `invalid_type`, `unrecognized_keys`,
  `too_big`, `too_small` (no minimum-array constraint was added).

An optional local-only `GatewayCall.diagnoseShape` callback is invoked only AFTER
the unchanged shape acceptance path rejects. Only the visual adapter enables it.
It reparses a diagnostic-only copy with the ORIGINAL wire schema, inspecting a
prefix of at most seven entries per descriptor array (enough to preserve max-six
violations). It selects constant field names, deduplicates signatures and emits
at most eight triplets. This is a bounded observation, not an exhaustive issue
census or a second acceptance path. Original values are never normalized or
changed. Zod's `invalid_value` can mean a missing/wrong-type enum as well as an
unknown string; the separate rule distinguishes these. Size issues on wrong-type
strings are not falsely labeled array bounds.

The runner's metadata boundary independently allowlists the three values, copies
only those properties, caps output, freezes array/entries and retains them in a
private WeakMap. No raw keys/paths/indexes/values/messages/enum options/expected
schema/causes or full Zod errors are stored. Unknown fields map only to
`response/unknown_fields/unrecognized_keys`. Callback failure cannot replace the
original error. The existing stage WeakMap API, exact `ProviderError` instances,
kinds/messages, spend ledger/observers/circuits and maxRetries=0 are unchanged.

Main may add only this safe projection to a separately authorized new harness:

```ts
response_shape_issues: getStructuredResponseShapeIssues(error) ?? null
```

As with the stage API, call it on the original thrown error in the same process
and module instance before copying/wrapping/serialization. Unknown or non-shape
errors have no issues. No new diagnostic is written to existing ledger rows.

`VISUAL_SIMILARITY_PROMPT_VERSION` is now **`visual-similarity-v3`**.
Schema stays **`atlas_visual_similarity_v1`**, max output **600**. Wire schema and
semantic validator requirements/code are unchanged. Existing exact-version gates
reject v1/v2 prompt profiles. Main owns any new private profile/version/hash,
source binding and future frozen experiment. Do not infer quality qualification
or enable the feature from the synthetic checks.

### Checks and exact files for this follow-up

- Focused visual/runner/metadata tests: **130 passed, 4 files**.
- All offline provider tests: **663 passed, 39 files**.
- Provider TypeScript, focused ESLint and owned whitespace checks passed.
- Same `/tmp/ca-visual-vitest.config.mjs`: credentials cleared, no root DB setup,
  DB suites excluded. All transport requests use mocks/injected fetch; isolated
  MemorySpendStore only. Tests cover actual wire enums, every supported current
  shape category, malicious keys/values, bounded/deduplicated/frozen metadata,
  unknown/throwing callbacks, loss on error serialization, valid negatives and
  unchanged one-dispatch/ledger behavior.
- First focused run retained 126 passes/one test failure: Zod also emitted
  `too_big` for a wrong-type string with length. Diagnostic mapping was corrected
  to emit array bounds only for actual arrays; no validation was changed.

Changed provider files (absolute root below):
`/Users/vontariusfalls/culture-atlas-worktrees/factory6-integration/packages/providers/src/`

- `model-gateway/diagnostics.ts`
- `model-gateway/diagnostics.test.ts` (new)
- `model-gateway/types.ts`
- `model-gateway/runner.ts`
- `model-gateway/runner.test.ts`
- `visual-similarity/shape-diagnostics.ts` (new)
- `visual-similarity/provider.ts`
- `visual-similarity/schema.ts`
- `visual-similarity/diagnostics.test.ts`
- `visual-similarity/visual-similarity.test.ts`
- `index.ts`
- `/Users/vontariusfalls/culture-atlas-worktrees/factory6-integration/prp/2026-10-23-style-analysis/hybrid-provider.md`

## Earlier finite diagnostics and prompt v2 implementation (historical)

This supersedes the earlier offline-investigation-only note below, which is
retained as history. Read the integration checkpoint and runner architecture
before selecting this propagation seam. Changed only provider files and this
handoff; preserved existing dirty work. No network/paid calls, database access,
services, runtime/private harness/profile/artifact edits, evaluation binding
edits, qualification, commits or deployment.

### Design and public API

The runner still creates exact `ProviderError` instances with the existing
provider/kind/message/retryability/serialization. A module-private WeakMap binds
each structured-response failure to one finite reason. No new public error
property, `.code`, subclass, arbitrary cause or message is introduced. The root
`@culture-atlas/providers` exports:

- `getStructuredResponseFailureReason(error: unknown):
  StructuredResponseFailureReason | undefined`
- Type `StructuredResponseFailureReason`, exactly:
  `json_parse | schema_shape | semantic_consistency | route_mismatch |
  provider_error | provider_incomplete | provider_refusal`.

`json_parse` means JSON parsing failed; `schema_shape` means strict decoding or
the ORIGINAL Zod schema rejected the parsed value (including local max-six
cardinality). `semantic_consistency` means the local `validate` callback rejected
it. These are stages, not individual rule identifiers or inferred model intent.
The last four identify the existing route check and the three reported provider
outcomes. Existing priority is preserved: refusal/incomplete/error before route,
then JSON, schema, semantic checks. Returned model and returned provider mismatch
share `route_mismatch`; that existing role circuit still opens.

The internal factory accepts only a finite reason and chooses a static kind and
message. No raw model text, exception message/cause, schema issue/path, labels,
images or response fragments reach the diagnostic. The lookup never reads
properties of unknown values. Unknown, pre-dispatch and transport errors return
undefined. Caller-controlled lookalike fields do not create reasons.

For the separately authorized future harness, project only:

```ts
import {
  isProviderError, getStructuredResponseFailureReason,
} from '@culture-atlas/providers';
const safe = {
  error_kind: isProviderError(error) ? error.kind : 'unclassified',
  response_failure_reason: getStructuredResponseFailureReason(error) ?? null,
};
```

Compatibility limitation: read the reason from the ORIGINAL thrown error in the
same process/module instance, before wrapping/copying/serialization. WeakMap
metadata deliberately does not survive those operations and is not written into
attempt observers, ledger rows or durable outcomes. The existing route circuit's
`route_mismatch` value remains unchanged. Ledger completion still happens before
return/throw; storage failures still fail closed. This runner seam also covers
other structured roles additively, without changing their errors or behavior.
Visual adapter dispatch remains maxRetries=0 even when the caller requests one;
no reservations, costs, pauses, circuits or retry policy were relaxed.

### Versioning and unchanged validation

`VISUAL_SIMILARITY_PROMPT_VERSION` is now **`visual-similarity-v2`**.
`VISUAL_SIMILARITY_SCHEMA_VERSION` stays **`atlas_visual_similarity_v1`**;
output cap stays **600**. The v2 prompt explicitly states max six entries per
array; uniqueness within each array; all six similar/different descriptor pairs
are mutually exclusive; none requires empty matches; non-none requires matches;
same-type forbids `different object type`; incompatible/uncertain type requires
false/none/empty matches; strong requires at least two matched features.
The insufficient-detail negative option and all safety instructions remain.
Wire schema and semantic validator requirements/code are unchanged.

This is instruction completeness, NOT a proven fix for the old pair03 failure,
quality improvement, passing negative live check or qualification. Old v1 profiles
now fail the existing exact-version gate. Coordinator must separately revise the
private experimental profile/version/hash and applicable source/evaluation
bindings before any authorized v2 experiment. No retrospective cause is known;
retain all old attempts and failures, and do not enable the feature from these
offline checks.

### Exact changed files and checks

Prefix for the provider paths below:
`/Users/vontariusfalls/culture-atlas-worktrees/factory6-integration/packages/providers/src/`

- `model-gateway/diagnostics.ts` (new finite factory/private metadata/public lookup).
- `model-gateway/runner.ts` (separate failure stages, existing behavior preserved).
- `model-gateway/runner.test.ts` (semantic message/cause leakage and unknown stages).
- `index.ts` (the two public exports).
- `visual-similarity/schema.ts` (prompt v2 only; no validator/schema relaxation).
- `visual-similarity/diagnostics.test.ts` (all seven finite categories, strict/Zod
  cap, both route mismatches, valid negative/uncertain outputs, safe projection,
  unknown/hostile error properties, no raw body/cause/message leaks, one dispatch,
  unchanged observer/ledger classifications and unknown-cost accounting).
- `visual-similarity/visual-similarity.test.ts` (old v1 prompt rejected).
- `/Users/vontariusfalls/culture-atlas-worktrees/factory6-integration/prp/2026-10-23-style-analysis/hybrid-provider.md`.

Checks run from the repository root, all passed:

- `pnpm exec vitest run --config /tmp/ca-visual-vitest.config.mjs
  packages/providers/src/visual-similarity
  packages/providers/src/model-gateway/runner.test.ts --maxWorkers=4`:
  **103 passed, 3 files**.
- `pnpm exec vitest run --config /tmp/ca-visual-vitest.config.mjs --maxWorkers=4`:
  **636 passed, 38 files**.
- `pnpm --filter @culture-atlas/providers typecheck`.
- Focused ESLint on all seven changed provider files and owned whitespace checks.
- Existing isolated config clears live credential variables and has no root DB
  setup; postgres, inference-attempts and Qloo rate-gate DB suites remain excluded.
  Synthetic transports and fresh isolated MemorySpendStore only.

## Earlier 2026-10-27 offline investigation (historical)

Scope: read the integration checkpoint, current prompt/schema/validator/runner and
the private v2 harness error projection. Added only synthetic offline provider
tests and this note. No provider implementation, prompt/version, schema, validator,
profile, artifact, config, runtime, web or domain changes. No network/paid calls,
database access, services, model retries, qualification, commits or deployment.
Private harness and frozen attempt records were not edited.

### Proven conclusions

- The incompatible-type path is satisfiable through strict schema decoding,
  local validation and the real adapter with a mock transport:
  `{"sameObjectType":false,"similarity":"none","matchedFeatures":[],
  "differences":["different object type"]}` is accepted unchanged.
  Uncertain-type `false/none/[]` plus `insufficient visible detail`, and same-type
  `true/none/[]` plus that descriptor, also pass. Empty differences are allowed.
  A negative judgment is not itself an error. This does NOT show that the live
  Chair/Vase response supplied any of these values or judged object type correctly.
- All six matched/different descriptor contradictions, duplicate descriptors,
  incompatible-type matches, same-type plus `different object type`, nonempty
  matches for `none`, empty matches for non-`none`, and single-feature `strong`
  remain rejected. More than six differences remains rejected locally.
  No validation was softened and no provider implementation bug was proven.
- Provider-facing JSON Schema supplies required fields/types/closed enums and
  forbids extra keys; cross-field consistency remains a local validator rule.
  The structured-output transform intentionally omits `maxItems`; the original
  Zod schema still enforces six locally. The prompt explicitly gives the
  incompatible/uncertain tuple, insufficient-detail option and strong minimum,
  but does not spell out every local rule (e.g. uniqueness or mutually exclusive
  similar/different descriptors). This is an instruction-completeness observation,
  not evidence that it caused the live failure. No unversioned prompt change.
- Malformed JSON, wrong JSON types, unknown descriptors/fields, semantic
  contradictions, a reported model error and a returned-route mismatch can all
  become `invalid_response`. Parse/schema/semantic failures deliberately collapse
  to `Model output failed validation` with no raw cause. Reported incomplete
  output becomes `incomplete_response`; refusal becomes `content_rejected`.
  Identical synthetic usage of 2088 input/78 output tokens accompanies both valid
  and invalid outputs in tests: usage metadata cannot identify the failing rule
  or prove truncation. All mock adapter cases dispatch once even with caller
  `maxRetries:1`; unknown-cost accounting remains unknown, not zero.
- Confirmed harness-only reporting defect: private
  `run/comparison-diagnostic-v2.mts:106` reads `error.code`, while
  `packages/providers/src/errors.ts` exposes `ProviderError.kind`, not `code`.
  This explains the caller's `unclassified` projection, NOT the durable
  `invalid_response`. There is no need to change the provider error contract.
  Tests prove typed failures expose `.kind`, have no `.code`, and that safe
  projections/attempt events/ledger state need not include response content.

For a separately authorized future harness revision, use the exported type guard
and only the typed finite classification; do not serialize arbitrary errors,
messages, causes, response bodies or unknown `.code` values:

```ts
import { isProviderError } from '@culture-atlas/providers';
const safe = { error_kind: isProviderError(error) ? error.kind : 'unclassified' };
```

This recommendation is not a harness edit or authorization to rerun the pairs.
Do not overwrite v1/v2 records or reconstruct a purported raw response.

### Unknowns and next checks

The actual semantic cause of the retained Chair/Vase failure is unrecoverable
from the supplied records: raw output was not retained and content logging was
off. The two weak Vase/Vase completions and the failed negative check remain
exactly as recorded; none is human visual-quality or qualification evidence.
No schema change, favorable retry or full24 wave is justified by these tests.
If a future diagnostic is separately authorized, fix the safe caller projection
first and retain only policy-approved finite validation-stage/reason codes
(JSON/shape/local semantic/route/outcome), not content. Such instrumentation is
not implemented here and cannot retrospectively explain pair03.

### Focused checks

- New `packages/providers/src/visual-similarity/diagnostics.test.ts`: **30 passed**.
- Visual suites combined: **72 passed, 2 files**.
- All offline provider suites: **628 passed, 38 files**.
- Used existing `/tmp/ca-visual-vitest.config.mjs` (clears live credential variables,
  no root database setup; excludes postgres, inference-attempts and Qloo rate-gate
  DB suites). Mock transports and fresh isolated MemorySpendStore instances only.
- Provider TypeScript, focused ESLint and owned whitespace checks: passed.
- An initial new-test TypeScript union-narrowing error was corrected with
  `'text' in body`; no product behavior changed.

## Public seam

`ProviderRegistry.visualSimilarity` and `ModelGateway.visualSimilarity` implement
the fixed `VisualSimilarityProvider` contract. Public exports include request,
result, normalized region types, schema/version constants, unavailable adapter,
Concentrate adapter and contact-sheet builder. `bindModelIdentity` binds the new
operation as `vision_similarity` without overwriting explicit server identity.
Default and rollback registries are unavailable, with no verifier/fallback reuse.
Capability name is `vlm.visual_similarity`; per-role readiness includes the new role.

## Exact profile / dispatch requirements

- Role: `vision_similarity`.
- Prompt: `visual-similarity-v3` (v1/v2 retained only as historical evidence above).
- Schema: `atlas_visual_similarity_v1`.
- Independent profile version and qualification artifact ID must be supplied by
  the operator. No real profile or artifact was created or changed.
- Existing profile cardinality remains **one image**, including this role.
- Contact-sheet profile minimum: maxDimension >=512, maxPixels >=139264,
  maxBytes >=4096. The actual sheet must retain at least 512x272 after bounding.
  Normal full sheet is 1024x544; actual bounds never exceed profile limits.
- Existing exact provider/model pin, no allowed fallbacks, structured output,
  requireZdr=true, providerZdrEligible=true, contentLoggingEnabled=false,
  real privacyVerifiedAt and pricingSnapshotVersion remain mandatory.
- Additionally checks the exact catalog timestamp/model/provider, a listed ZDR
  route, non-future privacy verification, and finite nonnegative base-tier
  input/output prices with positive units. Missing data fails closed.
- Reservation is max(profile reservation, catalog-computed input/image/output
  worst case), with a new conservative hard ceiling of 100000 micro-USD ($0.10)
  per comparison. This does not increase any global/account/unknown-spend limit.
- Output cap is 600 tokens. Existing durable ledger, experimental bucket,
  request allowance, pauses, role circuits and route identity checks all apply.
  MemorySpendStore requires the explicit test-only switch, never inferred env.
- Explicit `ANALYSIS_EXPERIMENTAL_ROLES=vision_similarity` may admit an otherwise
  catalog-compatible profile through the existing operator policy, always
  experimental. Production/demo privacy policy is not relaxed.

## Honest qualification limitation

No independent frozen visual-pair evaluation set/scorer was supplied. The runtime
therefore deliberately refuses to qualify this role from ANY existing artifact:
`evalGateFailure('vision_similarity', ...)` returns
`visual_pair_evaluation_not_bound`. The minimum future live fixture count is 10
pairs, but that count alone does not qualify it. Binding a genuine independently
scored pair evaluation (including negative/incompatible/uncertain cases), exact
prompt/schema/profile hash, and its own artifact is required before qualified
production access can be enabled. This is a conservative implementation gap,
not a claimed qualification. Do not reuse a photo/verifier/style artifact ID.

The qualification CLI refuses paid visual qualification until that evaluator is
bound. It supports this deterministic, zero-request check instead:

`pnpm exec tsx scripts/qualify-concentrate.ts --role vision_similarity --self-test`

It prints SYNTHETIC OFFLINE CONTRACT CHECK ONLY, requires no key/output directory,
and writes no artifact. `--confirm-paid-requests` is refused for this task.
The coordinator can separately run an explicitly permitted experimental trial
through the registry after real cumulative-budget/privacy/pricing preflight.
Never copy synthetic unit-test metadata into a real profile.

## Image and output safety

Only JPEG/PNG/WebP single-page raster input is admitted, <=16 MiB and <=20 million
decoded pixels per image. Strict decoding rejects corrupt/vector/animated input.
Normalized source coordinates refer to the auto-oriented image; invalid,
out-of-bounds, non-finite and sub-two-pixel crops are rejected. Original bytes,
decoded whole-image echoes and exact decoded source-crop echoes are rejected.
This is not a near-duplicate/perceptual-authentication detector.

Fixed bitmap SOURCE/CANDIDATE headers (no host fonts, SVG, user overlays or remote
resources) label left source crop / right full candidate. Sharp strips metadata,
flattens transparency and creates one bounded JPEG. Repeated fixed inputs produce
the same sheet in the tested Sharp/libvips runtime; cross-library-version byte
identity is not claimed.

Source/candidate original-byte hashes, final sheet hash and region are computed
server-side. Mutable caller bytes/region/labels/identity are snapshotted. Stable
idempotency binds source/candidate/sheet hashes, region, labels, exact profile hash
and logical attempt key; ledger scopes it to account/job/role. Duplicate attempts
do not dispatch twice. No automatic retries, including favorable retries.

Only the contact sheet and escaped, bounded untrusted labels reach the model.
The independent prompt prohibits following image/text/metadata instructions,
protected-trait inference, makers/dates/provenance/authentication/chemistry and
ownership/availability/value claims. No model strings become IDs, URLs or paths.
Matched features/differences use a CLOSED visible-appearance descriptor vocabulary
(max six each), not free prose. Strict schema rejects unknown fields, duplicates,
contradictions and incompatible-type matches. All result identity/provenance
metadata is server-bound, never model-selected. Similarity is not calibrated truth.

Cancellation/deadline checks run before and after bounded native preparation,
and the runner receives only the remaining deadline. Native Sharp preparation
is bounded but not interruptible mid-operation. In-flight cancellation/timeouts
retain unknown-cost reservations; late results do not publish.

## Validation

- All offline provider tests: **37 files, 598 tests passed**.
- Dedicated new visual suite: **42 tests passed**.
- Provider TypeScript: passed.
- `tsc -p tsconfig.scripts.json --noEmit`: passed.
- Focused ESLint and owned `git diff --check`: passed.
- CLI deterministic offline self-test: passed; no artifact/qualification claimed.
- Used `/tmp/ca-visual-vitest.config.mjs`, which clears live credentials and omits
  root DB global setup. Excluded DB suites: model-gateway/postgres,
  model-gateway/inference-attempts, qloo/rate-gate. All new spend tests use fresh
  MemorySpendStore instances. No shared test ledger or database was touched.
- Full repository suite, production/browser/native behavior and any live
  comparison/qualification remain coordinator-owned and were not claimed here.
- Domain worker's migration 210 independently includes both ledger role CHECKs;
  provider migration-role compatibility test passed. I did not edit migrations.

## Files changed in this track

All paths below are absolute; pre-existing provider Qloo/style diffs are NOT mine.

- /Users/vontariusfalls/culture-atlas-worktrees/factory6-integration/packages/providers/src/capabilities.ts
- /Users/vontariusfalls/culture-atlas-worktrees/factory6-integration/packages/providers/src/index.ts
- /Users/vontariusfalls/culture-atlas-worktrees/factory6-integration/packages/providers/src/registry.ts
- /Users/vontariusfalls/culture-atlas-worktrees/factory6-integration/packages/providers/src/concentrate/gateway.ts
- /Users/vontariusfalls/culture-atlas-worktrees/factory6-integration/packages/providers/src/concentrate/profiles.ts
- /Users/vontariusfalls/culture-atlas-worktrees/factory6-integration/packages/providers/src/concentrate/providers.ts
- /Users/vontariusfalls/culture-atlas-worktrees/factory6-integration/packages/providers/src/concentrate/profiles.test.ts
- /Users/vontariusfalls/culture-atlas-worktrees/factory6-integration/packages/providers/src/concentrate/qualification.test.ts
- /Users/vontariusfalls/culture-atlas-worktrees/factory6-integration/packages/providers/src/model-gateway/types.ts
- /Users/vontariusfalls/culture-atlas-worktrees/factory6-integration/packages/providers/src/model-gateway/identity.ts
- /Users/vontariusfalls/culture-atlas-worktrees/factory6-integration/packages/providers/src/testing/index.ts
- /Users/vontariusfalls/culture-atlas-worktrees/factory6-integration/packages/providers/src/testing/visual-similarity.ts (new)
- /Users/vontariusfalls/culture-atlas-worktrees/factory6-integration/packages/providers/src/visual-similarity/types.ts (new)
- /Users/vontariusfalls/culture-atlas-worktrees/factory6-integration/packages/providers/src/visual-similarity/schema.ts (new)
- /Users/vontariusfalls/culture-atlas-worktrees/factory6-integration/packages/providers/src/visual-similarity/contact-sheet.ts (new)
- /Users/vontariusfalls/culture-atlas-worktrees/factory6-integration/packages/providers/src/visual-similarity/provider.ts (new)
- /Users/vontariusfalls/culture-atlas-worktrees/factory6-integration/packages/providers/src/visual-similarity/visual-similarity.test.ts (new)
- /Users/vontariusfalls/culture-atlas-worktrees/factory6-integration/scripts/qualify-concentrate.ts
- /Users/vontariusfalls/culture-atlas-worktrees/factory6-integration/prp/2026-10-23-style-analysis/hybrid-provider.md (this handoff)
