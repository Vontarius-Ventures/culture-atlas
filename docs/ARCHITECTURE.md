# culture atlas architecture

This document is the working contract for everyone building culture atlas in parallel. The [build spec](../specs/cultural-discovery-build-spec.md) governs behavior and permissions; the [design guide](../design/cultural-atlas-v1/DESIGN-GUIDE.md) and [tokens](../design/cultural-atlas-v1/tokens.css) govern the interface. If this document conflicts with the spec, the spec wins and this document should be fixed.

## Layout

```
apps/
  web/            Next.js App Router: consumer UI, REST /v1 route handlers, MCP endpoint /mcp, demo inspector
  worker/         DB-backed job worker (leases, heartbeats, deadlines, retries) -> pipeline handlers
  demo-agent/     Independent MCP client (talks only to /mcp; must not import domain/providers)
  sensor-bridge/  Outbound World Sensor bridge (talks only to the relay and public /v1; no domain imports)
packages/
  domain/         Domain services, zod schemas, authz, jobs, db access, pipeline handlers
  providers/      VLM, text model, Qloo, research and storage adapters + capability matrix
  agent-gateway/  MCP tool definitions over domain services, MCP transport
db/migrations/    Plain SQL migrations (applied by scripts/migrate.ts)
fixtures/         Recorded-shape fixtures and sample inputs (see fixtures/README.md)
scripts/          migrate.ts, dev-db.sh (+ probe-qloo.ts once the Qloo adapter lands)
docs/             This file, capability-matrix.md
```

Dependency direction (no cycles): `providers` <- `domain` <- `agent-gateway` <- `web`; `worker` -> `domain` + `providers`. `demo-agent` and `sensor-bridge` depend on neither (enforced by ESLint `no-restricted-imports`).

