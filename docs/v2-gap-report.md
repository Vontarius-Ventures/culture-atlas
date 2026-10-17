# capture platform v2: gap report

Date: 2026-10-17. Branch `claude/wizardly-cannon-yu8trw`. Authority: `specs/capture-platform-v2/` (v2.1).

This report replaces the earlier one, written before the package branches were merged. It describes the tree after these merges:

| Branch | Package |
| --- | --- |
| `v2/media` | media worker, verifier and preparer, library backend |
| `v2/concentrate` | Concentrate gateway and v2 media analysis |
| `v2/identity-ops` | production identity wiring, feature flags, push, ops, AWS |
| `v2/agents-sharing` | collection sharing, agent media wiring, screens 10–13 |
| `v2/capture-ui` | web screens 01–09 |
| `v2/native` | iOS and Android apps, native contract fixtures |

Status values:

- **done:** implemented and covered by automated tests in this repo.
- **done (server):** the server side is done; the client or device part is not proven.
- **partial:** something named is still missing.
- **missing:** not implemented.
- **unverified:** written, but it cannot run in this environment (no toolchain, device, key or network).

## 0. Tree health

| Check | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | passes (the lockfile merged cleanly; `pnpm install` made no changes) |
| `pnpm typecheck`, `pnpm lint` | pass |
| `pnpm test` | 104 files, 791 tests pass (two full runs after integration) |
| Fresh-database migrate | 20 migrations apply; a second run applies nothing |
| `pnpm build` | passes |
| Playwright mock suite (`pnpm test:e2e`, 1440/390/360/320) | 317 passed and 5 skipped (desktop-only cases). Two other desktop tests timed out on a cold `next dev` compile and passed on rerun. |
| Real-stack v1 journey (`next start` + worker) | 3 of 3 widths pass |
| Real-stack v2 journey (`next dev` + worker + media worker) | 3 of 3 widths pass ([v2-real-stack.md](v2-real-stack.md)) |

### Integration fixes made while merging

1. **Analysis readiness for the feature flags.** The feature flags reported analysis as "not ready" no matter what. `concentrate_analysis_enabled` now comes from the gateway's read-only readiness (`model-readiness.ts` `photoAnalysisReadiness`). A credit pause counts as provider-ready but budget-unavailable.
2. **`meta_glasses_label` in the capabilities response.** The flag merge put this string into the boolean `flags` map of `/v2/capabilities`. The web client and native apps validate that map against `CaptureCapabilitiesResponse`, so the response would have been rejected. The label now stays server-side (it is copy). `production-runtime.test.ts` now checks the response against the schema.
3. **Analysis admission is injectable.** `CaptureV2Runtime.analysisAvailability` lets tests that are about agent grants admit analysis. A new test asserts the default honest refusal: 503 "Exploration is temporarily unavailable." with no work queued.
4. **One storage directory for all workers.** The analysis worker built its own storage and resolved `STORAGE_LOCAL_DIR` from its own working directory. It now uses the shared `createMultipartStorage`, so the web app, media worker and analysis worker read the same files.
5. **Native contract fixtures.** They gained the `unsupported_media` and `duration_exceeded` codes (both mapped to `reject_item` in the Swift and Kotlin error policies) and the `remote_glasses` availability entry. A capability-gate case now matches the server's real flag evaluation for an enrolled phone.
6. **One test-database helper.** `createIsolatedDatabase` serves both the concentrate and identity-ops call shapes.

### Fixes found by the real-stack v2 journey

1. **Moment order.** Video moments were returned in arbitrary order. They now come back in timestamp order (`capture-v2/intake.ts`), with a regression check in `apps/media-worker/src/worker.test.ts`.
2. **Link share with media.** Creating the link left the panel saying "Currently private" while the link was already live and media inclusion awaited confirmation. The panel now refreshes as soon as the link exists.
3. **Shared view copy.** It said "Nothing has been shared in this collection yet." above the shared photos and videos.
4. **Player notice.** "This video cannot play in this browser" was dark text on the dark player bar.

## 1. Cross-cutting gaps from the previous report

