# World Sensor import

culture atlas can import photos taken with World Sensor glasses. The Sensor repository stays separate and unchanged: culture atlas only reads committed `kind=photo` assets through the relay's authenticated viewer API, the same asset boundary the Sensor app already uses. Imports are opt-in, never count as likes, and do not modify the Sensor evidence chain.

> **Status.** The relay runs only on the operator's machine and was not reachable while this was built. Everything below is tested against the mock relay in `fixtures/sensor/mock-relay.ts`, which models the API described in the [source review](../research/world-sensor-qloo-integration.md). The route paths and field names are **assumptions** until checked against the real relay. They live in one section of `relay.ts` (see [Verifying the relay contract](#verifying-the-relay-contract)).

## Two ways to connect

| | Poll mode | Bridge mode (recommended for the demo) |
| --- | --- | --- |
| Who talks to the relay | The culture atlas worker, every `SENSOR_POLL_INTERVAL_MS` (10 s) | `apps/sensor-bridge`, running next to the relay |
| Relay must be reachable from the server | Yes, over https in production | No: the bridge makes outbound calls only |
| Viewer credential | Stored server-side, encrypted (AES-256-GCM) | Stays on the bridge machine |
| Server credential | n/a | Restricted capture-write token (shown once) |
| Choosing existing photos | `import_existing_asset_ids` in the setup request | `BRIDGE_IMPORT_EXISTING` on the bridge's first run |

Both modes share one implementation of the import rules (`relay.ts`, copied verbatim into the bridge; a test fails if the copies differ):

- **Allowlisted origins only.** Poll mode refuses origins outside `SENSOR_ALLOWED_ORIGINS`, re-checks on every poll, follows redirects only within the same origin, and rejects oversized bodies (`SENSOR_MAX_ASSET_BYTES`) and unexpected content types. Arbitrary URLs are never fetched.
- **Dedupe by connection + asset id.** A photo is imported at most once per connection. The server ledger (`sensor_imports`) survives capture deletion, so a deleted photo is not re-imported.
- **Hash verification.** When the relay declares a sha256, the downloaded bytes must match. The app checks again on upload. A mismatch is recorded and that photo is skipped. Unreadable declared hashes count as unverifiable and are never imported.
- **`captured_at` vs `received_at`.** The capture keeps the relay's capture time, separate from the time culture atlas received it.
- **First connection imports only selected existing photos.** Every photo that already exists when you connect is recorded as skipped unless you selected it. After that, every newly committed photo is imported.
- **No skips, no duplicates across outages.** The cursor never moves past a page that still holds an unresolved photo (a transient failure, or a photo listed before it is committed). When the relay or the app is offline, polling backs off (interval × 2ⁿ, up to 5 minutes) and resumes where it stopped.
- **Imports are not likes.** An import creates a private capture and queues its analysis like an upload. It never saves anything or records a preference.

## Poll mode

1. Set on the server: `SENSOR_ALLOWED_ORIGINS=https://relay.example.com:8443` and `CREDENTIAL_ENCRYPTION_KEY` (`openssl rand -base64 32`).
2. As the signed-in account owner, call `POST /v1/sensor-connections` (cookie session and `x-csrf-token`):

   ```json
   { "origin": "https://relay.example.com:8443", "viewer_credential": "<viewer credential>", "mode": "poll",
     "import_existing_asset_ids": ["<asset id>", "<asset id>"] }
   ```

   The response never contains the credential. The first poll runs immediately.
3. `GET /v1/sensor-connections` shows `status` (`connecting`, `active`, `offline`, `needs_attention`), `last_success_at`, `last_error_code`, `imported_count` and `last_imported_at`. "World Sensor offline" in the settings UI comes from `status: offline`. Upload and camera capture keep working regardless.

## Bridge mode