All workspace packages export TypeScript source (`"main": "./src/index.ts"`). Next transpiles them (`transpilePackages`), the worker and scripts run under `tsx`, Vitest handles them natively. There is no separate build step for packages; `pnpm build` type-checks them and runs `next build`.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm install` | Install pinned dependencies (exact versions; lockfile committed) |
| `pnpm db:setup` | Start PostgreSQL 16 and create role `culture_atlas` (CREATEDB) plus databases `culture_atlas` and `culture_atlas_test` |
| `pnpm db:migrate` | Apply `db/migrations/*.sql` to `DATABASE_URL` (or `-- --url ...`) |
| `pnpm dev` | Next.js dev server on :3000 |
| `pnpm worker` | Start the job worker |
| `pnpm test` | Vitest (creates and drops an isolated database per run) |
| `pnpm test:e2e` | Playwright browser journeys (Chromium preinstalled; never run `playwright install`) |
| `pnpm typecheck` / `pnpm lint` / `pnpm build` | Type-check every package / ESLint / type-check + `next build` |

## Suggested workstreams and file ownership

Parallel agents work in separate worktrees. Each owns the files below and should avoid editing files owned by another stream. Shared files (bottom table) change only additively and with a clear commit message, because every stream merges them.

| Stream | Owns |
| --- | --- |
| 1. Providers | `packages/providers/src/{vlm,text,qloo,research,storage}/**`, `packages/providers/src/testing/**`, `fixtures/{qloo,vlm,research}/**`, `scripts/probe-qloo.ts`, `docs/capability-matrix.md`, `apps/web/app/v1/media/route.ts` |
| 2. Capture and compiler | `packages/domain/src/services/{captures,analyses,references,jobs,traces}.ts`, `packages/domain/src/media/**`, `packages/domain/src/pipeline/{analyze-capture,purge}.ts`, new `packages/domain/src/compiler/**` |
| 3. Library and plans | `packages/domain/src/services/{discovery,items,preferences,taste,collections,plans}.ts`, `packages/domain/src/services/auth.ts` (`createAccount` / session claim), `apps/web/app/v1/accounts/route.ts`, `packages/domain/src/pipeline/{discover-related,generate-plan,replace-plan-section}.ts`, new `packages/domain/src/{feed,composer}/**`, `fixtures/samples/**` |
| 4. Agents and sensor | `packages/agent-gateway/**`, `apps/demo-agent/**`, `apps/sensor-bridge/**`, `packages/domain/src/services/{agent-connections,sensor-connections}.ts`, `packages/domain/src/pipeline/sensor-poll.ts`, `fixtures/relay/**` |
| 5. Web UI | `apps/web/app/**` except `app/v1/**` and `app/mcp/**`, `apps/web/components/**`, `apps/web/lib/client/**`, `apps/web/styles/**`, `apps/web/e2e/**`, `apps/web/public/**` |

Shared (coordinate, additive changes only): `packages/domain/src/{enums,errors,principal,config,context}.ts`, `packages/domain/src/schemas/**`, `packages/domain/src/index.ts`, `packages/domain/src/services/{index,cards,display}.ts`, `packages/domain/src/jobs/**`, `apps/web/lib/server/http.ts`, `apps/web/app/v1/**` route files, `package.json` files and `pnpm-lock.yaml`, `.env.example`, this document.

The stream assignment given by the orchestrator wins over this table.

## Contracts

### Principals and authorization

`packages/domain/src/principal.ts` defines `Principal`:

- `anonymous`: isolated temporary session (24 h). Holds `captures:read/write` and `taste:read/write` over its own records only. Anything needing an account throws `account_required` (403) so the UI can prompt account creation.
- `account`: signed-in browser session; every scope over its own data.
- `agent`: bearer connection (`Authorization: Bearer cat_<prefix>_<secret>`), limited by `scopes`, `libraryAccess` (`none` / `selected_collections` / `all`) and `allowedCollectionIds`. `purpose: 'sensor_bridge'` marks the restricted capture-write token used by `apps/sensor-bridge`; the route helper only lets it call `POST /v1/uploads`, `POST /v1/captures` and `GET /v1/jobs/{id}`.
- `system`: worker/maintenance code. Never reachable over HTTP.

`ownerOf(principal)` returns the data owner (an account, or an anonymous session). Private tables use the owner pair `(owner_account_id, owner_session_id)` with exactly one set; account-only tables use `owner_account_id`. Use `ownerPredicate(owner, alias, $n)` in SQL. Never trust an id from the client: every read constrains by owner, and for agents also by the CURRENT grant (`grantedCollectionFilter`, `requireCollectionGrant`). Not-owned or not-granted records are always `404 not_found`, never 403. Missing scopes are `403 scope_denied`.

`packages/domain/src/authz/index.ts` holds the pure checks (`requireScopes`, `requireAccount`, `requireAccountOwner`, `requireWholeLibrary`, `requireCanCreateCollection`, `resolveTasteScope`, ...). Services call them first; route `auth`/`scopes` in the route contract are a fast pre-check, not a substitute.

Sessions and credentials (`services/auth.ts`, implemented): the `ca_session` HttpOnly cookie holds a random token whose sha256 is stored in `sessions.token_hash`. `GET /v1/session` (and any GET route) creates an anonymous session when none exists and returns a `csrf_token` (HMAC of the session id). Every cookie-authenticated mutation must send it as `x-csrf-token`; bearer calls skip CSRF. Mutations without any session get `401` ("Start a session first"). Agent tokens are stored as sha256 + display prefix; revoked or expired tokens fail with `token_revoked` / `token_expired` (401) on the very next call.

Accounts and sign-in (demo mechanism, `services/accounts.ts`):

- `POST /v1/accounts` creates an account. `email` + `password` are optional together: with them the account can sign in anywhere (password stored only as a scrypt hash in `account_credentials`, migration `030`); without them it is a "device account" bound to this browser's session.
- The web account prompt offers optional email + password on creation and a "Sign in" mode; Settings has "Sign out".
- `POST /v1/session/sign-in` (`{email, password}`) and `POST /v1/session/sign-out` are extension routes. Failed sign-ins are limited per email (10/day, `rate_limited`) and unknown emails take the same time as wrong passwords.
- Creating an account or signing in from an anonymous session **claims** it: captures (which then persist until deletion), uploads, saved items, hides, preference events, discovery items (merged by `canonical_key`, with recommendations/saves/related contexts remapped), discovery jobs, jobs and the taste profile move to the account, and the taste revision moves forward. Then the visitor's intended save runs: `pending_save` = `{target_type, target_id, collection_id? | new_collection_name?}`; the result is returned as `pending_save` in the response.
- The session token rotates on every privilege change (account creation, sign-in, sign-out): the old cookie is revoked, a new `ca_session` cookie is set through `HandlerArgs.setSession`, and the response carries the new `csrf_token`.
- Anonymous visitors cannot save (`403 account_required`, the UI then sends the save as `pending_save`); they can hide/unhide and browse.
- Cookies are HttpOnly, SameSite=Lax, and Secure in production or whenever `APP_BASE_URL` is https. `SESSION_SECRET` is required in production.

Quotas and abuse limits (`quotas.ts`, counters in `usage_counters`): daily `analyses` / `plans` per anonymous session or per account (agents count against their account), consumed only when new work is created (reused jobs are free), inside the same transaction. Capture intake should call `consumeDailyQuota(db, {principal, metric: 'analyses', config, now})`. `apiRoute` applies a per-IP daily limit (`IP_DAILY_REQUESTS`, salted-hash bucket, never the raw address) to every mutation and to anonymous-session creation.

### Errors

`AppError(code)` with codes in `errors.ts`. HTTP mapping: 400 `invalid_input`/`unsupported_image`, 401 `unauthenticated`/`token_expired`/`token_revoked`, 403 `scope_denied`/`account_required`/`csrf_failed`, 404 `not_found`, 409 `conflict`/`revision_conflict`/`idempotency_conflict`/`idempotency_in_progress`, 413 `payload_too_large`, 429 `rate_limited`/`quota_exceeded`, 503 `provider_unavailable`/`service_unavailable`, 501 `not_implemented` (stubs only), 500 `internal`. The body is always `{code, message, retryable, request_id}` plus optional safe `details` (zod issues). Unknown errors become `internal` without leaking their message. Provider failures surface as `ProviderError` from adapters; domain code converts them (`provider_unavailable`, `rate_limited`).

### Schemas and the route contract

Every REST request/response has a zod schema in `packages/domain/src/schemas/*.ts`, one file per area. Requests use `z.strictObject` (unknown mutation fields are rejected); responses use `z.object`. Wire format is snake_case JSON with ISO-8601 UTC timestamps.

`schemas/routes.ts` exports `ROUTES`: method, path, auth level, scopes, params/query/body/response schemas, success status, idempotency and the matching MCP tool. Routes marked `extension: true` are additions beyond the spec table (`GET /v1/session`, `POST /v1/accounts`, `POST /v1/uploads`, `GET /v1/plans`, `GET /v1/agent-connections`, `GET /v1/sensor-connections`). `GET /v1/health` and `GET /v1/media` (local-storage signed media) live outside the registry.

Consumer DTOs never contain raw scores, affinity values, provider names or technical labels. `DiscoveryCard.is_example` must be true for anything from samples or replayed fixtures, and the UI labels those cards "Example result". Only the demo inspector schema (`schemas/traces.ts`) exposes provider ids, queries and ranks.

`services/display.ts` defines the `discovery_items.display_metadata` shape, and `services/cards.ts` (`loadCards`) is the single DiscoveryItem -> DiscoveryCard mapper (visibility, saved state, signed image URLs). Reuse it everywhere a card is returned.

### How REST handlers call services

Route files in `apps/web/app/v1/**/route.ts` are one-liners over `apiRoute(contract, handler)` from `apps/web/lib/server/http.ts`:

```ts
export const GET = apiRoute(ROUTES.getCapture, ({ ctx, params }) => captures.getCapture(ctx, params));
```

`apiRoute` assigns a request id, resolves the principal, enforces the contract's auth level and scopes, checks CSRF, validates params/query/body, applies `Idempotency-Key`, validates the response outside production (a schema violation is a 500 in dev and tests, so contract drift fails loudly), and maps errors. Handlers receive a `ServiceContext` (`principal`, `requestId`, `db`, `providers`, `config`, `now`, `surface`). Services never read `process.env` or globals directly, so tests can build a context with fakes (`testContext` in `@culture-atlas/domain/testing`). Multipart routes receive the raw `FormData` (`readImageField`, `formFields` helpers).

Server components use `getServerContext()` from `apps/web/lib/server/session.ts` to call the same services directly. The browser client calls REST.

Service functions are typed stubs that throw `not_implemented` (HTTP 501) until their owner implements them. Keep the exported signatures; if a signature must change, change the schema and the route file in the same commit.

### MCP

`packages/agent-gateway/src/tools.ts` defines the 15 spec tools. Each tool's input mirrors the REST schema and its `run` calls the same domain service as the REST route. `routeForTool(name)` returns the mirrored `ROUTES` contract.

`server.ts` (`createMcpHandler` / `handleMcpRequest`, mounted at `apps/web/app/mcp/route.ts`) is a stateless Streamable HTTP endpoint (POST only, JSON responses, low-level SDK `Server` per request). Per request it resolves the bearer token with `auth.resolvePrincipal` (missing, unknown, expired or revoked tokens return the REST HTTP status and error body, plus `WWW-Authenticate: Bearer`; cookies are ignored; sensor-bridge tokens get 403). Per tool call it runs `authorizeOperation(principal, routeForTool(name), 'mcp')`, validates input with the tool's zod schema, calls the service, validates output against the route's response schema outside production, and records a redacted `agent_tool_call` trace event (args, outcome, error code, one-line summary, and `refs` of the ids touched, which the inspector uses to link calls to jobs). Errors are tool results with `isError: true` and `structuredContent.error` equal to the REST error body. Mutating tools accept `_meta.idempotency_key`. Client setup is in [agents.md](agents.md).

### Authorization entry point (REST and MCP)

`authz/operations.ts#authorizeOperation(principal, contract, surface)` is the single operation-level check. `apiRoute` (`enforceAuth`) and the MCP gateway both call it with the same `ROUTES` contract, so the two surfaces refuse a token with the same code. It covers the sensor-bridge restriction (three REST routes only, nothing over MCP), the auth level (`owner` and `demo` are browser account sessions only) and scopes. Grant and ownership checks stay in the services (`authz/index.ts` pure checks plus `library/access.ts` SQL visibility), which re-read the CURRENT grant on every call. `authz/connection-access.ts#describeConnectionAccess` produces the plain-language reads, writes and limits shown at connection setup (`access_summary` on `AgentConnectionDto`).

