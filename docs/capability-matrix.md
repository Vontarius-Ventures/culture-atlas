# Capability matrix

What each provider capability can actually do in this deployment. Source of truth at runtime: `ProviderRegistry.capabilities()` (`packages/providers/src/registry.ts`), surfaced by `GET /v1/health` (statuses only) and the demo inspector. This file records the probe results and access decisions that runtime code cannot discover by itself.

Statuses: **available** (probed and working) · **degraded** (working with limits) · **unverified** (configured, not yet probed; calls attempted, failures mark it unavailable) · **unavailable** (not configured, not implemented, or inaccessible — dependent features show partial states, never simulated data).

Last updated: 2026-10-13 (provider adapters and World Sensor import implemented). Qloo key: **not yet issued**.

## Qloo (hackathon key pending)

Probes to run with the hackathon key, per the build spec: resolve one brand, look up one relevant tag, request artist/film/brand/place results, inspect explainability, verify rate limits and permitted response storage. Run `pnpm qloo:probe [--brand "Levi's"] [--tag streetwear]` ([qloo-probes.md](qloo-probes.md)). It probes the raw API and writes the Status and Result columns below plus a generated "Qloo probe results" section. The adapter-level `pnpm tsx scripts/probe-qloo.ts --record` saves sanitized real responses for labeled replay (only after confirming storage rights).

Adapter behavior (`packages/providers/src/qloo/client.ts`): `X-Api-Key` header, `QLOO_API_URL` base, `QLOO_TIMEOUT_MS` per attempt, up to two retries for 429/timeouts/5xx with exponential backoff and jitter (Retry-After honored; waits longer than 15 s are not taken in-process and the job re-queues instead), a circuit breaker (5 consecutive transient failures, 30 s cooldown), and the per-job budget (`JOB_MAX_QLOO_REQUESTS`, default 12, every HTTP attempt counts). With a key, capabilities start `unverified / probe_pending` and become `available` after a successful call, `unavailable / access_denied` after 401/403, or `degraded / circuit_open` while the breaker is open. Without a key they are `unavailable / not_configured`. Contract tests (`qloo/client.test.ts`) run against shape-only fixtures in `fixtures/qloo/contract/` with 429, timeout, 5xx, auth, malformed and empty-result injection.

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
| `vlm.analyze_image` | Anthropic (`VLM_MODEL`, default `claude-sonnet-5-5`) | `unavailable / not_configured` without `ANTHROPIC_API_KEY`; `unverified` with a key until the first success | Native structured outputs (`output_config.format` via `zodOutputFormat`), re-validated with zod; no tools; image text and user strings passed as data; SDK retries off, budgeted retries in the adapter; server-side refusal fallback on supported models (`ANTHROPIC_REFUSAL_FALLBACK`) |
| `text.generate` | Anthropic (`RESEARCH_MODEL` / `COMPOSER_MODEL`) | as above | Claim extraction and dish ideas (plans use the same adapter) |
| `research.sources` | Wikipedia Action API search + REST `/page/summary` | `unverified` until first call (no key needed) | Real canonical page URLs, CC BY-SA 4.0 text license, disambiguation skipped; `WIKIMEDIA_USER_AGENT` sent. Not reachable from this build sandbox (egress proxy 403), so tests use documented response shapes |
| `research.claims` | text model over research sources | follows `text.generate` | Factual claims without a supplied source URL are dropped; overview and section text are assembled only from kept claims |
| `catalog.tracks` | none | unavailable (no catalog adapter this release) | Music falls back to artist recommendations |
| `storage.objects` / `storage.signed_urls` | local fs / S3 / memory | local: available (signed URLs `degraded` without `STORAGE_SIGNING_SECRET`); S3: available when `S3_BUCKET` is set, else `unavailable / not_configured` | Local links are HMAC-signed `/v1/media` URLs (`SIGNED_URL_TTL_SECONDS`, default 300); S3 links are presigned GETs capped at 1 hour |
| `sensor.import` | World Sensor relay (operator's machine) via the outbound bridge or server polling | implemented; **unverified against the real relay** (unreachable from the build environment) | Tested end to end against `fixtures/sensor/mock-relay.ts` (pagination, offline recovery, hash checks, no skips or duplicates). Relay routes and field names in `packages/domain/src/sensor/relay.ts` (copied to the bridge) are assumptions from the source review; verify with `pnpm sensor-bridge list` ([sensor.md](sensor.md)). |

## Image decoding

| Format | Status | Notes |
| --- | --- | --- |
| JPEG / PNG / WebP | supported by sharp 0.35.5 (libvips 8.18.7) | |
| AVIF | decodable | not in the spec's accepted list; treat as accepted only if product agrees |
| HEIC (HEVC) | **not supported** by the prebuilt libvips | decode is attempted; on failure `unsupported_image` with JPEG export guidance |
| AVIF | decodable but not accepted | rejected with `unsupported_image` (not in the spec's accepted list) |