| # | Gap | Status | Where |
| --- | --- | --- | --- |
| G1 | Production `CaptureIdentityAdapter` and native resolver | done | `apps/web/lib/server/runtime.ts`, `services/capture-identity.ts`; real-stack journey |
| G2 | Authority lifecycle hook (sign-out, switch and revocation fence uploads and arming) | done | `runtime.ts` registers `endCaptureAuthority` |
| G3 | Worker processes `capture_work` | done | `apps/media-worker` handles verify, prepare, purge and cleanup; `apps/worker/src/media-analysis.ts` handles analyze |
| G4 | Video verifier and preparer (ffmpeg) | done | `apps/media-worker/src/{verifier,probe,preparer,qualify}.ts`; ffmpeg is in the `Dockerfile` |
| G5 | Production `CaptureAgentAuthorization` | done | `authz/capture-agent-authorization.ts`, the default in `agent-fence.ts` |
| G6 | MCP media tools get a capture context | done | `app/mcp/route.ts` → `agentCaptureContext`; real-stack journey (`list_media`, `get_media`) |
| G7 | Agent REST media | done | the `cat_` hook in `captureV2Route` → `agent-media-http.ts`; real-stack journey |
| G8 | Identity mail adapter | done (SES unverified) | `providers/mail/identity-mail.ts` supports SES, a file mailbox (dev only) and none |
| G9 | Concentrate wired into v1 and v2 analysis | done in code; **no qualified model** | `providers/concentrate`, `model-gateway`, `apps/worker/src/media-analysis.ts` |

## 2. Delivery packages (BUILD-AND-ACCEPTANCE.md)

| Package | Status | What remains |
| --- | --- | --- |
| 1 Domain and infrastructure | done (server) | `consent_records` table still missing. The restore drill was tested locally only, not in the cloud. The reconciliation sweep is untested at scale. |
| 2 Camera and uploads (web) | done | Upload drafts in IndexedDB are not encrypted at rest. The 'Uploading' filter makes three status queries and has no pagination. Real browser MP4 playback was not observed (MED-05). |
| 3 Observer extraction / native | **unverified** | The iOS and Android apps have never been compiled or run. The Android Meta SDK binding is unchecked. Store and SDK eligibility has no evidence. |
| 4 Concentrate | done in code; **unverified live** | No qualified profile and no live qualification run. ZDR and logging not verified on a real key. Billing reconciliation is manual. Alerts are log lines only. |
| 5 Agent platform | done | Rate limits are per connection only (no per-account or per-endpoint budget). |
| 6 Collection sharing | done | Revocation reaches open viewers by polling, not push. The shared-media player was not checked in a browser able to decode MP4. |
| 7 Release qualification | **missing** | Independent two-user and device trial, store and SDK eligibility, cloud deploy, cloud restore drill, alert routing |

## 3. Routes (BACKEND-CONTRACTS.md, AGENTS-AND-SHARING.md)

Every route in both documents is implemented and routed.

These routes were added since the last report:

- `GET /v2/device/commands` and `POST /v2/device/commands/{id}/ack` (native `cna_` sessions only);
- `PUT`/`DELETE /v2/device/push-token`;
- `POST /v2/media/{id}/preparation` (retry);
- all sharing routes (`/v2/collections/{id}/shares`, `/v2/shares/{id}[/invitations]`, `/v2/share-invitations/accept`, `/v2/shared/{redeem,collection,media/{id}/{variant}}`);
- agent REST media and the `analyze_media` tool.

`GET /v2/events` is still a 1-second database poll that closes after 25 seconds; clients reconnect with `Last-Event-ID`. It now:

- sends deletion events to the owner;
- accepts `cna_` tokens, re-checking revocation on every poll;
- sends keepalives;
- sends a resync event when the cursor has expired.

## 4. Screens 01–13 (SCREEN-CONTRACT.md)

| Screen | Status | Evidence |
| --- | --- | --- |
| 01/08 Library, 02 Source, 03 Camera, 06 Uploads, 07 Video detail | done (web) | mock suite at 1440/390/360/320; real-stack journey for 01, 06, 07 and 08 |
| 04/05/09 Glasses | done (web explanation and phone hand-off); native **unverified** | `/capture/glasses`, `/settings/devices`. The glasses are always unavailable until an operator lists qualified SDK builds. |
| 10/11 Agents | done | mock suite with axe; real-stack journey |
| 12/13 Sharing | done | mock suite with axe; real-stack journey (link, separate viewer, revoke) |

Deviations from the mockups are listed in [design-deviations.md](design-deviations.md). Hero images and fixtures are crops of the generated mockups; replace them with licensed photography before release.

## 5. Acceptance IDs

"Here" means this container: Node 22, PostgreSQL 16, ffmpeg, and Playwright Chromium without H.264. There is no Xcode, Android SDK or kotlinc, no provider key in use, and network access is npm only.

