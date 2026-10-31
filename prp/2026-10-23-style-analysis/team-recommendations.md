# Bounded recommendation-coverage recovery

## Trace-grounded causes

Artifact root: `/private/tmp/claude-501/-Users-vontariusfalls/393049b5-02c6-422c-abfa-f13922b6f047/scratchpad/style/r3run`.

- `iter13transfer/h19-craft-ceramic-head.json`: stored subject is **other / Terracotta head figurine**, not media. Its More-like-this rail was `unsupported`; Watch ended `skipped / no_anchors`. The only style-tag lookup was `portrait`, not sculpture/Documentary. The documentary planner excluded `other` before considering its explicit art form, and its sculpture forms also omitted `figurine`.
- `iter13transfer/h60-art-marble-statue.json`: stored subject is **other / Marble figure sculpture**. More-like-this was `unsupported`; Watch was `skipped / no_anchors`; there were no documentary or movie-insights queries. This was a planning exclusion, not rejection of the known sculpture positives.
- `iter13native/03-interior-modern-room.json`, `iter13native/h56-interior-wood-panelled-bedroom.json`, and `iter13transfer/h18-interior-kitchen.json`: labels **Sunroom dining nook**, **Abandoned motel bedroom**, **Galley kitchen** were missed by the documentary architecture source regex (`rooms?` does not match `bedroom`). These took the broad Design/Architecture union route instead. The kitchen's 20 commercial results were all evidence-gated; those commercial gates remain unchanged.
- Separate verified compiler defect: a documentary-only fill used no primary request. If every returned film failed admission, the final `!entities.length && !request` branch discarded the fill/query trace and mislabeled the result `no_anchors`. It now preserves the actual query and publishes an honest empty section.

## Changes

- `packages/domain/src/style/content-evidence.ts`: allow only explicit sculptural forms in an `other` subject's **label** to plan sculpture documentaries; add figurines; recognize the compound room nouns above. An unclassified clay object, sculptural lamp, ceramic mug, human head, or stone wall still cannot use this route. Fashion remains excluded. No taxonomy/category rewriting.
- `packages/domain/src/compiler/style-stage.ts`: documentary lookups use the actual genre/subgenre/theme/keyword namespaces with bounded `take: 30`; scoped lookups cannot reuse differently scoped top-ten style cache entries. This is retrieval/cache hardening, not a claim that truncation caused the observed sculpture failures.
- `packages/domain/src/compiler/analyze.ts`: preserve documentary-only empty-admission outcomes and provider query IDs.
- `packages/domain/src/style/content-evidence.test.ts` and `apps/worker/src/discovery-evidence.test.ts`: positive/rejection coverage for real frozen category/label shapes, exact recorded Rivers and Tides / Michelangelo descriptions and IDs, recorded A Film About Coffee versus Ice Cold, compound rooms, contentless/incidental/crime films, wrong scope/type, and the honest empty outcome.

All documentary candidates still require returned movie typing, the actual requested topic tag, a documentary genre tag, and an exact candidate-owned content/process sentence. Commercial evidence/affinity thresholds, quotas, privileges, provenance rules, compiler version, and configuration are unchanged.

## Validation

- `pnpm test packages/domain/src/style/ apps/worker/src/discovery-evidence.test.ts apps/worker/src/style-analysis.test.ts --maxWorkers=1`: **20 files / 257 tests passed**.
- `pnpm --filter @culture-atlas/domain typecheck`: passed.
- Scoped ESLint (both compiler files, content evidence and its test, worker discovery evidence test): passed.
- Scoped tracked-file `git diff --check`: passed.
- Offline replay using actual stored iter13 subjects and actual `documentary-probe-v1.json` entities, without provider calls: both sculpture subjects now admit **7/20**, including Rivers and Tides, Michelangelo - Infinito, and Exhibition on Screen: Michelangelo Love and Death. The cafe subject admits **3/13** coffee results (Black Gold, Barista, A Film About Coffee), not Ice Cold. This validates admission eligibility, not final selection or live retrieval.

## Expected improvement and remaining limits

The two sculpture photos can now reach genuine recorded positives instead of stopping before retrieval. The three compound-room labels can use bounded, content-gated architecture retrieval; home-brand thresholds have not been weakened to fill empty rails.

No new live run was made and no relevance target is claimed. The existing Interior Design documentary probe returned zero movies, so the canopy-bed furniture route remains a catalogue limitation. Pottery/ceramics lookups were empty; ceramic mugs/displays remain limited. No fallback invents tags or broadens a material into sculpture. Weak commercial results remain rejected. Scoped cache misses can consume existing request budget, never raise it.

No paid calls, evaluation-database mutation, commits, pushes, deployments, config/version edits, or sibling-scope edits were performed. Coordinator follow-up: review/version this new iteration and, only if separately authorized and budgeted, rerun the frozen photos for actual retrieval/selection and relevance assessment.
