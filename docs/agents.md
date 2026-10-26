# Connecting an agent to culture atlas

culture atlas exposes the same services to personal agents through a remote MCP endpoint (`/mcp`) and REST (`/v1` for captures, collections, taste and plans; `/v2` for media, devices, setup, preferences and connections). Every MCP tool calls the same domain service as its REST route, so scopes, collection grants and ownership are checked identically. The endpoint is tested with the official TypeScript MCP SDK client (`apps/demo-agent`); any MCP client that speaks Streamable HTTP with an `Authorization` header works.

Machine-readable contract: `docs/api/agent-platform.openapi.json` (OpenAPI 3.1), `docs/api/agent-tools-v2.json` (MCP tool catalog with input schemas), `docs/api/schemas/` and `docs/api/examples/`. The scope and tool tables at the end of this page are generated from the code (`SCOPES`, `TOOLS`); regenerate everything with `pnpm exec tsx scripts/generate-agent-contract.ts`. `scripts/generate-agent-contract.test.ts` fails when they drift.

## 1. Connect an agent

There are two ways to connect. Both create the same kind of connection, shown in **Settings → Agents**, where the owner can narrow or revoke it at any time.

### a. OAuth 2.1 with PKCE (MCP clients that support authorization)

1. Discovery: `GET /.well-known/oauth-protected-resource/mcp` returns the resource (`<APP_BASE_URL>/mcp`), the authorization server and `scopes_supported` (every scope listed below). `GET /.well-known/oauth-authorization-server` returns the endpoints.
2. Authorization: send the owner's browser to `/settings/agents/authorize?response_type=code&client_id=…&redirect_uri=…&state=…&code_challenge=…&code_challenge_method=S256&resource=<APP_BASE_URL>/mcp`. The owner picks the scopes and library access on the consent screen (it posts `POST /v2/oauth/authorize`). Only a signed-in owner can consent, and only to a registered client and redirect URI.
3. Token: exchange the code at `POST /v2/oauth/token` (`grant_type=authorization_code`, `code_verifier`, the same `resource`). Access tokens last 10 minutes; refresh with `grant_type=refresh_token`. Refresh-token reuse revokes the whole token family.

### b. A personal token (owner, browser session)

`POST /v2/agent-connections` (cookie session + `x-csrf-token`, `Idempotency-Key`), which is what **Settings → Agents → Connect an agent** calls:

```json
{
  "client_name": "My agent",
  "scopes": ["collections:read", "taste:read", "plans:read", "plans:write"],
  "library_access": "selected_collections",
  "collection_ids": ["<collection uuid>"],
  "expires_in_days": 30
}
```

The response contains `credential` (`cat_<prefix>_<secret>`), shown exactly once (only its SHA-256 is stored), `mcp_url`, and `connection.access_summary`, which lists in plain language what the agent can read and change. The default grant is `setup:read` + `preferences:read` with no library access. `devices:command` also needs `installation_ids`. The older `POST /v1/agent-connections` still works for the v1 scopes.

### Library access

- `selected_collections` limits the agent to the items and media of those collections, their compiled context, their related discoveries and plans made entirely from granted items. Unfiled saves, other collections and the global taste profile stay private (`get_taste` requires `collection_id`). New collections are not added automatically. Global unsave, hide/unhide and capture deletion are refused (`scope_denied`). The agent can add or remove memberships in granted collections with `collections:write`.
- `all` is the whole library. Only `collections:write` with whole-library access can create collections.
- `none` gives no library access.
- `PATCH /v2/agent-connections/{id}` narrows the grant (scopes, `collection_ids`, `installation_ids`, `expires_at`). It takes effect on the agent's next call, including for plans and preview links that depend on it.
- `DELETE /v2/agent-connections/{id}` revokes immediately. The next REST or MCP call fails with `401 token_revoked`; expired tokens fail with `401 token_expired`.
- `discover_related` needs no extra scope (it reads items already in the grant), but it starts a bounded Qloo job that writes related discovery items to the account. It always counts as a mutation against the per-connection budget (10 mutations and 60 reads a minute, REST v1 and MCP alike), so a read-only grant cannot run unbounded paid discovery.
- Every successful v1 or MCP mutation (collections, memberships, preferences, related discovery, plans, captures, uploads) is listed in the owner's agent activity (`GET /v2/agent-activity`) with the collection, plan or item name.