### Demo inspector

`services/traces.ts#getTrace` backs both `GET /v1/demo/traces/{job_id}` and the server-rendered page `/inspector/{jobId}` (`apps/web/app/inspector/[jobId]`). It is available only to the job's owning account when that account is a demo owner (`accounts.is_demo_owner` or `DEMO_INSPECTOR_ACCOUNT_IDS`); everyone else gets 404. It assembles the photo (short-lived signed URL), observations, resolved provider ids, provider queries (sanitized request plus the top-10 ranked results), references with claim and source counts, recommendations with origin and query ids, preference events on the involved items, the agent's tool calls and pipeline events. A second redaction pass removes credentials, storage keys and private-network URLs. No consumer screen links to it.

### Idempotency

`withIdempotency(db, {principal, route, key, request}, run)` (`idempotency.ts`) scopes keys to principal + route template, stores the request hash and response for 24 h, replays a matching request, returns `409 idempotency_conflict` for a changed payload and `409 idempotency_in_progress` while the first call is still running, and releases the key if the handler throws. `apiRoute` applies it automatically whenever an idempotent route receives the header.

### Jobs

The tables are `jobs` (lease columns: `lease_owner`, `lease_expiry`, `heartbeat_at`, `attempt`, `max_attempts`, `available_at`, `cancel_requested_at`) and `job_stages` (idempotent per-stage outputs). Primitives live in `packages/domain/src/jobs/`:

