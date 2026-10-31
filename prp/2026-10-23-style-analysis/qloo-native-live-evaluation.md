# Qloo-native discovery: bounded live improvement checks (iter9–iter11)

2026-10-26. Evaluates the Qloo-native implementation
([`qloo-native-implementation.md`](qloo-native-implementation.md)) against
the pre-existing evidence-method baseline (`iter8method` / `iter8transfer`)
under [`evidence-method-evaluation.md`](evidence-method-evaluation.md)'s
protocol: the same 16 tuning photos and the same 8 existing golden-transfer
photos (not a fresh holdout), two independent judges per round, randomized
paired A/B variants, all 24 source images opened, reasons/tags/proofs/
latency/variant identity hidden, no candidate-image similarity claims.
Gates: mean style 7.5, mean relevance 7.0, first readable 5 s, complete
30 s. Private artifacts live under the run scratchpad
(`style/r3run/eval-qloo-native-v{1,2}.json` manifests, judged outputs,
operational metrics); raw provider rows stay out of the repository.

## Round 1 (iter9, manifest `qloo-native-improvement-v1`, source hash 8c4c5e0d…): FAILED

| split | baseline style | candidate style | baseline relevance | candidate relevance | mean useful cards (baseline → candidate) |
| --- | --- | --- | --- | --- | --- |
| tuning | 8.45 | 8.59 | 5.02 | **4.30** | 69.5/110 → 94/214 |
| transfer | 8.31 | **6.59** | 1.78 | **2.78** | 12.5/33 → 31/65 |

Both splits failed the relevance gate; transfer also failed style. Extra
cards raised the useful count but diluted relevance with generic pop/film
taste filler, scope-only commercial brands, a home rail admitting a
Qloo record whose tags say furniture but whose name is an automotive
brand, modern furniture for a period room, glassware for artifact
ceramics, and anchor echoes. Separately, a reproducible guard fault was
found: the person-safety guard dropped an entire terracotta face-vessel
reading because facial-form words in an explicit art object tripped the
person detector (`G-STYLE-PERSON`).

## Corrective changes (all in this working tree, tested before round 2)

- **guard-v20** (`packages/providers/src/vlm/style.ts`): an explicitly
  qualified figurative art object (sculpture/statue/figurine/effigy/carving/
  painting/illustration, or vessel/mask/bust/head plus a material) may keep
  modeled facial-form observations; identity, age, skin, hair, role and
  expression claims are still removed, and the remaining text must still
  pass the unchanged person detector. 9 focused cases plus the existing
  44 guard cases.
- **Evidence-first selection** (`packages/domain/src/style/discovery-selection.ts`):
  candidate-specific evidence (shared design/topic/subculture, named title,
  catalogue facet, place) always ranks ahead of `qloo_taste` and
  `brand_exploration`. More-like-this rails admit at most 4 exploratory
  cards of 8; cross-domain at most 1 of 3; stage-2 appends add none.
  Exploratory candidates can no longer become bridges for another taste hop.
- **Publication fence re-checked inside the transaction** in both rail
  publishers and cross-domain composition (a style rail and a category
  could otherwise double-publish one candidate); section status now
  reflects rows actually inserted.
- Compiler cache version advanced to `compiler-2026-10-26-qloo-native-v2`.
- The Moroso-type mismatch is a Qloo catalogue data conflict (furniture
  industry tags on an automotive-named entity), documented; no name
  blacklist was added.

## Round 2 (iter10, manifest `qloo-native-improvement-v2`, source hash 6200e528…): FAILED relevance, style gates pass

Fresh judges re-scored both variants of all 24 photos; iter9 scores were
not reused. One tuning photo's style call returned an invalid model
response and was retained with no style reading and no cards (no favorable
retry). Judges nevertheless assigned mean style 4 to that capture. This
deviates from the missing-reading scoring instruction; the original scores
are retained, not silently rewritten.

| split | baseline style | candidate style | baseline relevance | candidate relevance | mean useful cards (baseline → candidate) |
| --- | --- | --- | --- | --- | --- |
| tuning | 8.69 | 8.25 | 4.88 | **4.53** | 69.5/110 → 84/131 |
| transfer | 7.94 | 8.00 | 1.88 | **3.13** | 13/33 → 29.5/48 |

