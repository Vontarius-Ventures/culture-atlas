# Cultural compilation pipeline

How a photo becomes discoveries. The behavior rules live in the [build spec](../specs/cultural-discovery-build-spec.md) ("Cultural compilation pipeline", "Qloo integration contract", "Recommendation and memory rules"); this page maps them to code.

## Intake (`packages/domain/src/services/captures.ts`, `media/image.ts`)

1. `normalizeImage` sniffs magic bytes (the declared type and filename are ignored), rejects payloads over `UPLOAD_MAX_BYTES` (413) and images over `UPLOAD_MAX_PIXELS` (checked from the header before decoding), applies EXIF orientation, strips all metadata (EXIF, GPS, XMP, ICC) and writes a JPEG derivative bounded to `IMAGE_MAX_EDGE` (2048 px). The sha256 is of the original bytes. JPEG, PNG and WebP are accepted. HEIC is attempted and otherwise gets conversion guidance; AVIF is rejected.
2. `createCapture` accepts multipart bytes, an owned `upload_id` (agents and the sensor bridge), or a `sample_id` ("Try an example": `samples/<id>.<ext>` in storage or `apps/web/public/samples/<id>.<ext>`). It computes `analysisDedupeKey(owner, sha256, focus, COMPILER_VERSION)`, so a duplicate submission returns the existing capture and job with `reused: true`; other owners never share. It consumes the daily analysis quota and creates the capture, its `kind=capture` DiscoveryItem and the `analyze_capture` job (budget `{qloo_requests, research_refs, provider_retries, deadline_ms}`) in one transaction. Sensor imports must come from the bridge token for that connection, are deduped by `(connection, asset_id)` in `sensor_imports`, and are verified against `declared_sha256`.
3. Private storage layout: `owners/<a|s>-<owner>/uploads/<upload>/derivative.jpg` and `owners/<a|s>-<owner>/captures/<capture>/{derivative.jpg,original}`. Originals are kept only with `STORE_ORIGINALS=true`.

## Compiler (`packages/domain/src/compiler/analyze.ts`)

Each stage runs through `ctx.runStage`, so a retried attempt (lost lease, crash, deadline) reads completed outputs back from `job_stages` instead of calling providers again. Publishing is idempotent and always goes through `publishForCapture`: `ctx.ensureActive()` and then a transaction holding the capture row lock (`SELECT ... FOR UPDATE` where `deleted_at IS NULL`). `deleteCapture` takes the same lock, so a delete either wins and nothing is published, or runs after and removes what was published.

| Stage | Public stage | What happens | Section(s) |
| --- | --- | --- | --- |
| observe | `observing` | VLM structured analysis of the derivative (focus, confirmed interests and rejected names passed as data). Title, interpretation, observations, visible text, candidates with evidence boxes, and a "What caught your eye?" question when there are 2-3 competing subjects. The first analysis becomes active immediately (progressive results). Corrections activate at the end. Unusable photos get `unclear_photo` guidance and stop. | `observations` |
| resolve | `resolving` | Up to 5 strongest candidates (amendment 2.2), at most 3 Qloo requests in flight: entity types go to `/search`, styles/traditions/cuisines to `/v2/tags`. A provider result counts as the same thing only on a close name match (0.75 for entities, 0.6 for tags). Matches become public `cultural_references` (`qloo:<id>` / `qloo_tag:<id>`). Unmatched candidates are kept as qualified references (`<type>:<slug>`). At most 5 anchors are chosen: user selections, then depicted, then certainty. A candidate that resolves to a reference the user rejected stays `rejected`. | `references` |
| recommend + compose | `recommending` | One `/v2/insights` call per category (wear = brands, play = artists, watch = films), with the anchors' real entity and tag ids and explainability on, in priority order from the anchors' suggested categories. Results are filtered (anchors themselves, hidden items, keys already used), fused with RRF (style directions join Wear), diversified by contributing reference, and capped at 3 per category. Ranks interleave categories. Every item is a per-owner `DiscoveryItem` (stable `canonical_key`) plus a `Recommendation` citing its `provider_query_ids` and `contributing_reference_ids`, with a plain-language reason from explainability. | `wear`, `play`, `watch` |
| enrich | `enriching` | Stage 2 of the two-stage photo reading (amendment 2.2, see below). Skipped unless stage 1 was a Concentrate quick read and `fast_analysis_two_stage` holds. Strictly additive: never reorders or removes a published card. | `wear`, `play`, `watch` (append only) |
| research | `researching` | Up to 5 references, anchors first (references added by stage 2 included): Wikipedia sources, then claim extraction. Results go to the public library (`sources`, `claims`, overview, sections). Pages researched in the last 30 days are reused. | `research` |
| eat | `composing` | Dish ideas from supported cuisine, place or tradition references (resolved or researched) via the composer model. Each must cite a supplied reference. `origin = 'vlm_creative'`. | `eat` |
| publish | `publishing` | Warnings, active analysis, capture status `ready` / `partial`. | |