- `enqueueJob(db, {type, owner, payload, dedupeKey, ...})` validates the payload against `JobPayloads[type]`. A non-failed, non-cancelled job with the same `dedupeKey` is reused (`reused: true`); this is how a duplicate submission maps onto the existing job. Build keys with `analysisDedupeKey`, `relatedDiscoveryDedupeKey`, `planDedupeKey` and `planReplacementDedupeKey`. They include the owner, so a hash never exposes another user's result.
- `claimJobs` leases with `FOR UPDATE SKIP LOCKED`. It also reclaims running jobs whose lease expired, which is how a lost worker recovers.
- `heartbeatJob`, `setJobStage`, `completeJob`, `failJob` (retryable failures go back to `queued` with exponential backoff and jitter; otherwise `failed`), `cancelJob`, `cancelJobsForResult`, `markJobCancelled`, `reapJobs` and `stillOwnsJob`. Every write is guarded by `lease_owner`, so a worker that lost its lease cannot overwrite a newer attempt.
- `runStageOnce` / `recordStage` keep stage writes idempotent: the first completion wins, and a retry reads the stored output back instead of calling providers again.

States are `queued`/`running` while active, then terminal `complete`, `partial` (useful output with some sections failed or unavailable; targeted retry possible), `failed` or `cancelled`. Job-starting routes return 202 with `job_id`. Clients poll `GET /v1/jobs/{id}`, which returns `poll_after_ms` (1.5 s, then 4 s after 15 s, null when terminal).

### How the worker dispatches job types

