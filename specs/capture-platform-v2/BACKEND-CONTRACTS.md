# Backend and device contracts

> Audio scope is extended by [amendment2.3](AUDIO-AND-MULTIMODAL.md): standalone audio, Music Mode, soundtrack/evidence analysis, provider qualification, new permissions and safe sharing migration. This amendment takes precedence for audio; other behavior is unchanged.

All operations below are required v2 contracts, not claims that routes exist. Existing v1 capture endpoints retain their old behavior through a compatibility adapter. New media lifecycle endpoints live under `/v2` to avoid colliding with existing `/v1/media` signed-image serving.

## Ownership and persistence invariants

Derive account/installation from verified authentication. Ignore or reject client owner overrides. Every asset, upload, derivative, command, device event and processing job is account-owned. Every child reference must have the same account as its parent. Use composite `(account_id,id)` foreign keys or equivalent validated transaction constraints. A UUID is not authorization. Service workers act from persisted job ownership and cannot use a generic founder account.

Storage keys are server-generated opaque paths: `accounts/{account_uuid}/media/{asset_uuid}/{version}/{variant}`. Client filenames are sanitized display metadata only. Signed upload instructions can only address that upload's staging object/part, never an arbitrary key. Cross-account lookups return 404; requests for unsupported capabilities by an authenticated owner return a safe explicit reason.

| Record | Required columns and constraints |
| --- | --- |
| mobile_installations | id UUID, account_id FK, platform, version, auth_session_id, push token encrypted/reference, last_seen_at, revoked_at; installation/account pair unique |
| wearable_connections | id, account_id, installation_id same-owner FK, SDK opaque reference encrypted/hashed as appropriate, display_name, capabilities JSON, permission state, last_verified_at, disconnected_at |
| capture_sessions | id, account_id, installation_id, wearable_connection_id nullable, source, media_mode, state, generation, remote_arm_expires_at, started_at, stopped_at |
| media_assets | id, account_id, installation_id nullable, client_capture_id UUID, capture_session_id nullable, kind photo/video, source, status, original_key nullable, sha256, byte_size BIGINT, width/height, duration_ms nullable, container/codecs, audio_source, captured_at, received_at, deleted_at, generation, legacy_capture_id nullable |
| upload_sessions | id, account_id, asset_id, state, staging_key, provider_multipart_id, expected bytes/hash, reserved_bytes, expires_at, committed_version, error_code, created_at |
| media_derivatives | id, account_id, asset_id, generation, kind, processing_version, object_key, checksum, dimensions/duration, created_at; unique asset+generation+kind+version |
| media_segments | id, account_id, asset_id, frame_derivative_id, timestamp_ms, extraction_version; ordered timestamps inside source duration |
| device_commands | id, account_id, installation_id, capture_session_id, generation, action, idempotency_key, state, expires_at, result_asset_id nullable, error_code, ack_sequence |
| device_events | account_id, installation_id, sequence, event_type, safe payload, created_at; unique installation+sequence; bounded retention |
| usage_reservations | id, account_id, resource, amount, expires_at, state reserved/settled/released/unknown; linked upload/job |
| inference_attempts | id, account_id, job_id, role, gateway, requested/returned model/provider, route/profile version, prompt/schema versions, request id, token usage nullable, estimated/reconciled cost nullable, status, times |
| consent_records | account_id, purpose, policy_version, accepted/revoked timestamps |

Unique `(account_id, client_capture_id)` covers web/native retries; client IDs persist before uploads start. Analysis caching may key owner+media hash+focus+versions, but does not collapse two distinct physical captures into one library asset. Database media metadata supports large sizes without integer overflow. Unique active upload per asset prevents concurrent conflicting commits.

## Authentication

Browser mutations use current session+CSRF protection. Native clients use an explicitly supported native principal, short-lived access tokens and rotating refresh sessions stored in OS secure storage. Device tokens cannot enroll another device, select another account, or acknowledge another installation's command. Enrollment requires signed-in recoverable identity and an authenticated challenge; never accept possession of a hardware ID as enrollment proof.

Account recovery, verification, reauthentication for destructive account operations, refresh-reuse detection, lost-device revoke, and sign-out-all-devices are release requirements. The server rejects revoked tokens on new API calls. Cached/presigned object authorization has bounded expiry; immediate revocation must invalidate the actual object or use an authorization gateway, not merely a metadata flag.

## Endpoint contract