## 2. Configure the client

- Endpoint: `POST <APP_BASE_URL>/mcp` (Streamable HTTP, stateless, JSON responses; `GET` returns 405).
- Header: `Authorization: Bearer <token>` (an OAuth access token or `cat_<prefix>_<secret>`).
- Job-starting tools (`analyze_capture`, `discover_related`, `create_plan`, `replace_plan_section`) return a `job_id` at once. Poll `get_job` until the state is `complete`, `partial`, `failed` or `cancelled`. Media uploads, media analysis and capture commands return an operation id instead: check it with `get_operation`.
- Errors: tool results with `isError: true` and `structuredContent.error = {code, message, retryable, request_id}`, the same codes as REST. Records outside the grant always look like `not_found`.
- Optional idempotency: pass `_meta: { "idempotency_key": "..." }` on mutating tool calls (media tools take an explicit `idempotency_key` argument).
- Reading results: `list_captures` (newest captures with analysis titles, references and recommended item ids), `get_item` (an item plus the `related[]` that `discover_related` found), `get_discoveries` (the interest feed), `list_saved`, `list_plans`. `get_media` adds `analysis_summary` (the compiled result) when the grant also holds `captures:read`.
- `tools/list` shows only the tools this connection's scopes allow; each description ends with `Requires: <scopes>`. Error text names the missing scope or the invalid fields (e.g. `invalid_input: The request is not valid. (target_id: Required)`).
- Phone capture: with `devices:command`, `get_setup` returns each permitted installation's `id` and, while the owner has armed it for this connection, `armed_session {session_id, generation, mode, source, remote_arm_expires_at}`; pass these to `request_capture`. If the owner revokes the agent after the phone claimed a command, the phone's executing acknowledgement returns the command `cancelled` with `error_code: agent_revoked` (never a 401 to the phone).
- Media links (`links.playback`, `links.poster`, `frames[].thumbnail_url`) are absolute URLs on `APP_BASE_URL` under `/v2/agent-media/{id}/content/{variant}`. Fetch them with the same bearer token; they stop working the moment the grant no longer covers the media.

### Photos

Upload with `POST /v1/uploads` (same bearer token, `captures:write`) as `multipart/form-data` with the photo in a field named **`image`** (JPEG, PNG, WebP, HEIC/HEIF or AVIF, up to 15 MB). Other field names are rejected with `Attach a photo in the "image" field.` Then pass the returned `upload_id` to `analyze_capture`. URLs and file paths are never accepted.

```bash
curl -X POST "$APP_BASE_URL/v1/uploads" \
  -H "Authorization: Bearer $TOKEN" \
  -F "image=@photo.jpg"
```

### Boards and plans

- A board is a collection: `create_collection` (whole-library access), then `add_collection_item` for each discovery item (from `get_capture`, `get_collection` or `discover_related` results).
- `create_plan` makes a **movie night** only (`template: "movie_night"`, the single plan template): film, food and music from 2-5 items of one collection. For a dinner party, a trip or a mood board, build a collection instead.

Text in photos, item titles, collection names and tool arguments is treated as data by the service. It never changes instructions or triggers tools.

## 3. Run the demo agent

```bash
# Seed a demo owner, a "Tokyo evenings" collection and a selected-collection connection (development only)
DATABASE_URL=... pnpm exec tsx scripts/seed-demo-agent.ts
# Start the app and the worker, then:
DEMO_AGENT_TOKEN=cat_... pnpm demo-agent -- --url http://localhost:3000/mcp --collection "Tokyo evenings"
```