`apps/worker/src/worker.ts` claims up to `WORKER_CONCURRENCY` jobs and looks each one up in `JOB_HANDLERS` (`packages/domain/src/pipeline/index.ts`, a `JobType -> handler` map). It runs the handler with a `JobContext` that provides `payload`, `db`, `providers`, `config`, `signal`, `budget`, `setStage`, `runStage`, `ensureActive`, `trace` and `log`, plus a heartbeat timer and a per-attempt deadline (`ANALYSIS_DEADLINE_MS`, 60 s). After the handler:

- a returned `{state: 'complete' | 'partial', resultType, resultId}` completes the job;
- `AppError` or `ProviderError` re-queues the job with backoff when retryable (honoring `retryAfterMs`) and fails it otherwise;
- cancellation, lease loss or deletion marks it cancelled;
- a deadline overrun fails the attempt as retryable `service_unavailable`.

Handlers must call `ctx.ensureActive()` right before publishing anything. That is how a deletion during a running job prevents publication.

To add a job type, add it to `JOB_TYPES` (`enums.ts`), add its payload schema to `JobPayloads` (`jobs/types.ts`), and register its handler in `pipeline/index.ts`. TypeScript then rejects the build until all three agree.

### Library, feed and plans

- **Access** (`library/access.ts`): `visibleItemIds` / `requireVisibleItem` decide which discovery items a principal can see (owned or sample; for selected-collection agents only the CURRENT grant: members of granted collections, the compiled context of granted captures, related discoveries whose origin is still a granted member, items of plans derived entirely from granted items, and captures the connection created). `loadAccessibleCollection` and `planWithinGrant` apply the same rule to collections and plans. Everything outside is `404`.
- **Taste** (`library/taste-fold.ts`): `foldPreferences` is a pure function of current saved items + hides. An item save endorses that item (weight 1) and lends its anchors 0.5; an inspiration (capture) save contributes its anchors (0.6, user-selected/confirmed 1.0); a saved item counts once however many collections hold it; hide removes only that item. Every effective save/remove/hide/unhide bumps `taste_profiles.revision` and rebuilds `summary` in the same transaction.
- **Feed** (`services/discovery.ts`): new users (no saves) get the reviewed samples in `feed/samples.ts`; returning users get a bounded pool (120) of recommendations connected to explicit saves (saved inspirations, captures they saved results from, related jobs from saved items), fused with RRF, already-saved and hidden items removed, interleaved by category (`interleaveFeed`: dedupe, ≤2 consecutive of one category while alternatives exist). Pages read a `feed_snapshots` row; the cursor carries snapshot id + taste revision + position; Load more never generates. Hides take effect inside existing snapshots.
- **Composer** (`composer/`): `fusion.ts` (exclusions first, reciprocal rank fusion, diversity, `familiar`/`balanced`/`adventurous` windows that always keep the strongest anchor), `dietary.ts` (exclusion matching with common forms; safety claims stripped), `movie-night.ts` (Qloo insights with real resolved ids, every Qloo pick cites its provider queries; composer-model creative fallback flagged `vlm_creative`; otherwise the section is `unavailable`), `provider-calls.ts` (≤ `JOB_MAX_QLOO_REQUESTS` per job, ≤ `JOB_MAX_PROVIDER_RETRIES` with backoff + jitter; Retry-After over 5 s re-queues the job), `store.ts` (stable identities: `qloo:<id>`, `film:<title>|<year>`, `food:<title>|<reference ids>`).
- **Plans**: `POST /v1/plans` snapshots selected items, anchors (with revisions), constraints and collection revision into `plan_versions.input_snapshot`; the pipelines read only the snapshot. Replacement creates a new version copying the other sections and never re-proposes earlier picks of that section; all versions are kept. Collection deletion detaches `source_collection_id` but keeps the plan.
- **Test support**: `packages/domain/src/test-support/library.ts` has factories (items, references, captures with analyses, saves) and `runJob(jobId, {providers})`, which runs a queued job through `JOB_HANDLERS` with the worker contract.

### Providers and capabilities

`createProviderRegistry(env, overrides)` returns `{vlm, text, composer, research, qloo, storage, capabilities()}`. Every adapter reports a `CapabilityEntry` (`available` / `degraded` / `unverified` / `unavailable` + reason). Unimplemented or unconfigured adapters are `Unavailable*` classes that reject with `ProviderError('unavailable')`. They never fabricate data.

