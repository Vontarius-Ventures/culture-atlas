# Capability matrix

What each provider capability can actually do in this deployment. Source of truth at runtime: `ProviderRegistry.capabilities()` (`packages/providers/src/registry.ts`), surfaced by `GET /v1/health` (statuses only) and the demo inspector. This file records the probe results and access decisions that runtime code cannot discover by itself.

Statuses: **available** (probed and working) · **degraded** (working with limits) · **unverified** (configured, not yet probed; calls attempted, failures mark it unavailable) · **unavailable** (not configured, not implemented, or inaccessible — dependent features show partial states, never simulated data).

Last updated: 2026-10-22: Qloo hackathon key live-probed; Concentrate catalog pin `anthropic/claude-haiku-5-5`; text roles qualified on text-v1 (`rt-haiku55-none-20261022`, `co2-haiku55-none-20261022`); photo roles remain catalog-compatible (golden-v5 has no unused blind split). Featherless rollback `google/gemma-3-27b-it`. Earlier: 2026-10-19 live photo-stage transport; 2026-10-17 first Qloo probe.

## Qloo (hackathon key live)

Probes to run with the hackathon key, per the build spec: resolve one brand, look up one relevant tag, request artist/film/brand/place results, inspect explainability, verify rate limits and permitted response storage. Run `pnpm qloo:probe [--brand "Levi's"] [--tag streetwear]` ([qloo-probes.md](qloo-probes.md)). It probes the raw API and writes the Status and Result columns below plus a generated "Qloo probe results" section. The adapter-level `pnpm tsx scripts/probe-qloo.ts --record` saves sanitized real responses for labeled replay (only after confirming storage rights).

Adapter behavior (`packages/providers/src/qloo/client.ts`): `X-Api-Key` header, `QLOO_API_URL` base, `QLOO_TIMEOUT_MS` per attempt, up to two retries for 429/timeouts/5xx with exponential backoff and jitter (Retry-After honored; waits longer than 15 s are not taken in-process and the job re-queues instead), a circuit breaker (5 consecutive transient failures, 30 s cooldown), and the per-job budget (`JOB_MAX_QLOO_REQUESTS`, default 12, every HTTP attempt counts). With a key, capabilities start `unverified / probe_pending` and become `available` after a successful call, `unavailable / access_denied` after 401/403, or `degraded / circuit_open` while the breaker is open. Without a key they are `unavailable / not_configured`. Contract tests (`qloo/client.test.ts`) run against shape-only fixtures in `fixtures/qloo/contract/` with 429, timeout, 5xx, auth, malformed and empty-result injection.

| Capability | Endpoint | Status | Probe | Result / notes |
| --- | --- | --- | --- | --- |
| `qloo.search` | `GET /search?query=&types=` | available (probed 2026-10-22) | Resolve one brand (e.g. a well-known denim brand) | 2 result(s); top "Levi Strauss & Co." (EE2B58FF-37F6-4521-912F-55EBC25D83E2) |
| `qloo.tags` | `GET /v2/tags?filter.query=&filter.tag.types=` | available (probed 2026-10-22) | Look up one style tag | 2 tag(s); top "Streetwear Culture Influence" (urn:tag:ambience:qloo:streetwear_culture_influence) |
| `qloo.insights` | `GET /v2/insights?filter.type=urn:entity:{artist,movie,brand,place}&signal.interests.entities=` | available (probed 2026-10-22) | Artist, film, brand and place results from one resolved entity | 5 artist result(s); explainability on 5 |
| `qloo.insights.explainability` | `feature.explainability=true` | available (probed 2026-10-22) | Contributing input entities present? | contributing inputs present on 20 of 20 result(s) |
| `qloo.trending` | `GET /v2/trending` (requires `signal.interests.entities`, `filter.type`, `filter.start_date`, `filter.end_date`) | degraded (probed 2026-10-22) | Optional; inspector only | no trending results |
| `qloo.trends_entity` | `GET /trends/entity?entity_id=&start_date=` | unavailable (probed 2026-10-22) | Optional; inspector only | HTTP 404: The requested resource could not be found. |

