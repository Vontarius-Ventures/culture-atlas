# Capture v2 domain and REST contract

Contract `2026-10-15.1`. Executable wire schemas:
`packages/domain/src/schemas/capture-v2.ts` (exported by `@culture-atlas/domain/schemas`).
The authoritative product/backend spec is `specs/capture-platform-v2/`.
This publication fixes interfaces, not implementation/release acceptance.

## Authentication and consistency

Browser calls use the existing signed-in account cookie and CSRF header.
Anonymous users and existing agent/bridge tokens gain **no v2 authority**.
Native installation calls use `Authorization: Bearer <access_token>`:
these tokens are bound to one existing account and installation and cannot enroll
another installation. Full recoverable native account login/refresh is separate
from installation authority and remains a release requirement.

Every mutation requires `Idempotency-Key: <UUID>`, except provider byte PUTs.
Every browser v2 mutation also requires `X-Atlas-Expected-Account: <account UUID>`.
Compare it to the authenticated principal immediately, before policy, quotas,
idempotency replay or side effects; mismatch returns409 `account_mismatch`.
It asserts the persisted draft owner and never selects/overrides the actual owner.
Installation bearers are already bound to their original account; an optional
expected-account header is still honored. Identity/grant exchange endpoints are
not browser-session mutations and do not use idempotent secret-response caches.
Keys are scoped by account, installation (if any), method and path. Reusing a key
with different normalized JSON returns 409 `idempotency_conflict`.
Replays recheck authentication and ownership. Cross-owner IDs return 404.
Errors use `{error:{code,message,retryable,request_id,retry_after_ms?}}`.
No request accepts an account ID, installation ID override, object key or bucket.

## Uploads and library (P2 integration)

| Route | Body/schema | Result |
|---|---|---|
| GET `/v2/capabilities` | none | contract_version, flags, limits, safe availability/reasons |
| POST `/v2/uploads` | CreateMediaUploadRequest | 201 MediaUploadResponse |
| GET `/v2/uploads/{id}` | none | 200 MediaUploadResponse, verified provider receipts |
| POST `/v2/uploads/{id}/parts` | UploadPartsRequest | 200 `{parts: UploadPartInstruction[]}` |
| POST `/v2/uploads/{id}/complete` | CompleteMediaUploadRequest | 202 MediaUploadResponse; 200 if committed |
| DELETE `/v2/uploads/{id}` | none | 202 `{upload_id,state}`; committed upload is not implicitly deleted |
| GET `/v2/library` | MediaLibraryQuery (query params) | MediaLibraryResponse |
| GET `/v2/media/{id}` | none | MediaDetailResponse |
| PATCH `/v2/media/{id}` | UpdateMediaRequest | MediaDetailResponse, stale revision409 |
| DELETE `/v2/media/{id}` | DeleteMediaRequest | 202 `{id,generation,status:"deleted"}` |
| POST `/v2/media/batch-delete` | BatchDeleteMediaRequest | BatchDeleteMediaResponse, explicit partial results |

Persist `client_capture_id` **and original owner** before taking/uploading media.
One upload per batch file; at most20 files and2 concurrent transfers on clients.
Account-switch must lock old drafts, not restart them with the new account.
`client_capture_id` uniqueness is per account, not content hash. A retried create
with matching content returns the existing upload; different content conflicts.

Upload instruction `part_size` is 8 MiB, `part_count=ceil(byte_size/part_size)`.
PUT each part using the supplied URL and headers, record the exposed `ETag`,
then submit ordered `{part_number,etag}` receipts. URLs expire in15 minutes;
session expires in24 hours. Refresh URLs through `/parts` after reauthorization.
GET resume returns the provider-verified parts, not client-reported progress.
S3 CORS must allow PUT and expose ETag. No reusable storage credentials.

Completion only queues verification. Poll GET upload/media, never assume a202
means ready. Workers validate length, signature, digest and decoded limits, then
seal to an immutable key and transactionally publish a preparation job.
No automatic analysis. State: created/uploading/verifying/committed, with terminal
aborted/expired/rejected. Library status is independent:
pending_upload/verifying/processing/ready/failed/deleted.

`MediaDetailResponse.media` matches the supplied media-contract JSON schema.
Revision, generation and links live outside that strict object. Missing links
are null, never fabricated playback. Links are owner-authorized application
gateway paths, not public bucket paths. This permits immediate deletion fencing
even after a link was issued. Original reads are restricted until validation.
P2 owns playback/poster/frame generation; use the MediaPreparation interface
and durable job ownership/generation instead of writing media rows directly.

## Devices (iOS and agent integration)

