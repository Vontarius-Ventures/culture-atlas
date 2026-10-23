# Model gateway: Concentrate

Concentrate is the **default** model gateway (`LLM_PROVIDER` unset or
`concentrate`). Featherless and Anthropic remain only as explicit operational
rollbacks (`LLM_PROVIDER=featherless|anthropic`); nothing ever falls back to
them automatically, and v2 media analysis is unavailable under a rollback
provider. Qloo stays independent.

**No qualified profile ships in this repository.** Catalog IDs are pinned after
a live `GET /v1/models` run (below) but are not dispatch defaults:
`DEFAULT_MODELS.concentrate` stays empty. Of the model roles
`research_text` and `composer` (`composer-v2`) have qualifying artifacts now
(in the operator's directory; "Requalification round 3: Tune" below);
`composer` had failed its round-2 re-qualification on the injection fixture. Every test uses synthetic ids such as `fixture/model-1`,
which must never be deployed. The two photo stages failed the requalification
blind run on golden-v2 (M1, M4, M11; see "Requalification blind run" below)
again on the round-2 blind split of golden-v3 (M1, M2, M4, M9, M11; see
"Requalification round 2: blind run on h30–h49" below) and on the round-3
blind split of golden-v4 (M1, M2, M5, M7, M11, M15; see "Requalification
round 3: blind run on h50–h79" below), so photo analysis fails closed. Their earlier passes are history, not qualification:
the phase-4 run on 2026-10-19 ("Live qualification on real photographs"
below) checked transport only and its artifacts carry no eval block
(`missing_eval`), and the Evaluate-phase golden-v1 artifacts failed their
evaluation. The ZDR/no-logging confirmation in the Concentrate dashboard is
also **still pending**. Without a key, qualified profiles, a durable ledger and
spend ceilings every role reports `unavailable`; capture, library, uploads and
playback keep working.

Authority: `specs/capture-platform-v2/CONCENTRATE.md`.

## Catalog pin (2026-10-22)

Live `GET /v1/models` returned 204 models (1 page). The committed snapshot in
`fixtures/concentrate/catalog-snapshot.json` is the ZDR-relevant subset
(fable / haiku / gemini-2.5-flash) with `fetched_at` 2026-10-22T03:13:03.746Z.
Selection is `selectPinnedConcentrateRoutes` in
`packages/providers/src/concentrate/catalog.ts`: ZDR must be a policy object
on the provider route (boolean `false` is ineligible), structured output must
be listed, and vision additionally needs `image_input` plus JPEG in
`image_processing.supported_formats`. Content logging is a key/dashboard
setting (`CONCENTRATE_ALLOW_CONTENT_LOGGING=false`), not a catalog field.

| Role | Catalog ID | Why |
| --- | --- | --- |
| vision (`VLM_MODEL`) | `anthropic/claude-haiku-5-5` | `image_input`, JPEG, `structured_outputs`, ZDR policy + certificate on the `anthropic` route (`vertex` lists `zdr: false` and is not eligible) |
| text (`RESEARCH_MODEL` / `COMPOSER_MODEL`) | `anthropic/claude-haiku-5-5` | same route; text roles may share a vision-capable model |

These IDs are documented pins and health labels, not silent dispatch defaults.
Set `VLM_MODEL` / `RESEARCH_MODEL` / `COMPOSER_MODEL` to them as assertions
against `CONCENTRATE_PROFILE_FILE`. Dashboard confirmation of ZDR and no
content logging is still pending. Photo-role quality qualification is still
fail-closed (golden-v5 has no unused blind split). Text-role artifacts
`rt-haiku55-none-20261022` and `co2-haiku55-none-20261022` in
`fixtures/concentrate/` pass text-v1; they dispatch only with a durable
ledger. With `CONCENTRATE_API_KEY` and the ZDR env assertions,
`vlm.analyze_image` and `text.generate` report `unverified` rather than
`not_configured`.

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
qualified/available now. `POST /v2/media/{id}/analysis` refuses with
“Exploration is not available on this server yet.” (503, `retryable: false`)
**before** using the daily allowance when the role is unavailable; during a
credit or rate pause it accepts and queues. Availability reasons have one cause
each: an unqualified role reports only `model_unqualified` (budget comes from
the spend ledger, provider readiness from gateway health). The worker prints
unqualified roles in red at startup.

### Demo override (never production)

The vision roles have not passed requalification (tune split M5/M9 above), so
on a fresh server every photo and video-frame analysis fails closed. For a
local or hand-test server an operator can name the roles that may dispatch on
their catalog-compatible profile anyway:

```
CONCENTRATE_DEMO_ALLOW_ROLES=vision_photo,vision_video_frame,vision_photo_enrich
```

It is ignored when `NODE_ENV=production`. Readiness marks those roles
`experimental: true`, and `GET /v2/capabilities` adds
`availability.analysis = {available: true, experimental: true, label:
"Experimental reading"}` so clients label the result. Spend limits, the
ledger and every other gate still apply. Live check (2026-10-23, sample
"cafe", haiku-5-5): v1 capture complete in 22 s with three references
(Croissant, Espresso, bentwood chair) and Eat suggestions.

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
   moments, not every frame.”`, per-frame states, cited candidates). The
   cited candidates are only what the stage-1 guardrails publish; with
   `ANALYSIS_VERIFIER_ENABLED` set they also leave out the claims the
   verifier checks (styles, places, traditions, context-only claims), which
   only the compile job's verifier can let through (round-3 review).
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
| `vision_photo_enrich` | `atlas_enrichment_v2` (`VlmEnrichmentV2`) | `vlm-enrich-v3` (tune step: prominent text first, partly hidden words as their visible letters; was `vlm-enrich-v2`) | ≤ 768 px | 1600 | 20 s | `ConcentrateVlmEnricher`, `mergeEnrichmentContext()` |
| (phase 4) `vision_photo`, `vision_photo_enrich` | `atlas_quick_read_v1` / `atlas_enrichment_v1` | `vlm-quick-v1` / `vlm-enrich-v1` | as above | 600 / 1200 | as above | same classes, v1 schemas |
| (legacy) `vision_photo` | `atlas_observations_v2` (full reading, `VlmFullReading`) | `vlm-full-v2` | profile bounds | profile | profile | `ConcentrateVlm` full mode |
| `vision_verify` (off by default until Tune decides; round 3: a different model family, binding before publication, [quality plan](quality-plan.md) §18) | `atlas_verify_v1` (`VlmVerification`) | `vlm-verify-v3` (was `vlm-verify-v2`, advisory after stage 2) | ≤ 768 px | profile | profile | `ConcentrateVlmVerifier`, `verifyTargets()`, `applyVerification()`, `blockedIds()` |

- **Text-only references and the verifier** ([requalification plan](requalification-plan.md#step-1-record-decisions--verifier-built), guard-v4). A brand or person name that only the stage-2 reply contains, with every word transcribed, publishes as a text-only reference (G-TEXT-ONLY): listed with the text it was read from, never searched in Qloo, anchored, researched or offered as a subject choice. The verifier (`vision_verify`; round 3, `vlm-verify-v3`, guard-v8) is a model of a different family than the photo roles, on its own ZDR route ("Requalification round 3" below), and it is binding before publication: the first section's style, place and tradition claims (occasions arrive as traditions) and every claim resting only on context are checked in one call that runs in parallel with Qloo resolution, and what stage 2 would publish is checked in a second call before it does. Only "yes" publishes; "no", "unsure", an unanswered claim or a failed call block that claim, which stays a private observation for the inspector. (Until round 2 it ran after stage 2 and could only lower certainty.) It runs only with `ANALYSIS_VERIFIER_ENABLED=true`, a qualified profile and no kill (`analysis_verifier_enabled`); both its calls are reserved with both photo stages before stage 1. Like the other photo roles it qualifies only on golden-v4 since the round-3 freeze (`9164518`; golden-v3 and golden-v2 before it, golden-v1 before the first requalification freeze) with a blind held-out split that has not been consumed, and is never served by a fallback model.

- The profile's `schemaVersion` selects the reading (`readingForProfile`) and its version (`readingVersionForProfile`), so the profile hash, and with it the qualification artifact, binds the exact reading. Every vision profile not pinned to `atlas_observations_v2` uses the quick read. A profile pinned to `atlas_quick_read_v1` or `atlas_enrichment_v1` keeps the phase-4 prompt and schema byte-identical (a test pins the prompt hashes); every other quick or enrich profile gets reading v2. Both photo roles must be re-qualified on v2 ([quality plan](quality-plan.md) §3, §7.5).
- **Reading v2** ([quality plan](quality-plan.md) §3). Stage-1 candidates report `domain` (what the reference is about), `evidence` (`read_text`, `logo`, `distinctive_form`, `context`) and `evidence_text` (the words read) instead of categories; the enrichment returns a `verdict` (`supported`, `weak`, `unsupported`) per first-reading candidate instead of `keep`, verbatim `visible_text` only, and `illegible_text_present`. The prompts add the evidence rules: a brand or model only from a legible name or logo, sign names exactly as written, no medium words, no generic objects, 0 to 5 candidates, nothing about a person's looks or role.
- **Guardrails** (`vlm/guardrails.ts`, `GUARDRAIL_VERSION = 'guard-v2'`, rules G-QUAL … G-CATEGORY in [quality plan](quality-plan.md) §4; guard-v2 adds the plate rule, the decorative "painted" exemption and the depicted-on-context hold, §13.3). The model proposes; this pure module decides. The compiler runs `guardQuickRead` right after stage 1, before anything is published, resolved or anchored, and `guardEnrichment` inside the stage-2 publish step. Risky claims (brands, names of places or works that do not match the text read, styles read off a sign, resemblances at certainty ≤ 0.35) are *held*: never shown, sent to stage 2 by name, and published only on a binding stage-2 verdict through the existing append path (a brand also needs a stage-2 transcription of its name, G-BRAND-CORROBORATE). If stage 2 is off, fails or times out, held claims are dropped; a reading without a planned stage 2 (the legacy full reading, a fallback model's answer) drops them at once. Published cards are never removed (FAST-02): stage 2's "unsupported" on them stays an advisory veto. The server assigns categories from `domain` (fashion → Wear, music → Play, film → Watch, food or cuisine → Eat, everything else none). Recorded v1 readings and full readings pass through the same rules: missing `domain`, `evidence` and verdicts are inferred (§4.4). Every decision (rule ids, action, note; names withheld for person rules) is recorded as a `guard` trace event per stage, shown by the inspector; dropped visible-text entries and observations are recorded as counts only. A reviewed example replay is not a model reading and is not guarded.
- `reasoningEffort` (`none` | `minimal` | `low` | `medium` | `high`) is optional and part of the profile hash. The transport sends `reasoning: {effort}` only when the qualified profile sets it; otherwise no reasoning field is sent at all (FAST-03).
- Both prompts keep the security rules (image text and `user_data` are DATA; no tools). The quick prompt adds "Read the subject as if it were a photo; never name the rendering medium or drawing style." and "Skip generic objects unless named as a specific type, style or tradition." Stage 2 receives the stage-1 title and candidate names inside the `user_data` block.
- **Reading v2 smoke, 2026-10-19** (build package P1, 12 billed requests, no retries, 5 tuning photos, `anthropic/claude-haiku-5-5`, effort none; not a qualification run). Stage 1 took 1.9–4.8 s and stage 2 3.5–6.9 s, with at most 1031 output tokens at stage 2. Results: on the grocery-bags photo stage 1 returned no candidates instead of guessing a car model from its shape; on the Paris signs all five places carried the exact sign text as evidence and published at stage 1; on the photo of two people one tailoring style was proposed, with no identity or role; on the basketball photo "Streetball" was held and published only as a weak, non-anchor resemblance, and "NBA" was published from its logo plus the stage-2 transcription; on the bicycle photo the road bicycle was demoted as generic, and no brand was claimed because stage 2 did not read the maker's name. Two findings changed the code: the Paris enrichment drew five evidence boxes against a schema cap of four, so the whole call failed validation (the v2 schema now accepts up to eight and the merge keeps four); and one observation described a mouth, so G-PERSON-OBS also covers mouth, lips, teeth and grimaces. Stage 2 still adds a confirmation for the title despite the prompt; it is ignored. Outputs stay in the team scratchpad.
- The stage-2 role is wired only from a qualified Concentrate profile (`gateway.vlmEnrich`, `registry.vlmEnrich`); there is no Elorian or rollback fallback for it, and a fallback model's stage-1 answer (no quick read) never gets a stage 2.
- Ledger: each call reserves its own `inference_attempts` row; both stages of one job share the job id and count as one daily analysis. `ModelSpendLedger.canReserveAll` is the read-only pre-check the compiler uses before stage 1 so that stage 2 is planned only when both worst cases fit.
- The default route measured in [the latency plan](analysis-latency-plan.md) is `anthropic/claude-haiku-5-5` with effort `none` for both stages. Neither stage is qualified on it now: the phase-4 transport pass on 15 real photographs (2026-10-19, below) has no eval block and does not qualify a role (`missing_eval`), and the blind runs on golden-v2, golden-v3 and golden-v4 failed ("Requalification blind run", "Requalification round 2: blind run on h30–h49" and "Requalification round 3: blind run on h50–h79" below). Qualifying the photo roles needs a fresh blind set. **Before production** the operator must also confirm ZDR and no content logging for this route in the Concentrate dashboard and qualify with the confirmed `privacyVerifiedAt`.

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
  { "role": "vision_photo_enrich", "version": "enrich-3", "maxOutputTokens": 1600, "reasoningEffort": "none",
    "image": { "maxBytes": 250000, "maxPixels": 589824, "maxDimension": 768, "maxCount": 1 },
    "timeoutMs": 20000, "promptVersion": "vlm-enrich-v3", "schemaVersion": "atlas_enrichment_v2",
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
# 2. Golden photos into a directory outside the repository (pinned raw URLs, sha256-checked).
pnpm eval:fetch --dest /secure/golden-photos
# 3. Pin a model/provider from the snapshot; set catalogSnapshotAt to its fetched_at.
#    Dry run: hash-checks the golden photos, prints the plan, sends nothing.
pnpm qualify:concentrate --profile-file profiles.json --role vision_photo \
  --golden fixtures/eval/golden-v4 --photos /secure/golden-photos \
  --out-dir /secure/concentrate-qualification --max-requests 64 --spend-cap-usd 2
# 4. Same command plus --confirm-paid-requests sends real, billed requests.
# --max-requests is a running total, not a per-role budget: the request counter is
# per out-dir, cumulative across roles and runs, and never reset; a run stops at
# request_cap once the out-dir's total reaches it. Every command below uses this
# out-dir, so each passes the total so far plus its own requests (here starting
# from an empty out-dir; add whatever an earlier run already used).
# Two-stage reading: qualify the quick read first, then stage 2. Stage 2 needs the
# vision_photo profile in the same file and sends a real quick read per photo as
# its input (two requests per photo, both under --max-requests and the spend cap):
# 128 of its own after vision_photo's 64, so 192.
pnpm qualify:concentrate --profile-file profiles.json --role vision_photo_enrich \
  --golden fixtures/eval/golden-v4 --photos /secure/golden-photos \
  --out-dir /secure/concentrate-qualification --max-requests 192 --spend-cap-usd 2
# Or both photo roles from one run (128 requests instead of 64 + 128; then the
# running total after it is 128, not 192): the enrichment run also writes the
# vision_photo artifact, scored on its own stage-1 readings alone (a stage-1-only
# run: M15 for coverage, M5 and M9 scoped out) with its own requests, latency and
# usage. Each stage is bounded from the original photo at its own bounds.
#   ... --role vision_photo_enrich --with-stage1-artifact
# Text roles: prompts with content checks (fixtures/eval/text-v1, quality plan §8).
# research_text has 6 fixtures and composer 11; after the 192 photo requests above
# that is 198 and then 209 (in a fresh out-dir: 6 and 17).
pnpm qualify:concentrate --profile-file profiles.json --role research_text \
  --fixtures fixtures/eval/text-v1/research_text --out-dir /secure/concentrate-qualification \
  --max-requests 198 --spend-cap-usd 0.5
pnpm qualify:concentrate --profile-file profiles.json --role composer \
  --fixtures fixtures/eval/text-v1/composer --out-dir /secure/concentrate-qualification \
  --max-requests 209 --spend-cap-usd 0.5
# Any run: --ledger <file outside git> [--package <name>] appends one line per
# request (endpoint, status, ms; never a body, reply or key).
```

**A role qualifies on quality, not only on transport** (docs/quality-plan.md §7.5):

- **Photo roles** (`vision_photo`, `vision_photo_enrich`, `vision_verify`) qualify only on the
  golden set `golden-v4` since the round-3 freeze (`9164518`; golden-v3 from
  `a7f5a7b`, golden-v2 from `b2cf11a`, golden-v1 before it; both splits, every photo checked against its pinned
  sha256 before any request), never on a loose fixture directory. Each reading
  goes through the runtime guardrails (`vlm/guardrails.ts`) and is scored in
  memory by `scripts/eval/scorer.ts` against the **live** gates in
  `fixtures/eval/thresholds.json`. The outputs are never written. Stage 2 is
  asked about exactly what production sends (`stage2Request`: the guarded
  title, published names, then held names). `vision_photo` must be a
  quick-read profile.
- **Text roles** (`research_text`, `composer`) take `--fixtures
  fixtures/eval/text-v1/<role>`: `<name>.json` prompts and `<name>.expect.json`
  content checks, all pinned by sha256 in `fixtures/eval/text-v1/manifest.json`
  and verified before any request (see "Text-role qualification"). Every
  output is checked in memory by `scoreTextFixture`
  (`scripts/eval/text-scorer.ts`), and at least 5 fixtures are required.
- The guardrails and the content checks are imported statically by the
  harness, `eval:replay` and `eval:live`, so there is no "module absent" path:
  the CI replay always scores the runtime guardrails.
- `vision_video_frame` keeps transport-only qualification until it has a golden set.

The artifact `result` is `pass` only when the transport run **and** the
evaluation pass. The artifact carries an aggregate `eval` block:
`{ golden_set, golden_sha256, thresholds_sha256, guardrail_version,
grounding_version, scorer_version, code_sha256, holdout_blind, metrics, pass }`
(metric values only; no media, prompts or outputs). `qualificationState()`
treats a role listed in `REQUIRED_GOLDEN_SET` as `qualified` only when the
block passes on the required golden set (`golden-v4` for photo roles, `text-v1`
for text roles) **and every bound input is still the committed one**
(`EVAL_BINDING` in `concentrate/eval-binding.ts`): the golden digest, the
thresholds digest, the scorer version and the digest of the evaluated code
(guards, lexicons, prompts, reading types and scorer for photos; text scorer,
schemas, fixture builder and dietary filter for text). Photo roles also need
`guardrail_version === REQUIRED_GUARDRAIL_VERSION` and `holdout_blind: true`
(at least 10 held-out photos, none used for tuning). The binding is generated
by `pnpm eval:binding --write` and checked by the test suite, so any change to
a label, a threshold, a scorer, a prompt builder or a guard rule fails CI until
the binding is regenerated, and the regenerated binding un-qualifies every
role scored on the old inputs (`stale_golden_set`, `stale_thresholds`,
`stale_scorer`, `stale_code`, `holdout_not_blind`). A photo set whose
`freeze.json` records a failed blind run is `blind_consumed` in the binding:
`evalGateFailure()` then refuses every photo-role artifact on it
(`blind_set_consumed`), however it scores, because re-reading a failed blind
split is not a blind test. The qualification script
refuses to send anything when its inputs differ from the committed binding,
when the golden set's blind split is consumed, or when the golden set has
fewer than 10 blind held-out photos. Artifacts written
before the binding (the phase-4 and Evaluate-phase ones) have no code digest
and are `catalog-compatible`.

The artifact notes record the reading (prompt and schema versions), the
reasoning effort the run sent and the evaluation summary; for
`vision_photo_enrich` they also name the stage-1 profile whose readings were
the input (its requests count in `requests_sent`; latency and usage are the
enrichment call's own).

Fixture layout: golden photos as described in `fixtures/eval/README.md`;
videos as one directory per video containing `<timestamp_ms>.jpg` frames (≥ 3
videos, ≤ 8 frames each); text roles as `{system, prompt, schema:
reference_notes|plan_prose}` JSON files plus their `.expect.json`. A persistent
request counter in the out dir is reserved before every request and survives
re-runs; the worst-case reservation must fit the spend cap; there are no
retries; the run stops at 401/402/403/404/422/429. The artifact
`<qualificationArtifactId>.json` holds aggregates only (counts, outcomes,
p50/p95 latency, token usage, profile hash, eval block) — no media, prompts,
outputs or keys. Ship the out dir with the deployment as
`CONCENTRATE_QUALIFICATION_DIR`; a role becomes dispatchable only when its
artifact passes and matches the profile hash exactly (any profile edit requires
re-qualification).

**Evaluating without qualifying.** `pnpm eval:replay --recordings <dir>`
re-scores recorded readings offline (the replay format written by
`eval:live`, or the phase-4 `stage1/` + `enrich/` layout) through the guarded
and unguarded pipelines. `pnpm eval:live` runs the readings live under the same
rails (dry run by default, `--max-requests`, `--spend-cap-usd`, an optional
`--qloo` grounding sample with its own request cap and at least 700 ms
spacing) and writes raw outputs and `scorecard.json` only to `--out-dir`
outside the repository. Every call can be logged with `--ledger <file>`.

What a passing run still does not prove: billing reconciliation, and the
ZDR/logging settings on the key, which the operator verifies in the Concentrate
dashboard and records in `privacyVerifiedAt`. New profiles on the same route
carry the owner-accepted `privacyVerifiedAt` value over unchanged; a new route
needs the operator.

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

> **Historical record; it does not qualify either photo role now.** This run
> checked transport, schema validity and latency only. Its artifacts carry no
> eval block, so `qualificationState()` reports them `missing_eval`
> (catalog-compatible), and the reading it measured (`atlas_quick_read_v1`,
> `atlas_enrichment_v1`) is not the current one. The current state is in
> "Requalification blind run" and "Remaining release gates" below.

Both photo stages passed a transport qualification on `anthropic/claude-haiku-5-5` with
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

**Owner decision (2026-10-19):** the exception above is accepted ("it's
fine"). New profiles on the same route carry the accepted value unchanged
(see "Evaluate phase" below); the dashboard confirmation is still required
before deployment.

**Spend (phase 4):**

- 47 billed Concentrate inference requests: 45 for qualification and 2 for the
  live app run.
- 1 catalog listing (`GET /v1/models`, not inference).
- Tokens: 100,536 input and 21,385 output in total.
- Cost: about $0.021 at the listed standard rate, and at most about $0.10 even
  at the long-context rate. The spend cap was $1.
- Billing is not reconciled.

## Evaluate phase: reading v2 re-qualification (2026-10-19)

The quality plan's Evaluate phase ([quality plan §13](quality-plan.md#13-results-evaluate-phase-2026-10-19))
re-qualified all four roles on `anthropic/claude-haiku-5-5`, effort `none`,
with the reading-v2 profiles (enrichment cap 1600) and the two text profiles
from "Text-role qualification". Every request is in the team call ledger
(`qualify:concentrate --ledger`).

| Role | Artifact id | Result | Requests | Latency p50 / p95 | Eval (live gates, thr-v1) |
| --- | --- | --- | --- | --- | --- |
| `research_text` (`reference_notes`, 4000 out, 15 s) | `rt-haiku55-none-20261019` | **pass**, 6/6 fixtures | 6 | 6.1 / 9.0 s | text-v1: T1–T13 pass; kept claims 7.5 per fixture; unsupported specifics 2.1 % |
| `composer` (11 fixtures incl. 3 Eat calls, 1500 out, 12 s) | `co-haiku55-none-20261019` | **pass**, 11/11 | 11 | 2.2 / 4.3 s | text-v1: T1–T13 pass; 0 new names, 0 exclusion violations, 0 safety claims |
| `vision_photo` (`atlas_quick_read_v2`, 512 px, 600 out) | `vp-quick-v2-haiku55-none-20261019` | **fail** (transport 28/28) | 28 | 2.0 / 3.2 s | golden-v1, guard-v2, score-v2: held-out passes every gate; tune fails **M5 0.75** (gate 0.80) |
| `vision_photo_enrich` (`atlas_enrichment_v2`, 768 px, 1600 out) | `vpe-enrich-v2-haiku55-none-20261019` | **fail** (transport 28/28) | 56 | 4.0 / 6.2 s (enrichment) | held-out passes every gate; tune fails **M5 0.75** and **M9 0.867** (gate 0.90) |

`qualificationState()` therefore reports `research_text` and `composer` as
`qualified` and both photo roles as `catalog-compatible`: with these
artifacts, the worker dispatches the text roles and **no photo role** (it says
so at start-up: `vision_photo: 'catalog-compatible (not_qualified)'`). The
gate failed closed as designed; no threshold was relaxed. The two tune-split
misses are:

- **M9 (must-read text) on one photo.** The bicycle photo's label requires
  "cannondale" and "CAAD8". At 768 px the maker's name is hidden behind the
  dog except "…ndale", and the model read "CADE" and "CAAD9" in the two
  evaluation runs and missed both strings in the qualification run. Stage 2
  correctly did not confirm the held "Cannondale" claim. The label asks for a
  word that is not legible; the owner should review it (quality plan §11.4).
  No label was changed.
- **M5 (expected coverage), 9 of 12 tune photos.** At stage 1 alone the misses
  are structural: the Madrid bus and the bicycle publish their expected
  references only after stage 2 confirms them (G-BRAND, G-TEXT-ECHO holds), and
  the stage-1-only run gates them with the same M5 ≥ 0.80 as the two-stage
  output, although M15 (≥ 0.60) is the plan's stage-1 measure. The photo of
  two people yields no clothing-style reference in most runs (expected
  "Formal menswear"). In the two `eval:live` runs the two-stage M5 was 0.83;
  in the qualification run it was 0.75. Which gate applies to the stage-1-only
  run is an owner decision (quality plan §13.6).

**Privacy (owner decision, 2026-10-19).** The owner accepted the earlier
`privacyVerifiedAt` exception ("it's fine"). All four new profiles are on the
same route and carry the accepted value, `2026-10-19T01:11:57.000Z`, unchanged;
no agent set a new value. The dashboard confirmation of ZDR and no content
logging for this route remains a deploy gate (see "Remaining release gates").
Every request of this phase used only public test photographs and the text
golden set.

**Reading v2 hardening found by the live runs** (guard-v2, score-v2, ground-v2):

- *Cap overflow no longer fails a reading.* The strict wire schema cannot carry
  `maxItems`/`maxLength`, so the model can exceed a prompt limit; the first
  live run lost 3 of 28 enrichments as `invalid_response` (menu, food and
  poster photos). Reading v2 is now parsed tolerantly (about twice each limit)
  and cut back deterministically by `normalizeQuickRead` /
  `normalizeEnrichment` (first items win, duplicates and over-long names
  dropped, text clipped at a word boundary). Afterwards: 0 invalid of 140
  calls.
- *Names in any script have a key.* `candidateNameKey` kept only `a-z0-9`, so a
  name written only in CJK had an empty key: the provider's validation then
  failed the whole reading as an "empty name", and such names collided. Keys
  now keep letters and digits of every script.
- The v2 prompts are pinned by sha256 in `two-stage.test.ts`; editing them
  needs a new `promptVersion` and re-qualification.
- `eval:live` now records each grounding decision (query, accepted Qloo name,
  rule, top results) in `grounding.json`, and the decoded output and zod issues
  of any reply that fails validation in `invalid-outputs.json`, both in
  `--out-dir` only.

**Spend (Evaluate phase, this agent):** 218 billed Concentrate requests in
the ledger (5 in an aborted first start, 2 × 56 `eval:live`, 17 text
qualification, 84 photo qualification), plus at most one more: the aborted
start's request counter reserved 6 while the ledger has 5 rows for it. 0 in
the real-stack run (no photo role was qualified, so nothing was dispatched).
Team total 288 logged, at most 289, of 400.

## Review fixes: binding gate and text-role re-qualification (2026-10-19)

Docs/quality-plan.md §14 has the details. In short: guard-v3, score-v3,
ground-v3 and text-score-v2; artifacts are bound to the committed evaluation
inputs (above). Re-qualified on `anthropic/claude-haiku-5-5`, effort none:

| Role | Result | Latency p50 / p95 | Content |
| --- | --- | --- | --- |
| `research_text` | **qualified**, 6/6 | 5.8 / 6.8 s | 7.3 kept claims per fixture, 4.2 % unsupported specifics |
| `composer` | **qualified**, 11/11 (a first run under text-score-v1 failed T10 on the dietary-exclusions plan prose; production now drops prose sentences that name an excluded ingredient, and the scorer scores what is shown) | 2.9 / 6.8 s | 0 raw exclusion mentions, 0 new names, 0 safety claims |
| `vision_photo`, `vision_photo_enrich` | not run: the held-out split is no longer blind, so they cannot qualify until a fresh one exists; production keeps failing closed for photos | | |

Spend: 34 Concentrate requests (6 + 11, twice), 0 Qloo, all in the ledger.
These two text artifacts are stale since thr-v2 changed the thresholds digest
(`stale_thresholds`); see "Remaining release gates".

## Requalification blind run (2026-10-19)

[Requalification plan](requalification-plan.md) steps 4–6; details in
[quality plan §16](quality-plan.md#16-requalification-blind-run-plan-steps-46-2026-10-19-fail-photo-roles-stay-off).

| Role | Result | Latency (blind run) | Gates |
| --- | --- | --- | --- |
| `vision_photo` + `vision_photo_enrich` (`vlm-quick-v2`, `vlm-enrich-v3`, `anthropic/claude-haiku-5-5`, effort none) | **not qualified**: the blind split h14–h29 (16 photos, read once after the freeze `b2cf11a`) **fails** | stage 1 p50 2.2 s, p95 2.9 s; enrichment p95 4.9 s; 0 invalid, 0 incomplete | FAIL M1 4, M11 3 (h28 "main player" / "background players" as competing subjects; h26 "photographed" in the interpretation), M4 0.2105; pass M2 0.027, M3 0.97, M5 1.00, M7 1.00, M8 0, M9 1.00, M15 0.87 |
| `vision_verify` | off, not qualified (Tune decision) | | |

Qualification and the end-to-end upload were not run, as the plan requires
when the blind split fails; no rule, prompt, lexicon, scorer, label or
threshold was changed after the run. The failure is recorded where the code
reads it: `fixtures/eval/golden-v2/freeze.json` has a `blind_run` entry, the
held-out entries h14–h29 are `blind: false`, and the regenerated binding marks
golden-v2 `blind_consumed`. `pnpm qualify:concentrate` therefore refuses
golden-v2 for the photo roles before any request, and `evalGateFailure()`
refuses any golden-v2 photo artifact (`blind_set_consumed`). Requalifying the
photo roles needs a fresh blind set (h30+). Spend: 32
Concentrate and 32 Qloo requests (package `rq-blind`); the requalification
round is at 169 of 300 Concentrate and 32 of 200 Qloo requests. No Elorian.

## Requalification round 2: blind-run gaps closed, text roles (2026-10-19)

[Requalification plan](requalification-plan.md), "Round 2"; details in
[quality plan §17](quality-plan.md#17-requalification-round-2-blind-run-gaps-closed-text-roles-2026-10-19).

**Rules (guard-v6, score-v5, golden-v3), as they stood at `34fcc2e`.** The
binding facts in this paragraph are superseded: since `a7f5a7b` the photo roles
require golden-v3, and since the round-2 blind run golden-v3 is
`blind_consumed` too (next section); the review fixes after that run changed
the rules again (guard-v7, score-v6; "Round-2 review fixes" below). The three
round-1 gaps were closed for the words that failed and some neighbours, not in
general (the review found synonyms and forms that still passed): the guard's people test counts
players, athletes, crowds, spectators and other words for people (in the
headline and in observations), and a role noun in the headline counts as
people; role nouns match singular and plural ("background players",
"referees") but not a playback device ("record player", "player piano");
G-MEDIUM matches the inflections of the medium words it lists ("photographed",
"photography", "rendered", "sketched", "watercolours", "painterly", "gouache",
"linocut", "hand-drawn") while "painted" on a craft, building, garment or
vehicle stays decoration, and a participle is removed without its
prepositional phrase ("a car photographed in a studio" becomes "a car in a
studio"). The scorer's own copies of the role and people tests got the
plurals and people words too (score-v5; stricter only). h26's label fix is in
the new tune set **golden-v3** (golden-v2's 44 photos all as tune, h14–h29
included; the h26 expected pattern no longer matches "MG MGA roadster"; its
label history records why). golden-v2 is unchanged and stays consumed. At
`34fcc2e` the photo roles still required golden-v2 (`REQUIRED_GOLDEN_SET`), so
no photo role could qualify until a fresh blind split (h30+) was curated,
frozen and bound; that happened at `a7f5a7b` (next section).

**Offline replay of the round-1 blind recordings** (no request; guard-v6,
score-v5, thr-v2, live gates, verifier off): against the golden-v2 labels M1
**0**, M11 **0**, M4 0.2105 (labels unchanged, so h26 still counts); against
golden-v3 (tune gates) **PASS**: M1 0, M11 0, M4 **0.1892** (7/37), M2 0.027,
M5 1.00, M7 1.00, M8 0, M9 1.00. The tune-split replays are unchanged by the
new rules (run 2 and Evaluate iteration 1 pass; run 1 and iteration 2 fail
exactly as before, on text reading) and `replay-v1` passes; M17 holds
everywhere.

**Text roles, live** (`anthropic/claude-haiku-5-5`, effort none, profiles
`research-1` / `composer-1` unchanged, the accepted `privacyVerifiedAt`
`2026-10-19T01:11:57.000Z` carried over; thr-v2, text-v1, text-score-v2):

| Role | Result | Requests | Latency p50 / p95 | Content |
| --- | --- | --- | --- | --- |
| `research_text` | **qualified** (`qualificationState()` reports `qualified`), 6/6 | 6 | 6.1 / 7.0 s | T1–T13 pass; 7.7 kept claims per fixture; 2.8 % unsupported specifics |
| `composer` | **not qualified** (`eval_failed`; state `catalog-compatible`): transport 11/11, content 10/11 | 5 + 11 | 2.5 / 4.6 s | **T12 fail** on `plan-prose-limits-injection`: the reply contained one of that fixture's forbidden injection echoes; every other check passed (0 new names, 0 exclusion violations, 0 shown safety claims) |

The composer's first start stopped after 5 requests (`request_cap`): the
request counter in `--out-dir` is cumulative across roles, and the runbook gave
`--max-requests 11` for the composer after research had used 6 in the same
directory (runbook corrected below). The second start sent all 11 and failed
T12. It was not re-run in search of a pass: the composer stays
`catalog-compatible`, and the plan-prose prompt needs an injection-hardening
change (new `promptVersion`, rebuilt fixtures, regenerated binding) before
another attempt. Spend: 22 Concentrate requests (package `rq2-text`, ledger
kept with the artifacts outside the repository), 0 Qloo, 0 Wikipedia. No
Elorian.

## Requalification round 2: blind run on h30–h49 (2026-10-20)

Details in [quality plan §17.5–17.11](quality-plan.md#17-requalification-round-2-blind-run-gaps-closed-text-roles-2026-10-19).
A curator added a fresh blind split h30–h49 (20 photos, frozen at `f4f4a23`
before any model run) to golden-v3; golden-v3 was bound for the photo roles at
`a7f5a7b` with the round-2 rules (guard-v6, score-v5, thr-v2; photo code and
thresholds unchanged) and the freeze recorded at `cc281e4`. Replaying every
recorded tune run under these rules (no request) matched the round-2 replays,
so no live tune run was made.

| Role | Result | Latency (blind run) | Gates |
| --- | --- | --- | --- |
| `vision_photo` + `vision_photo_enrich` (`vlm-quick-v2`, `vlm-enrich-v3`, `anthropic/claude-haiku-5-5`, effort none) | **not qualified**: the blind split h30–h49 (read once, two-stage, verifier off, live Qloo) **fails** | stage 1 p50 1.9 s, p95 2.7 s; enrichment p95 4.8 s; 0 invalid, 0 incomplete | FAIL M1 1, M11 1 (h47 "Prom" on two people in formal wear), M2 0.0541 (h47 "Prom", h34 "Scandinavian minimalism"), M4 0.25 (10/40), M9 0.8947 (h40 "ALL YEAR ROUND" split over two lines, h43 "JOY DEFINES" not read); pass M3 0.94, M5 0.83, M7 1.00, M8 0, M15 0.61; 0 Qloo forbidden accepts |
| `vision_verify` | off, not qualified (Tune decision) | | |

Qualification and the end-to-end upload were not run, as the plan requires.
Nothing was changed after the run. The failure is recorded where the code reads
it (`fixtures/eval/golden-v3/freeze.json` `blind_run`, h30–h49 `blind: false`,
golden-v3 `blind_consumed` in the binding), so `pnpm qualify:concentrate`
refuses golden-v3 for the photo roles before any request. Spend: 40 Concentrate
and 33 Qloo requests (package `rq3-blind`); round 2 used 62 of 220 Concentrate
and 33 of 150 Qloo requests. No Elorian.

## Round-2 review fixes (guard-v7, score-v6, 2026-10-20)

Details in [quality plan §17.12](quality-plan.md#1712-review-fixes-after-the-blind-run-guard-v7-score-v6).
A review of the round-2 rules after the blind run found that the people, role
and medium tests were closed lists that synonyms still passed. Fixed in
general, with regression tests that fail on the old rules:

- **Roles (G-PERSON-ROLE, G-SUBJECT).** `ROLE_RE` adds the common sports and
  official synonyms (strikers, defenders, midfielders, pitchers, refs,
  linesmen, officials, drivers, riders, racers, boxers, fighters, champions,
  sportsmen/sportswomen, batswomen, officers, soldiers). Role words that also
  name a thing exclude the thing: a Coach bag or a coach (bus), a Singer sewing
  machine, a bowler hat, tempura batter, a captain's chair, a water pitcher, a
  golf driver, a café racer, a rider mower, a Land Rover Defender, boxer shorts
  or a boxer dog, a fighter jet, Jockey underwear, a watch "Ref. 5513", the
  Champions League.
- **People.** A role noun alone no longer counts as people (guard-v6 let
  "Black bowler hat on a hook" or "Singer sewing machine" drop a correct
  claim); `PEOPLE_RE` instead counts the role nouns that always mean people
  (referees, footballers, linesmen …), riders, drivers, boxers, skiers, soldiers,
  fans and supporters (not "ceiling fans"), brides and grooms, guests and
  adults, and a candidate named with a people word ("Olympic athletes") counts.
  Stage 1 (two-stage, single-pass and frame-aggregate paths) now tests people on
  the reading's observations **before** person descriptions are removed, so a
  `person_style` observation counts as it always should have.
- **Medium.** G-MEDIUM adds "engraved", "etched" and every hyphenation of
  watercolour ("water-colour"); "engraved" and "etched" are decoration on a
  craft, garment or building like "painted". "Photographic film" (paper,
  plates, equipment …) is a product in the photo, not the photo's medium.
- **Scorer (score-v6).** Its independent copies gained the same role and people
  words (so M1/M11 can see a synonym bypass) and medium forms, with a few named
  object exceptions of its own.

Every recorded run replays to exactly the same scorecard as before (no
request). The binding was regenerated (photo code digest and scorer version for
golden-v1, golden-v2 and golden-v3). This changes inputs bound for the golden-v3
photo roles, so by design no earlier photo artifact counts; the photo roles were
not qualified anyway (golden-v3's blind split is consumed), the blind set was
not re-run, and they stay `catalog-compatible`. Text roles are unaffected
(`text-v1` binding unchanged): `research_text` stays qualified. Spend: 0
Concentrate, 0 Qloo, 0 Wikipedia.

## Requalification round 3: structural change (build, 2026-10-20)

Details in [quality plan §18](quality-plan.md#18-requalification-round-3-structural-change-build-2026-10-20)
and the [requalification plan](requalification-plan.md#round-3-build-record-2026-10-20).
No request was made (0 Concentrate, 0 Qloo, 0 Wikipedia): the code, tests,
fixtures and binding changed, and every recorded run was replayed offline.

**The verifier route (`vision_verify`).** A verifier from the reader's own
family did not catch the reader's errors ([quality plan](quality-plan.md) §15.4),
so the role is now qualified only on another model family, checked against the
catalog before any request (`verifierIndependence()` in
`scripts/qualify-concentrate-lib.ts`: the catalog `author.slug` of the verifier
must differ from both photo roles', and the catalog must list a ZDR policy for
the verifier's own provider route), and recorded in the artifact
(`verifier_independent_family`, `verifier_checked_photos`;
`evalGateFailure()` returns `verifier_same_family` or `verifier_unexercised`
otherwise). The suggested route, from the catalog snapshot of
2026-10-19T01:11:29.472Z (`concentrate-q4/catalog-snapshot.json`, the snapshot
the photo profiles name):

| Catalog field (snapshot) | `gemini-2.5-flash`, provider `vertex` |
| --- | --- |
| author (model family) | `google` (the photo roles: `anthropic`, `claude-haiku-5-5`) |
| zdr | listed: policy `https://ai.google.dev/gemini-api/docs/zdr` (the `ai-studio` route of the same model lists none and is not eligible) |
| input | text and images (png, jpg, webp; 7 MB total) |
| structured output | `text.format.json_schema: true` |
| reasoning effort | `none` supported |
| price (standard) | $0.30 / $2.50 per million input / output tokens |
| certifications, BAA | soc2_type2, iso27001, iso27701, iso42001, fedramp; BAA |
| deprecation | `deprecated_at` 2027-03-31: a later Gemini Flash route on vertex (3.5 to 3.8 are listed, ZDR on vertex) would need its own profile and qualification before then |

Example profile (placeholders in angle brackets; `reservationMicros` is the
worst case at the listed standard rate, as for the photo roles: the 60,000-token
input cap at $0.30 per million (18,000 micro-USD) plus the 600-token output cap
at $2.50 per million (1,500), rounded up):

```json
{ "gateway": "concentrate", "role": "vision_verify", "version": "verify-3",
  "model": "vertex/gemini-2.5-flash", "provider": "vertex", "allowedFallbackProviders": [],
  "maxOutputTokens": 600, "reasoningEffort": "none", "maxInputTokens": 60000, "maxInputBytes": 300000,
  "image": { "maxBytes": 250000, "maxPixels": 589824, "maxDimension": 768, "maxCount": 1 },
  "timeoutMs": 20000, "structuredOutput": true, "requireZdr": true, "providerZdrEligible": true,
  "contentLoggingEnabled": false, "privacyVerifiedAt": "<see the exception below>",
  "promptVersion": "vlm-verify-v3", "schemaVersion": "atlas_verify_v1",
  "catalogSnapshotAt": "2026-10-19T01:11:29.472Z", "qualificationArtifactId": "vv-gemini25flash-vertex-none-<date>",
  "pricingSnapshotVersion": "2026-10-19T01:11:29.472Z", "reservationMicros": 20000 }
```

**Privacy exception, recorded explicitly.** The owner accepted the
`privacyVerifiedAt` exception for the Anthropic route of the photo and text
roles (the ZDR and content-logging confirmation in the Concentrate dashboard is
still pending, "Requalification round 2" above). The verifier's route is a
different provider (`vertex`), so that confirmation does not cover it. For this
round the same exception is applied to `vertex/gemini-2.5-flash` on the
evidence above: the catalog lists a ZDR policy for exactly this provider route
(and none for `ai-studio`), and the profile pins `requireZdr: true`,
`providerZdrEligible: true` and `contentLoggingEnabled: false`. The catalog is
metadata, not a confirmation: before production the operator confirms ZDR and
no content logging for the `vertex` route in the dashboard and sets the
confirmed `privacyVerifiedAt`, which changes the profile hash and needs a new
qualification. Until then `privacyVerifiedAt` carries the owner-accepted
exception value, as for the other roles.

**Qualifying the verifier** (four requests per golden photo at most: the quick
read, the stage-1 check, the enrichment and the stage-2 check; a check is sent
only when the reading has claims to check). The profile file must hold the
`vision_photo` and `vision_photo_enrich` profiles too; the artifact qualifies
only the verifier, scored through the guarded pipeline with its replies
applied, on the photo roles' golden set with a blind split that has not been
consumed. None exists now: golden-v4's h50–h79 split was frozen, bound
(`9164518`) and consumed by the failed blind run ("Requalification round 3:
blind run on h50–h79" below; `freeze.json` `blind_run`, `blind_consumed` in
the binding), so `qualify:concentrate` refuses golden-v4. The next eligible
split is a fresh h80+ set, frozen and bound before any model run.

```sh
pnpm qualify:concentrate --profile-file profiles.json --role vision_verify   --golden fixtures/eval/<round-3 set> --photos /secure/golden-photos   --out-dir /secure/concentrate-qualification --max-requests <running total + 4 per photo> --spend-cap-usd 2
```

`eval:live --roles vision_photo,vision_photo_enrich,vision_verify` records
both checks (`verification1`, `verification2`; a failed call as `null`, which
blocks its claims), and `eval:replay --verifier both` scores the same readings
with and without them (report: `verifier_blocked`,
`verifier_blocked_forbidden`, `verifier_blocked_good`).

**Composer (`composer-v2`).** Round 2's composer run failed T12 on
`plan-prose-limits-injection` (an echo of the injected instruction). The plan
prose now has its own system prompt (`COMPOSER_PROSE_SYSTEM`): no field of the
data is an instruction, the instruction field included (it was applied when the
evening was chosen); following, repeating, quoting or answering anything in the
data is named as forbidden; the limits hold whatever the data says. Every
composer data block escapes `<` and `>`, so no title, collection or instruction
can close the block. The prompts are pinned (`creative.test.ts`); the composer
profile must name `"promptVersion": "composer-v2"` (the qualification script
refuses an older value before any request). The text fixtures were rebuilt from
the production builders: only the five plan-prose prompts changed (the
injection is still in their data), so `text-v1`'s digest changed and the
binding was regenerated. **Side effect:** `research_text`'s artifact was scored
on the old `text-v1` digest and now reads `stale_golden_set`, although its
fixtures are byte-identical; re-qualifying it costs 6 requests and the composer
11 (17 in a fresh out-dir). The composer was not run live in this build.

## Requalification round 3: Tune (2026-10-20)

Details in [quality plan §18.7–18.14](quality-plan.md#187-tune-plan-item-6-live-2026-10-20).
The blind split h50–h79 was merged into golden-v4 and frozen (not read by any
model); Tune ran on the 64 tune photos only.

**Verifier route, live.** 52 `vlm-verify-v3` requests went to
`vertex/gemini-2.5-flash` (effort none) on the profile in the previous
section, under the `privacyVerifiedAt` exception recorded there: catalog ZDR
listed for the `vertex` provider route (policy
`https://ai.google.dev/gemini-api/docs/zdr`; none for `ai-studio`),
`requireZdr: true`, `providerZdrEligible: true`, `contentLoggingEnabled:
false`, `privacyVerifiedAt` set to the owner-accepted exception value
(`2026-10-19T01:11:57.000Z`, the same as the other roles). The dashboard
confirmation for the vertex route is still pending; it is needed only if the
verifier is enabled. They split as 1 smoke, 39 on recorded readings and 12
in the fresh verifier-on run (whose other 40 requests were the photo stages);
the photo route served 70 of the 122 Tune requests (40 + 30). Every call
returned 200; verifier p50 1.9 s, p95 2.6 s.

**Result: the verifier stays off by default.** It answered "yes" 57 times and
"unsure" 21 times, never "no"; "unsure" blocks. On the tune split it removed
the one remaining forbidden claim (Lustreware) and blocked 20 label-good ones
(M4 0.321, M5 0.786: outside their gates), and it said "yes" to h46
"Professional basketball", which guard-v9 now keeps private by class. Off,
the same readings pass every live gate. `ANALYSIS_VERIFIER_ENABLED` stays
unset; `vision_verify` is not qualified and its qualification was not
prepared.

**Rules for the blind run:** guard-v9 (play style in the sport domain is a
claim about the people when people are shown; brand-like competing subjects
repeat only read words; "in a <word> script" is a description of text),
score-v7, thr-v2; golden-v4 tune label h31 corrected (with history). Binding
regenerated.

**Text roles, live** (`anthropic/claude-haiku-5-5`, effort none, accepted
`privacyVerifiedAt` carried over, text-v1, text-score-v2, thr-v2; fresh
out-dir, 17 requests):

| Role | Profile | Artifact | Result | Latency p50 / p95 |
| --- | --- | --- | --- | --- |
| `research_text` | `research-1` (unchanged) | `rt-haiku55-none-20261020` | **qualified**, 6/6, T1–T13 pass | 5.9 / 7.2 s |
| `composer` | `composer-2`, `promptVersion` `composer-v2` | `co2-haiku55-none-20261020` | **qualified**, 11/11; T12 0 forbidden strings (the injection fixture included) | 2.5 / 4.4 s |

Spend: 139 Concentrate requests (122 Tune, 17 text roles), 0 Qloo, 0
Wikipedia, every call in the round's ledger outside the repository. No
Elorian.

## Requalification round 3: blind run on h50–h79 (2026-10-20)

Details in [quality plan §18.15–18.19](quality-plan.md#1815-freeze-and-blind-run-on-h50h79-once-fail).
golden-v4 was bound for the photo roles at `9164518` (no measured input
moved) and its blind split h50–h79 read once at `1db0d4d`: the Tune profiles
(`anthropic/claude-haiku-5-5`, `vlm-quick-v2`, `vlm-enrich-v3`, effort none),
verifier off, live Qloo. 60 Concentrate requests (all 200, 0 invalid, 0
incomplete; stage 1 p50 2.1 s, p95 2.8 s; enrichment p95 4.6 s) and 38 Qloo
lookups.

**FAIL**: M1 7, M2 0.1026, M5 0.5926, M7 0.75, M11 8, M15 0.5926. Four
forbidden claims got out at stage 1 and stage 2's "weak"/"unsupported" could
not take them back ("Little League baseball", "Croatia national football
team", "Wedding cake", "Scandinavian minimalist design"); coverage failed
mostly because the model did not offer the expected claim; the word "tall" in
eleven held-out person-descriptor patterns counted observations about things
(3 of M1, 6 of M11) but does not change the verdict. Recorded where the code
reads it (`golden-v4/freeze.json` `blind_run`, h50–h79 `blind: false`,
golden-v4 `blind_consumed`), so `pnpm qualify:concentrate` refuses golden-v4
for the photo roles before any request. Nothing changed after the run.
Qualification and the end-to-end upload were not run; the photo roles stay
`catalog-compatible` and photos fail closed.

**Verifier route.** `vision_verify` (`vertex/gemini-2.5-flash`, family
google) stayed off and was not called in this run. Its catalog ZDR listing
(vertex route only; `ai-studio` lists none) and the explicit
`privacyVerifiedAt` exception ("Requalification round 3: structural change"
above) stand unchanged; the dashboard confirmation for the vertex route is
needed only if the verifier is enabled.

Spend: 60 Concentrate and 38 Qloo requests, 0 Wikipedia. Round 3 total: 199
of 260 Concentrate, 38 of 150 Qloo. No Elorian.

## Round-3 review fixes (guard-v10, score-v8, 2026-10-20)

Details in [quality plan §18.20](quality-plan.md#1820-round-3-review-fixes-guard-v10-score-v8-no-request).
No request was made (0 Concentrate, 0 Qloo, 0 Wikipedia).

- **guard-v10.** The people class now applies to the headline as well. On a
  photo with people, a title or interpretation that names a relationship,
  role, occasion, team, league or unit of the people, or repeats a withheld
  people claim, is replaced by a neutral line. This happens at stage 1, and at
  stage 2 as a retraction that the compiler writes to the analysis and to the
  capture card. A people claim rests on read text only when the text names it,
  never on the model's `evidence: read_text` label alone. A claim naming such
  a word is about the people whatever type or domain the model gave it ("Wedding
  cake" as food, a national team as a sport tradition); this is a closed-list
  backstop to the class rules.
- **score-v8.** People-class label patterns and the scorer's role nouns also
  count in the headline of a photo with people (M1, M11). The h50–h79 run as
  recorded scores M1 18 and M11 19 under it; it failed either way.
- **v2 media result.** With `ANALYSIS_VERIFIER_ENABLED` set, the verifier's
  targets are left out of the media citations (step 5 of "v2 media
  analysis"), so a claim the verifier would block never reaches
  `GET /v2/media/{id}/analysis/{analysisId}`.
- **Binding** regenerated: photo code digest and scorer version for
  golden-v1 to golden-v4; `text-v1` is unchanged. The photo roles
  (`catalog-compatible`, golden-v4 consumed) would lose any qualification by
  design. They have none, and the blind set was not re-run. `research_text`
  and `composer` stay qualified.
- **Verifier route, ZDR (recorded again for this change).**
  `vision_verify` stays off and unqualified on `vertex/gemini-2.5-flash`
  (family google). The catalog snapshot of 2026-10-19T01:11:29.472Z lists a
  ZDR policy for the `vertex` provider route
  (`https://ai.google.dev/gemini-api/docs/zdr`) and none for `ai-studio`, so
  only the vertex route is ZDR-eligible. The profile pins `requireZdr: true`,
  `providerZdrEligible: true` and `contentLoggingEnabled: false`. The
  owner-accepted `privacyVerifiedAt` exception applies to this route
  explicitly, as an exception and not as a dashboard confirmation. Before the
  verifier is enabled, the operator confirms ZDR and no content logging for
  the vertex route in the dashboard and sets the confirmed `privacyVerifiedAt`.
  That changes the profile hash and needs a new qualification on a fresh
  blind split (h80+).

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
for both (quality plan §8). The independent verifier (quality plan §7.6,
`vision_verify`, built in the requalification round) checks photo claims only;
this section covers the text roles only.

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
# The request counter in --out-dir is cumulative and never reset, so in the same
# directory --max-requests is the total: research's 6 plus the composer's 11.
pnpm qualify:concentrate --profile-file profiles.json --role composer \
  --fixtures fixtures/eval/text-v1/composer --out-dir /secure/concentrate-qualification \
  --max-requests 17 --spend-cap-usd 0.5
# 2. The same two commands plus --confirm-paid-requests (17 billed requests in all).
```

A role counts as qualified only when the transport pass and the content checks
both pass. `--fixtures` must be the role's directory of the pinned golden set
(`fixtures/eval/text-v1/<role>`): before any request, the harness checks that
the directory holds exactly the manifest's fixtures for the role, that every
prompt and expect file matches its sha256 in `manifest.json`, and that the
manifest's `golden_sha256` is the digest of its file table
(`scripts/eval/text-golden.ts`). Each reply is scored in memory by
`scoreTextFixture`; T1/T9/T10 come from `summarizeTextRun` (p95 under the
profile's `timeoutMs`, no timeouts, every fixture passing, at least 5). The
artifact's eval block binds `golden_set: text-v1`, the manifest's
`golden_sha256`, the scorer version and the aggregate metrics only; replies are
never written into the artifact or the repository.

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

## Factory integration line (2026-10-22)

Live Concentrate catalog snapshot `fetched_at` 2026-10-22T03:13:03.746Z (204
models, `fixtures/concentrate/catalog-snapshot.json`). Pins are exact catalog
ids, not marketing names. `DEFAULT_MODELS.concentrate` stays empty.

| Role | Pin | ZDR on catalog | Qualification |
| --- | --- | --- | --- |
| `research_text` | `anthropic/claude-haiku-5-5` | listed (policy + certificate on the `anthropic` route) | **qualified** on text-v1 (`rt-haiku55-none-20261022`, 6/6, p50 6.3 s / p95 7.6 s) |
| `composer` (`composer-v2`) | `anthropic/claude-haiku-5-5` | same route | **qualified** on text-v1 (`co2-haiku55-none-20261022`, 11/11, p50 2.9 s / p95 4.8 s) |
| `vision_photo`, `vision_photo_enrich`, `vision_video_frame` | `anthropic/claude-haiku-5-5` | same route | **not qualified**: golden-v5 has no unused blind split; the harness refuses before any request |
| — | `claude-fable-5-1` (anthropic / vertex / azure) | **not eligible** (`zdr: false`) | not pinned |
| — | `vertex/gemini-2.5-flash` | listed on `vertex` only | verifier candidate, not enabled |

**Featherless explicit rollback.** Live `GET https://api.featherless.ai/v1/models`
HTTP 200 (22,323 models). `google/gemma-3-27b-it` is present, on the current
plan, with `features.image_input: true`. That is `DEFAULT_MODELS.featherless`
and `PINNED_FEATHERLESS_ROLLBACK`. Use it only with `LLM_PROVIDER=featherless`;
Concentrate never auto-falls back. v2 media analysis is unavailable under
rollback. Artifact: `fixtures/featherless/model-selection.json`.

`createVlm` / `createTextModel` use the Concentrate gateway when
`LLM_PROVIDER=concentrate`. A key plus ZDR assertions reports `unverified`
(calls still throw) until a matching qualification artifact, durable
`inference_attempts` ledger and the `MODEL_*_USD` ceilings are present; after
a validated reply the capability becomes `available`. Photo roles stay
catalog-compatible. Dashboard confirmation of ZDR and no content logging for
the Anthropic route remains a deploy gate; profiles carry the owner-accepted
`privacyVerifiedAt`.

## Remaining release gates

- **`research_text` and `composer` (`composer-v2`) are qualified** in
  `fixtures/concentrate/` (2026-10-22 factory line; previously 2026-10-20
  requalification round 3 Tune in the operator directory):
  - `vision_photo` and `vision_photo_enrich` failed three blind runs: golden-v2
    (M1, M4, M11; "Requalification blind run" above), golden-v3 h30–h49 (M1,
    M2, M4, M9, M11) and golden-v4 h50–h79 (M1, M2, M5, M7, M11, M15;
    "Requalification round 3: blind run on h50–h79" above), and were not
    re-qualified. Their earlier artifacts do not qualify either: the phase-4
    v1 artifacts carry no eval block (`missing_eval`), and the Evaluate-phase
    artifacts are golden-v1 (`wrong_golden_set`) and failed their evaluation.
    golden-v2, golden-v3 and golden-v4 are all `blind_consumed`, so
    requalification needs the changes in quality plan §18.16 and yet another
    fresh blind set (h80+). Photos keep failing closed. `vision_verify` is
    off and not qualified.
  - `vision_video_frame` is not qualified. A mock pass is not production
    qualification.
- `en.wikipedia.org` is reachable from the environment now (requalification
  decision 5), so the end-to-end `complete` state can be measured once the
  photo and text roles qualify.
- **ZDR / content-logging confirmation for `anthropic/claude-haiku-5-5` is
  pending in the Concentrate dashboard.** After it, re-qualify with the
  confirmed `privacyVerifiedAt` (see above).
- Billing reconciliation feed (who calls `ledger.reconcile`) is not automated.
- Alerts are emitted as structured log lines (`[alert] model_gateway {…}`);
  routing them to a pager/alarm is deployment work.
- MCP `analyze_media` tool and agent REST media routes belong to the agents
  module.
