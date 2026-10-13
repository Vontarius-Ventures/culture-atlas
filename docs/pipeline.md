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
| resolve | `resolving` | Up to 8 strongest candidates: entity types go to `/search`, styles/traditions/cuisines to `/v2/tags`. A provider result counts as the same thing only on a close name match (0.75 for entities, 0.6 for tags). Matches become public `cultural_references` (`qloo:<id>` / `qloo_tag:<id>`). Unmatched candidates are kept as qualified references (`<type>:<slug>`). At most 5 anchors are chosen: user selections, then depicted, then certainty. A candidate that resolves to a reference the user rejected stays `rejected`. | `references` |
| recommend + compose | `recommending` | One `/v2/insights` call per category (wear = brands, play = artists, watch = films), with the anchors' real entity and tag ids and explainability on, in priority order from the anchors' suggested categories. Results are filtered (anchors themselves, hidden items, keys already used), fused with RRF (style directions join Wear), diversified by contributing reference, and capped at 3 per category. Ranks interleave categories. Every item is a per-owner `DiscoveryItem` (stable `canonical_key`) plus a `Recommendation` citing its `provider_query_ids` and `contributing_reference_ids`, with a plain-language reason from explainability. | `wear`, `play`, `watch` |
| research | `researching` | Up to 5 references, anchors first: Wikipedia sources, then claim extraction. Results go to the public library (`sources`, `claims`, overview, sections). Pages researched in the last 30 days are reused. | `research` |
| eat | `composing` | Dish ideas from supported cuisine, place or tradition references (resolved or researched) via the composer model. Each must cite a supplied reference. `origin = 'vlm_creative'`. | `eat` |
| publish | `publishing` | Warnings, active analysis, capture status `ready` / `partial`. | |

Job outcome is `partial` whenever a section is `failed`, `unavailable` or `partial`. When Qloo is unavailable, references are still published, Wear, Play and Watch are `unavailable`, and the analysis carries `discoveries_delayed` ("Related discoveries are taking longer."). Research failures omit historical text.

### Example replays

`packages/domain/src/feed/examples.ts` holds a hand-reviewed reading for each "Try an example" photo (`outfit`, `room`, `cafe`). It is used only when an example capture is analyzed while the VLM is unavailable; uploaded photos are never replayed. The observe stage records a `vlm` provider query with `is_replay = true` and model `reviewed-example`, so the inspector shows it as a replay. Resolution, Qloo categories and research then run as usual, so without a Qloo key Wear/Play/Watch still report `unavailable` and the "Related discoveries are taking longer." warning stays.

After that, the example's reviewed picks (public sample items from `feed/samples.ts`) fill categories that have no live results. They are stored with `origin = 'sample'` and no provider query ids, cite the example references they were chosen for as a creative rationale, and their sections become `partial`. Cards and the capture are labeled "Example result". Live results always take precedence.

### Budgets and resilience

- `JobBudget` (`compiler/budget.ts`): Qloo requests per job (default 12; every HTTP attempt counts, including retries, across job attempts via `provider_queries.query_context.attempts`), and two retries per provider stage. The compiler prepays one request per Qloo call, so the limit holds even for adapters that ignore the budget. Lower-priority categories are `skipped` once it is spent.
- Adapters retry transient errors with exponential backoff and jitter, honor Retry-After, and trip a circuit breaker. A Retry-After longer than 15 s propagates instead, and the worker re-queues the job with that delay.
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
