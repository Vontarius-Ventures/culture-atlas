# Concentrate integration findings

Checked October 14, 2026. Official documentation only; no credentials, inference calls, or account inspection used.

## Documented API contract

Base URL `https://api.concentrate.ai/v1`; inference authentication is `Authorization: Bearer <server-secret>`. Prefer `POST /responses` for the new adapter. The compatibility endpoint `/chat/completions` also exists. Model strings accept a bare slug or `provider/model`. Do not assume every documented example model is available to this account. [API introduction](https://concentrate.ai/docs/api-reference/introduction), [Chat Completions](https://concentrate.ai/docs/api-reference/endpoint/chat-completions).

Responses image input uses `input[]` messages whose content contains `input_text` and `input_image` blocks. `image_url` accepts a base64 data URI or public HTTPS URL. Private authenticated URLs may fail. JPEG, PNG, GIF and WebP are documented, with provider-specific subsets and limits. Discover image support using `capabilities.image_input.supported`; inspect per-provider `image_processing`, including size, count, `max_pixels` and `max_dimension`. `detail` is not uniformly supported. Native video input is not established by this image documentation. [Multimodal](https://concentrate.ai/docs/api-reference/endpoint/multi-modal).

Structured Responses output uses `text.format={type:'json_schema',name,schema,strict:true}`; Chat uses `response_format` with nested `json_schema`. Strict schemas require `additionalProperties:false` on each object. Some streaming provider combinations can fall back to JSON-object mode with schema instructions, so use non-streaming analysis and independently validate returned JSON. [Structured output](https://concentrate.ai/docs/api-reference/endpoint/structured-output).

Proposed request shape (illustrative; placeholders are deployment configuration):

```json
{
  "model": "<qualified-provider>/<qualified-model>",
  "stream": false,
  "max_output_tokens": 2000,
  "input": [{"role":"user","content":[
    {"type":"input_text","text":"<versioned Atlas analysis prompt>"},
    {"type":"input_image","image_url":"data:image/jpeg;base64,<normalized derivative>"}
  ]}],
  "text":{"format":{"type":"json_schema","name":"atlas_observation_v1","strict":true,"schema":{"type":"object","properties":{"summary":{"type":"string"}},"required":["summary"],"additionalProperties":false}}}
}
```

The response schema includes `id`, `model`, `output`, nullable `usage`, `error`, and `incomplete_details`. Usage includes input/output/total tokens and cached/reasoning breakdowns. Parse output message/text items robustly rather than assuming the first item is text. Treat incomplete/error/refusal/unparseable/schema-invalid outcomes separately. Do not assume dollar cost is a stable response field; record token usage and reconcile estimated cost to billing. [Create Response](https://concentrate.ai/docs/api-reference/endpoint/create-response).

## Routing and privacy

Pin a qualified provider/model. A pinned provider falls back only when `routing.provider.fallbacks` or `whitelist` is set. `fallbacks` is preference order, NOT a restriction: other providers can follow. Use `whitelist` to constrain permitted providers. Model fallbacks exist under `routing.model.fallbacks`. Automatic model selection is a curated pool and should not be used for reproducible Atlas analysis. Routing may drop optional features; documented image input and structured output are required, never stripped. [Routing](https://concentrate.ai/docs/api-reference/endpoint/auto-routing).

ZDR and content logging are independent API-key/dashboard settings, not request-body switches. ZDR defaults off; content logging defaults off. Atlas production should explicitly enable ZDR and disable content logging, with organizational enforcement where available. With ZDR enabled, no eligible provider produces 422 rather than relaxing policy. ZDR is specific to model/provider pairs; inspect `GET /v1/models/{id}` per-provider `zdr`, since combined models output omits it. Metadata and billing remain logged even when content logging is off. These are documented behaviors, not verified account settings. [ZDR and logging](https://concentrate.ai/docs/api-reference/endpoint/zero-data-retention).

## Discovery, failures and credits

`GET /v1/models` is documented as unauthenticated; returns provider configurations, pricing and capabilities. Model-level capability match may mean only one provider supports the feature, so qualification must inspect the actual provider. Catalog responses include `has_more`; do not assume the first response exhausts models. [List Models](https://concentrate.ai/docs/api-reference/endpoint/list-models).

Errors include 400 invalid request, 401 auth, 402 insufficient credits, 404 unknown model, 424 provider unavailable, 429 throttling and 500/503/504 transient failures. Error bodies vary (string `error` vs nested object). Honor Retry-After where present. A 504 can leave partially processed upstream work; retry does not imply no duplicate billing. [Errors](https://concentrate.ai/docs/api-reference/endpoint/errors).

The site advertises credits usable across models/providers, no platform markup, and provider-key routing. This does not establish the user's balance, expiry, promotional restrictions, eligible models, account rate limits or billing permissions. Use Concentrate as the initial production gateway, funded by the existing account credits after account checks. Do not silently switch to an externally billed provider when depleted. [Concentrate](https://concentrate.ai/).

## Atlas design recommendations (proposed, not vendor guarantees)

- Server-owned `ConcentrateVisionProvider` implementing Atlas's provider interface; no browser/mobile key and no customer BYOK requirement.
- Separate key per environment. Configurable exact model/provider and an approved fallback list; no hard-coded provider recommendation before evaluation.
- Model qualification set must test vision + schema + privacy policy together, with actual Atlas photographs and timestamped video frames, cultural-label quality and uncertainty handling, latency, cost and refusal behavior.
- Normalize/resize private media derivatives server-side; send bounded base64 images so originals remain private. Use extracted video frames, not an invented video API.
- Persist provider, returned model, prompt/schema version, catalog/pricing snapshot, request correlation, usage and status for every attempt. Never log media or prompt content by default.
- Reserve per-account/global analysis budget before dispatch; settle on actual usage; unknown usage stays pending reconciliation. Repeated timeouts have bounded retries and attempt budgets.
- 402 opens an analysis circuit and alerts operators; media capture/upload remains operational. Users see analysis temporarily unavailable, without being asked for the founder's provider credits.
- Contract tests cover malformed images, too-large requests, schemas, 422 ZDR failure, 402, 429, 504, null usage, refusals and schema drift.
- Before production: account credits eligibility/expiration, key scope, ZDR/logging enforcement, selected model/provider capability, real usage/cost fields, retention/legal terms, and failover tests remain qualification gates. Response-header docs could not be retrieved; do not hard-code undocumented request-ID header names.
