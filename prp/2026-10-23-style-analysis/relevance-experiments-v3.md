# Relevance experiments under the cumulative $20 allowance

2026-10-26. All work remains local. No pass target or photo denominator was
changed. Earlier failed checks remain in
[`qloo-native-live-evaluation.md`](qloo-native-live-evaluation.md).

## Hypotheses and findings

1. **Fix retrieval before ranking.** The iter10 transfer split contains
   three photos with no suggestions. With those unchanged, even perfect
   relevance 10 on the other five gives only 6.25, below the 7.0 gate.
   A new reranker alone cannot fix that coverage limit.
2. **Subject-based topics.** The old planner mostly searches style
   adjectives; fine art always searches painting/portrait, even for
   sculpture. The new movie planner uses bounded observed-subject topics,
   including pottery for terracotta, sculpture for a statue, architecture
   for a building, and furniture/interior design for a bed. It sends at
   most two queries. Tags must still be real, target-compatible, and
   supported by the active subject. No cultural origin is inferred.
3. **Wait for the guarded subject.** The one-shot category pass could run
   while its subject reader remained pending, then return
   `subject_not_ready` without trying again. A new bounded readiness wait
   precedes that pass. First-readable output remains progressive; both
   this wait and the bridge wait respect the soft deadline.
4. **Keep form classification consistent.** Face vessels remain artworks
   rather than shopping opportunities. Actual sculpture theme/genre tags
   can establish art adjacency; sculpture plot keywords still cannot.

These code changes use compiler cache version
`compiler-2026-10-26-qloo-native-v3`. Explicit overrides need an operator
update. They do not change VLM qualification bindings.

## Recorded-pool scoring experiment

Frozen iter10 metadata: all 24 photos, 1,442 distinct-within-photo
candidates, including empty pools and the missing reading. Candidate
metadata was grouped without inventing tags; demographic and identity
fields were excluded. No source or candidate images were sent.

The existing Concentrate route ran an explicitly **unqualified text-only
experiment** with a separate prompt/schema/profile version, durable
attempt ledger, no retries, existing privacy assertions, and no provider
fallback. This is not Jev and does not establish model calibration.

- 279 calls, 277 valid responses, two invalid responses retained.
- 1,439 candidates scored; three unscored after the failed calls.
- 141 model scores at least 7. These are model predictions, **not human
  relevance judgments**, admission proofs, or a product pass.
- Maximum reservations: $0.892800, charged inside the existing cumulative
  ledger. Actual billed costs remain unreconciled.

The diagnostic assigns no high-scoring candidates to several existing
interior/art pools. It also favors some broad culinary/architecture films.
That is not sufficient evidence to deploy it as a production admission
gate or claim a measured ranking improvement. It was not deployed.

## Bounded Qloo probes

Private artifacts: `subject-topics-probe-v{1,2,3}.json` and
`documentary-probe-v1.json`, with pre-dispatch manifests.

- Probe v1 had a harness error calling a nonexistent method: zero HTTP
  attempts. Its failed output is retained, not treated as empty-provider
  evidence. v2 used the real `lookupTags` method.
- Six existing failure inputs were probed. The architecture query returned
  a supported Architecture subgenre and eight admissible films. Pottery,
  ceramics, sculpture, furniture and illustrated-cafe searches did not
  resolve admissible movie topics under the current evidence contract.
- A separate namespace-scoped search surfaced real movie keywords for
  sculpture, museum, coffee and interior design. Keywords alone were
  still rejected where they did not establish the subject's topic.
- Intersecting actual sculpture/coffee keywords with a real documentary
  genre retrieved useful possibilities, including sculpture biographies
  and coffee-craft documentaries. It also retrieved incidental matches,
  such as a coffee-related murder documentary and a rock documentary with
  a sculpture subplot. Documentary plus keyword is therefore not a
  publication waiver. This route was not deployed.

The next defensible experiment is candidate-content verification using
real provider descriptions and exact supporting excerpts, not a lower
confidence threshold or a fabricated taxonomy. Books, visual-artist
surfaces and a new provider still require their own verified contracts.

## Jev