| Access question | Answer |
| --- | --- |
| Base URL (`QLOO_API_URL`) | `https://hackathon.api.qloo.com` (live-probed 2026-10-22) |
| Auth | `X-Api-Key` header |
| Rate limits (per second / per day) | not published. Bursts are throttled: on 2026-10-19, 2 of the 5 insights calls made while reading one photo got HTTP 429 and were retried, and insights latency ranged from 3.6 s to 13.7 s. Every caller keeps ≤ 3 requests in flight |
| May responses be stored (`provider_queries.results`)? For how long? | pending — until confirmed, store only ids, names and ranks needed for traceability |
| May provider images/metadata be displayed publicly? | pending — until confirmed, use licensed/own imagery or text treatment |
| Categories available to the key | `/search`, `/v2/tags`, `/v2/insights` for `urn:entity:artist`, `urn:entity:movie`, `urn:entity:brand`, `urn:entity:place` (never `urn:entity:music`). `/v2/trending` returns empty. `/trends/entity` HTTP 404 |

## Other providers

| Capability | Provider | Status today | Notes |
| --- | --- | --- | --- |
| `vlm.analyze_image` | Concentrate (default, `LLM_PROVIDER=concentrate`): role profiles `vision_photo` / `vision_video_frame` pinned by `CONCENTRATE_PROFILE_FILE` or `CONCENTRATE_PROFILES_JSON`. 2026-10-22 live catalog pin: `anthropic/claude-haiku-5-5` (ZDR policy + certificate on the `anthropic` route; JPEG + structured output). `claude-fable-5-1` is in the catalog but **not** ZDR-eligible on any listed route, so it is not pinned. Explicit rollback only: `LLM_PROVIDER=featherless` uses `google/gemma-3-27b-it` (live Featherless catalog 2026-10-22, `features.image_input: true`; no auto-fallback) | With `CONCENTRATE_API_KEY` and ZDR env assertions: **`unverified / probe_pending`** (catalog pin labelled; calls throw). Dispatch stays fail-closed until a durable ledger, spend limits AND a **qualified** profile exist (see [concentrate.md](concentrate.md)). golden-v5 has no unused blind split, so photo roles cannot qualify yet. Dashboard ZDR/no-logging confirmation is pending. Without a key: `unavailable / not_configured`. `vision_video_frame` is not qualified | Responses API (`POST /v1/responses`), nonstreaming strict `json_schema`, bounded JPEG data URIs, no tools, no automatic cross-gateway fallback. Readiness ladder configured → catalog-compatible → qualified → available / degraded / unavailable is read-only (no paid probe). Video uses ≤ 8 extracted frames, one call each |
| `vlm.enrich_image` (stage 2) | Concentrate `vision_photo_enrich` profile only; no Elorian or rollback fallback | Health does not use the catalog pin for this role (stays `unavailable / not_configured` without a profile). Catalog pin on `anthropic/claude-haiku-5-5` is catalog-compatible only; **not quality-qualified** (golden-v5 has no unused blind split) | Background call after the first section; deterministic merge, advisory vetoes (FAST-02). Reads visible text and small logos well at 768 px |
| `text.generate` | Concentrate `research_text` / `composer` profiles. Catalog pin `anthropic/claude-haiku-5-5` (same ZDR-listed route). Rollback: Featherless or Anthropic `RESEARCH_MODEL` / `COMPOSER_MODEL` | With a Concentrate key: **`unverified / probe_pending`**. Artifacts in `fixtures/concentrate/` (`rt-haiku55-none-20261022` 6/6, p50 6.3 s; `co2-haiku55-none-20261022` 11/11, p50 2.9 s) qualify the text roles on text-v1; dispatch still needs `CONCENTRATE_QUALIFICATION_DIR` plus a durable spend ledger. Without a key: `unavailable / not_configured` | Claim extraction, dish ideas and plan prose. v1 jobs attach verified job identity per call; session-only (anonymous) jobs get none, so the budgeted gateway refuses them |
| `research.sources` | Wikipedia Action API search + REST `/page/summary` | `unverified` until first call (no key needed) | Real canonical page URLs, CC BY-SA 4.0 text license, disambiguation skipped; `WIKIMEDIA_USER_AGENT` sent. Not reachable from this build sandbox (egress proxy 403), so tests use documented response shapes |
| `research.claims` | text model over research sources | follows `text.generate` | Factual claims without a supplied source URL are dropped; overview and section text are assembled only from kept claims |
| `catalog.tracks` | none | unavailable (no catalog adapter this release) | Music falls back to artist recommendations |
| `music.recognize` | none | unavailable (`not_implemented`) | Typed stub only; no fake matches. Licensed fingerprint/catalog provider is a procurement gate |
| `storage.objects` / `storage.signed_urls` | local fs / S3 / memory | local: available (signed URLs `degraded` without `STORAGE_SIGNING_SECRET`); S3: available when `S3_BUCKET` is set, else `unavailable / not_configured` | Local links are HMAC-signed `/v1/media` URLs (`SIGNED_URL_TTL_SECONDS`, default 300); S3 links are presigned GETs capped at 1 hour |
| `sensor.import` | World Sensor relay (operator's machine) via the outbound bridge or server polling | implemented; **unverified against the real relay** (unreachable from the build environment) | Tested end to end against `fixtures/sensor/mock-relay.ts` (pagination, offline recovery, hash checks, no skips or duplicates). Relay routes and field names in `packages/domain/src/sensor/relay.ts` (copied to the bridge) are assumptions from the source review; verify with `pnpm sensor-bridge list` ([sensor.md](sensor.md)). |

## Image decoding

| Format | Status | Notes |
| --- | --- | --- |
| JPEG / PNG / WebP | supported by sharp 0.35.5 (libvips 8.18.7) | |
| AVIF | decodable | not in the spec's accepted list; treat as accepted only if product agrees |
| HEIC (HEVC) | **not supported** by the prebuilt libvips | decode is attempted; on failure `unsupported_image` with JPEG export guidance |
| AVIF | decodable but not accepted | rejected with `unsupported_image` (not in the spec's accepted list) |

<!-- qloo-probe:begin (generated by scripts/qloo-probe.ts; do not edit by hand) -->
## Qloo probe results

Last run 2026-10-22T20:55:28.088Z against `https://hackathon.api.qloo.com`. Rate limits: no rate-limit headers observed; 0 request(s) answered 429.

| Probe | Capability | Status | HTTP | Detail | ms |
| --- | --- | --- | --- | --- | --- |
| `search.brand` | `qloo.search` | available | 200 | 2 result(s); top "Levi Strauss & Co." (EE2B58FF-37F6-4521-912F-55EBC25D83E2) | 370 |
| `tags.lookup` | `qloo.tags` | available | 200 | 2 tag(s); top "Streetwear Culture Influence" (urn:tag:ambience:qloo:streetwear_culture_influence) | 59 |
| `insights.artist` | `qloo.insights` | available | 200 | 5 artist result(s); explainability on 5 | 3172 |
| `insights.movie` | `qloo.insights` | available | 200 | 5 movie result(s); explainability on 5 | 2406 |
| `insights.brand` | `qloo.insights` | available | 200 | 5 brand result(s); explainability on 5 | 188 |
| `insights.place` | `qloo.insights` | available | 200 | 5 place result(s); explainability on 5 | 1369 |
| `insights.explainability` | `qloo.insights.explainability` | available | - | contributing inputs present on 20 of 20 result(s) | 0 |
| `insights.tag_signal` | `qloo.insights` | available | 200 | 5 brand result(s) from a tag signal | 2134 |
| `trending` | `qloo.trending` | degraded | 200 | no trending results | 72 |
| `trends.entity` | `qloo.trends_entity` | unavailable | 404 | HTTP 404: The requested resource could not be found. | 42 |
| `auth.invalid_key` | `qloo.auth` | available | 401 | rejected as expected (HTTP 401) | 33 |

Not answerable by probes (confirm with Qloo and record in the access table above): permitted storage of responses, public display of provider images and metadata.
<!-- qloo-probe:end -->