1. `POST /v1/sensor-connections` with `{ "origin": "http://127.0.0.1:8787", "mode": "bridge" }`. In this mode the origin is a label only; the server never contacts it. Save the `bridge_token` from the response: it is shown once. The token can only call `POST /v1/uploads`, `POST /v1/captures` (for this connection) and `GET /v1/jobs/{id}`.
2. On the machine next to the relay, check out this repository, run `pnpm install`, and set:

   | Variable | Value |
   | --- | --- |
   | `BRIDGE_RELAY_ORIGIN` | The relay as the bridge sees it, e.g. `http://127.0.0.1:8787` |
   | `BRIDGE_VIEWER_CREDENTIAL` | Relay viewer credential (never sent to the app) |
   | `BRIDGE_APP_URL` | Public app URL, e.g. `https://culture-atlas.example` |
   | `BRIDGE_CAPTURE_TOKEN` | The `bridge_token` from step 1 |
   | `BRIDGE_CONNECTION_ID` | `connection.id` from step 1 |
   | `BRIDGE_IMPORT_EXISTING` | Optional, first run only: comma-separated existing asset ids to import |
   | `BRIDGE_STATE_FILE` | Default `.data/sensor-bridge-state.json` (cursor and ledger; one file per connection) |
   | `BRIDGE_POLL_INTERVAL_MS` / `BRIDGE_MAX_ASSET_BYTES` | Default 10000 / 15728640 |

3. `pnpm sensor-bridge list` prints the photos on the relay, which helps you choose `BRIDGE_IMPORT_EXISTING`.
4. `pnpm sensor-bridge` polls until stopped (Ctrl-C). `pnpm sensor-bridge once` runs one pass, for cron or a quick check. Exit codes: 0 ok, 1 offline or error, 2 fatal (token revoked or expired, connection disabled, bad configuration).

The bridge keeps working across restarts: its state file is a ledger of every asset it has resolved. If the state file is lost, the app's own ledger still prevents duplicate captures; the bridge only uploads again. Disconnecting in settings (`DELETE /v1/sensor-connections/{id}`) revokes the token, and the bridge stops on its next call.

## Disconnecting

`DELETE /v1/sensor-connections/{id}` stops imports immediately. It deletes the stored viewer credential, revokes the bridge token and cancels pending polls. Captures that were already imported stay in the library; delete them individually. The import ledger keeps the asset ids so this connection never re-imports them.

## Trying it locally with the mock relay

```sh
pnpm mock-relay --port 8787 --existing 3 --emit-every 20   # credential: dev-viewer-credential
```

- **Bridge:** create a bridge connection against your local app, then run the bridge with `BRIDGE_RELAY_ORIGIN=http://127.0.0.1:8787` and `BRIDGE_VIEWER_CREDENTIAL=dev-viewer-credential`.
- **Poll mode:** set `SENSOR_ALLOWED_ORIGINS=http://127.0.0.1:8787` in development. Production requires https.

Tests covering this: `packages/domain/src/sensor/*.test.ts`, which includes a bridge-to-app end-to-end test against the real domain services, and `apps/sensor-bridge/src/bridge.test.ts`.

## Verifying the relay contract

Before the live demo, run against the real relay:

1. `pnpm sensor-bridge list` with the real origin and viewer credential. If it fails, compare the relay's responses with the "Contract" section at the top of `packages/domain/src/sensor/relay.ts`:
   - routes `GET /wc/v2/assets?kind=photo&committed=true&cursor=&limit=` and `GET /wc/v2/assets/{id}/content`;
   - `Authorization: Bearer` viewer auth;
   - page fields `assets`/`items`, `next_cursor`/`nextCursor`, `has_more`/`hasMore`;
   - asset fields `asset_id`/`assetID`, `kind`, `committed` or `state: "committed"`, `sha256`, `captured_at`/`capturedAt`.
2. Fix it in `packages/domain/src/sensor/relay.ts`, copy the file to `apps/sensor-bridge/src/relay.ts`, and run `pnpm test`.
3. Update the mock relay if the real shape differs, so the tests keep modeling reality.
4. Run `pnpm sensor-bridge once` against a staging app, then take one photo with the glasses and confirm it appears exactly once.