- Qloo: with `QLOO_API_KEY` unset every Qloo capability is `unavailable / not_configured`. That is the expected state until the key arrives; the pipeline must still return reference results and mark discovery categories `unavailable` ("Related discoveries are taking longer"). Contract tests use recorded-shape fixtures. Replays are `is_replay: true` and are shown as "Example result".
- VLM and text use Anthropic (`ANTHROPIC_API_KEY`, `VLM_MODEL` / `RESEARCH_MODEL`, default `claude-sonnet-5-5`). Image text is data and cannot change instructions; the model gets no tools apart from the structured-output schema.
- Research uses Wikipedia/Wikimedia REST (real URLs) for sources and the text model for claim extraction.
- Storage: the drivers are `local`, `s3` and `memory`. Tests use `memory` (`testProviders()`).

Tests never touch the network; use the fakes in `@culture-atlas/providers/testing` (`FakeVlm`, `FakeTextModel`, `FakeResearch`, `FakeQloo`, `MemoryObjectStorage`).

### Images

`media/image.ts` handles intake. `sniffImageType` is implemented; `normalizeImage` is a stub. The prebuilt `sharp@0.35.5` / libvips 8.18 in this repo decodes AVIF but not HEVC-based HEIC, so HEIC uploads must return `unsupported_image` with conversion guidance unless a HEIC decoder is added.

## Database

`db/migrations/001_init.sql` implements every record in the spec's data model, plus `uploads`, `discovery_jobs` (the third parent for provider queries and recommendations), `agent_connection_collections` (grant rows, cascading on collection delete), `item_exclusions`, `taste_profiles`, `job_stages`, `idempotency_keys`, `sensor_imports` (dedupe ledger), `trace_events` and `usage_counters`. Notable constraints:

- The spec `Reference` table is `cultural_references`, because `references` is an SQL keyword.
- `collection_items` uses composite foreign keys to `collections(id, owner_account_id)` and `saved_items(id, owner_account_id)`, so the database itself enforces "owner must match".
- `provider_queries` and `recommendations` require exactly one of `analysis_id` / `plan_id` / `discovery_job_id`. A `qloo`-origin recommendation must cite at least one `provider_query_id`.
- A factual `claims` row must cite at least one source.
- Uniqueness: `saved_items(owner, discovery_item_id)`, `collection_items(collection_id, saved_item_id)`, `discovery_items(owner, canonical_key)` (sample items unique by key), `analyses(capture_id, version)`, `jobs.dedupe_key` while active, `idempotency_keys(principal_key, route, key)` and `sensor_imports(connection, asset_id)`.

Migration rules:

- Never edit an applied migration; the runner stores checksums and refuses. Add a new file instead.
- To avoid numbering collisions between parallel streams, use the stream's range: providers `010-019`, capture/compiler `020-029`, library/plans `030-039`, agents/sensor `040-049`, web `050-059` (for example `031_collections_cover_index.sql`). Each migration must stand on its own after `001`.
- Pool connections run with `timezone=UTC`. `bigint` counts come back as JS numbers and `date` as `YYYY-MM-DD` strings.

## Testing

- Put unit and integration tests in `*.test.ts` next to the code (node environment). Name web component tests `*.dom.test.tsx` (jsdom). Browser journeys go in `apps/web/e2e/*.spec.ts` (Playwright at 1440, 390 and 360 px).
- `vitest.global-setup.ts` creates a fresh database (`ca_test_<pid>_<rand>`) per run from `TEST_DATABASE_URL`, migrates it and drops it afterwards, so parallel worktrees never collide. Use `getTestDb()` and the factories in `@culture-atlas/domain/testing`: `insertAccount`, `insertAnonymousSession`, `insertAgentConnection`, `testContext` and `testProviders`.
- Never `TRUNCATE`. Create fresh owners per test, because test files run in parallel against the same database. When a test drives the queue, claim jobs by id (`claimJobs({ids})`, `new Worker({jobIds})`).
- The spec's required unit tests cover preference folding, membership and ordering, identity dedupe, ownership and grant checks, rank fusion, idempotency and job transitions. Integration tests cover isolation, deletion, revocation and plan snapshots. Adapter contract tests run against fixtures. Keep a real-provider smoke check separate from fixture tests and skipped without keys.

## Conventions

- The product name is always "culture atlas", in lowercase.
- Pin exact dependency versions. Most plausible dependencies are already installed; add new ones only when necessary, with an exact version, and say so in the commit message because the lockfile is shared.
- Never commit secrets. `.env.example` lists names only.
- Logs contain ids, timings, counts and safe errors only: no image bytes, credentials or full private prompts.
- Do not add a LICENSE file; choosing a license is a release step for the user.