Job outcome is `partial` whenever a section is `failed`, `unavailable` or `partial`. When Qloo is unavailable, references are still published, Wear, Play and Watch are `unavailable`, and the analysis carries `discoveries_delayed` ("Related discoveries are taking longer."). Research failures omit historical text.

### Two-stage photo reading (amendment 2.2)

Specs: [`specs/onboarding-and-fast-analysis.md`](../specs/onboarding-and-fast-analysis.md) (FAST-01..03) and the measured schemas in [`docs/analysis-latency-plan.md`](analysis-latency-plan.md).

- **Stage 1 (observe).** A `vision_photo` profile whose `schemaVersion` is `atlas_quick_read_v1` makes `ConcentrateVlm` send the slim `VlmQuickRead` (title, one-sentence interpretation, at most 5 candidates, quality) with the quick prompt, the image bounded to 512 px, and the profile's `reasoningEffort`. `toVlmAnalysis(quick)` turns it into today's `VlmAnalysis` with synthetic ids (`c1..cN`), so everything downstream is unchanged and the first sections publish as before. A profile pinned to `atlas_observations_v2` keeps the legacy single full reading.
- **Plan and budget.** Before stage 1 the compiler decides whether stage 2 will run: a usable stage-2 enricher (a qualified Concentrate `vision_photo_enrich` role; Elorian never serves it), no `fast_analysis_two_stage` or `concentrate_analysis_enabled` kill for the account (env `FEATURE_KILL_SWITCHES` or `feature_flag_kills`), the spend ledger able to reserve both profiles' worst cases together for this job (`ModelSpendLedger.canReserveAll`; both calls share the job id, so they count as one daily analysis), and the job budget's two photo-reading calls (`JobBudget.reserveVisionCalls`). Otherwise the reading is the single stage-1 call and the trace says why.
- **Stage 2 (enrich, after recommend).** One `VlmEnrichment` call on the capture image (≤ 768 px; for v2 media the best frame, see below) with the stage-1 title and candidate names as DATA, 20 s timeout capped by the soft deadline. The model output is cached by `runStage('enrich')`, so a retried attempt never dispatches it twice; a failure or timeout is recorded (`provider_queries` `vlm`/`enrich_image`, status `error`) and leaves stage 1 exactly as published.
- **Merge (deterministic, `mergeEnrichment`).** Stage-1 candidates keep order, ids and names; confirmations fill rationales; `keep=false` is advisory: certainty × 0.5, the reference stays an anchor and keeps its cards, but `capture_references.advisory_veto` moves it out of "Explore the references" (`db/migrations/130_fast_analysis_enrichment.sql`). Regions, observations, visible text and (when there were none) competing subjects are added; title and interpretation never change. A "What caught your eye?" question is only added, never replaced.
- **Additions.** Up to 4 extra candidates are appended to the reading. Only the slots left under the 5-candidate Qloo resolution cap are resolved (same rules, ≤ 3 concurrent); the results become new non-anchor references. A Qloo category with fewer than 3 cards is then filled from the new references only, after its published cards (`composeCategory` append mode: no delete, ranks continue). Research and dish ideas see the new references.
- **v2 media.** The media worker runs stage 1 per photo/frame (5 candidates) and marks the result `reading: "quick"` when every frame came from the qualified quick read. The display image it publishes for the capture is the best frame (the one most aggregated candidates cite), so the compile job's single stage-2 call reads that frame. Publishing never waits for stage 2.