The agent prints every service call as it:

1. Lists and reads the granted collection.
2. Shows that global taste is refused while collection taste is allowed.
3. Starts related discovery.
4. Creates a movie night.
5. Replaces only its film section.

With `FEATHERLESS_API_KEY` (or `ANTHROPIC_API_KEY`) set, the agent's own model (`DEMO_AGENT_MODEL`) writes the replacement instruction. Without Qloo or model keys, sections come back `partial` instead of being invented.

## 4. Show how it works

A demo owner (`accounts.is_demo_owner` or `DEMO_INSPECTOR_ACCOUNT_IDS`) can open `/inspector/<job_id>` for one of their own jobs. The same data is available as JSON at `GET /v1/demo/traces/<job_id>`. The page shows:

- the photo and its observations;
- the resolved Qloo ids;
- the query inputs and ranked results, with replays labeled "Example result";
- the sourced references;
- the provenance of each recommendation;
- saved taste changes;
- the agent's service calls.

Tokens and private deployment details are redacted. Nothing in the consumer app links to the inspector.

## 5. Reference

<!-- generated:agent-reference:start (pnpm exec tsx scripts/generate-agent-contract.ts) -->

### Scopes (16)

Every scope below is accepted by `POST /v2/agent-connections` and the OAuth consent, and is listed in `/.well-known/oauth-protected-resource/mcp`.

| Scope | What it allows |
| --- | --- |
| `captures:read` | Read photo captures, their interpretation, references and recommendations. |
| `captures:write` | Upload photos (`POST /v1/uploads`) and start photo analysis (`analyze_capture`). |
| `collections:read` | List and read granted collections (boards) and their items. |
| `collections:write` | Add or remove items in granted collections; with whole-library access, create collections. |
| `taste:read` | Read the explicit interest summary (selected-collection grants must pass `collection_id`). |
| `taste:write` | Save, unsave, hide or unhide items when the user explicitly asks. |
| `plans:read` | Read plans and their sections. |
| `plans:write` | Create plans and replace one plan section. |
| `setup:read` | Read safe device capabilities and aliases. Never grants OS permissions. |
| `preferences:read` | Read ordinary preferences (theme, language, exploration, food exclusions). Not taste. |
| `preferences:write` | Change ordinary preferences. Cannot enable capture, microphones, sharing or automatic analysis. |
| `media:read` | List and view permitted media and its preview links (absolute URLs). |
| `media:download` | Download originals of permitted media. |
| `media:write` | Begin and complete signed media uploads into a granted destination. |
| `media:analyze` | Explicitly request analysis of permitted media (never automatic). |
| `devices:command` | Request capture on an explicitly granted, locally armed phone. |

### MCP tools (30, catalog 2.3.0)

