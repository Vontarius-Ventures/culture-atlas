# Recommendation logic repair, v4

2026-10-26. Implementation plan following the read-only iter11 audit.
Local work only. No new paid evaluation, provider, model switch, or publication.
Preserve historical results, the cumulative $20 allowance, and acceptance targets.

## Plan

1. Classify artwork by explicit art forms, preserving compound-word boundaries.
   Four-poster beds and painted functional objects must remain functional objects.
   Head/face vessels remain artifacts, not shopping intent.
2. Preserve the source phrase behind matching tokens. Home-brand matches must
   not confuse side chairs with side tables, chair backs with back-pain relief,
   or fine speckles with fine dining. Generic product nouns alone do not
   establish style. Apply the same evidence policy to catalogue seeds and cards.
3. Treat retrieval provenance as a necessary filter, never a waiver of relevance.
   Wire the existing home evidence filter into production ranking. Seed provenance
   must not attach an arbitrary aesthetic that did not select the seed.
4. Add synthetic unit and worker regressions, including valid-match controls.
   Audit frozen iter11 inputs offline without replaying network calls or claiming
   a new end-to-end relevance score. Invalidate compiler caches for changed logic.
5. Run focused tests, then appropriate broader tests, type checking, and lint.
   Record outcomes and remaining limits.

## Evaluation limits

The historical 5.84375 and 3.40625 scores are means of subjective AI judgments,
not Qloo confidence or human ratings. Two judge sessions rated 16 tuning and
8 reused transfer photos. Candidate images and underlying evidence were hidden.
The judge model was not recorded. These photos are not a fresh holdout.

Keep reading accuracy, retrieval coverage, per-card usefulness, unsupported
claims, and abstention separate in future evaluations. Anchor any new subjective
rubric with human-reviewed examples. Removing bad recommendations may increase
empty rails; fewer cards is not by itself evidence of improved usefulness.

## Validation and results

Implemented locally:

- Artwork detection now preserves hyphenated compounds, normalizes Unicode
  dashes, and recognizes spaced four-poster wording. A painted finish alone is
  not an art form. Explicit portraits, sculptures, and head/face vessels remain
  artwork. Functional vessels and furniture keep their own routes.
- Matching tokens retain the actual source phrase, including defining features.
  Home evidence checks compound boundaries and ambiguous relational words in
  that phrase. Invalid high-weight tag matches cannot hide a valid alternative
  tag. Generic home-product nouns alone do not qualify a style match.
- Catalogue seed selection and home-card ranking use the same evidence policy.
  Existing minimum card-score and relative-ranking thresholds are unchanged;
  catalogue seeds still need a positive score rather than the card threshold.
- `rankAffinity` treats admission as a required filter before reference-score
  computation, not a waiver of relevance. `buildHomeRail` now actually calls
  `homeRailCarry`. Fashion rails also lose the provenance/relevance bypass.
- Seed records identify the subject that selected them, without attaching the
  first aesthetic or material regardless of the actual match.
- Default cache version is `compiler-2026-10-26-qloo-native-v4`.
  Explicit deployment overrides still require an operator update.

### Frozen-input audit

`scripts/style/relevance-logic-audit.ts` reads the existing iter11 artifacts.
It imports only local logic, makes no provider calls, fingerprints input files,
fails on missing/truncated candidate tags, and refuses to overwrite outputs.
Use absolute paths and a new output filename:

```sh
pnpm exec tsx scripts/style/relevance-logic-audit.ts \
  --manifest /absolute/path/eval-qloo-native-v3.json \
  --out /absolute/path/new-audit.json
```

Final local artifact: `relevance-logic-audit-v4-final.json`.

- All 24 photos retained.
- 14 recorded home-brand pools, 247 retrieved candidates.
- 67 previously published home cards; only 3 still qualify under these checks.
- Seed choices differ in 8 of 14 pools.
- The recorded canopy bed is no longer classified as artwork.
- The secondary side chair now has no qualifying catalogue seeds, rather than
  Burrow/EVA/Joybird selected through generic side/chair overlap.

This is **not a new relevance score or an end-to-end result**. Changed seeds
would retrieve different candidates. The audit does not apply final publication
selection, verify candidate images, or measure latency. It must not be described
as proving the other 64 cards are useless: it demonstrates that those cards do
not clear this stricter metadata policy. Many recorded pools become empty.

### Checks

- New unit regressions first reproduced 9 failures against the old logic.
- Focused compiler/audit checks pass, including functional-object publication,
  weak-card rejection, label-only seed attribution, and valid-match controls.
- Full repository type checking passes.
- Lint passes with the existing MusicView hook warning.
- Workspace build passes with two existing dynamic-filesystem tracing warnings
  in `services/captures.ts`.
- A full run passed all 2,088 test assertions but exited nonzero during the
  migration reconciliation suite's database cleanup: PostgreSQL denied
  terminating a process. No privileges or unrelated processes were changed.
  The complete rerun, `pnpm test --maxWorkers=4`, passed all 2,088 tests across
  204 files and exited zero. The earlier cleanup failure remains recorded here.
- No new paid calls, live evaluation, browser/mobile validation, commits, push,
  or deployment.

## Remaining work

Do not promote v4 as a demonstrated overall recommendation improvement.
The restored checks reveal a serious coverage trade-off, not a solved product.
Subject-specific retrieval and verified candidate content are the next track:

1. Avoid broad architecture routing for craft artifacts; distinguish the depicted
   object from the enclosing interior category.
2. Use recorded, supported form/material/style constraints when choosing seeds
   and requests. Do not backfill a missing signal with generic product overlap.
3. Explore documentary content using genuine returned descriptions and exact
   supporting excerpts, rather than accepting incidental keywords as proof.
4. Keep direct connections, taste exploration, abstention, and coverage separate.
   Human-reviewed examples must anchor the next usefulness evaluation.

General phrase semantics are not solved by the bounded relational-word guard.
Broad material adjacency (for example ceramics) is not proof of speckled
stoneware, a current matching product, or shared visual appearance.