Every mutation accepts `Idempotency-Key` UUID except part byte transfer (provider protocol). Scope keys by account + installation where applicable + operation; retain at least 7 days, longer for active uploads/commands. Same key + different normalized payload returns 409 `idempotency_conflict`; same key returns original response. Auth/ownership checks run on replay. Standard error: `{error:{code,message,retryable,request_id,retry_after_ms?}}`; omit private internals. Cursor responses include `items,next_cursor`; page size default 30/max100, stable ordering `(created_at,id)`.

| Route | Request | Success and behavior |
| --- | --- | --- |
| GET /v2/capabilities | Authenticated session | 200 effective feature flags, limits, contract version, safe model availability; never sends paid probe |
| POST /v2/devices/enroll | platform, app_version, installation_public_id, enrollment proof | 201 installation_id and scoped session result; account derived from auth |
| GET /v2/devices | cursor optional | 200 own installations, fresh status and capabilities only |
| DELETE /v2/devices/{id} | expected_revision | 202 revoke, expire commands/remote sessions; past media retained |
| PUT /v2/device/status | sequence, capabilities, readiness, app_state | 200 accepted sequence; installation from token; out-of-order ignored |
| POST /v2/device/wearables | SDK reference, display name, capabilities, permission state | 201 connection associated only with authenticated installation |
| DELETE /v2/device/wearables/{id} | none | 204 unlink/revoke future cloud authority; client performs SDK unregistration where needed |
| POST /v2/device/capture-sessions | source, mode, connection_id nullable | 201 session_id,generation; offline local sessions reconcile later |
| POST /v2/device/capture-sessions/{id}/arm | enabled, duration_seconds <=600 | 200 arm expiry; requires explicit local user action |
| POST /v2/device/capture-sessions/{id}/end | reason | 200 ended; repeated safe; cancels queued start commands |
| POST /v2/uploads | client_capture_id, kind, source, filename, byte_size, sha256, captured_at?, capture_session_id? | 201 asset_id,upload_id,state,expiry,transfer instructions; validate quota/capability; no analysis |
| GET /v2/uploads/{id} | none | 200 state, verified parts/offset,expiry; only own upload |
| POST /v2/uploads/{id}/parts | requested bounded part numbers | 200 fresh scoped signed part instructions; no reusable bucket credentials |
| POST /v2/uploads/{id}/complete | provider part receipts/object version as applicable | 202 verifying or 200 already committed; repeat must not create new assets |
| DELETE /v2/uploads/{id} | none | 202 aborted; release reservation, stop parts, clean staging; cannot delete committed media implicitly |
| GET /v2/library | kind?,status?,source?,cursor? | 200 own media summaries; do not enumerate deleted records |
| GET /v2/media/{id} | none | 200 media-contract schema, preparation state, permitted links and analysis link |
| PATCH /v2/media/{id} | title,expected_revision | 200 new revision; stale409 |
| POST /v2/media/{id}/analysis | focus, mode photo/selected_frame/sampled_video, timestamp_ms?, expected_generation | 202 analysis/job IDs, reused; explicit analysis quota |
| DELETE /v2/media/{id} | expected_generation | 202 tombstone/cancel/purge; replay safe; local source deletion separate |
| POST /v2/media/batch-delete | ids<=100, expected generations | 200 per-item results; validate each; partial failures explicit |
| POST /v2/devices/{id}/commands | session_id,generation,action,capture_client_id,expires_in_seconds<=30 | 202 command_id,state,expiry; same account and live armed session required |
| GET /v2/device/commands | after_sequence,wait<=25 | 200 only commands for token installation; duplicates possible |
| POST /v2/device/commands/{id}/ack | sequence,state,result_asset_id?,safe_error? | 200 durable monotonic ack; cannot mark another user's asset |
| GET /v2/commands/{id} | none | 200 owner-visible state/result |
| GET /v2/events | after_cursor | Authenticated SSE of own media/command events; expired cursor requires state resync |

For batch uploads, initiate one upload per file with separate IDs; no all-or-nothing dependency. For long offline capture, local shutter does not require pre-created cloud capture session: store local session UUID and establish its same-owner mapping before upload. Never trust source metadata to prove identity or authenticity; server records reported source separately from verified enrolled installation.

## Upload state and consistency

`created → uploading → verifying → committed`; `aborted`, `expired`, `rejected` terminal. Verification/transcoding are server work, not client-supplied progress. Verified byte transfer progress can show percent; processing/inference cannot fabricate percent.

