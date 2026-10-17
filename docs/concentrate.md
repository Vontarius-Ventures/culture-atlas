# Model gateway: Concentrate

Concentrate is the **default** model gateway (`LLM_PROVIDER` unset or
`concentrate`). Featherless and Anthropic remain only as explicit operational
rollbacks (`LLM_PROVIDER=featherless|anthropic`); nothing ever falls back to
them automatically, and v2 media analysis is unavailable under a rollback
provider. Qloo stays independent.

**No production model is qualified in this repository.** Every test uses
synthetic ids such as `fixture/model-1`, which must never be deployed. Without a
key, qualified profiles, a durable ledger and spend ceilings every role reports
`unavailable`; capture, library, uploads and playback keep working.

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
   proceed as for v1). `GET /v2/media/{id}/analysis/{analysis_id}` adds
   `waiting_reason`, `error_code` and `result` (`note: “We explore selected
   moments, not every frame.”`, per-frame states, cited candidates).
6. 402 / 429 return the work to the queue **without** consuming an attempt;
   media stays `ready`. Deleting the asset fences publication and a trigger
   removes stored readings.

v1 jobs (captures, plans, related discovery) get a fresh verified identity per
model call (`v1:<job type>:a<attempt>:<operation>:<n>`). Session-only
(anonymous) jobs get none, so the budgeted gateway refuses them: anonymous AI is
unavailable under Concentrate.

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
```

Fixture layout: photos as image files (≥ 10, owned and varied); videos as one
directory per video containing `<timestamp_ms>.jpg` frames (≥ 3 videos, ≤ 8
frames each); text roles as `{system, prompt, schema: reference_notes|plan_prose}`
JSON files (≥ 3). A persistent request counter in the out dir is reserved
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
and structured output on `elorian-1-agent` have not been verified live.

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

## Remaining release gates

- No qualified model ids; no live run of the qualification script yet (no key or
  network here). A mock pass is not production qualification.
- Billing reconciliation feed (who calls `ledger.reconcile`) is not automated.
- ZDR / content-logging settings on the real key are unverified.
- Alerts are emitted as structured log lines (`[alert] model_gateway {…}`);
  routing them to a pager/alarm is deployment work.
- MCP `analyze_media` tool and agent REST media routes belong to the agents
  module.
