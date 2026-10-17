# capture platform v2: gap report

Date: 2026-10-17. Branch `claude/wizardly-cannon-yu8trw`, after merging
`capture-v2/identity`, `capture-v2/p1-domain-infra`, `capture-v2/p4-concentrate`
and `capture-v2/p5-agents`. Authority: `specs/capture-platform-v2/` (v2.1).

This report covers what the code in this tree does today. It does not claim
any runtime acceptance case is complete. Status values:

- **done**: implemented and covered by automated tests in this repo.
- **partial**: some code exists, but production wiring, a sub-requirement or
  verification is missing (the gap is named).
- **missing**: no implementation in this tree.

## 0. Tree health (this change)

| Check | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | passes |
| `pnpm typecheck` | passes |
| `pnpm lint` | passes (fixed: unused `z` import in `packages/domain/src/services/agent-platform.ts`; setState inside an effect in `apps/web/components/views/AgentPlatformView.tsx`) |
| `pnpm test` | 71 files / 541 tests pass, 4 consecutive full runs |
| `pnpm build` | passes |
| Fresh-database migrate | passes (was failing at `071_agent_resources_commands.sql`) |

Fixes made while merging:

1. **Duplicate migration objects.** `055_agent_media_fences.sql` (p1 line) and
   `071_agent_resources_commands.sql` (p5 line) both added
   `media_assets.created_by_agent_connection_id` and an owner-scoped foreign
   key. Both files are now order-independent: columns use `ADD COLUMN IF NOT
   EXISTS`, and foreign keys and pairing checks are added only if missing. 055
   backfills `authorization_version` for agent-created rows from
   `agent_media_uploads`. Rows with no recorded version get `0`, which matches
   no live grant, so they fail closed. No file was renumbered.
   `packages/domain/src/db/migrate.ts` accepts the exact pre-merge checksums of
   those two files (`RECONCILED_CHECKSUMS`) and updates the stored record.
   Any other edited migration is still refused.
   `packages/domain/src/db/migration-reconcile.test.ts` covers four cases:
   - a fresh database;
   - a database that applied the p1 line, then upgraded;
   - a database that applied the p5 line with agent rows, then upgraded;
   - an unknown edit to an applied file, which is still rejected.

   All three upgrade paths end with the same schema shape. The pre-merge files
   are kept as test fixtures in `packages/domain/src/db/pre-merge-migrations/`.
2. **Agent upload broke the p1 pairing check.** p5 `beginUpload` set
   `created_by_agent_connection_id` without `authorization_version`, which 055's
   CHECK rejects. It now records both together
   (`packages/domain/src/services/agent-media.ts`). Test:
   `packages/domain/src/services/agent-media.test.ts`.
