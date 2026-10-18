# Concentrate model backend

## Decision and scope

Use Concentrate as the default gateway for the v2 release, funded initially by the operator's existing credits. Customers do not supply keys. Atlas remains provider-independent through its vision/text/composer interfaces. Preserve existing Featherless/Anthropic adapters for explicitly configured operational rollback; do not automatically bill them when Concentrate credits are exhausted.

Current code only supports Featherless/Anthropic in `packages/providers/src/config.ts`. Add Concentrate configuration, transport, provider registry support, health status, documentation and tests. Merely changing the base URL on the existing Featherless transport is not the implementation: it speaks Chat Completions, whereas the new adapter should use the documented Responses contract. Existing code may continue working unchanged during this specification-only phase.

## Vendor contract and adapter

Use `POST https://api.concentrate.ai/v1/responses`, with server-side `Authorization: Bearer` and JSON. The Chat Completions compatibility endpoint exists but is not the primary v2 adapter. Model identity and provider selection are configuration, not consumer choices. [API introduction](https://concentrate.ai/docs/api-reference/introduction).

Normalize input media into bounded JPEG derivatives. Responses content carries `input_text` and `input_image`; the latter can use `image_url` with a base64 data URI. This avoids exposing original media or requiring a model to fetch an authenticated private URL. Image formats/count/dimensions vary by route. Native video input is not established here: videos use extracted image frames. [Multimodal contract](https://concentrate.ai/docs/api-reference/endpoint/multi-modal).

Request nonstreaming structured output using `text.format` with `type:json_schema`, `name`, `schema`, `strict:true`; schemas disallow additional properties on every object. Validate returned output with Atlas's schema and semantic checks regardless of provider enforcement. Do not use partially streamed JSON as completed analysis. [Structured output](https://concentrate.ai/docs/api-reference/endpoint/structured-output).

Illustrative request (substitute a qualified profile and the complete versioned schema):

```json
{
  "model": "<qualified-provider>/<qualified-model>",
  "stream": false,
  "max_output_tokens": 2000,
  "input": [{"role":"user","content":[
    {"type":"input_text","text":"<versioned task text; untrusted user/media text delimited as data>"},
    {"type":"input_image","image_url":"data:image/jpeg;base64,<normalized-image>"}
  ]}],
  "text":{"format":{"type":"json_schema","name":"atlas_observations_v2","strict":true,"schema":{
    "type":"object","properties":{"summary":{"type":"string"}},"required":["summary"],"additionalProperties":false
  }}}
}
```

The example schema is transport illustration only, not a substitute for Atlas's complete VLM contract. Supply the versioned system instructions through the documented Responses instruction/message mechanism, keeping user focus and observed text in separate data. No model tools are supplied. Use the established Atlas quality, observation, candidate, reference and uncertainty schemas after conversion to the provider-compatible strict form. Never replace an unrepresentable schema with `{type:object}` silently; fail qualification or use a tested transform with equivalent post-validation.

Parse `output` message/text items rather than assuming the first output item contains text. Handle `error`, refusal, `incomplete_details`, and nullable usage explicitly. Preserve the response ID/model and usage when returned. Missing cost/usage is unknown, not zero. [Create Response](https://concentrate.ai/docs/api-reference/endpoint/create-response).

## Atlas roles and profiles

| Role | Input | Output | Default policy |
| --- | --- | --- | --- |
| vision_photo | One normalized image + bounded focus | Existing validated VLM reading | Required for photo discovery |
| vision_video_frame | One timestamped frame per bounded call | Same VLM reading plus server-owned frame linkage | Up to 8 frames, partial result allowed |
| research_text | Bounded authoritative excerpts, source IDs and extracted claims | Structured supported claims | No invented citations; URLs must come from actual research |
| composer | Selected collection items, restrictions and grounded discoveries | Structured plan | Existing exclusions/taste contracts remain |
| vision_photo_enrich (2.2) | The same photo at 768 px plus stage-1 title and candidate names as DATA | `VlmEnrichment`: observations, visible text, confirmations, up to 4 extra candidates, regions | Background stage 2 of the [two-stage reading](../onboarding-and-fast-analysis.md); never reorders or removes published cards; failures leave stage 1 intact |

Amendment 2.2: under the two-stage reading, `vision_photo` returns the slim `VlmQuickRead` (512 px, 600 output tokens, 10 s). Profiles may set an optional `reasoningEffort` (`none`, `minimal`, `low`, `medium`, `high`); it is part of the profile hash, is sent as `reasoning.effort` only when the qualified profile sets it, and both photo roles qualify on at least 10 real, owned photos. Schemas: `packages/providers/src/vlm/types.ts`.

Model IDs are selected from the current catalog and pinned after qualification; do not bake a marketing-page example into a default. A profile contains gateway, requested model/provider, allowed fallback providers, output-token cap, image max bytes/pixels/count, timeout, schema support, ZDR requirement, prompt/schema version, catalog snapshot timestamp and qualification artifact ID. Text roles may share a qualified model; vision must prove image support. Roles are independently unavailable when their profile is missing; media storage remains available.

`GET /v1/models` exposes capabilities and provider configurations; follow pagination/has_more. Inspect actual provider image-processing limits, not only an aggregate model capability. Qualification checks a selected model/provider pair. [Model discovery](https://concentrate.ai/docs/api-reference/endpoint/list-models).

## Routing and fallback

Pin a qualified provider/model; do not use automatic model selection for reproducible analysis. If fallbacks are enabled, only prequalified routes satisfying privacy, modality, schema and cost policies may receive requests. Concentrate's provider `fallbacks` is order of preference, not a strict restriction; use the documented whitelist when enabling a bounded provider chain. No default cross-gateway fallback. [Routing contract](https://concentrate.ai/docs/api-reference/endpoint/auto-routing).

Record requested and returned identifiers separately. If the response does not disclose actual upstream provider, record actual_provider unknown rather than asserting the requested route executed. Configure one retry owner: default Atlas retry budget with gateway fallback disabled; if gateway fallback is enabled for a profile, account for its possible upstream attempts and disable redundant Atlas provider retry multiplication. Correlation/idempotency headers must only use documented support; no invented provider idempotency guarantee.

## Privacy and credentials

Use separate keys for staging/production, restricted and budgeted in the Concentrate workspace. Set ZDR on and content logging off explicitly in the API-key/dashboard configuration. These are independent settings; do not invent request-body flags. Verify the selected provider/model's ZDR eligibility using its detailed catalog entry. With no eligible route, fail closed and keep media for later analysis. Billing/operational metadata can still exist; do not promise no metadata retention. [ZDR and logging](https://concentrate.ai/docs/api-reference/endpoint/zero-data-retention).

Keep keys in hosted secret management. No key, provider balance or admin endpoint in web/mobile bundles. Operator account credit amount/expiry/eligible models and rate limits remain unverified until the account is inspected during deployment. Never ask customers to fix the product's Concentrate account. Existing credits affect initial funding, not data isolation or unlimited usage. The operator verifies provider terms/retention settings for the production workload before activation.

## Failure behavior

| Condition | Adapter/job behavior | Consumer treatment |
| --- | --- | --- |
| 400 / incompatible schema/input | Nonretryable configuration/input failure; capture remains | “We couldn’t explore this media.” with appropriate next step |
| 401 / authentication failure | Open role circuit; operator alert; no retry loop | “Exploration is temporarily unavailable.” |
| 402 / insufficient credits | Stop new inference dispatch; reconcile in-flight; never auto-switch billing | Same unavailable copy; library/capture/upload stay working |
| 404 / unknown model | Profile unavailable; operator qualification required | Unavailable, no endless retry |
| 422 / no policy-eligible route | No privacy downgrade; fail role readiness | Unavailable |
| 424 / provider unavailable | Bounded qualified retry if policy allows | Preserve asset and show retry after budget permits |
| 429 | Honor Retry-After; queue delay with account fairness | “Waiting to explore” with Cancel |
| 500/503/504 | Bounded backoff; uncertain billing recorded | Retryable after deadline; never fake results |
| Refusal / incomplete / invalid JSON | Distinct classified failure; no result publication | Explain inability without raw provider payload |
| Nullable usage | Record unknown and reconcile reservation | No claim of free inference |

Vendor status mapping is based on the [error contract](https://concentrate.ai/docs/api-reference/endpoint/errors). Timeout does not prove upstream work or billing stopped. Atlas hides raw error bodies because they may echo input.

Initial deadlines: 30 seconds per vision attempt, 15 seconds per text attempt, photo job 90 seconds, sampled-video analysis job 180 seconds excluding media preparation. Retry at most once for retryable transport/provider faults inside the deadline. A single bounded schema-repair call is allowed only if configured, with original security constraints, no tools, and reserved budget; combined attempt cap is three per frame/role. Do not repair refusals or policy failures. Cancellation fences publication; it cannot promise provider refund.

## Budget and readiness

Per-account daily analysis allowance and global provider limits must both pass before dispatch. Reserve worst-case capped tokens/frames against a versioned pricing snapshot and a configurable spend ceiling. Reconcile actual usage after each attempt. Unknown charges keep a bounded outstanding reservation until billing reconciliation; cap outstanding unknown spend and alert. Do not treat request token estimates as actual credits remaining.

At 402, stop new inference work; no paid health probe. Operators restore credit/profile readiness explicitly before queue recovery. User-initiated retries must reuse asset and account budget identity. Global/day and per-key limits prevent a single account from consuming all credits. Fair scheduling and role-specific concurrency protect interactive photo jobs from large video batches.

The readiness endpoint distinguishes configured, catalog-compatible, qualified, available, degraded and unavailable. Ordinary health requests are read-only. Qualification is a deliberate operator action with known owned fixtures and a bounded spend allowance. Production keys/model IDs are not requested in chat for this documentation task.

## Implementation and qualification gates

Add `packages/providers/src/concentrate/transport.ts`, parser/contract tests, config enum/default, profile loader, registry integration and structured transport that does not depend on Anthropic-specific request fields. Reuse existing resilience/domain validation behind provider-neutral interfaces; do not leak reasoning/tool/effort settings into a gateway that has not been qualified for them. Update `.env.example`, deployment configuration, docs and capability report when implementation lands.

Contract fixtures: text-only, valid image JSON, multiple output items, refusal, incomplete output, invalid JSON/schema/cross-reference, unknown model, 402, 422 ZDR, 429 Retry-After, timeout, null usage, returned model mismatch, route mismatch and cancellation. Ensure secrets/base64 never enter captured logs.

Live qualification: at least 10 owned varied photos and 3 short videos; verify real image interpretation, cautious cultural labels, timestamp support, structured output, exact selected route, privacy policy, observed cost/latency, retry behavior and global credit exhaustion handling. Use a low spend cap and real account authorization during implementation. A mock pass is not production model qualification. Archive safe profile/config hashes and aggregate results, not private media or credentials.