TypeSafe AI describes Jev as a structured-decision System One model:
[introduction](https://docs.typesafe.ai/introduction),
[announcement](https://typesafe.ai/blog/introducing-system-one-models-and-jev).
That makes candidate scoring/routing a plausible experiment, not a
replacement for the photo reader or evidence requirements. Vendor speed,
price and confidence claims are not validated accuracy on this task.

No Jev credential is configured. No photos or metadata were sent to Jev,
and no new provider was integrated. Access and privacy/retention checks
must precede any such experiment.

## Validation and final check

Before the v3 freeze: `pnpm test` passed **2,070 tests / 203 files**;
typecheck, lint and build passed. Lint retains the existing MusicView hook
dependency warning. One earlier focused run passed all tests but failed
PostgreSQL forced-drop teardown permissions; the complete final run
passed without changing database privileges.

The v3 manifest freezes the same 16 tuning and eight existing transfer
photos, not a fresh holdout, against iter8method/iter8transfer. It retains
the original style 7.5, relevance 7.0, first-readable 5 s and complete
30 s gates. No diagnostic result above substitutes for those judgments.

### Completed capture run (iter11)

All 24 captures completed once, with no favorable retries.

| Metric | Tuning, 16 | Existing transfer, 8 |
| --- | --- | --- |
| Style section ready | 16 | 8 |
| Published cards | 155 | 40 |
| Photos with no suggestions | 0 | 2 |
| More-like-this coverage | 12 | 6 |
| Cross-domain coverage | 13 | 1 |
| First readable within 5 s | 14 | 8 |
| Complete within 30 s | 15 | 6 |
| Complete median / maximum | 21.425 / 36.692 s | 19.919 / 38.527 s |

Compared with iter10, empty tuning photos fell from three to zero;
transfer empties fell from three to two. The sculpture and face-vessel
transfer photos remain empty. These are coverage observations, not
semantic usefulness scores or causal proof.

The latency gates **failed**: three captures exceeded 30 s and two missed
the 5 s first-readable target. No non-fashion Wear cards or raw-result
status-empty anomalies were observed.

The run added $1.838552 in reservations and 152 Qloo request records.
Including the $0.892800 scoring experiment and all prior attempts, the
preserved cumulative ledger is **$16.803375**, leaving **$3.196625** under
the authorized $20 ceiling. There are 1,228 unknown-cost attempt rows;
these are reservations, not settled billing. Standalone Qloo probes have
their own bounded manifests and are not included in the capture-run's
152 records.

The queue was empty after the run; gateway pause/circuits were unchanged.
Owned local web/worker processes were stopped. No external publication,
commit, push or PR merge occurred.

### Independent blinded judgments: FAIL

Both judges opened all 24 source images and assessed both randomized
variants, 48 unique rows and 338 cards per judge. Card counts and score
bounds were validated before decoding assignments. No candidate images,
network/model API calls, prior scores or assignment keys were available
to the judges.

| Split | Baseline style | Candidate style | Baseline relevance | Candidate relevance | Mean useful cards |
| --- | --- | --- | --- | --- | --- |
| Tuning | 8.796875 | 8.796875 | 5.34375 | **5.84375** | 69.5/110 → 96/155 |
| Existing transfer | 8.5 | 8.4375 | 1.90625 | **3.40625** | 13.5/33 → 20/40 |

Style passes both 7.5 gates. Relevance fails both 7.0 gates.
Paired descriptive relevance improves by +0.5 on tuning and +1.5 on
transfer, but that is not a target pass, causal claim or fresh holdout
qualification. Each row averages the two judges; useful-card counts are
also averaged, not independent additional cards. Prior rounds used
different judges, so cross-round score comparisons are descriptive only.

Both judges identify generic contemporary furniture replacing period
forms, tableware replacing artifact ceramics, and loosely related
music/films as recurring weaknesses. The two empty transfer photos score
zero relevance. Accurate subject readings do not make those suggestions
useful. Unknown brands and inventory remain unverified, not imagined.

The evaluated runtime was checked against the frozen manifest:
70 non-Markdown files matched, with no drift. Frozen source hash:
`6e75de0b5987d0eba09bb1984d759daad6555789b4a558072ae43e42b51ffe2c`.
Only outcome documentation changed after freezing. The private manifests,
all capture artifacts, original judgments and assignment key are retained.

Final `git diff --check` passed. No new Playwright or native runs followed
the v3 pipeline changes; the earlier platform checks remain historical,
not newly rerun validation.

**Outcome:** the experiments and all-24 check are complete, but relevance
and latency requirements remain unmet. The remaining $3.196625 was not
spent on favorable retries or a claim of success. The next useful change
needs stronger candidate content evidence and retrieval coverage, not
merely a different ranking model.
