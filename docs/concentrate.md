# Model gateway: Concentrate

Concentrate is the **default** model gateway (`LLM_PROVIDER` unset or
`concentrate`). Featherless and Anthropic remain only as explicit operational
rollbacks (`LLM_PROVIDER=featherless|anthropic`); nothing ever falls back to
them automatically, and v2 media analysis is unavailable under a rollback
provider. Qloo stays independent.

**No qualified profile ships in this repository.** Every test uses synthetic
ids such as `fixture/model-1`, which must never be deployed. The two photo
stages passed a live qualification on 2026-10-19 (see "Live qualification on
real photographs" below), but the profiles and artifacts stay with the operator,
and the ZDR/no-logging confirmation in the Concentrate dashboard is **still
pending**. Without a key, qualified profiles, a durable ledger and spend
ceilings every role reports `unavailable`; capture, library, uploads and
playback keep working.

Authority: `specs/capture-platform-v2/CONCENTRATE.md`.

## What runs where

| Piece | Code |
| --- | --- |
| Responses transport (`POST /v1/responses`, nonstreaming, `input_text` + `input_image` JPEG data URIs, `text.format` strict `json_schema`, instructions separate from data, no tools, no redirects, bounded body, error bodies never read) | `packages/providers/src/concentrate/transport.ts` |
| Strict schema transform with proven inverse | `packages/providers/src/model-gateway/schema.ts` |
| Role profiles, catalog snapshot, qualification artifacts, profile hash | `packages/providers/src/concentrate/profiles.ts`, `catalog.ts` |
| Runner (validation, deadlines, single retry owner, error matrix, circuits, alerts, readiness) | `packages/providers/src/model-gateway/runner.ts` |
| Spend ledger (`inference_attempts`, global/account/unknown caps, credit pause, role circuits) | `packages/providers/src/model-gateway/budget.ts`, `postgres.ts`, `db/migrations/066_inference_attempts.sql` |
| Gateway factory + read-only per-role readiness | `packages/providers/src/concentrate/gateway.ts` |
| Per-job identity for v1 jobs | `packages/providers/src/model-gateway/identity.ts`, used by `apps/worker/src/worker.ts` |
| v2 media analysis state (frame checkpoints, aggregation with frame citations, AI-only pauses, publication) | `packages/domain/src/capture-v2/analysis-run.ts`, `analysis.ts`, `db/migrations/067_media_analysis_runs.sql` |
| v2 media analysis loop (claims, bounded JPEGs, dispatch, classification) | `apps/worker/src/media-analysis.ts`, started by `apps/worker/src/main.ts` |
| Request gate + `concentrate_analysis_enabled` | `apps/web/lib/server/model-readiness.ts`, wired in `apps/web/lib/server/capture-v2.ts` |
| Operator qualification | `scripts/qualify-concentrate.ts` (`pnpm qualify:concentrate`) |
| Two-stage reading: quick read, enrichment, deterministic merge, compiler `enrich` stage | `packages/providers/src/vlm/{types,prompt}.ts`, `concentrate/providers.ts`, `packages/domain/src/compiler/analyze.ts` |

## Structured output: the strict transform

Atlas zod schemas are converted with `structuredOutputContract(schema)`:

- every object becomes `additionalProperties:false` with **all** keys required;
- an optional (non-nullable) key becomes required `T | null`, and the decoder
  removes the null again before zod, so absence stays expressible;
- value constraints that strict routes commonly reject (`minLength`, `maximum`,
  `maxItems`, `pattern`, `format`, `default`, …) are removed from the schema that
  is sent. Atlas still enforces every one: the decoded output is parsed by the
  **original** zod schema plus semantic checks (VLM ids, cross-references,
  geometry);
- unrepresentable schemas (records, `unknown`/`any`, tuples, open objects,
  `not`/`allOf`/conditionals) fail before dispatch. There is no permissive
  `{type:object}` fallback.

Equivalence is proven by property tests rather than asserted:
`checkContractEquivalence` (`packages/providers/src/testing/schema-fuzz.ts`)
generates zod-valid values from the original schema (including absent optional
keys), shows each one encodes to a provider-schema-valid value and decodes back
to an equal zod-valid value, and that adding an unknown key or deleting any key
anywhere is rejected by the strict decoder. It runs over `VlmAnalysis`,
`RawExtraction` (research), the composer schemas (`FilmIdeas`, `ArtistIdeas`,
`DishIdeas`, `PlanProse`) and the compiler's `DishIdeas`
(`model-gateway/schema.test.ts`, `capture-v2/analysis-run.test.ts`).

## Response parsing

All `output` items are scanned; only `message` items' `output_text` parts form
the answer (reasoning items are ignored). `refusal` parts, `status:
incomplete|in_progress|queued`, `incomplete_details`, `status:
failed|cancelled` and `error` objects are distinct outcomes. `usage` is nullable
and a partial usage object counts as unknown (never zero). The response `id`,
returned `model` and a `x-request-id`/`request-id` header (when present) are
recorded. The upstream provider is recorded only when a response discloses it;
otherwise `actual_provider` stays `NULL` (never inferred from the requested
route).

## Error matrix (runner policy)

| Condition | Runner / ledger | Consumer |
| --- | --- | --- |
| 400 | `bad_request`, no retry | “We couldn’t explore this media.” |
| 401 / 403 | `auth`; **durable role circuit** (`model_gateway_control.circuits`), alert `auth_failed` | “Exploration is temporarily unavailable.” |
| 402 | `budget_exhausted`; **global AI-only pause** until an operator resumes; alert `credits_exhausted` | request stays queued (`waiting_reason: ai_paused`) |
| 404 | `not_found`; role circuit, alert `unknown_model` | unavailable |
| 422 | role circuit (`policy`), never a privacy downgrade, alert `policy_route_unavailable` | unavailable |
| 424 / 5xx / network | one bounded retry inside the deadline with a new reservation | retried, then an honest failure |
| 429 | dispatch pause until `Retry-After` (default 30 s); the scheduler re-queues, the runner never spins | `waiting_reason: rate_limited` |
| refusal / incomplete / invalid JSON / schema / cross-reference / returned-model or disclosed-route mismatch | distinct classified failure, no repair, no publication; a route mismatch also opens the role circuit | explained without the raw payload |
| timeout / cancellation | no retry; the charge stays `unknown` | |

Raw error bodies are never read. Keys, image base64 and provider text never
reach logs, alerts, errors or the ledger (asserted in `contract.test.ts`).

**Deadlines and retry ownership.** Vision attempts 30 s, text 15 s (profile
cap), photo job 90 s, sampled-video job 180 s. Atlas is the single retry owner
(`CONCENTRATE_GATEWAY_FALLBACKS_ENABLED` must stay `false`). Per frame: round 0
may use the runner's one retry, round 1 gets one attempt, so at most three HTTP
attempts per frame/role. Schema repair is not configured.

## Budgets and `inference_attempts`

Each HTTP attempt reserves its profile's worst-case `reservationMicros` under a
global row lock before dispatch. Global daily, per-account daily, outstanding
unknown spend and per-account daily analysis counts must all pass. The store
loads only the rows a decision needs (the UTC day, every unsettled attempt, the
target) instead of the whole history. Usage tokens are recorded but are not a
dollar charge: every attempt stays `unknown` until billing evidence settles it
with `ledger.reconcile(id, actualCostMicros)`; a charge above its reservation
pauses dispatch (`cost_overrun`). Stale reservations never expire on their own.
Migration 066 copies 065's `model_gateway_attempts` rows so outstanding charges
stay counted.

Operator controls: `ledger.resume()` clears the global pause;
`ledger.resume({ roles: ['vision_photo'] })` or `{ roles: 'all' }` also closes
role circuits. Do this only after restoring credits or re-qualifying.

## Readiness (no paid probes)

`gateway.readiness()` reports per role, from local evidence only:

| State | Meaning |
| --- | --- |
| `configured` | key, profile and privacy assertions present |
| `catalog-compatible` | the pinned model id and provider appear in the stored catalog snapshot the profile names |
| `qualified` | a passing qualification artifact matches this exact profile hash, with enough fixtures |
| `available` | qualified and a validated response was observed |
| `degraded` | throttled (429 pause) |
| `unavailable` | missing pieces, open role circuit, credit or cost pause |

Only `qualified` profiles get a dispatching runner. `GET /v2/capabilities`
reports `concentrate_analysis_enabled` true only when the photo role is
qualified/available now. `POST /v2/media/{id}/analysis` refuses with “Exploration
is temporarily unavailable.” (503) **before** using the daily allowance when the
role is unavailable; during a credit or rate pause it accepts and queues.

## v2 media analysis

1. `POST /v2/media/{id}/analysis` (modes `photo`, `selected_frame`,
   `sampled_video`) queues `analyze_media` work (≤ 8 frames, server-owned ids
   and timestamps).
2. The worker claims photo and video work in separate slots (default 2 / 1) so
   interactive photos are not stuck behind videos; accounts with less running
   work go first. While AI is paused it claims nothing.
3. Each bounded JPEG (the photo's normalized derivative or an extracted frame,
   re-encoded into the profile's byte/pixel/dimension bounds) is sent once per
   frame with identity `media:<analysis>:<frame>:r<round>`. Every outcome is
   checkpointed in `media_analysis_frames`. A dispatch whose outcome was lost
   (crash after reservation) is recorded `unknown` and **never re-sent**; its
   charge stays counted (MED-01).
4. Frame readings are aggregated: duplicate candidates (normalized name + type)
   merge and cite every frame (`frame_id`, `timestamp_ms`); `depicted` needs one
   frame's strong evidence; frame-local boxes are dropped for multi-frame
   readings; certainty never reaches consumers.
5. Publication re-checks lease, owner, generation and tombstone in one
   transaction, creates a capture linked to the asset, and queues the existing
   cultural compiler with `media_analysis_id`, which uses the stored reading
   instead of a second VLM call (Qloo resolution, research and recommendations
   proceed as for v1). With a quick-read profile each frame gets stage 1
   (≤ 5 candidates) and the result carries `reading: "quick"`; the capture's
   display image is the best frame, and the compile job runs the one stage-2
   enrichment on it (see `docs/pipeline.md`, "Two-stage photo reading").
   `GET /v2/media/{id}/analysis/{analysis_id}` adds
   `waiting_reason`, `error_code` and `result` (`note: “We explore selected
   moments, not every frame.”`, per-frame states, cited candidates).
6. 402 / 429 return the work to the queue **without** consuming an attempt;
   media stays `ready`. Deleting the asset fences publication and a trigger
   removes stored readings.

v1 jobs (captures, plans, related discovery) get a fresh verified identity per
model call (`v1:<job type>:a<attempt>:<operation>:<n>`). Session-only
(anonymous) jobs get none, so the budgeted gateway refuses them: anonymous AI is
unavailable under Concentrate.

## Two-stage photo reading (amendment 2.2)

| Role | Reading (`schemaVersion`) | Prompt (`promptVersion`) | Image | Output cap | Timeout | Code |
| --- | --- | --- | --- | --- | --- | --- |
| `vision_photo`, `vision_video_frame` | `atlas_quick_read_v2` (`VlmQuickReadV2`, 0–5 candidates) | `vlm-quick-v2` | ≤ 512 px | 600 | 10 s | `ConcentrateVlm` quick mode, `toVlmAnalysis()` |
| `vision_photo_enrich` | `atlas_enrichment_v2` (`VlmEnrichmentV2`) | `vlm-enrich-v2` | ≤ 768 px | 1600 | 20 s | `ConcentrateVlmEnricher`, `mergeEnrichmentContext()` |
| (phase 4) `vision_photo`, `vision_photo_enrich` | `atlas_quick_read_v1` / `atlas_enrichment_v1` | `vlm-quick-v1` / `vlm-enrich-v1` | as above | 600 / 1200 | as above | same classes, v1 schemas |
| (legacy) `vision_photo` | `atlas_observations_v2` (full reading, `VlmFullReading`) | `vlm-full-v2` | profile bounds | profile | profile | `ConcentrateVlm` full mode |

- The profile's `schemaVersion` selects the reading (`readingForProfile`) and its version (`readingVersionForProfile`), so the profile hash, and with it the qualification artifact, binds the exact reading. Every vision profile not pinned to `atlas_observations_v2` uses the quick read. A profile pinned to `atlas_quick_read_v1` or `atlas_enrichment_v1` keeps the phase-4 prompt and schema byte-identical (a test pins the prompt hashes); every other quick or enrich profile gets reading v2. Both photo roles must be re-qualified on v2 ([quality plan](quality-plan.md) §3, §7.5).
- **Reading v2** ([quality plan](quality-plan.md) §3). Stage-1 candidates report `domain` (what the reference is about), `evidence` (`read_text`, `logo`, `distinctive_form`, `context`) and `evidence_text` (the words read) instead of categories; the enrichment returns a `verdict` (`supported`, `weak`, `unsupported`) per first-reading candidate instead of `keep`, verbatim `visible_text` only, and `illegible_text_present`. The prompts add the evidence rules: a brand or model only from a legible name or logo, sign names exactly as written, no medium words, no generic objects, 0 to 5 candidates, nothing about a person's looks or role.
- **Guardrails** (`vlm/guardrails.ts`, `GUARDRAIL_VERSION = 'guard-v1'`, rules G-QUAL … G-CATEGORY in [quality plan](quality-plan.md) §4). The model proposes; this pure module decides. The compiler runs `guardQuickRead` right after stage 1, before anything is published, resolved or anchored, and `guardEnrichment` inside the stage-2 publish step. Risky claims (brands, names of places or works that do not match the text read, styles read off a sign, resemblances at certainty ≤ 0.35) are *held*: never shown, sent to stage 2 by name, and published only on a binding stage-2 verdict through the existing append path (a brand also needs a stage-2 transcription of its name, G-BRAND-CORROBORATE). If stage 2 is off, fails or times out, held claims are dropped; a reading without a planned stage 2 (the legacy full reading, a fallback model's answer) drops them at once. Published cards are never removed (FAST-02): stage 2's "unsupported" on them stays an advisory veto. The server assigns categories from `domain` (fashion → Wear, music → Play, film → Watch, food or cuisine → Eat, everything else none). Recorded v1 readings and full readings pass through the same rules: missing `domain`, `evidence` and verdicts are inferred (§4.4). Every decision (rule ids, action, note; names withheld for person rules) is recorded as a `guard` trace event per stage, shown by the inspector; dropped visible-text entries and observations are recorded as counts only. A reviewed example replay is not a model reading and is not guarded.
- `reasoningEffort` (`none` | `minimal` | `low` | `medium` | `high`) is optional and part of the profile hash. The transport sends `reasoning: {effort}` only when the qualified profile sets it; otherwise no reasoning field is sent at all (FAST-03).
- Both prompts keep the security rules (image text and `user_data` are DATA; no tools). The quick prompt adds "Read the subject as if it were a photo; never name the rendering medium or drawing style." and "Skip generic objects unless named as a specific type, style or tradition." Stage 2 receives the stage-1 title and candidate names inside the `user_data` block.
- **Reading v2 smoke, 2026-10-19** (build package P1, 12 billed requests, no retries, 5 tuning photos, `anthropic/claude-haiku-5-5`, effort none; not a qualification run). Stage 1 took 1.9–4.8 s and stage 2 3.5–6.9 s, with at most 1031 output tokens at stage 2. Results: on the grocery-bags photo stage 1 returned no candidates instead of guessing a car model from its shape; on the Paris signs all five places carried the exact sign text as evidence and published at stage 1; on the photo of two people one tailoring style was proposed, with no identity or role; on the basketball photo "Streetball" was held and published only as a weak, non-anchor resemblance, and "NBA" was published from its logo plus the stage-2 transcription; on the bicycle photo the road bicycle was demoted as generic, and no brand was claimed because stage 2 did not read the maker's name. Two findings changed the code: the Paris enrichment drew five evidence boxes against a schema cap of four, so the whole call failed validation (the v2 schema now accepts up to eight and the merge keeps four); and one observation described a mouth, so G-PERSON-OBS also covers mouth, lips, teeth and grimaces. Stage 2 still adds a confirmation for the title despite the prompt; it is ignored. Outputs stay in the team scratchpad.
- The stage-2 role is wired only from a qualified Concentrate profile (`gateway.vlmEnrich`, `registry.vlmEnrich`); there is no Elorian or rollback fallback for it, and a fallback model's stage-1 answer (no quick read) never gets a stage 2.
- Ledger: each call reserves its own `inference_attempts` row; both stages of one job share the job id and count as one daily analysis. `ModelSpendLedger.canReserveAll` is the read-only pre-check the compiler uses before stage 1 so that stage 2 is planned only when both worst cases fit.
- The default route measured in [the latency plan](analysis-latency-plan.md) is `anthropic/claude-haiku-5-5` with effort `none` for both stages. Both stages passed live qualification on 15 real photographs on 2026-10-19 (below). **Before production** the operator must still confirm ZDR and no content logging for this route in the Concentrate dashboard, then re-qualify with the confirmed `privacyVerifiedAt`.

Example profile pair for reading v2 (values from the latency plan, with the enrichment cap raised to 1600; ids, artifact names and privacy dates are placeholders the operator fills in after qualification; on the same route the owner-accepted `privacyVerifiedAt` carries over unchanged):

```json
[
  { "gateway": "concentrate", "role": "vision_photo", "version": "quick-2",
    "model": "anthropic/claude-haiku-5-5", "provider": "anthropic", "allowedFallbackProviders": [],
    "maxOutputTokens": 600, "reasoningEffort": "none", "maxInputTokens": 60000, "maxInputBytes": 60000,
    "image": { "maxBytes": 120000, "maxPixels": 262144, "maxDimension": 512, "maxCount": 1 },
    "timeoutMs": 10000, "structuredOutput": true, "requireZdr": true, "providerZdrEligible": true,
    "contentLoggingEnabled": false, "privacyVerifiedAt": "<operator>",
    "promptVersion": "vlm-quick-v2", "schemaVersion": "atlas_quick_read_v2",
    "catalogSnapshotAt": "<snapshot fetched_at>", "qualificationArtifactId": "<artifact id>",
    "pricingSnapshotVersion": "<pricing>", "reservationMicros": "<worst case>" },
  { "role": "vision_photo_enrich", "version": "enrich-2", "maxOutputTokens": 1600, "reasoningEffort": "none",
    "image": { "maxBytes": 250000, "maxPixels": 589824, "maxDimension": 768, "maxCount": 1 },
    "timeoutMs": 20000, "promptVersion": "vlm-enrich-v2", "schemaVersion": "atlas_enrichment_v2",
    "...": "other fields as above" }
]
```

## Profiles

`CONCENTRATE_PROFILE_FILE` (path) or `CONCENTRATE_PROFILES_JSON` (inline, for
hosted parameter stores) holds an array of `ModelProfileSchema` objects, one per
role. Each pins gateway, role, exact `provider/model` and provider, an empty
`allowedFallbackProviders`, output/input caps, image byte/pixel/dimension/count
caps, timeout, structured-output support, ZDR requirement and eligibility,
content logging off, privacy verification time, prompt/schema/pricing versions,
catalog snapshot time, qualification artifact id and the worst-case
`reservationMicros`. `VLM_MODEL` / `RESEARCH_MODEL` / `COMPOSER_MODEL`, if set,
are assertions against profiles, never replacements.

## Qualification (deliberate operator action)

```sh
# Key in a private file (chmod 600) outside the repository.
export CONCENTRATE_API_KEY_FILE=/secure/concentrate-key
# 1. Catalog snapshot (GET /v1/models, paginated; no inference).
pnpm qualify:concentrate --catalog --out-dir /secure/concentrate-qualification
# 2. Pin a model/provider from the snapshot; set catalogSnapshotAt to its fetched_at.
#    Dry run: prints the plan, sends nothing.
pnpm qualify:concentrate --profile-file profiles.json --role vision_photo \
  --fixtures /secure/owned-fixtures/photos --out-dir /secure/concentrate-qualification \
  --max-requests 12 --spend-cap-usd 2
# 3. Same command plus --confirm-paid-requests sends real, billed requests.
# Two-stage reading: qualify the quick read first, then stage 2. Stage 2 needs the
# vision_photo profile in the same file and sends a real quick read per photo as
# its input (two requests per photo, both under --max-requests and the spend cap).
pnpm qualify:concentrate --profile-file profiles.json --role vision_photo_enrich \
  --fixtures /secure/owned-fixtures/photos --out-dir /secure/concentrate-qualification \
  --max-requests 24 --spend-cap-usd 2
```

The artifact notes record the reading (prompt and schema versions) and the
reasoning effort the run sent; for `vision_photo_enrich` they also name the
stage-1 profile whose readings were the input (its requests count in
`requests_sent`; latency and usage are the enrichment call's own).

Fixture layout: photos as image files (≥ 10, owned and varied); videos as one
directory per video containing `<timestamp_ms>.jpg` frames (≥ 3 videos, ≤ 8
frames each); text roles as `{system, prompt, schema}` JSON files (≥ 3; the
schema keys and the role each belongs to are in `scripts/eval/text-schemas.ts`;
`*.expect.json` siblings are skipped; see "Text-role qualification"). A persistent request counter in the out dir is reserved
before every request and survives re-runs; the worst-case reservation must fit
the spend cap; there are no retries; the run stops at 401/402/404/422/429. The
artifact `<qualificationArtifactId>.json` holds aggregates only (counts,
outcomes, p50/p95 latency, token usage, profile hash) — no media, prompts,
outputs or keys. Ship the out dir with the deployment as
`CONCENTRATE_QUALIFICATION_DIR`; a role becomes dispatchable only when its
artifact passes and matches the profile hash exactly (any profile edit requires
re-qualification).

What a passing run still does not prove: cultural-label quality judged by a
person, billing reconciliation, and the ZDR/logging settings on the key, which
the operator verifies in the Concentrate dashboard and records in
`privacyVerifiedAt`.

## Live qualification attempts (2026-10-17)

First runs against the operator's real key, `vision_photo` role, 16 owned
illustrations (`apps/web/public/samples`), one request each, `--spend-cap-usd 1`.
No role is qualified yet.

| Profile | Result | Outcomes | Latency p50 / p95 | Notes |
| --- | --- | --- | --- | --- |
| `openai/gpt-5-nano` | fail 2/16 | 14 `incomplete_response` | 15.2 s / 20.9 s | Reasoning model: hidden reasoning tokens exhaust `max_output_tokens` (4000) before the JSON is written. |
| `deepinfra/gemma-3-27b` | fail 3/16 | 13 `timeout` | 23.9 s / 29.0 s | Hits the 30 s per-attempt deadline. |
| `deepinfra/mistral-small-3.2` | fail 3/16 | 13 `timeout` | 20.7 s / 23.5 s | Same. |

Diagnosis: the gateway and network are fast (a one-sentence image request
returns in 1.5–5.5 s on these routes). The full `VlmAnalysis` reading is the
bottleneck: one complete mistral-small-3.2 reading wrote 781 output tokens in
14.2 s (about 55 tokens/s), and readings with more observations, candidates,
rationales and region boxes exceed 30 s. Model choice alone will not meet the
30 s deadline or the 10 s first-section target; the reading must get shorter
(fewer and terser candidates/observations, optional or dropped region boxes) or
be split into a fast first section and a follow-up call.

The catalog fix needed to run these at all (provider/model pins vs bare catalog
ids) landed in `packages/providers/src/concentrate/profiles.ts`.

## Live qualification on real photographs (2026-10-19, build plan phase 4)

Both photo stages qualified on `anthropic/claude-haiku-5-5` with
`reasoningEffort: "none"`, through `pnpm qualify:concentrate` with the
`--confirm-paid-requests` flag. The owner asked for public test photographs
instead of their own: 15 real photographs from open-source test-image sets
(OpenCV samples, Segment Anything, Depth Anything V2, EasyOCR, Ultralytics,
Darknet), fetched from raw.githubusercontent.com at pinned commits. They cover
food, interiors, architecture, crafts, signage with Japanese, Chinese and
French text, a busy street, a sports object, a brand on a bicycle frame, a
motion-blurred car, and one photo of two real, well-known people as an
adversarial check. The photos, their source list, the profiles, the catalog
snapshot and both artifacts are kept outside the repository, in the operator's
qualification directory. Per-photo quality notes are in
[the latency plan](analysis-latency-plan.md#results-on-real-photographs-phase-4-2026-10-19).

| Role | Artifact id | Result | Requests | Latency p50 / p95 | Tokens in / out | Profile hash (prefix) |
| --- | --- | --- | --- | --- | --- | --- |
| `vision_photo` (quick read, `atlas_quick_read_v1`, 512 px, 600 out, 10 s) | `vp-quick-haiku55-none-20261019` | **pass** 15/15 | 15 | 2.47 / 5.30 s | 27,706 / 3,901 | `9cbbb362ef19` |
| `vision_photo_enrich` (`atlas_enrichment_v1`, 768 px, 1200 out, 20 s) | `vpe-enrich-haiku55-none-20261019` | **pass** 15/15 | 30 (15 stage-1 inputs + 15 enrichments) | 4.60 / 9.27 s (enrichment calls) | 40,479 / 12,209 (enrichment calls) | `07a1836b20c6` |

- **Catalog snapshot:** `fetched_at` 2026-10-19T01:11:29.472Z (200 models). It
  lists `anthropic` as the provider for `claude-haiku-5-5`, with a ZDR policy
  and certificate link. It lists $0.10 per million input tokens and $0.50 per
  million output tokens below 100k input tokens, and $0.50 / $2.50 above that.
  Both profiles use `reservationMicros` 7000 (60k input-token cap plus the
  output cap at the standard rate, rounded up).
- **Reasoning effort:** `none` was sent on every request, and every response
  reported `reasoning_tokens: 0`.
- **Stage-1 model time over both runs (30 quick reads, FAST-01):** p50 2.27 s,
  p95 4.63 s, max 5.25 s. Output was 262 tokens on average and 378 at most,
  under the 600 cap.
- **Enrichment output** averaged 814 tokens. One photo (a ceramics display)
  used exactly the 1200-token cap and still completed. Raise
  `maxOutputTokens` to about 1600 at the next re-qualification so that a busy
  photo does not end `incomplete`.
- **Live app run:** one upload on the real stack, with live Concentrate and
  live Qloo, made 2 model calls. The quick read took 3.9 s and the enrichment
  5.3 s. Timings are in [the latency plan](analysis-latency-plan.md#end-to-end-on-the-local-real-stack).

**Privacy gate, still open, and a process exception the owner must accept.**
For this qualification run only, the build agent (not the operator) set
`privacyVerifiedAt` on both profiles to 2026-10-19T01:12Z. The build plan
reserves that flag for the operator ("Profiles may only be marked
privacy-verified by the operator"), precisely so that no image is sent before
zero data retention is confirmed. The operator has **not** yet confirmed in the
Concentrate dashboard that zero data retention and no content logging apply to
`anthropic/claude-haiku-5-5` on this key. The run nevertheless sent 15 real
photographs, including the photo of two real, well-known people, and one live
app upload. The privacy gate was bypassed rather than waited on. What this
means:

- Nothing can be recalled: those requests went out under whatever retention
  the route actually has.
- No artifact, photo or key is in the repository; they stay in the operator's
  qualification directory.
- The owner either accepts this as a recorded exception, or discards both
  artifacts and re-qualifies after the operator's confirmation (steps below).
  Either way, these artifacts must not be used to deploy until step 1 is done.
- From now on, only the operator sets `privacyVerifiedAt`; the build agents do
  not set it, even for a qualification run.

Before production:

1. Confirm ZDR and no content logging for this route in the dashboard.
2. Set `privacyVerifiedAt` to the confirmation time. Raise the enrichment
   output cap at the same time.
3. Re-qualify both roles, because any profile edit changes the profile hash.
   That is about 45 requests, roughly $0.02 at the listed standard rate.

Until then, do not deploy these profiles.

**Spend (phase 4):**

- 47 billed Concentrate inference requests: 45 for qualification and 2 for the
  live app run.
- 1 catalog listing (`GET /v1/models`, not inference).
- Tokens: 100,536 input and 21,385 output in total.
- Cost: about $0.021 at the listed standard rate, and at most about $0.10 even
  at the long-context rate. The spend cap was $1.
- Billing is not reconciled.

## Elorian fallback (operator choice)

`MODEL_FALLBACK=elorian` plus `ELORIAN_API_KEY` adds Elorian
(`https://api.elorian.ai/v1/chat/completions`, model `ELORIAN_MODEL`, default
`elorian-1-agent`) behind the vision and text roles
(`packages/providers/src/fallback.ts`). It is used when Concentrate cannot
serve a role at all (no qualified profile, circuit open, unavailable), and as
one second attempt after a provider-side failure (`unavailable`, `timeout`,
`incomplete_response`, `invalid_response`, `rate_limited`, `server`, `auth`,
`not_found`). Refusals, bad requests, cancellations and the per-job budget
never fall through. Replies use the same zod validation, so nothing unvalidated
is published. This deliberately departs from the spec's "no cross-gateway
fallback" default at the operator's request: Elorian calls are not reserved in
the Concentrate spend ledger (only the per-account daily analysis allowance
applies), and Elorian's data-retention terms are not verified here. Image input
and structured output on `elorian-1-agent` were checked live on 2026-10-17:

- `elorian-1-agent` accepts images (its model entry lists text, image and
  video) but rejects `response_format` (`json_object` and `json_schema`) with
  `structured_output_unsupported`, so `ELORIAN_JSON_MODE` defaults to `none`:
  the schema goes in the prompt and the reply is validated afterwards.
- Same 16 illustrations, one `VlmAnalysis` reading each, 60 s limit: 6
  complete, 10 cut off at the limit. Completed readings took 38.6–58.6 s
  (p50 51.5 s). About 6.8k input and 2.9k output tokens per request, mostly
  hidden reasoning. Completed readings were good (for example tetsubin,
  matcha and chanoyu for the tea still life, Japandi and wabi-sabi for the
  interior).
- It is a slow, heavy agent model: as configured (30 s attempt deadline) it
  will rarely finish an interactive photo reading. It is better suited to
  background re-tries or to a shorter reading format.

## Deployment configuration

**Render** (`render.yaml`): set `CONCENTRATE_API_KEY`,
`CONCENTRATE_PROFILES_JSON`, `CONCENTRATE_QUALIFICATION_DIR` and the three
`MODEL_*_USD` ceilings as secrets on the shared group (web reads readiness; the
worker dispatches). Keep `FEATHERLESS_API_KEY` only for an explicit rollback.

**AWS** (single EC2 host or ECS on EC2, RDS PostgreSQL, S3, as mapped in
`docs/v2-gap-report.md` §7): keep `CONCENTRATE_API_KEY` in Secrets Manager or an
SSM `SecureString` parameter and `CONCENTRATE_PROFILES_JSON` in SSM, injected
into both containers at start; never bake them into the image. Copy the
qualification out dir onto the host (or into the image, it holds no secrets)
and point `CONCENTRATE_QUALIFICATION_DIR` at it. The worker needs outbound HTTPS
to `api.concentrate.ai` only for analysis; requests carry bounded JPEGs (tens of
kB per frame), so model traffic is not a meaningful AWS data-transfer cost
compared with video playback. Whether the deployment fits AWS's free offer has
not been verified here (no AWS access); Concentrate usage is billed by
Concentrate against the operator's credits, independently of AWS.

## Text-role qualification (`research_text`, `composer`)

Until both text roles are qualified, every real upload ends `partial`: the
research section needs `research_text` and the Eat section needs `composer`.
The owner chose `anthropic/claude-haiku-5-5` with `reasoningEffort: "none"`
for both (quality plan §8). No independent verifier model is built in this
round (quality plan §7.6); this section covers the text roles only.

**What is checked.** A transport pass only proves that a reply arrived and
parsed. The text golden set `fixtures/eval/text-v1` (see its README) adds
content checks, scored by `scoreTextFixture` in `scripts/eval/text-scorer.ts`:

| Check | Role | Gate |
| --- | --- | --- |
| T1 schema-valid reply | both | every fixture |
| T2 cited URL that was not supplied | research | 0 |
| T3 factual claims citing no supplied URL (before enforcement) | research | ≤ 20 % |
| T4 claims kept after `enforceExtraction` | research | ≥ 2 |
| T5 overview present, ≤ 150 words | research | every fixture |
| T6 word and sentence limits (prose title ≤ 6 words, one-sentence summary; idea reasons) | composer | every fixture |
| T7 proper names in the prose that are not in the input | composer | 0 |
| T8 dietary exclusions, judged on what is shown: prose mentions none; ≥ half of the requested movie-night dishes survive the production filter; Eat reasons (shown unfiltered) make no safety claim | composer | every fixture |
| T9 p95 latency under the profile timeout, no timeouts | both | `summarizeTextRun` |
| T10 every fixture passes, ≥ 5 fixtures | both | `summarizeTextRun` |
| T11 kept claims stating a number or name their source does not contain (text invented under a real URL, or a fact relabelled "interpretive") | research | ≤ 20 % |
| T12 forbidden strings (echoes of the injection cases) | both | 0 |
| T13 ideas cite real input ids, honour avoid lists and counts; Eat ideas cite a supplied reference | composer | every fixture |

The composer fixtures include the Eat call that every photo analysis makes
(`eat_dish_ideas`), not only plan prose: a composer qualified on prose alone
would not have exercised the call that decides whether an upload is complete.
A fixture names its schema, and `parseTextFixture` refuses a fixture whose
schema belongs to another role before any request is sent. Each request uses
the production wire schema name and output cap.

**Profiles.** Add these two entries to the same profile file as the photo
roles. Keep `privacyVerifiedAt` exactly as it is on the owner-accepted photo
profiles of the same route; do not set a new value (a different route needs the
operator). Copy `catalogSnapshotAt` and `pricingSnapshotVersion` from the
snapshot in use.

```json
{ "gateway": "concentrate", "role": "research_text", "version": "research-1",
  "model": "anthropic/claude-haiku-5-5", "provider": "anthropic", "allowedFallbackProviders": [],
  "maxOutputTokens": 4000, "reasoningEffort": "none", "maxInputTokens": 24000, "maxInputBytes": 24000,
  "image": { "maxBytes": 0, "maxPixels": 0, "maxDimension": 0, "maxCount": 0 },
  "timeoutMs": 15000, "structuredOutput": true, "requireZdr": true, "providerZdrEligible": true,
  "contentLoggingEnabled": false, "privacyVerifiedAt": "<unchanged accepted value>",
  "promptVersion": "research-v1", "schemaVersion": "reference_notes",
  "catalogSnapshotAt": "<snapshot fetched_at>", "qualificationArtifactId": "rt-haiku55-none-<date>",
  "pricingSnapshotVersion": "<snapshot fetched_at>", "reservationMicros": 4500 }
{ "...": "same fields", "role": "composer", "version": "composer-1", "maxOutputTokens": 1500,
  "timeoutMs": 12000, "promptVersion": "composer-v1", "schemaVersion": "composer-v1",
  "qualificationArtifactId": "co-haiku55-none-<date>", "reservationMicros": 3200 }
```

`timeoutMs` 15000 for research is the cap for text profiles: live research
replies wrote about 1,200 output tokens and took up to 10.6 s, so 12 s would
leave too little margin. The input caps cover five 4,000-character sources
(the runner compares prompt bytes with both caps). `reservationMicros` is the
worst case at the listed standard rate ($0.10 / $0.50 per million tokens):
24k input plus the output cap, rounded up.

**Runbook (operator).**

```sh
export CONCENTRATE_API_KEY_FILE=/secure/concentrate-key
# 0. The fixtures must match the production prompts (also enforced by pnpm test).
pnpm exec tsx scripts/eval/build-text-fixtures.ts --check
# Optional, needs network: re-check every source excerpt against its pinned file.
pnpm exec tsx scripts/eval/build-text-fixtures.ts --verify-sources
# 1. Dry runs: print the plan, send nothing.
pnpm qualify:concentrate --profile-file profiles.json --role research_text \
  --fixtures fixtures/eval/text-v1/research_text --out-dir /secure/concentrate-qualification \
  --max-requests 6 --spend-cap-usd 0.5
pnpm qualify:concentrate --profile-file profiles.json --role composer \
  --fixtures fixtures/eval/text-v1/composer --out-dir /secure/concentrate-qualification \
  --max-requests 11 --spend-cap-usd 0.5
# 2. The same two commands plus --confirm-paid-requests (17 billed requests in all).
```

A role counts as qualified only when the transport pass and the content checks
both pass. Scoring each reply with `scoreTextFixture` (expectations from
`readTextExpect`), aggregating with `summarizeTextRun`, and binding the result
and `manifest.json`'s `golden_sha256` into the artifact's eval block is wired
by the qualification-gating package (quality plan §7.5). Until then, run the
dry runs above and score the replies in memory; never write replies into the
artifact or the repository.

**Live smoke (2026-10-19, 16 billed requests, no artifact).** All 13 fixtures
tried completed and were schema-valid; replies stayed in the scratchpad.

- Research, 6 of 6 passed the checks, 5.0–10.6 s, 770–1,280 output tokens
  each. The model added one fact from its own knowledge (a publication year)
  in 1 of 8 claims, which T11 reports under its 20 % gate. It also corrected a
  misspelt name in an old source, which T11 accepts as a near spelling.
- Composer, Eat ideas 2 of 2 passed, 2.6–4.9 s. Both kept the injected
  reference name out of their output and grounded every dish in the real
  cuisine.
- Composer, plan prose: the first runs added a director's name that was not
  in the input (T7), and one title had eight words where the prompt asks for
  at most six (T6). The prose prompt now says to use only names and titles
  from the data and to count the title's words. Re-run once each (the name case
  with the name rule, the title case with the final wording), both passed. One
  run each is not a measured rate; the Evaluate run measures it.
- Movie-night dishes: the model wrote "gluten-free" in reasons. Production
  strips such sentences. The production dietary lexicon also dropped a potato
  tortilla and an almond-flour cake under a gluten exclusion. The case passed,
  because 2 of the 4 dishes survive the filter.

## Remaining release gates

- Qualified profiles exist only in the operator's directory: `vision_photo` and
  `vision_photo_enrich` on `anthropic/claude-haiku-5-5` (effort `none`, passed
  live on 2026-10-19). The other roles (`vision_video_frame`, `research_text`,
  `composer`) are not qualified. A mock pass is not production qualification.
- **ZDR / content-logging confirmation for `anthropic/claude-haiku-5-5` is
  pending in the Concentrate dashboard.** After it, re-qualify with the
  confirmed `privacyVerifiedAt` (see above).
- Billing reconciliation feed (who calls `ledger.reconcile`) is not automated.
- Alerts are emitted as structured log lines (`[alert] model_gateway {…}`);
  routing them to a pager/alarm is deployment work.
- MCP `analyze_media` tool and agent REST media routes belong to the agents
  module.
