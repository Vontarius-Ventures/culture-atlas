# Qloo-native implementation and validation

2026-10-26. Implements
[`qloo-native-discovery-plan.md`](qloo-native-discovery-plan.md).

## Delivered

- Explicit, validated GET filter/signal tag operators, identical HTTP/replay
  identity, and rejection of defined per-tag weights before network access.
  Capture callers now send deliberately unweighted tags. Documented optional
  metadata and explainability warnings survive normalization.
- Shared typed candidate proofs across early, MLT and cross-domain
  publication. Early entity calls prefetch only. Brand exploration, topic,
  named-title, place and attributable taste connections have distinct
  evidence requirements and reasons. Generic artist types do not imply
  music. Visual-style tags on sculpture/illustration do not establish movie
  topics, and artwork materials do not default to tableware shopping.
- Evidence-backed fallback when the optional style reader is off or fails.
  Proofs cite independently guarded/resolved references, with null style
  subject IDs. Exact candidate-owned tags support catalogue-facet wording,
  not visual or historical claims. A pending reader is not a fallback waiver.
- Entity-level titles and honest empty/experimental copy on server, web,
  iOS and Android, preserving public enums and wire keys. The web parser now
  honors the public 200-character reason limit instead of silently dropping
  valid reasons over 140 characters.
- Shared public projection for capture and item detail: proof-bearing Qloo
  connections do not expose photo attributes/palette as candidate-image
  matches. Existing legacy payloads remain readable.
- Bounded candidate evidence projections and separate retrieval/admission
  accounting. Standalone private offline audit with synthetic tests and
  optional complete-pool manual judgments; no raw provider fixtures.
- Default compiler cache version `compiler-2026-10-26-qloo-native`
  (advanced to `-v2`, then `-v3` by the corrective passes). Explicit deployment
  overrides must be advanced by the operator. No automatic rerun or VLM
  qualification-binding change.

## Post-freeze corrective pass (after the failed iter9 live check)

- guard-v20: an explicitly qualified figurative art object keeps modeled
  facial-form observations while identity, age, skin, hair, role and
  expression claims are still removed; the general person detector is
  unchanged (`packages/providers/src/vlm/style.ts`, 9 focused cases).
- Evidence-first selection (`style/discovery-selection.ts`): direct
  candidate evidence ranks ahead of `qloo_taste`/`brand_exploration`;
  More-like-this rails admit at most 4 exploratory cards of 8,
  cross-domain at most 1 of 3, stage-2 appends none; exploratory
  candidates no longer become style bridges.
- The cross-domain publication fence is re-checked inside the transaction
  and section status reflects rows actually inserted.
- Default compiler cache version advanced at this stage to
  `compiler-2026-10-26-qloo-native-v2`.

Both bounded live checks are recorded in
[`qloo-native-live-evaluation.md`](qloo-native-live-evaluation.md):
iter9 failed relevance on both splits and style on transfer; after these
fixes iter10 passes both style gates and improves transfer relevance
(+1.25) but still fails the relevance gate on both splits. The measured
relevance targets were not met.

## Subject-retrieval pass (v3)

Bounded subject readiness before the one-shot category pass, subject-based
movie topic queries, and sculpture/face-vessel classification fixes are
described in [`relevance-experiments-v3.md`](relevance-experiments-v3.md).
The default cache version is now `compiler-2026-10-26-qloo-native-v3`.
The text-only scoring and documentary-keyword probes are experiments,
not production admission logic or evidence of a relevance pass. The
completed iter11 check improved paired descriptive relevance on both
splits but still failed both relevance gates and the latency gates.
Final v3 checks pass: 2,070 tests / 203 files, typecheck, lint, build and
diff whitespace. The earlier browser/native checks were not rerun.

## Validation

| Check | Result |
| --- | --- |
| Full `pnpm test` | PASS, **2,060 tests / 203 files**, exit 0 (post-corrective) |
| Full `pnpm typecheck` | PASS, including scripts |
| Full `pnpm lint` | PASS, 0 errors; existing MusicView.tsx hook-dependency warning |
| `pnpm build` | PASS; existing sample-image dynamic-filesystem tracing warnings |
| Agent API generation consistency | PASS, 6 tests, also included in full suite |
| Android JVM style tests | PASS, 20 tests, existing JDK 17, offline |
| iOS build-for-testing / focused style tests | PASS, 23 tests; 5 server-contract tests rerun after fixture updates |
| Whitespace check | PASS |

The full suite emitted a trace-event foreign-key diagnostic in the
agent-media HTTP integration test, which passed. The earlier PostgreSQL
forced-drop teardown permission failure **did not recur in this run**.
No database privilege changes were made. Focused agent checks are subsets,
not additional tests to add to the full-suite total.

Not run: Android Compose tests, physical-device or visual QA. Playwright
journeys (`e2e/style.spec.ts`, 42/42 desktop/mobile/minimum) and two
bounded paid live checks ran after this table; see the live-evaluation
report.

Main validation logs are private:
`/tmp/culture-atlas-qloo-native-final-{test,typecheck,lint}.log` and
`/tmp/culture-atlas-qloo-native-build.log`.

## Recorded coverage is not relevance qualification

The new audit reproduces the existing 24-capture pools:
1,681 entity occurrences, 800 distinct IDs, 362 tag rows and 137 Qloo
publication rows. All published IDs reconcile to their recorded pools.
Twenty-three query records marked empty retain nonempty results.
The older iter7 artifacts have 103 missing result arrays, correctly
reported as unknown rather than zero.

Candidate image roles remain unknown. Reduced historical recordings cannot
establish upstream description/image absence. Withheld candidates remain
unjudged; useful coverage and yield metrics are `not_evaluated`.

Three paid live checks subsequently ran; the latest completed results are
the failed iter11 relevance and latency gates in
[`qloo-native-live-evaluation.md`](qloo-native-live-evaluation.md).
Reservations and failed captures were preserved. This change aligns implementation and promises
with Qloo's supported entity-level behavior; it does not establish product
readiness. Books/visual-artist surfaces, verified artwork/product matching,
and new provider endpoints remain outside this slice.

Changes remain local, uncommitted and unpushed. No external publication or
merge was performed; PR #7 remains open and unmerged.
