# P5 native command and collection-media contract

Version `2026-10-15.1`. This documents executable P5 policy and the route contract;
native route runtime integration uses P1's capture/identity HTTP context.

## Authentication

Agent creation uses an explicitly granted bearer with `devices:command` and
selected installation IDs. Native claim/ack use the enrolled installation's
short-lived `cna_` bearer. Account cookies and agent/share tokens cannot claim
or acknowledge commands. The verified principal supplies account/installation.

No endpoint arms a phone remotely. Local arming must list permitted connections,
remain unexpired, and match the capture session generation. Readiness is fresh
for at most30 seconds; foreground, source capability, wearable permission and
server experimental eligibility must still hold.

## Request and delivery

`POST /v2/devices/{installation_id}/commands`, agent bearer,
`Idempotency-Key: <UUID>`:

```json
{
  "session_id": "<capture-session UUID>",
  "generation": 1,
  "action": "capture_photo",
  "capture_client_id": "<persisted local-capture UUID>",
  "expires_in_seconds": 30
}
```

Actions: `capture_photo`, `start_video`, `stop_video`. `start_video` optionally
accepts `duration_seconds` (1–60, default60). Session mode must match. Audio is
never enabled by a command. Expiry is1–30 seconds, never extended by delivery.
Stop is for the initiating authorized agent while its active video exists;
the local user always has stop priority.

Success202 is the command envelope below. It is a request, not hardware success.
Repeated key+same normalized payload returns the same command; changed payload
returns409 `idempotency_conflict`. An active competing start returns409.
No local arm returns409 `action_required`, not a simulated capture.

`GET /v2/device/commands?after_sequence=0&wait=0`, native bearer:

```json
{
  "schema_version": "2.1",
  "request_id": "<request UUID>",
  "items": [{
    "command_id": "<command UUID>",
    "delivery_sequence": 1,
    "session_id": "<capture-session UUID>",
    "generation": 1,
    "action": "capture_photo",
    "duration_seconds": null,
    "capture_client_id": "<capture UUID>",
    "authorization_version": 1,
    "state": "delivered",
    "expires_at": "<RFC3339 timestamp>",
    "result_asset_id": null,
    "error_code": null
  }],
  "next_sequence": 1
}
```

Maximum20 commands per batch. `wait` is bounded0–25 seconds. Delivered or
awaiting-user commands may be repeated even after the cursor. Persist the receipt
and `capture_client_id` before acknowledging; deduplicate by command_id, not
transport delivery. Revoked/rotated/narrowed grants and expired/stale sessions
are rechecked at delivery and cancelled/expired instead of delivered.

## Acknowledgement and the last authorization check

`POST /v2/device/commands/{command_id}/ack`, native bearer,
`Idempotency-Key: <UUID>`:

```json
{"sequence": 1, "state": "executing"}
```

**Before the shutter**, send `executing` and wait for a successful response whose
state is still `executing` and whose authorization_version matches the receipt.
This is the final online version/arming/eligibility check. Never act after a
failed check or against a stale session generation. Even a repeated executing
ack rechecks current authorization, so replay cannot bypass revocation.

Ack sequence is monotonic **per command**. Duplicate/stale acks return current
state without regressing it. Changed payload under the same idempotency key is
409. Allowed transitions:

- delivered → awaiting_user / executing / failed / unknown
- awaiting_user → executing / failed / unknown
- executing → succeeded / failed / unknown

`succeeded` means the local file was durably recorded, not uploaded. Optional
`result_asset_id` must belong to the same account, installation and session.
An upload can appear later under the persisted capture_client_id.
Optional `safe_error`: `device_unavailable`, `permission_denied`, `interrupted`,
`storage_full`, `outcome_unknown`. Do not send photo content, device identifiers
or credentials in errors.

If a crash leaves shutter outcome uncertain, acknowledge `unknown`. Never
automatically reissue an expired or uncertain request. Persisted phone receipts
provide one known execution or explicit uncertainty, not a promise of exactly-once
hardware effects. Reconnect never re-arms capture.

Owner/initiating agent polls `GET /v2/commands/{id}` or
`GET /v2/operations/{id}`. No cross-account command IDs are revealed.

## Collection media, for P2

All routes require account authentication (cookie+CSRF+`x-ca-account-id` for web
mutations) or explicit agent scope/resource authorization. Mutation headers
include `Idempotency-Key: <UUID>`.

| Route | Response |
|---|---|
| GET `/v2/collections/{id}/media` | `{schema_version,request_id,items:[{id,kind,title,status,generation,source,created_at}],next_cursor:null}` (bounded100) |
| PUT `/v2/collections/{id}/media/{asset_id}` | `{schema_version,request_id,collection_id,asset_id}` |
| DELETE `/v2/collections/{id}/media/{asset_id}` | same membership result |

PUT and DELETE have no body. PUT is idempotent. Both parent owners must match;
cross-account media/collections return404 and composite database FKs also reject
an invalid membership. Hidden/deleted assets disappear immediately.

P2 routes call `collectionMedia.addMediaToCollection(ctx,collectionId,assetId)`,
`removeMediaFromCollection`, `listCollectionMedia`. P6 uses the same list
function and constructs a separate public-safe projection. Legacy captured
discovery membership is recognized read-only; use existing collection-item
operations to change that legacy membership.