### Example replays

`packages/domain/src/feed/examples.ts` holds a hand-reviewed reading for each "Try an example" photo (`outfit`, `room`, `cafe`). It is used only when an example capture is analyzed while no vision model can serve the job: the VLM is unavailable, or the job has no account and the only model is the account-budgeted Concentrate gateway (which refuses session-only jobs). Uploaded photos are never replayed. The observe stage records a `vlm` provider query with `is_replay = true` and model `reviewed-example`, so the inspector shows it as a replay. Resolution, Qloo categories and research then run as usual, so without a Qloo key Wear/Play/Watch still report `unavailable` and the "Related discoveries are taking longer." warning stays.

After that, the example's reviewed picks (public sample items from `feed/samples.ts`) fill categories that have no live results. They are stored with `origin = 'sample'` and no provider query ids, cite the example references they were chosen for as a creative rationale, and their sections become `partial`. Cards and the capture are labeled "Example result". Live results always take precedence.

### Budgets and resilience

- `JobBudget` (`compiler/budget.ts`): photo-reading model calls per job (2: quick read + enrichment, reserved together), Qloo requests per job (default 12; every HTTP attempt counts, including retries, across job attempts via `provider_queries.query_context.attempts`), and two retries per provider stage. The compiler prepays one request per Qloo call, so the limit holds even for adapters that ignore the budget. Lower-priority categories are `skipped` once it is spent.
- Adapters retry transient errors with exponential backoff and jitter, honor Retry-After, and trip a circuit breaker. A Retry-After longer than 15 s propagates instead, and the worker re-queues the job with that delay. An open circuit is transient too: its error carries the time until the breaker's next trial, and the worker re-queues with that delay.
- Qloo requests share one in-flight limit per process and key (`QLOO_MAX_CONCURRENCY`, default 3) across every caller.
- Soft deadline at 75% of `ANALYSIS_DEADLINE_MS` (45 of 60 s): research and dish ideas are skipped and what exists is published. The worker enforces the hard 60 s deadline per attempt.
- Non-retryable failures (or the last attempt) mark the capture `failed`, or `partial` if an analysis was already visible. A failure observed after cancellation is treated as cancellation.

### Evidence and the inspector

Every provider call writes a `provider_queries` row: sanitized request (no keys, no image bytes, no prompts), compact results (ids, names, ranks, per-query affinity and explainability for inspection only), status, timings and `is_replay`. Stage traces go to `trace_events`. Consumer DTOs never expose scores or provider names. Recommendations from replayed responses get `origin = 'replay'`, and their cards are `is_example`.

## Corrections (`services/analyses.ts`)

`submitCorrection` checks `expected_analysis_version` (409 when stale) and validates the referenced ids against the active analysis. It records a private `correct` preference event (global reference facts are never changed), bumps the taste revision, deletes active recommendations that relied on rejected references, cancels pending versions, and queues version N+1 with the correction in the payload.

## Deletion and purge

`deleteCapture` runs in one transaction under the capture lock. It cancels jobs and releases their dedupe keys, deletes dependent plans, the capture item (with its saves and memberships), preference links, analyses (cascading to private reference links, provider queries and recommendations), and items that only this capture's recommendations supported. It then marks the capture deleted with `purge_after = now() + 24h`. Media is deleted right after commit, and signed links stop working because the object is gone. The worker enqueues `purge_deleted` hourly (dedupe key per hour). It physically removes deleted captures, expired anonymous sessions with everything they own, expired uploads and their media, expired idempotency keys and feed snapshots.

## Known gaps

- Targeted retry of individual sections (`payload.sections`) is accepted but not yet used: retries rerun the job, reusing completed stages.
- No real-provider smoke check has run here: there is no Qloo key, and Anthropic and Wikipedia are unreachable from the build sandbox.