Gates: style passes both splits; relevance fails both (target 7.0).
Relevance improved on transfer (+1.25) and slightly regressed on tuning
(−0.34), so the both-splits improvement criterion also fails. Versus the
iter9 candidate (different judges; descriptive only), transfer style
recovered 6.59 → 8.00 and transfer relevance 2.78 → 3.13; tuning
relevance 4.30 → 4.53.

What the fixes visibly did: the face-vessel photo now publishes a guarded,
identity-free reading ("Terracotta face vessel fragment", archaic
hand-modeled) with an honest empty rail instead of no reading at all; the
marble statue no longer publishes eight generic blockbuster films;
exploratory cards are capped (rails show at most 4 taste/scope cards);
status-empty-with-rows retrieval anomalies went 23 → 0. What remains weak,
per both judges: sparse honest empties still score zero on relevance;
fashion rails are solid while interior/art photos still attract mid-market
catalogue filler or nothing; cross-domain artist/film picks remain uneven;
and one stochastic model failure is indistinguishable from a quality
regression at this sample size.

## Budget and operations

| round | reservations added | ledger after | Qloo calls | latency gates |
| --- | --- | --- | --- | --- |
| iter9 | $1.840552 | $12.284171 | within 400 cap | 24/24 ≤ 30 s; 23/24 first readable ≤ 5 s |
| iter10 | $1.787852 | $14.072023 | 135 | 24/24 ≤ 30 s; 24/24 first readable ≤ 5 s |

Unknown-cost reservations are conservative bookkeeping, not settled spend;
the ledger was not reconciled against model billing. The $15 aggregate
ceiling held with $0.93 of reservation headroom remaining. Per-capture
conservative headroom for iter10 was set to 95,000 micro-USD from iter9's
largest observed reservation (88,798) plus ~7%, not a retry-inclusive
worst-case bound. The gateway's hard spend ceiling is independent.

## Validation of the corrective tree

Full `pnpm test` 2,060/2,060 (203 files); `pnpm typecheck`, `pnpm lint`
and `pnpm build` pass. Browser journeys `e2e/style.spec.ts`: 42/42 across
desktop/mobile/minimum (the first post-restart desktop run had six navigation
timeouts; cold compilation was suspected, not established. The warm
re-run passed 14/14, and
mobile/minimum had already passed 28/28). Android JVM (20) and iOS
focused suites (23 + 5 contract) passed in the earlier round and the
corrective changes do not touch those platforms' code.

## Limitations

Existing tuning/transfer images, not fresh qualification. Stochastic model
readings and live provider results confound causal attribution. Judges saw
no candidate images; usefulness is semantic. Two different judge pairs
across rounds means cross-round score comparisons are descriptive only.
All failures, empty outputs and the invalid-response capture are retained
in the frozen manifests; no favorable subsetting or retries were applied.

## Round 3 (iter11): FAIL relevance and latency

The $20 cumulative extension, guarded-subject readiness/topic fixes, and
bounded scoring/retrieval experiments are documented in
[`relevance-experiments-v3.md`](relevance-experiments-v3.md). The scoring
model and documentary-keyword route were not deployed as admission logic.

| Split | Baseline style | Candidate style | Baseline relevance | Candidate relevance | Mean useful cards |
| --- | --- | --- | --- | --- | --- |
| Tuning | 8.80 | 8.80 | 5.34 | **5.84** | 69.5/110 → 96/155 |
| Existing transfer | 8.50 | 8.44 | 1.91 | **3.41** | 13.5/33 → 20/40 |

Fresh independent judges opened all 24 images and validated all 48 paired
rows each. Both style gates pass, both relevance gates fail. Paired
descriptive relevance improves on both splits (+0.5, +1.5), still below
7.0. Tuning empties fell to zero; transfer retains two. Three captures
exceeded 30 s; two missed 5 s first readable. Cross-round scores use
different judges and are not causal evidence.

The capture run added $1.838552 in reservations and 152 Qloo request
records. The separate text-only scorer reserved $0.892800. Preserving all
prior attempts, cumulative reservations are **$16.803375 of $20**;
actual billing remains unreconciled. Queue empty, owned services stopped,
no publication or merge. Final v3 checks pass: 2,070 tests / 203 files,
typecheck, lint, build and diff whitespace. Earlier browser/native checks
were not rerun after these pipeline changes.
