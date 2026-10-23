# Connecting an agent to culture atlas

culture atlas exposes the same services to personal agents through a remote MCP endpoint and the `/v1` REST API. For the hackathon demo, connections are manually issued, expiring bearer tokens. OAuth discovery and consent for broad public agent adoption come after the controlled demo. This endpoint has been tested with the official TypeScript MCP SDK client (`apps/demo-agent`). Other MCP clients work only if they support Streamable HTTP with a custom `Authorization` header.

## 1. Create a connection (account owner, browser session)

`POST /v1/agent-connections` (cookie session + `x-csrf-token`):

```json
{
  "client_name": "My agent",
  "scopes": ["collections:read", "taste:read", "plans:read", "plans:write"],
  "library_access": "selected_collections",
  "collection_ids": ["<collection uuid>"],
  "expires_in_days": 30
}
```

The response contains `credential` (`cat_<prefix>_<secret>`), shown exactly once. Only its SHA-256 is stored. It also contains `mcp_url` and `connection.access_summary`, which lists in plain language what the agent can read and change.

- Scopes: `captures:read`, `captures:write`, `collections:read`, `collections:write`, `taste:read`, `taste:write`, `plans:read`, `plans:write`. The default is read-only.
- `library_access`:
  - `selected_collections` limits the agent to the items of those collections, their compiled context, their related discoveries and plans made entirely from granted items.
  - `all` is the whole library.
  - `none` gives no library access.
- With a selected grant:
  - Unfiled saves, other collections and the global taste profile stay private. `get_taste` requires `collection_id`.
  - New collections are not added automatically.
  - Global unsave, hide/unhide and capture deletion are refused (`scope_denied`).
  - The agent can add or remove memberships in granted collections with `collections:write`.
- Only `collections:write` together with whole-library access can create collections.
- `discover_related` needs no extra scope (it reads items already in the grant), but it starts a bounded Qloo job that writes related discovery items to the account. It always counts as a mutation against the per-connection budget (10 mutations and 60 reads a minute, REST v1 and MCP alike), so a read-only grant cannot run unbounded paid discovery.
- Every successful v1 or MCP mutation (collections, memberships, preferences, related discovery, plans, captures, uploads) is listed in the owner's agent activity (`GET /v2/agent-activity`) with the collection, plan or item name.
- `PATCH /v1/agent-connections/{id}` with `{ "collection_ids": [...] }` changes the grant. Removing a collection takes effect on the agent's next call, including for plans that depend on it.
- `DELETE /v1/agent-connections/{id}` revokes the connection immediately. The next REST or MCP call fails with `401 token_revoked`. Expired tokens fail with `401 token_expired`.

## 2. Configure the client

- Endpoint: `POST https://<your deployment>/mcp` (Streamable HTTP, stateless, JSON responses; `GET` returns 405).
- Header: `Authorization: Bearer cat_<prefix>_<secret>`.
- Tools (v1): `analyze_capture`, `get_job`, `get_capture`, `list_captures`, `get_item`, `get_discoveries`, `list_saved`, `explore_reference`, `get_taste`, `record_preference`, `list_collections`, `get_collection`, `create_collection`, `add_collection_item`, `remove_collection_item`, `discover_related`, `create_plan`, `get_plan`, `list_plans`, `replace_plan_section`. Media and devices (v2): `list_media`, `get_media`, `begin_upload`, `complete_upload`, `analyze_media`, `get_operation`, `get_setup`, `request_capture`, `get_preferences`, `update_preferences`. Inputs and outputs mirror the REST schemas.
- Reading results: `list_captures` (newest captures with analysis titles, references and recommended item ids), `get_item` (an item plus the `related[]` that `discover_related` found), `get_discoveries` (the interest feed), `list_saved`, `list_plans`.
- `tools/list` shows only the tools this connection's scopes allow; each description ends with `Requires: <scopes>`. Error text names the missing scope or the invalid fields (e.g. `invalid_input: The request is not valid. (target_id: Required)`).
- Phone capture: with `devices:command`, `get_setup` returns each permitted installation's `id` and, while the owner has armed it for this connection, `armed_session {session_id, generation, mode, source, remote_arm_expires_at}`; pass these to `request_capture`. If the owner revokes the agent after the phone claimed a command, the phone's executing acknowledgement returns the command `cancelled` with `error_code: agent_revoked` (never a 401 to the phone).
- Job-starting tools return a `job_id` immediately. Poll `get_job` until the state is `complete`, `partial`, `failed` or `cancelled`.
- Photos are uploaded with `POST /v1/uploads` (multipart, same bearer token, `captures:write`). Then pass the `upload_id` to `analyze_capture`. URLs and file paths are not accepted.
- Errors: tool results with `isError: true` and `structuredContent.error = {code, message, retryable, request_id}`. These are the same codes as REST. Records outside the grant always look like `not_found`.
- Optional idempotency: pass `_meta: { "idempotency_key": "..." }` on mutating tool calls.

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