| Route | Body | Result |
|---|---|---|
| POST `/v2/devices/enrollment/challenge` | `{enrollment_grant?,installation_public_id,platform}` | 201 `{nonce,expires_at}` |
| POST `/v2/devices/enroll` | EnrollCaptureDeviceRequest | 201 EnrolledCaptureDeviceResponse |
| GET `/v2/devices` | cursor?,limit? | `{items:CaptureDeviceResponse[],next_cursor}` |
| DELETE `/v2/devices/{id}` | RevokeCaptureDeviceRequest | 202 `{id,revoked:true}` |
| PUT `/v2/device/status` | DeviceStatusRequest | `{accepted_sequence}` |
| POST `/v2/device/wearables` | CreateWearableRequest | 201 `{connection_id}` |
| DELETE `/v2/device/wearables/{id}` | none | 204 |
| POST `/v2/device/capture-sessions` | CreateCaptureSessionRequest | 201 CaptureSessionResponse |
| POST `/v2/device/capture-sessions/{id}/arm` | ArmCaptureSessionRequest | CaptureSessionResponse |
| POST `/v2/device/capture-sessions/{id}/end` | EndCaptureSessionRequest | CaptureSessionResponse |

Browser challenge and enrollment require a recoverable authenticated **account**,
never an installation/agent credential. Native enrollment instead consumes the
identity workstream's one-use5-minute `enrollment_grant` plus enrollment proof.
Native challenge accepts the enrollment grant as a grant, not an API bearer.
It does not consume it: the challenge binds its hash+platform+installation UUID
and a random nonce. Only enrollment consumes the identity grant atomically.
Enroll sends `{enrollment_grant,installation_public_id,proof:nonce,platform,
app_version,capabilities}` and returns `{installation,native_session}`.
Challenges expire in5 minutes and bind account+session (browser) or grant hash
(native), plus platform+public installation UUID.
SDK identity is not proof. In the same enrollment transaction P1 calls injected
`issueNativeSession(tx,{accountId,installationId},now)`. Identity owns opaque
`cna_` access tokens (10min) and `cnr_` rotating refresh, verification and recovery.

Device status/wearables/capture-session calls require the installation token.
Status sequence is monotonic. An account browser cannot pretend to be a phone
or arm it. Arming must follow explicit local action; it expires within600s.
`local_session_id` can reconcile an offline saved session. Owner equality applies
to session→installation→wearable→asset and every queued job/derivative.
SDK references are hashed, never exposed to browser/agent lists.

P5 remote commands must reference the P1 `capture_sessions` account+installation+
generation, fresh readiness (30s), active local arm and server capability policy.
Revocation ends sessions. P5 owns remote command delivery/ack policy and routes.
P6 media sharing must use its recipient authorization gateway, never reuse these
owner read links as bearer-share links. Existing agent scopes do not grant media.

## Deep-module entry points

P1 exports `MediaIntake`, `MediaPreparation`, `CaptureDevice`, `CaptureQueue`,
`evaluateCaptureCapabilities` and `createCaptureV2Context`.
Context carries verified account/installation authority, clock, DB, private
multipart storage, server limits and an injected preparation verifier.
HTTP adapters parse schemas and delegate, without reimplementing policy.
Preparation jobs carry account_id, asset_id and generation. Publication must
recheck a live lease and tombstone/generation inside the same DB transaction.
Leased work also exposes job_id and attempt_id (UUID, new on each lease) to
inject P4's `createModelGateway({db,accountId,jobId,profile})`; P4 owns the
model spend-ledger tables, not this queue. The identity workstream owns native
account login/refresh and returns verified account authority to this context.
Installation authority is a separate `{kind:"installation",accountId,
installationId,sessionId,expiresAt}` value, resolved server-side from the scoped token. It is not
an agent principal and cannot pass the enrollment account-only gate.
Identity's durable `authority_ended` event is consumed transactionally by P1 to
end capture/remote arm and fence pending uploads. Revocation never rebinds bytes.

Agent setup uses `SafeCaptureDeviceSetup`: alias, app version, last-seen time,
staleness, boolean capabilities and safe unavailable reasons only, no installation
or hardware IDs, SDK references or credentials. P5 supplies live AgentAuthorization
scope/resource checks. Remote-command creation checks the allowlisted agent;
claim/delivery rechecks persisted `authorization_version` against the current
grant. Media/job adapters must invoke the same live helper, not infer access from
the account UUID alone. P1's default installation/account adapters deny agents.

Defaults: photos JPEG/PNG/WebP <=15MiB/40MP; HEIC disabled pending qualified
decoder. MP4/MOV/WebM video <=250MiB/120s (native camera clips <=60s).
Storage quota5GiB, including bounded derivative reservations.
Experimental glasses capability is false unless every server-qualified gate
passes; client claims alone cannot activate it.
