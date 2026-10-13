# Capability matrix

What each provider capability can actually do in this deployment. Source of truth at runtime: `ProviderRegistry.capabilities()` (`packages/providers/src/registry.ts`), surfaced by `GET /v1/health` (statuses only) and the demo inspector. This file records the probe results and access decisions that runtime code cannot discover by itself.

Statuses: **available** (probed and working) · **degraded** (working with limits) · **unverified** (configured, not yet probed; calls attempted, failures mark it unavailable) · **unavailable** (not configured, not implemented, or inaccessible — dependent features show partial states, never simulated data).

Last updated: 2026-10-13 (foundation commit). Qloo key: **not yet issued**.

## Qloo (hackathon key pending)

Probes to run with the hackathon key (`scripts/probe-qloo.ts`, owned by the Qloo adapter), per the build spec: resolve one brand, look up one relevant tag, request artist/film/brand/place results, inspect explainability, verify rate limits and permitted response storage.

| Capability | Endpoint | Status | Probe | Result / notes |
| --- | --- | --- | --- | --- |
| `qloo.search` | `GET /search?query=&types=` | unavailable (`not_configured`) | Resolve one brand (e.g. a well-known denim brand) | pending key |
| `qloo.tags` | `GET /v2/tags?filter.query=&filter.tag.types=` | unavailable (`not_configured`) | Look up one style tag | pending key |
| `qloo.insights` | `GET /v2/insights?filter.type=urn:entity:{artist,movie,brand,place}&signal.interests.entities=` | unavailable (`not_configured`) | Artist, film, brand and place results from one resolved entity | pending key |
| `qloo.insights.explainability` | `feature.explainability=true` | unavailable (`not_configured`) | Contributing input entities present? | pending key |
| `qloo.trending` | `GET /v2/trending` (requires `signal.interests.entities`, `filter.type`, `filter.start_date`, `filter.end_date`) | unavailable (`not_configured`) | Optional; inspector only | pending key |
| `qloo.trends_entity` | `GET /trends/entity?entity_id=&start_date=` | unavailable (`not_configured`) | Optional; inspector only | pending key |

| Access question | Answer |
| --- | --- |
| Base URL (`QLOO_API_URL`) | default `https://hackathon.api.qloo.com` — confirm with key |
| Auth | `X-Api-Key` header |
| Rate limits (per second / per day) | pending |
| May responses be stored (`provider_queries.results`)? For how long? | pending — until confirmed, store only ids, names and ranks needed for traceability |
| May provider images/metadata be displayed publicly? | pending — until confirmed, use licensed/own imagery or text treatment |
| Categories available to the key | pending |

## Other providers

| Capability | Provider | Status today | Notes |
| --- | --- | --- | --- |
| `vlm.analyze_image` | Anthropic (`VLM_MODEL`, default `claude-sonnet-5-5`) | unavailable until `ANTHROPIC_API_KEY` is set and the adapter lands | Structured output via forced tool schema; image text treated as data |
| `text.generate` | Anthropic (`RESEARCH_MODEL` / `COMPOSER_MODEL`) | as above | Claim extraction and plan composition |
| `research.sources` | Wikipedia/Wikimedia REST | not implemented | Real source URLs; needs descriptive `WIKIMEDIA_USER_AGENT`; no key required |
| `research.claims` | text model over research sources | not implemented | Factual claims require a source URL |
| `catalog.tracks` | none | unavailable (no catalog adapter this release) | Music falls back to artist recommendations |
| `storage.objects` / `storage.signed_urls` | local fs / S3 / memory | memory available; local and S3 not implemented | Private storage, short-lived links |
| Sensor relay | World Sensor relay (user's machine) | unreachable from CI | Tested against `apps/sensor-bridge` mock relay; relay routes in `apps/sensor-bridge/src/relay-contract.ts` are assumptions to verify |

## Image decoding

| Format | Status | Notes |
| --- | --- | --- |
| JPEG / PNG / WebP | supported by sharp 0.35.5 (libvips 8.18.7) | |
| AVIF | decodable | not in the spec's accepted list; treat as accepted only if product agrees |
| HEIC (HEVC) | **not supported** by the prebuilt libvips | return `unsupported_image` with conversion guidance |
