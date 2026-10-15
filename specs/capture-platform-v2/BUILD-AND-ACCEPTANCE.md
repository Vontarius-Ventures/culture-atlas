# Build and release acceptance

## Delivery sequence

| Package | Work and exit condition |
|---|---|
| 1 Domain and infrastructure | Owner-scoped assets, migrations, upload reservations, durable queue/outbox, cloud object storage, backup restore. Two accounts pass isolation with all local relays off. |
| 2 Camera and uploads | Browser photo/video capability fallback, native camera, persisted drafts, multipart recovery, library and video processing. Interrupted transfer resumes without duplicate assets. |
| 3 Observer extraction | Port MetaWearablesService, ClipRecorder, local library/upload spool and segment writing into owned native adapters. Replace relay URLs/auth, in-memory upload identity, development transport exceptions and app IDs. Preserve SDK license obligations. Test iOS and implement equivalent Android adapter independently; iOS code does not imply Android readiness. |
| 4 Concentrate | Provider-neutral Responses adapter, schema validation, role qualification, privacy settings and credit/budget controls. Qloo remains separate. Stub tests first, operator-qualified live suite before production. |
| 5 Agent platform | Extend existing grants, setup/preferences API, allowlisted preference writes, scoped media/commands, activity history, OpenAPI and MCP adapter. Token and OAuth consent contracts follow AGENTS-AND-SHARING. |
| 6 Collection sharing | Separate grants, invitations, bearer redemption, public-safe projection, recipient media transport, revocation and UI. No editor role in v2. |
| 7 Release qualification | Independent-user/device trial, store/SDK eligibility evidence, accessibility, abuse limits, operational runbooks and restore drill. |

Observer code is a reusable device implementation, not the production multi-tenant backend. Atlas domain services and account ownership remain authoritative. Keep its relay as a development reference only. Implement deep modules for MediaIntake, MediaPreparation, CaptureDevice, AgentAuthorization, ShareProjection and ModelGateway; HTTP and native adapters should not duplicate policy.

## Required acceptance cases

| ID | Test and pass condition |
|---|---|
| TEN-01 | Two real accounts, separate phones/networks; founder computer and Observer relay off. Both upload/capture independently; guessed IDs never cross ownership. |
| TEN-02 | Account switching mid-upload cannot reassign a draft, grant, command or storage key. |
| MED-01 | Duplicate completion/retry/restart yields one committed asset and one billable logical analysis; uncertain provider billing is tracked, not asserted absent. |
| MED-02 | Cancel/delete races with completion and workers cannot resurrect a media item. |
| MED-03 | Invalid MIME, malicious image dimensions, corrupt video, long duration, excessive bytes and quota exhaustion reject safely without blocking valid batch siblings. |
| MED-04 | Offline capture, app termination, expired part URLs, abandoned multipart cleanup and reconnect preserve valid local files and bound server storage. |
| MED-05 | iOS/Android/browser codec matrix plays qualified outputs with correct orientation, duration and audio state; unsupported inputs get actionable errors. |
| DEV-01 | Each user registers their own supported glasses; permissions and reconnect tested on physical devices. Mock SDK tests alone do not qualify release. |
| DEV-02 | No permission/no arming/stale heartbeat/expired command/revoked agent cannot trigger capture. Duplicate command delivery records one execution or explicit unknown outcome. |
| DEV-03 | Disconnect/background/phone call/low storage interruption preserves valid media. Silent video remains silent; microphone starts only with explicit local permission. |
| AI-01 | Qualified models pass photo/frame/text fixtures with strict validated outputs; wrong schema, refusal, timeout, 402 and429 preserve assets and expose recoverable statuses. |
| AI-02 | Spending caps include reserved/unknown attempts, credits exhaustion pauses AI only; no silent fallback to another gateway or unqualified provider. |
| AGT-01 | Scope/resource intersections apply to list/detail/search/events/downloads/queued work. Existing tokens gain zero new rights. |
| AGT-02 | Preference optimistic concurrency, token rotation/revocation, OAuth code replay and refresh reuse tests pass. Setup responses contain no secrets or hardware identifiers. |
| SHR-01 | Restricted invite requires exact verified recipient. Link expiry/revocation/deletion blocks new views/ranges; original download off cannot be bypassed through another endpoint. |
| SHR-02 | Public-safe projection excludes private reasoning, device provenance, coordinates, other collections and taste. Live additions/removals match disclosed policy. |
| UX-01 | All13 references implemented responsively with keyboard/screen-reader operation, contrast, reduced motion and no horizontal scroll at320px. |
| OPS-01 | Cloud deployment, migrations, worker lease recovery, object cleanup, alerts and database/object restore exercised in staging. |

## Platform release gates

Include the real Meta feature in experimental builds and test it. Public binary eligibility is a separate gate for each operating system, supported device, SDK version and release channel. Verify the current Meta developer and app-store requirements before submitting; an Experimental badge does not satisfy platform entitlements. Where public distribution is blocked, ship permitted experimental channels and a public camera/upload build with the clearly unavailable entry. Do not mark the entire product blocked if only glasses distribution remains unresolved. Record evidence, owner and next check date for each gate.

Concentrate production needs verified credits/account access, qualified actual model/provider IDs, ZDR/logging settings and measured cost/latency; proposed config alone is not integration. No credentials or paid model calls are included in this documentation delivery.

## Operational targets and rollout

Proposed starting SLOs:99.9% hosted API availability monthly, metadata reads p95<500ms excluding media transfer, queue start p95<30s at qualified load, photo preparation p95<15s and120s video preparation p95<120s on benchmark workers. These are targets to load-test, not current measured performance. Track upload completion, preparation failures, queue age, model costs/unknown charges, device command latency and share/agent denials without payload logging. Alert on sustained queue age>5minutes, error rate>5% for5minutes, storage cleanup failures, spend cap approach and provider402. Per-account and global kill switches preserve reads/deletion and already captured media.

Rollout: internal two-user cloud trial → invited experimental cohort → camera/upload public launch with qualified AI → platform-eligible glasses expansion. Agent and share access require their isolation suite before cohort release. Canary database migrations with additive columns/tables and backfill verification; keep old API functioning. Roll back application flags without dropping media or grant tables. Pause jobs before incompatible migration rollback. Assign release owner, security/privacy reviewer, native owners and on-call owner before launch; staffing and duration depend on device/platform qualification.

## Documentation delivery verification

Validate package links, JSON fixtures/schema, all image dimensions/hashes and the gallery. This verifies the design handoff only. Runtime acceptance above remains work for the implementation; do not report it as completed by a documentation check.