Persist local capture ID/file path/owner/bytes/hash/upload_id and transfer receipts. On resume ask server status before transferring; a lost success response reuses committed asset. Signed part instructions expire before upload session, and may be refreshed after reauthorization. Provider multipart receipts do not replace media decoding or full content verification; ETags are not universally SHA-256.

Server checks actual stored bytes, content signature, dimensions/duration, digest, per-format decoder and quota before commit. Seal a verified object version or copy to an immutable committed key; a previously issued upload URL cannot overwrite the committed object. Transactionally store commit+job/outbox; storage/DB are not assumed atomic. Reconciliation cleans blobs missing records and pending records without blobs after their safety window, never while uploads remain active.

Quota reservation covers declared size plus bounded derivative allowance. Reject before transfer when possible; enforce actual limits on completion. Release abort/expiry reservations once, settle verified usage once. Restrict uploaded originals to validation workers until accepted. Scan/probe in resource-limited workers with bounded scratch and network access. Late part uploads after delete land only in staging and are removed, never re-published.

## Preparation and model states

Media preparation: `pending_upload`, `verifying`, `processing`, `ready`, `failed`, `deleted`. Completed photos become ready after normalization; videos after playable output+poster. A failed video retains original when safely stored and offers Retry preparation or Delete, with no misleading play action. Library readiness is not analysis completion.

Analysis: reuse existing jobs with queued/running/partial/complete/failed/cancelled. A credit/provider outage affects only analysis. Previous completed revisions remain readable; a new version never overwrites a result mid-run. Cancel cannot guarantee upstream processing/billing stopped. Jobs recheck lease, owner, media generation and tombstone before publishing any derivative/result.

Video preparation: probe → validate → transcode/remux qualified playable MP4 → poster → representative frame index. Frame selection uses deterministic extraction version and actual timestamps. Sample up to eight frames spanning duration, adding scene diversity within the cap; single-frame analysis uses a verified frame near selected time. Record effective timestamp. Do not send original video to an undocumented model endpoint. Audio stream/mux failures surface separately; never silently swap microphones.

## Remote command state

Actions are `capture_photo`, `start_video`, `stop_video`; remote connect is an invitation to foreground/authorize, not a backend bypass of Meta permissions. States: `queued`, `delivered`, `awaiting_user`, `executing`, `succeeded`, `failed`, `expired`, `cancelled`, `unknown`. State transition validation rejects stale sequence/generation. `succeeded` for capture means local file durably recorded; cloud availability is separate and reported by asset commit.

The phone persists command receipt before executing and associates a local capture ID. Duplicate delivery returns stored state. If a crash makes shutter outcome unknowable, return unknown rather than automatically taking another photo. At-least-once messaging cannot promise exactly-once hardware effects. Stop is idempotent and remains available locally offline. Expired start commands cannot execute after reconnect; reconnect never re-arms remote capture. Simultaneous controllers compete on session state with deterministic conflict409.

Server heartbeat freshness default30seconds; explicit app lifecycle/disconnect event overrides it sooner. Foreground requests can run only with suitable camera/SDK state; unavailable sessions return device_unavailable or user_action_required. APNs/FCM carries an opaque reference, not media or authorization tokens. User A never sees or controls User B's phone even if labels are identical.

## Migration and compatibility

Add schema without changing existing records. Backfill each existing photo capture to a media asset with owner/generation/source, original only when present. Preserve analysis URLs and collection membership. Legacy keys may point to session-era storage paths after account claim: use stored object keys as source of truth, not reconstructed new paths. Move objects transactionally through a tracked copy/verify/delete migration if desired; never assume updating owner columns moved files.

Existing anonymous photo capture and `/v1/uploads` stay bounded; no video through old in-memory endpoints. New authenticated mobile/web media uses `/v2`. Existing `captures` gains asset FK, with old columns readable during migration. Agent APIs remain grant-scoped: no devices/remote capture grants added by default; media analysis is available only for owned/granted assets. No automatic broadening of existing tokens.

Keep Sensor import as a legacy source adapter into the new asset module; the new feature must pass tests with it disabled. Old media remains accessible even when experimental glasses is disabled. Rollback can disable new creation/commands while retaining library reads and clean completion of already-authorized uploads. Destructive schema removal waits until older clients are outside the supported window.

## Additional account interfaces

Implement the scoped setup/preferences, connection lifecycle, capture-command authorization, share grants and viewer projection in [Agent access and collection sharing](AGENTS-AND-SHARING.md). Its share-session media transport overrides owner signed-read behavior for shared recipients. All new endpoints reuse the tenant predicates and transaction rules above.