3. **Root cause of the `demo.test.ts` "job … not claimable" flake.**
   `claimJobs` locked with `FOR UPDATE SKIP LOCKED`. Inserting a
   `trace_events` or `job_stages` row takes `FOR KEY SHARE` on the job row (for
   example while an agent's `get_job` poll is traced). `FOR UPDATE` conflicts
   with that lock, so a worker could see a job as `queued` and still fail to
   lease it. The claim now uses `FOR NO KEY UPDATE SKIP LOCKED`
   (`packages/domain/src/jobs/queue.ts`). A deterministic regression test is
   in `packages/domain/src/jobs/queue.test.ts` ("claims a queued job while
   another transaction is writing a trace or stage row for it"); it failed
   before the fix. `claimCommands` in `services/agent-commands.ts` uses the same
   lock against `device_command_ack_keys`. It was left unchanged because ack
   writes also update the command row; check it when device delivery is wired.

## 1. Cross-cutting integration gaps (highest priority)

These seams were built and tested separately on each line. Nothing connects
them in the running app, so most of v2 is unreachable in production today.

| # | Gap | Effect | Where |
| --- | --- | --- | --- |
| G1 | `setCaptureV2Runtime` / `configureCaptureV2Runtime` is never called outside tests. No production `CaptureIdentityAdapter` wraps the identity services (`services/identity.ts` `requireRecoverableAccount`, `services/native-sessions.ts` grant/issue/revoke/resolve). | Every `/v2/uploads`, device enrollment and `cna_` native call returns `service_unavailable`. | `apps/web/lib/server/capture-v2.ts:38-55`; `docs/capture-v2-operations.md` describes the wiring that is still missing |
| G2 | `setAuthorityLifecycle(endCaptureAuthority)` is not registered at startup. | Sign-out-all, account switch and installation revocation do not fence pending uploads or arming in production. | `services/native-sessions.ts:15`, `capture-v2/devices.ts` |
| G3 | The worker does not process `capture_work`: no `verify_upload`, `prepare_media`, `purge_media`, `cleanup_upload` or `analyze_media` loop, and no `heartbeatMediaWorker`. | Uploads never leave `verifying`, and video is never enabled (needs a fresh qualified-worker heartbeat). | `apps/worker/src/worker.ts` (no capture-v2 imports); `capture-v2/queue.ts`, `preparation.ts`, `analysis.ts`, `capabilities.ts` |
| G4 | No production `MediaVerifier`/`MediaPreparer` for video. The default `photoMediaVerifier` rejects video. There is no ffmpeg/ffprobe adapter, and ffmpeg is not in the `Dockerfile`. | Video upload and playback cannot work. | `capture-v2/context.ts:6`, `types.ts:155` |
| G5 | No production `CaptureAgentAuthorization`. Agent-created `capture_work` fails closed (`scope_denied`) in the worker. | Agent uploads and agent analysis never complete. | `capture-v2/agent-fence.ts`, `types.ts:159` |
| G6 | MCP `handleMcpRequest` is created without `captureContext`. | MCP media tools (`list_media`, `get_media`, `begin_upload`, `complete_upload`, `get_operation` for uploads) return `service_unavailable` in production. | `packages/agent-gateway/src/server.ts:282`, `apps/web/app/mcp/route.ts` |
| G7 | Agent REST media is not routed. The v2 catch-all rejects `Bearer cat_` with `scope_denied`, yet `agentMedia.getMedia` returns `/v2/agent-media/...` links that have no route, and `docs/api/agent-platform.openapi.json` lists `/v2/library`, `/v2/media/{id}` and `/v2/uploads` for agents. | The spec says REST is authoritative; today only MCP exposes agent media (and G6 blocks that). | `apps/web/lib/server/capture-v2.ts:236-252`, `services/agent-media.ts:22-29` |
| G8 | No production identity mail adapter (`setIdentityMail` is never called). | Email sign-in, verify and recover fail closed in production, so no account can become "recoverable", which G1 requires. | `services/identity-mail.ts` |
| G9 | Concentrate `createModelGateway` is not wired into the v2 analysis worker or the v1 pipeline (it needs a durable ledger plus verified job identity). | AI over v2 media is unavailable. Featherless remains the v1 default. | `packages/providers/src/registry.ts:40`, `docs/concentrate.md` |

## 2. Delivery packages (BUILD-AND-ACCEPTANCE.md)

| Package | Status | Evidence | What remains |
| --- | --- | --- | --- |
| 1 Domain and infrastructure | **partial** | Migrations 051–057 and 065–080; owner-composite FKs; `capture-v2/intake.ts`, `queue.ts`, `policy.ts`; S3/local multipart (`packages/providers/src/storage/multipart-*.ts`); `scripts/capture-backup.ts`; lifecycle isolation tests | G1–G3; outbox/reconciliation job is not scheduled; `inference_attempts` and `consent_records` tables are missing (`model_gateway_attempts` covers part of inference_attempts); restore drill not exercised |
| 2 Camera and uploads | **partial** (backend) / **missing** (UI) | Upload state machine, quota reservation, resumable parts, delete/abort races, photo verify/prepare (`capture-v2/intake.ts`, `preparation.ts`) | Video verifier/preparer (G4); worker loop (G3); every v2 web screen (section 5); native camera |
| 3 Observer extraction | **missing** | None. Reference source: `/home/user/worldcompilersensor/WorldCompilerSensor/Wearables/MetaWearablesService.swift`, `.../ClipRecorder.swift`, `.../Library/LibraryStore.swift`, `.../Library/LibraryUploader.swift`, `Shared/Assets.swift` | iOS adapters, an independent Android adapter, relay/auth replacement, SDK license obligations. There is no iOS or Android project in this repo. |
| 4 Concentrate | **partial** | Responses transport, profiles, strict schema runner, budget ledger, 402/429/timeout handling (`packages/providers/src/concentrate/*`, `model-gateway/*`, `065_model_gateway.sql`), all against fixtures | G9; no qualified model IDs; operator-qualified live suite; privacy/ZDR settings evidence |
| 5 Agent platform | **partial** | v2 scopes and consent, setup/preferences, connection lifecycle, OAuth PKCE and refresh rotation, commands, events, activity, OpenAPI (`docs/api/agent-platform.openapi.json`), tool catalog (`docs/api/agent-tools-v2.json`), MCP tools | G5–G7; `analyze_media` MCP tool missing; device delivery HTTP routes missing (section 3) |
| 6 Collection sharing | **missing** | `collection_media_items` (071) only | Tables (`collection_shares`, `collection_share_members`, `share_invites`, `audit_events`), all 8 routes, `ShareProjection`, recipient media gateway, screens 12–13. `rejectShareAuthority` in `capture-v2.ts` only guards owner routes. |
| 7 Release qualification | **missing** | CI runs install/typecheck/lint/test/migrate/build (`.github/workflows/ci.yml`) | Independent-user/device trial, store/SDK eligibility evidence, accessibility audit, runbooks/alerts, restore drill, hosting (section 7) |

## 3. Backend endpoints (BACKEND-CONTRACTS.md)

Routed by `apps/web/app/v2/[...capture]/route.ts`, which calls
`captureV2Route` in `apps/web/lib/server/capture-v2.ts` unless noted. "Prod"
lists the cross-cutting gaps from section 1 that block the route in a real
deployment.

| Route | Status | Implementation | Prod blockers |
| --- | --- | --- | --- |
| GET /v2/capabilities | done | `capture-v2.ts:291`, `capture-v2/capabilities.ts` | none |
| POST /v2/devices/enroll (+ `/enrollment/challenge`) | done (server) | `capture-v2.ts:394-399`, `capture-v2/devices.ts` | G1, G8; no native client |
| GET /v2/devices | done | `capture-v2.ts:400` | G1 for native |
| DELETE /v2/devices/{id} | done | `capture-v2.ts:405` | G2 |
| PUT /v2/device/status | done | `capture-v2.ts:408` | G1 |
| POST /v2/device/wearables | done (server) | `capture-v2.ts:410` | G1; no native SDK |
| DELETE /v2/device/wearables/{id} | done (server) | `capture-v2.ts:413` | G1 |
| POST /v2/device/capture-sessions | done | `capture-v2.ts:416` | G1 |
| POST /v2/device/capture-sessions/{id}/arm | done | `capture-v2.ts:420` | G1 |
| POST /v2/device/capture-sessions/{id}/end | done | `capture-v2.ts:420` | G1 |
| POST /v2/uploads | done | `capture-v2.ts:312`, `capture-v2/intake.ts` | G1 |
| GET /v2/uploads/{id} | done | `capture-v2.ts:317` | G1 |
| POST /v2/uploads/{id}/parts | done | `capture-v2.ts:318` (also `/resume`) | G1 |
| POST /v2/uploads/{id}/complete | done | `capture-v2.ts:322` | G1, G3 (stays `verifying`) |
| DELETE /v2/uploads/{id} | done | `capture-v2.ts:325` | G1 |
| GET /v2/library | done | `capture-v2.ts:329` | G1 |
| GET /v2/media/{id} | done | `capture-v2.ts:388` (+ `/content/{variant}` range gateway) | G1, G3 |
| PATCH /v2/media/{id} | done | `capture-v2.ts:389` | G1 |
| POST /v2/media/{id}/analysis | partial | `capture-v2.ts:383`, `capture-v2/analysis.ts` (request/lease/publish) | G3, G9: requests queue but never run |
| DELETE /v2/media/{id} | done | `capture-v2.ts:390` | G1; G3 for purge |
| POST /v2/media/batch-delete | done | `capture-v2.ts:331` | G1 |
| POST /v2/devices/{id}/commands | done | `apps/web/app/v2/devices/[id]/commands/route.ts`, `services/agent-commands.ts` | none for agents/owners; phone side missing |
| GET /v2/device/commands | partial | domain `claimCommands` (`services/agent-commands.ts:120`) | **no HTTP route** |
| POST /v2/device/commands/{id}/ack | partial | domain `acknowledgeCommand` (`services/agent-commands.ts:145`) | **no HTTP route** |
| GET /v2/commands/{id} | done | `apps/web/app/v2/commands/[id]/route.ts` | none |
| GET /v2/events | partial | `apps/web/app/v2/events/route.ts`, `services/agent-events.ts` (24h cursor → `cursor_expired` → 410 with resync message) | The stream polls the database every 1s and closes after 25s; clients reconnect with `Last-Event-ID`. There is no push or LISTEN/NOTIFY. Owner media/command events only advance once G3 is in place. |

Required tables: all present except `inference_attempts` and
`consent_records` (section 2, package 1).

## 4. Agent and sharing endpoints (AGENTS-AND-SHARING.md)

| Route | Status | Implementation |
| --- | --- | --- |
| GET /v2/me/setup | done | `apps/web/app/v2/me/setup/route.ts`, `services/agent-platform.ts:64` |
| GET /v2/me/preferences | done | `app/v2/me/preferences/route.ts`, `agent-platform.ts:22` |
| PATCH /v2/me/preferences | done (If-Match, 412) | same, `agent-platform.ts:46` |
| GET /v2/agent-connections | done | `app/v2/agent-connections/route.ts` |
| POST /v2/agent-connections | done | same, `agent-platform.ts:102` |
| PATCH /v2/agent-connections/{id} | done (narrowing only) | `app/v2/agent-connections/[id]/route.ts`, `agent-platform.ts:117` |
| POST /v2/agent-connections/{id}/rotate | done | `app/v2/agent-connections/[id]/rotate/route.ts` |
| DELETE /v2/agent-connections/{id} | done | `app/v2/agent-connections/[id]/route.ts` |
| POST /v2/devices/{id}/commands | done | see section 3 |
| GET /v2/operations/{id} | done | `app/v2/operations/[id]/route.ts`, `services/agent-operations.ts` (upload outcomes blocked by G3/G5) |
| GET /v2/events | partial | see section 3 |
| OAuth authorize/token + `.well-known` metadata | done | `app/v2/oauth/{authorize,token}/route.ts`, `app/.well-known/*`, `services/agent-oauth.ts` |
| Agent activity | done | `app/v2/agent-activity/route.ts` |
| Collection media membership (supporting) | done | `app/v2/collections/[id]/media[/asset_id]/route.ts`, `services/collection-media.ts` |
| Agent REST media (`/v2/library`, `/v2/media`, `/v2/uploads` with `cat_`) | missing | G7 |
| GET/POST /v2/collections/{id}/shares | missing | none |
| PATCH /v2/shares/{id} | missing | none |
| DELETE /v2/shares/{id} | missing | none |
| POST /v2/shares/{id}/invitations | missing | none |
| POST /v2/share-invitations/accept | missing | none |
| POST /v2/shared/redeem | missing | none |
| GET /v2/shared/collection | missing | none |
| GET /v2/shared/media/{id} | missing | none |

MCP tools (`packages/agent-gateway/src/tools.ts`). Present: get_setup,
get_preferences, update_preferences, list_media, get_media, begin_upload,
complete_upload, list_collections, get_collection, add_collection_item,
remove_collection_item, request_capture, get_operation. **Missing:
`analyze_media`.** The v1 `analyze_capture` remains. Media tools are blocked
in production by G6.

## 5. Screens 01–13 (SCREEN-CONTRACT.md)

The web navigation is still the v1 set, Discover / Collections / Plans
(`apps/web/components/AppShell.tsx:20`). The spec requires Library as a fourth
destination.

| Screen | Route | Status | Notes |
| --- | --- | --- | --- |
| 01 Library desktop | /library | missing | no page; v2 library API exists |
| 02 Source mobile | /capture | partial | `app/capture/page.tsx` is the v1 photo flow (`CaptureView.tsx` → `/v1` `createCapture`). There is no camera/glasses/upload source picker and no signed phone hand-off. |
| 03 Camera mobile | browser camera | partial | `CaptureStart.tsx` uses `<input capture>` for photos only. No video recording, no mic state, no Retake/Keep step. Native camera is missing. |
| 04 Glasses connect | Settings → Devices | missing | needs native |
| 05 Glasses ready | native | missing | needs native |
| 06 Uploads desktop | /uploads | missing | resumable API exists |
| 07 Video detail | /library/:id | missing | range gateway exists |
| 08 Library mobile | /library | missing | |
| 09 Glasses unavailable | native/web | missing | capability reasons exist in `/v2/capabilities` |
| 10 Agents | /settings/agents | done | `components/views/AgentPlatformView.tsx`, `app/settings/agents/page.tsx`; DOM tests. Exact-copy and 320px audit not done. |
| 11 Agent permission | /settings/agents/new (+ `/authorize` OAuth consent) | done | `ConnectAgentView`; DOM tests for default scopes and download separation |
| 12 Collection share | /collections/:id/share | missing | |
| 13 Shared collection | /shared | missing | |

## 6. Acceptance IDs

"Here" means this container: Node 22, PostgreSQL 16, ffmpeg, Chromium
Playwright. There is no Android SDK, no Xcode, no provider keys, and outbound
network is limited to npm.

| ID | Status | Automated evidence | Verifiable here | Not verifiable here |
| --- | --- | --- | --- | --- |
| TEN-01 | partial | `capture-v2/lifecycle.test.ts` "denies guessed upload/media IDs…", `services/isolation.test.ts` | DB/HTTP isolation with two accounts | two real phones on separate networks |
| TEN-02 | done (server) | `apps/web/lib/server/capture-v2.test.ts` "TEN-02…", `lifecycle.test.ts` "account switch…", `native-sessions.test.ts` | yes | native client behaviour |
| MED-01 | partial | `lifecycle.test.ts` "duplicate completion and worker restart…", `model-gateway/runner.test.ts` | yes, with fakes | live billing reconciliation |
| MED-02 | done (server) | `lifecycle.test.ts` "delete while verifier is running…", "abort racing complete…" | yes | |
| MED-03 | partial | `lifecycle.test.ts` MIME/size/quota/corrupt/dimension tests | yes; a real ffprobe corrupt-video test is possible once G4 exists | |
| MED-04 | partial (server) | `lifecycle.test.ts` "refreshes part authorization…", `multipart.test.ts` | server side | app termination/offline on devices |
| MED-05 | missing | none | browser codecs via Playwright once G4 + UI exist | iOS/Android playback |
| DEV-01 | missing | none | no | physical glasses |
| DEV-02 | done (server) | `services/agent-commands.test.ts` (arming, stale heartbeat, revoked, duplicate, unknown) | yes | phone execution |
| DEV-03 | missing | none | no | physical device interruptions |
| AI-01 | partial | `concentrate/*.test.ts`, `model-gateway/runner.test.ts` (fixtures only) | schema/failure classes with fakes | qualified live models |
| AI-02 | partial | `model-gateway/budget.test.ts` | yes, with fakes | live credit exhaustion |
| AGT-01 | partial | `services/agent-platform.test.ts`, `agent-privacy.test.ts`, `collection-media.test.ts` | yes | REST media parity (G7) |
| AGT-02 | done | `agent-platform.test.ts` (If-Match, rotation, OAuth replay, refresh reuse) | yes | |
| SHR-01 | missing | none | yes, once built | |
| SHR-02 | missing | none | yes, once built | |
| UX-01 | partial (2 of 13) | `AgentPlatformView.dom.test.tsx` | Playwright at 1440/390/320 once screens exist | native screens |
| OPS-01 | missing | CI only | migrations and lease recovery locally | cloud deploy, alerts, restore drill |

## 7. Hosting (AWS free tier request)

Nothing in the repo targets AWS yet. `render.yaml` and the `Dockerfile` target
Render or any Docker host (`docs/deploy.md`). Required runtime pieces:

- web and worker containers from the one image;
- PostgreSQL 16;
- a private S3 bucket with multipart lifecycle rules (`docs/capture-v2-operations.md`);
- outbound HTTPS to the model and Qloo providers;
- ffmpeg in the worker image once G4 lands.

The AWS mapping would be:

- one small EC2 instance running both containers (or ECS on EC2);
- RDS for PostgreSQL 16 on the smallest single-AZ class;
- S3 with lifecycle rules for incomplete multipart uploads (1 day) and staging (2 days).

Free-tier fit has **not been verified**: there was no network access to AWS
documentation, and AWS changed its free-tier model for accounts created from
July 2025 (credit-based free plan) compared with the older 12-month offers. The
operator must confirm current limits for:

- EC2 hours and instance class;
- RDS instance class, hours and storage;
- S3 storage, requests and data transfer.

Risks:

- 1 GiB-class instances are tight for Next.js, the worker, sharp and ffmpeg
  together;
- video transcoding may need a larger or burst instance;
- data transfer out for video playback is the most likely cost to exceed a
  free allowance.

Hosting work that remains:

- infrastructure as code (Terraform, CDK or CloudFormation);
- IAM least-privilege roles for web and worker;
- S3 CORS for the app origin;
- secrets in SSM Parameter Store or Secrets Manager;
- RDS automated backups plus a tested restore;
- alarms for queue age, error rate and storage cleanup;
- spend alarms on the AWS account.

## 8. Gap list by area

**Media pipeline + library backend**:

- G1–G5;
- worker loop for `capture_work` (verify/prepare/purge/cleanup/analyze) and the qualified-worker heartbeat;
- ffmpeg/ffprobe video verifier and preparer (probe → validate → MP4 → poster → ≤8 frames);
- reconciliation/outbox sweeper;
- `inference_attempts` and `consent_records` tables;
- HTTP routes for `GET /v2/device/commands` and `POST /v2/device/commands/{id}/ack`.

**Web capture UI**:

- screens 01, 06, 07 and 08 (Library, Uploads, Video detail, mobile Library);
- v2 `/capture` source picker and browser camera with video, mic state and Retake/Keep (02/03);
- Library added to navigation;
- glasses-unavailable explanation (09);
- signed phone hand-off;
- persisted drafts and the sign-out draft choice.

**Concentrate + analysis**:

- wire `createModelGateway` into the v2 analysis worker with ledger and job identity (G9);
- qualified model/profile IDs;
- operator-run live qualification suite;
- ZDR/logging evidence;
- `analyze_media` MCP tool.

**Agents + sharing**:

- production `CaptureAgentAuthorization` (G5);
- MCP `captureContext` wiring (G6);
- agent REST media routes, plus fixing the `/v2/agent-media` links (G7);
- the whole of collection sharing: tables, 8 routes, ShareProjection, recipient range gateway, screens 12–13, SHR-01/02 tests.

**Native iOS/Android**: everything (package 3). That covers:

- native camera, drafts and upload spool;
- the Meta wearables adapter ported from Observer;
- enrollment and refresh clients;
- command receipt and ack;
- local remote-arming UI;
- an Android adapter built independently.

No Swift or Kotlin toolchain exists here, so none of it can be compiled or
tested in this environment.

**Identity/devices + ops/hosting**:

- production identity mail adapter (G8);
- capture runtime identity adapter and lifecycle hook (G1, G2);
- deployment target (AWS mapping above);
- alerts and SLO metrics;
- staging restore drill using `scripts/capture-backup.ts`;
- store/SDK eligibility evidence;
- an independent two-user trial.