| ID | Status | Evidence | Not verifiable here |
| --- | --- | --- | --- |
| TEN-01 | done (server) | `worker.test.ts` TEN-01, `isolation.test.ts`, `lifecycle.test.ts` | two real phones on separate networks |
| TEN-02 | done (server) | `native-contract.test.ts`, `capture-v2.test.ts`, `worker.test.ts` | native client behavior |
| MED-01 | done (server) | `worker.test.ts` MED-01 (real ffmpeg) | live billing reconciliation |
| MED-02 | done | `worker.test.ts` MED-02 | |
| MED-03 | done | `worker.test.ts` MED-03, `media.test.ts` (damaged, truncated, mislabeled, codec, duration) | real device recordings that log harmless decoder errors |
| MED-04 | done (server) | `worker.test.ts` MED-04 (2-part resume, expired links, abandoned multipart) | app kill or offline on a device; real S3 |
| MED-05 | **partial** | prepared MP4 checked with ffprobe and a full ffmpeg decode, including through the ranged gateway (real-stack journey) | playback in Chrome, Safari, iOS and Android |
| DEV-01 | **unverified** | none | physical glasses |
| DEV-02 | done (server) | `device-commands-http.test.ts`, `native-contract.test.ts`; real-stack journey runs the command lifecycle over HTTP | execution on a phone |
| DEV-03 | **unverified** | none | interruptions on a physical device |
| AI-01 | partial | contract fixtures and property tests (`schema.test.ts`, `contract.test.ts`, `media-analysis.test.ts`) | qualified live models |
| AI-02 | done with fakes | 402 pause and resume, 429 Retry-After, spend caps | live credit exhaustion |
| AGT-01 | done | `agent-media-http.test.ts`; real-stack journey over REST and MCP | |
| AGT-02 | done | `agent-platform.test.ts` | |
| SHR-01 | done | `collection-shares.test.ts`, `share-http.test.ts`; real-stack journey | |
| SHR-02 | done | `collection-shares.test.ts` | |
| UX-01 | done (web) | mock suite with axe at 1440/390/360/320; real-stack screenshots `real-v2-*` | native screens |
| OPS-01 | partial | restore drill test (real `pg_dump`/`pg_restore`), ops metrics, runbooks | cloud deploy, alerts delivered, cloud restore drill |

## 6. Hosting on AWS

The user asked to host on AWS if it can run within free limits. `infra/aws/` and [deploy-aws.md](deploy-aws.md) contain:

- a CloudFormation template: one t3.micro, PostgreSQL on RDS db.t4g.micro or on the instance, a private versioned S3 bucket with CORS that exposes `ETag` and lifecycle rules, least-privilege IAM, SSM parameters, 9 alarms and a USD 1 budget;
- a Compose file for web, worker and media worker;
- Caddy for HTTPS;
- deploy, rollback and backup scripts.

All of it is statically tested (`scripts/aws-infra.test.ts`, `docker compose config`). **None of it has been deployed.** There was no `cfn-lint`, no `aws cloudformation deploy` and no Docker image build here.

Whether it is free depends on when the AWS account was opened. These terms were not checked against AWS (no network), so verify them in the AWS Free Tier page and Billing console:

- **Opened before 15 July 2025** (12-month free tier): the stack was sized to fit; expected about USD 0 a month.
- **Opened on or after 15 July 2025** (credit-based Free plan): roughly USD 15–27 a month, paid from credits while they last.

Risks:

- Video data transfer beyond about 100 GB a month is the most likely real cost.
- A 1 GiB t3.micro prepares only a few videos an hour on earned CPU credits.
- A single instance cannot meet a 99.9% availability target.

Other notes:

- The S3 `staging` lifecycle rule only matches objects tagged `atlas-lifecycle=staging`. The multipart adapter does not set that tag yet, so cleanup relies on the one-day incomplete-upload rule and the media worker's reconciliation.
- A production web server refuses local media storage and the file mailbox by design, so a real deploy needs S3 and SES configured.

## 7. Remaining work, by area

**Media and library**
- `consent_records` table.
- Encrypt upload drafts in IndexedDB.
- Pagination for the 'Uploading' filter.
- Scene-diversity frame selection (frames are evenly spaced, `frames-v1`).
- Measure the cost of reconciliation at scale.
- Tag staging objects for the S3 lifecycle rule.
- Test the Debian bookworm ffmpeg 5.1 build used by the Docker image.

**Concentrate**
- Qualify profiles with a live key (`pnpm qualify:concentrate --confirm-paid-requests`).
- Collect ZDR and logging evidence.
- Automate billing reconciliation.
- Route alerts somewhere.
- A Cancel action for queued analysis.

**Agents and sharing**
- Per-account and per-endpoint agent budgets.
- Push revocation to open viewers.
- A web UI for arming and capture-session listing (arming happens on the phone only).
- Let installation tokens list agent connections; until then the phone's arming sheet falls back to "choose agents on the web".

**Native**
- Compile and test on Xcode and the Android SDK.
- Verify the Android Meta SDK binding and the licence copy step.
- Generate the Gradle wrapper.
- Publish `assetlinks.json`.
- Run the device acceptance rows.
- Store and SDK eligibility.

**Ops and hosting**
- First AWS deploy as staging.
- SES domain verification.
- APNs and FCM credentials.
- A cloud restore drill.
- An independent two-user trial.