| Tool | Scopes | Returns | What it does |
| --- | --- | --- | --- |
| `list_media` | `media:read` | result | List or search media within the live collection grant. No originals or private analysis reasoning. |
| `get_media` | `media:read` | result | Read one currently permitted media item and authorized preview links. Originals require a separate download grant. |
| `begin_upload` | `media:write` | result | Begin byte intake, not analysis. Selected-collection agents must name a granted destination. Never accepts a URL or file path. |
| `complete_upload` | `media:write` | result | Submit signed byte-transfer receipts for a draft created by this connection. Check get_operation using upload_id. Analysis is never automatic. |
| `analyze_media` | `media:analyze` | result | Explicitly request analysis of one permitted, prepared photo or selected video moments. Analysis is never automatic; consent, the daily allowance and spend limits apply. Returns an analysis_id: check it with get_operation. No result links or private reasoning are returned. |
| `get_operation` | none (grant-checked) | result | Check an authorized asynchronous upload, analysis or capture command. This does not broaden resource access. |
| `request_capture` | `devices:command` | result | Request capture on an explicitly selected phone and fresh locally armed session. Take installation_id from get_setup installations[].id and command.session_id / command.generation from that installation's armed_session (present only while the owner has armed the phone for this connection). Cannot arm a phone. Check the returned command through get_operation. Uncertain or expired capture must not be retried as a new request. |
| `get_setup` | `setup:read` | result | Read safe capabilities and device aliases. Observations never grant OS permissions or arm a camera. |
| `get_preferences` | `preferences:read` | result | Read explicit and effective ordinary account preferences. This does not reveal taste. |
| `update_preferences` | `preferences:write` | result | Change only ordinary preferences using the version returned by get_preferences. Cannot enable capture, microphones, sharing or automatic analysis. |
| `analyze_capture` | `captures:write` | job_id (poll `get_job`) | Start discovery for a photo you uploaded via POST /v1/uploads (pass its upload_id; URLs and file paths are not accepted). Returns immediately with job_id; call get_job until complete, then get_capture. |
| `get_job` | none (grant-checked) | result | Get the state, progress stage and completed sections of a job started by another tool. |
| `get_capture` | `captures:read` | result | Get a capture’s interpretation, references and recommended discoveries. |
| `list_captures` | `captures:read` | result | List the newest captures this connection can see, newest first: compiled analysis title, detected references and recommended discovery item ids (open them with get_item). Use this for "things like my last capture". No photos or private reasoning. |
| `get_item` | none (grant-checked) | result | Read one discovery item (film, music, place, dish, style...) with its related items (related[] and related_state). Call this after discover_related completes to see what it found. Selected-collection connections pass the collection_id containing the item. |
| `get_discoveries` | `taste:read` | result | Read the user’s personal discovery feed (cards with title, category, image and why_this), optionally for one category. Cursor-paginated; pass next_cursor to continue. |
| `list_saved` | `taste:read` | result | List items the user explicitly saved, newest first (cursor-paginated). filter "unfiled" returns saved items in no collection. |
| `explore_reference` | none (grant-checked) | result | Get a concise sourced reference page (overview, sections, claims with sources). |
| `get_taste` | `taste:read` | result | Get the user’s explicit interest summary. Connections limited to selected collections must pass collection_id. |
| `record_preference` | `taste:write` | result | Save, remove (unsave everywhere), hide or unhide an item. Only call this when the user has explicitly said they like or dislike the item in this conversation. |
| `list_collections` | `collections:read` | result | List the collections this connection can access, with item counts and revisions. |
| `get_collection` | `collections:read` | result | Get a collection’s revision and its mixed items (cursor-paginated). |
| `create_collection` | `collections:write` | result | Create a private collection. Requires whole-library access. |
| `add_collection_item` | `collections:write` | result | Add a discovery item to a granted collection (idempotent). Adding an item the user has not saved also requires taste:write and an explicit user request. |
| `remove_collection_item` | `collections:write` | result | Remove one membership from a granted collection; the saved item and other memberships remain. |
| `discover_related` | none (grant-checked) | job_id (poll `get_job`) | Start a bounded related-discovery job for an item. Selected-collection connections pass the collection_id containing the item. Returns immediately; poll get_job. |
| `create_plan` | `plans:write`, `collections:read` | job_id (poll `get_job`) | Create a movie-night plan (film, food and music; the only plan template) from 2-5 items of one collection (include expected_revision). Returns immediately; poll get_job, then get_plan. For any other board (a dinner party, a trip, a mood board), use create_collection and add_collection_item instead. |
| `get_plan` | `plans:read` | result | Get a plan’s current version: film, food, music and section states. |
| `list_plans` | `plans:read` | result | List the user’s movie-night plans, newest first (cursor-paginated). Open one with get_plan. |
| `replace_plan_section` | `plans:write` | job_id (poll `get_job`) | Replace the film, food or music section, keeping the others. Returns immediately; poll get_job. |

<!-- generated:agent-reference:end -->
