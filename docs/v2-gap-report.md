# capture platform v2: gap report

Date: 2026-10-17. Branch `claude/wizardly-cannon-yu8trw`. All real-stack rows ran against the production build (`next start`) with `STORAGE_DRIVER=s3` and `IDENTITY_MAIL_DRIVER=ses` pointed at `scripts/local-aws.ts`, never a real AWS account. Authority: `specs/capture-platform-v2/` (v2.1).

Section 9 (added 2026-10-19, updated after the 2.2 review round the same day) covers the spec amendment 2.2 merge (taste onboarding, fast analysis), the screens 14–18 fidelity branch (`fidelity/v22`), the review fixes and the final gate; sections 0–8 describe the v2 state as of 2026-10-17. This report describes the final tree after the package merges listed below, the two design-fidelity branches (`fidelity/v2-capture`, `fidelity/v1-and-account`) and the fixes for the last review round (section 8).

| Branch | Package |
| --- | --- |
| `v2/media` | media worker, verifier and preparer, library backend |
| `v2/concentrate` | Concentrate gateway and v2 media analysis |
| `v2/identity-ops` | production identity wiring, feature flags, push, ops, AWS |
| `v2/agents-sharing` | collection sharing, agent media wiring, screens 10–13 |
| `v2/capture-ui` | web screens 01–09 |
| `v2/native` | iOS and Android apps, native contract fixtures |
| `fidelity/v2-capture` | screens 01–09 matched to their references on the real stack |
| `fidelity/v1-and-account` | v1 screens and screens 10–13 matched to their references |

Status values (a row can carry more than one):

- **done:** everything the spec names for it is implemented and covered by automated tests in this repo.
- **verified-here:** also driven end to end in this container on the real stack: the production build (`next start`), the job worker, the media worker with ffmpeg, PostgreSQL 16, and the offline S3/SES stand-ins from `scripts/local-aws.ts`.
- **partial:** something the spec names is still missing; the missing piece is listed.
- **needs-physical-device:** written, but only a real phone or real Meta glasses can prove it.
- **needs-live-keys:** needs Concentrate (or Qloo) keys and a paid qualification run.
- **needs-AWS-account:** needs a real AWS account (S3, SES, deploy, alerts).
- **missing:** not implemented.

"Here" means this container: Node 22, PostgreSQL 16, ffmpeg, Playwright Chromium built without H.264/AAC, no Xcode, Android SDK or kotlinc, no provider keys, network access to the npm registry only.

## 0. Tree health (final gate)

| Check | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | passes, no changes |
| `pnpm typecheck`, `pnpm lint` | pass |
| `pnpm test` | 105 files, 820 tests pass (one earlier run hit a transient `DROP DATABASE … permission denied` in `migration-reconcile.test.ts` cleanup; it passed alone and in the final full run) |
| Fresh-database migrate | 21 migrations apply to a fresh database (including `095_analysis_capture_creator.sql`); a second run applies nothing |
| `pnpm build` (`next build`) | passes |
| Playwright mock suite (`pnpm test:e2e`, 1440/390/360/320) | 326 passed, 5 skipped (desktop-only cases); one v1 save-picker test failed once on a checkbox click and passed 12 of 12 on `--repeat-each 3` |
| Real-stack v1 journey (`e2e/real/journey.spec.ts`, production build) | 3 of 3 widths pass (1440/390/360) |
| Real-stack v2 journey (`e2e/real/v2-journey.spec.ts`, production build, worker, media worker) | 3 of 3 widths pass, with `AGENT_REMOTE_CAPTURE_ENABLED=true` for the command step ([v2-real-stack.md](v2-real-stack.md)) |
| Fidelity, capture 01–09 (`e2e/real/v2-fidelity.spec.ts`, both phases) | pass (seed, 01–08 with the experimental rollout configured, 09 without it) |
| Fidelity, v1 and 10–13 (`playwright.fidelity.config.ts`) | 30 of 30 pass (1440/390/320) |

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
| G8 | Identity mail adapter | done; verified-here against the local SES stand-in; needs-AWS-account for real SES | `providers/mail/identity-mail.ts` supports SES, a file mailbox (dev only) and none |
| G9 | Concentrate wired into v1 and v2 analysis | done in code; **needs-live-keys** (no qualified model) | `providers/concentrate`, `model-gateway`, `apps/worker/src/media-analysis.ts` |

## 2. Delivery packages (BUILD-AND-ACCEPTANCE.md)

| Package | Status | What remains |
| --- | --- | --- |
| 1 Domain and infrastructure | **partial**; verified-here | The `consent_records` table from the BACKEND-CONTRACTS persistence table does not exist (no migration defines it). The restore drill ran locally only (needs-AWS-account for the cloud drill). The reconciliation sweep is untested at scale. |
| 2 Camera and uploads (web) | **partial**; verified-here | Upload drafts kept in IndexedDB are **not encrypted** at rest (SCREEN-CONTRACT: "encrypt retained drafts"). Sign-out with pending drafts now offers Keep on this device or Delete local drafts. The 'Uploading' filter makes three status queries and has no pagination. Browser MP4 playback was not observed (MED-05: Playwright's Chromium has no H.264). |
| 3 Observer extraction / native | **needs-physical-device** | The iOS and Android apps have never been compiled or run here (no Xcode, Android SDK or kotlinc). The Android Meta SDK binding is unchecked. Store and SDK eligibility has no evidence. |
| 4 Concentrate | done in code; **needs-live-keys** | No qualified profile and no live call. ZDR and logging not verified on a real key. Billing reconciliation is manual. Alerts are log lines only. The CONCENTRATE failure-matrix consumer states (400, 429 with Cancel, unavailable) and a real cancel are now in place. |
| 5 Agent platform | **partial** | Only the per-connection limit exists (10 mutations and 60 reads a minute, `authz/agent-authorization.ts`); the per-account and per-endpoint agent budgets AGENTS-AND-SHARING names are missing. Kill switches (`agent_api_enabled`, `agent_remote_capture_enabled`) are now enforced on every agent surface. |
| 6 Collection sharing | done; verified-here | Revocation reaches open viewers on their next request or range (polling), not by push. The shared-media player was not checked in a browser that decodes MP4. |
| 7 Release qualification | **missing**; needs-physical-device; needs-AWS-account | Independent two-user and device trial, store and SDK eligibility, cloud deploy, cloud restore drill, alert routing. |

## 3. Routes (BACKEND-CONTRACTS.md, AGENTS-AND-SHARING.md)

Every route in both route tables is implemented and routed. The last one missing was the spec path `GET /v2/shared/media/{id}`, which now serves the default share-safe rendition (`app/v2/shared/media/[id]/route.ts`, tested in `share-http.test.ts`) next to `/v2/shared/media/{id}/{variant}`.

Additions beyond the tables:

- `GET /v2/device/commands` and `POST /v2/device/commands/{id}/ack` (native `cna_` sessions only);
- `PUT`/`DELETE /v2/device/push-token`;
- `POST /v2/media/{id}/preparation` (retry);
- `DELETE /v2/media/{id}/analysis/{analysis_id}` (cancel waiting or running exploration; publication is fenced, upstream billing is not promised to stop);
- agent REST media and the `analyze_media` tool.

Error bodies follow the standard shape including `retry_after_ms` when there is a backoff hint, and 429/503 responses on the `/v2` capture and device-command routes also send `Retry-After`.

`GET /v2/events` is a 1-second database poll that closes after 25 seconds; clients reconnect with `Last-Event-ID`. It sends deletion events to the owner, accepts `cna_` tokens (revocation re-checked on every poll), sends keepalives, and answers an expired cursor (24 h) with **HTTP 410** `cursor_expired` and `details.action: "resync"` before any stream starts, as the API contract says. Push delivery of events is not implemented.

## 4. Screens 01–13 (SCREEN-CONTRACT.md)

| Screen | Status | Evidence |
| --- | --- | --- |
| 01/08 Library, 02 Source, 03 Camera, 06 Uploads, 07 Video detail | done; verified-here (web) | mock suite at 1440/390/360/320; real-stack journey and fidelity run ([design-fidelity-v2-capture.md](design-fidelity-v2-capture.md)) |
| 04/05/09 Glasses | done (web explanation and phone hand-off); **needs-physical-device** for the native screens | `/capture/glasses`, `/settings/devices`. The 05 "Ready" screenshots come from a scripted phone stand-in, not real glasses. Glasses are unavailable until an operator lists qualified SDK builds. |
| 10/11 Agents | done; verified-here | mock suite with axe; real-stack journey and fidelity run |
| 12/13 Sharing | done; verified-here | mock suite with axe; real-stack journey (link, separate viewer, revoke) and fidelity run |
| v1 01–07 | done; verified-here | [design-fidelity-v1-and-account.md](design-fidelity-v1-and-account.md) |

Deviations from the mockups are listed in [design-deviations.md](design-deviations.md) and the two fidelity documents. Hero images and fixtures are the project's own illustrations (`fixtures/images/LICENSES.md`); licensed photography is still needed before release.

## 5. Acceptance IDs

| ID | Status | Evidence | Not verifiable here |
| --- | --- | --- | --- |
| TEN-01 | done (server) | `worker.test.ts` TEN-01, `isolation.test.ts`, `lifecycle.test.ts` | two real phones on separate networks |
| TEN-02 | done (server) | `native-contract.test.ts`, `capture-v2.test.ts`, `worker.test.ts` | native client behavior |
| MED-01 | done (server) | `worker.test.ts` MED-01 (real ffmpeg) | live billing reconciliation |
| MED-02 | done | `worker.test.ts` MED-02 | |
| MED-03 | done | `worker.test.ts` MED-03, `media.test.ts` (damaged, truncated, mislabeled, codec, duration) | real device recordings that log harmless decoder errors |
| MED-04 | done (server) | `worker.test.ts` MED-04 (2-part resume, expired links, abandoned multipart); part URLs bind each part's exact length and oversized stored parts abort the upload (`multipart.test.ts`, `lifecycle.test.ts`) | needs-physical-device (app kill, offline); needs-AWS-account (real S3 enforcing the signed `content-length`) |
| MED-05 | **partial** | prepared MP4 checked with ffprobe and a full ffmpeg decode, including through the ranged gateway (real-stack journey) | playback in Chrome, Safari, iOS and Android |
| DEV-01 | **needs-physical-device** | none (the fidelity run's glasses are a scripted stand-in and do not count) | physical glasses |
| DEV-02 | done (server) | `device-commands-http.test.ts`, `native-contract.test.ts`, `agent-commands.test.ts` (remote capture off by default; kills stop requests, claims and execution); real-stack journey runs the command lifecycle over HTTP with the operator opt-in | needs-physical-device (execution on a phone) |
| DEV-03 | **needs-physical-device** | none | interruptions on a physical device |
| AI-01 | partial; **needs-live-keys** | contract fixtures and property tests (`schema.test.ts`, `contract.test.ts`, `media-analysis.test.ts`) | qualified live models |
| AI-02 | done with fakes; needs-live-keys | 402 pause and resume, 429 Retry-After, spend caps; the UI shows "Waiting to explore" with a real Cancel | live credit exhaustion |
| AGT-01 | done; verified-here | `agent-media-http.test.ts` (including the `agent_api_enabled` kill on REST v1/v2, media gateway and MCP), `media-analysis.test.ts` (analysis does not make the agent the capture creator), `collection-media.test.ts` (no media into media-including shares); real-stack journey over REST and MCP | |
| AGT-02 | done | `agent-platform.test.ts` | |
| SHR-01 | done; verified-here | `collection-shares.test.ts` (including the `collection_sharing_enabled` kill), `share-http.test.ts`; real-stack journey | |
| SHR-02 | done | `collection-shares.test.ts` | |
| UX-01 | done (web); verified-here | mock suite with axe at 1440/390/360/320; real-stack screenshots `real-v2-*` and the fidelity sets | needs-physical-device (native screens) |
| OPS-01 | partial; **needs-AWS-account** | restore drill test (real `pg_dump`/`pg_restore`), ops metrics, runbooks, kill switches enforced in services (`feature-flags.test.ts` keeps the service and capabilities evaluations equal) | cloud deploy, alerts delivered, cloud restore drill |

## 6. Hosting on AWS

The user asked to host on AWS if it can run within free limits. `infra/aws/` and [deploy-aws.md](deploy-aws.md) contain:

- a CloudFormation template: one t3.micro, PostgreSQL on RDS db.t4g.micro or on the instance, a private versioned S3 bucket with CORS that exposes `ETag` and lifecycle rules, least-privilege IAM, SSM parameters, 9 alarms and a USD 1 budget;
- a Compose file for web, worker and media worker;
- Caddy for HTTPS;
- deploy, rollback and backup scripts.

All of it is statically tested (`scripts/aws-infra.test.ts`, `docker compose config`). **None of it has been deployed.** There was no `cfn-lint`, no `aws cloudformation deploy` and no Docker image build here.

**It is not free on any AWS account today.** These terms were not checked against AWS (no network), so verify them in the AWS Free Tier page and Billing console:

- **Legacy 12-month free tier** (accounts opened before 15 July 2025): it lasted 12 months from account creation, so it ended for every such account by 14 July 2026 at the latest. The stack was sized for it, but that USD 0 case no longer exists.
- **Credit-based Free plan** (accounts opened on or after 15 July 2025): roughly USD 15 a month with `DatabaseMode=instance` or USD 27 with RDS, **paid from credits** for a limited period (assumed 6 months); after that it bills or the account closes.

So the answer to "host it on AWS if it can run free" is: only as a credit-funded trial, not indefinitely. Status: **needs-AWS-account**.

Risks:

- Video data transfer beyond about 100 GB a month is the most likely real cost.
- A 1 GiB t3.micro prepares only a few videos an hour on earned CPU credits.
- A single instance cannot meet a 99.9% availability target.

Other notes:

- The S3 `staging` lifecycle rule only matches objects tagged `atlas-lifecycle=staging`. The multipart adapter does not set that tag yet, so cleanup relies on the one-day incomplete-upload rule and the media worker's reconciliation.
- A production web server refuses local media storage and the file mailbox by design, so a real deploy needs S3 and SES configured.
- Presigned part URLs now sign `content-length` and no longer embed a checksum of the empty presigning body (`requestChecksumCalculation: WHEN_REQUIRED`); a real bucket has not confirmed either.

## 7. Remaining work, by area

**Media and library**
- `consent_records` table (Package 1 stays partial until it exists).
- Encrypt upload drafts in IndexedDB (Package 2 stays partial until then).
- Pagination for the 'Uploading' filter.
- Scene-diversity frame selection (frames are evenly spaced, `frames-v1`).
- Measure the cost of reconciliation at scale.
- Tag staging objects for the S3 lifecycle rule.
- Test the Debian bookworm ffmpeg 5.1 build used by the Docker image.

**Concentrate** (needs-live-keys)
- Qualify profiles with a live key (`pnpm qualify:concentrate --confirm-paid-requests`).
- Collect ZDR and logging evidence.
- Automate billing reconciliation.
- Route alerts somewhere.

**Agents and sharing**
- Per-account and per-endpoint agent budgets (Package 5 stays partial until then).
- Push revocation to open viewers.
- A web UI for arming and capture-session listing (arming happens on the phone only).
- Let installation tokens list agent connections; until then the phone's arming sheet falls back to "choose agents on the web".

**Native** (needs-physical-device)
- Compile and test on Xcode and the Android SDK.
- Verify the Android Meta SDK binding and the licence copy step.
- Generate the Gradle wrapper.
- Publish `assetlinks.json`.
- Run the device acceptance rows (DEV-01, DEV-03, MED-04/05 on devices).
- Store and SDK eligibility.

**Ops and hosting** (needs-AWS-account)
- First AWS deploy as staging, on Free plan credits.
- SES domain verification.
- APNs and FCM credentials.
- A cloud restore drill.
- An independent two-user trial.

**Known issue noted by the fidelity run, not fixed**
- Opening `/identity` as the very first request can create two anonymous sessions, so the emailed link then fails as "expired or already used" ([design-fidelity-v2-capture.md](design-fidelity-v2-capture.md), problem 4).

## 8. Last review round: what changed

| Finding | Outcome |
| --- | --- |
| Agent remote capture, agent API and sharing kill switches not enforced on the server | Fixed. `requireServiceFeature` (`flags/feature-flags.ts`) is evaluated in `requestCapture`, phone claims and the pre-execution ack (`agent-commands.ts`), in every agent surface (`enforceAgentAccess`: v1 `apiRoute`, `agentRoute`, the agent media gateway, MCP, open event streams) and in sharing (create, broaden, invite, accept, redeem, view; revoke and list keep working). Remote capture is off unless `AGENT_REMOTE_CAPTURE_ENABLED=true`. Regression tests in `agent-commands.test.ts`, `agent-media-http.test.ts`, `collection-shares.test.ts`, `feature-flags.test.ts`. |
| Analysis makes the agent the capture creator (grant laundering) | Fixed. Only an agent that uploaded the media becomes the capture's creator (`analysis-run.ts`); migration `095_analysis_capture_creator.sql` clears existing rows. Regression test in `apps/worker/src/media-analysis.test.ts`. |
| Agent `collections:write` can expose media to link holders | Fixed. `assertAgentCannotExposeMedia` refuses agent additions of media, and of capture items, to collections with a live share that includes media. Tests in `collection-media.test.ts`. |
| Presigned UploadPart URLs do not bind length | Fixed. S3 signs `content-length` per part, the local driver signs the size, and verification aborts uploads with wrongly sized stored parts. Tests in `multipart.test.ts`, `lifecycle.test.ts`. |
| Selected-collection agents cannot start uploads | Fixed. The destination now reaches intake's fence. Tests in `agent-media.test.ts`. |
| 'partial' analysis polls forever | Fixed (`explore-state.ts`); unit and mock-browser tests. |
| CONCENTRATE failure-matrix consumer states missing | Fixed: "We couldn’t explore this media." with a next step, "Waiting to explore" with a real Cancel (new cancel route), "Exploration is temporarily unavailable." |
| Web sign-out ignores pending local uploads | Fixed: Keep on this device or Delete local drafts (`SettingsView.dom.test.tsx`). Encryption of retained drafts is still missing. |
| No `retry_after_ms`; no `Retry-After` on `/v2` capture 429 | Fixed (`errors.ts`, `capture-v2.ts`, `device-commands-http.ts`). |
| Expired SSE cursor returns 200 with a resync event | Fixed: HTTP 410 with `details.action: "resync"`. |
| AWS docs offer the legacy free tier as USD 0 | Fixed in `deploy-aws.md`, `README.md`, this report, `media-worker.md` and the template text. |
| This report labelled packages done while pieces were missing | Fixed: Packages 1, 2 and 5 are partial; the bare `GET /v2/shared/media/{id}` route was added. |
| Fidelity doc presented scripted phone and glasses as real | Fixed in `design-fidelity-v2-capture.md`. |
| Source screen claims connected glasses in a browser | Fixed (`glassesEntryLine`). |

## 9. Spec amendment 2.2: taste onboarding and fast analysis

Date: 2026-10-19. Authority: [specs/onboarding-and-fast-analysis.md](../specs/onboarding-and-fast-analysis.md) (wins on conflicts) and [docs/build-plan-v2.2.md](build-plan-v2.2.md). Phase 3 (merge and end to end) of the build plan.

> **Model status now (2026-10-19, after the photo-role requalification).** No model role is qualified. `vision_photo` and `vision_photo_enrich` failed the blind held-out run on golden-v2 (M1 4, M4 0.2105, M11 3; [quality plan §16](quality-plan.md#16-requalification-blind-run-plan-steps-46-2026-10-19-fail-photo-roles-stay-off)), and golden-v2 can no longer qualify them (its failed blind run is recorded in `fixtures/eval/golden-v2/freeze.json`), so requalification needs a fresh blind set. Photos fail closed. The phase-4 live artifacts mentioned in older rows below checked transport only (no eval block) and do not qualify the roles. The text roles' artifacts are stale since thr-v2. No real upload on this branch has reached `complete` or a first useful section. FAST-01 and FAST-03 below reflect this.

| Branch | Package |
| --- | --- |
| `v22/onboarding-backend` | A: catalog, picks, exclusions, onboarding state, `/v1/onboarding/*`, `/v1/taste/picks` |
| `v22/taste-seed` | B: the `taste_seed` job, seeded feed pool, seed status |
| `v22/fast-analysis` | C: quick read, `vision_photo_enrich`, `reasoningEffort`, compiler enrich stage, v2 worker stage 2 |
| `v22/web-ui` | D: screens 14–18 on the web |
| `v22/native-onboarding` | E: iOS and Android onboarding, Settings → Taste and ready notices |

### Integration work done while merging

1. **Seed wiring (A ↔ B).** Onboarding completion now queues the seed through `tasteSeed.enqueueTasteSeed`. `GET /v1/onboarding/seed` and the `seed` field of the state and completion responses return `tasteSeed.getTasteSeedStatus`, which reads `taste_seed_runs`/`taste_seed_categories`. A's placeholder `job_stages` reader is gone. A's tests now record progress the way the job does.
2. **Settings → Taste re-seeds.** After completion, adding or removing a pick queues one seed for the new taste revision. No second seed is queued while one is still waiting to start, because that one will read the current saves. Covered by a test.
3. **Tag picks were not seed signals (found by the real-stack journey).** Catalog picks store their Qloo tag under `external_ids.qloo_tag`, but the seed only read `external_ids.qloo`. An onboarding made only of image and chip picks therefore seeded nothing: every category came back `empty`. The seed now reads both. B's test helper now stores tags the way real picks do, and the test failed before the fix.
4. **An open Qloo circuit made the seed give up (found by the journey).** After an outage the adapter's circuit breaker stays open for 30 s. The seed treated "circuit open" as permanent and ended `partial` or `failed`. A circuit-open error now carries the time until the breaker's next trial. The worker re-queues with that delay, and the seed retries instead of giving up. New test in `taste-seed.test.ts`.
5. **One Qloo limit per process.** Every Qloo adapter built for the same key now shares one FIFO limiter (`QLOO_MAX_CONCURRENCY`, default 3), across onboarding search, the seed, analysis resolution and related discovery. Waiting for a slot does not use up a request's timeout. Tests in `http/concurrency.test.ts`.
6. **Native ready push (E's server side).** `media_analysis_requests.started_by_installation_id` (migration 140) records the enrolled phone that asked for an analysis. When the worker publishes the reading, it calls `devicePush.wakeInstallation` for that phone only: a silent wake with an opaque reference. Web, agent and backfill requests never wake a phone. Covered by a test in `media-analysis.test.ts`.
7. **Anonymous examples under a qualified gateway.** The Concentrate gateway refuses session-only jobs. If a vision role had been qualified, "Try an example" for an anonymous visitor would have failed instead of replaying its reviewed reading. The compiler now replays the example whenever no model can serve the job. Covered by a test in `pipeline.test.ts`.
8. **Native bridge on the real handlers.** E's bridge tests used stand-in handlers because A's routes were not on its base. A new test drives an enrolled phone through the real `/v1/onboarding/*` and `/v1/taste/picks` route files: required state, the 409 below 3 picks, picks, exclusions, completion and seed status.
9. **Mock images (owner request).** The 12 image picks are now generated mock photos in `apps/web/public/samples/onboarding` (800×1000, no people, text or logos), recorded in `fixtures/images/LICENSES.md`. The catalog was updated with the script's own version function (new `catalog_version`). The web mock, native fixtures and tests, and the screen 14/15/18 mockups point at them.
10. **Older real-stack journeys.** `journey.spec.ts` and `v2-journey.spec.ts` now answer the questionnaire after account creation.

### Review round after the fidelity merge (2026-10-19)

`fidelity/v22` (screens 14–18 matched to their mockups on the real stack with live Qloo; [design-fidelity-v22.md](design-fidelity-v22.md)) was merged, then the review findings below were checked against the code. Each one was reproduced or confirmed by reading the code before it was fixed; every fix has a test that fails without it.

| Finding | Outcome |
| --- | --- |
| Onboarding search and Settings → Taste reseeds had no per-account bound on the shared Qloo key (major) | **Fixed.** Search takes one unit of a per-account daily quota (`ACCOUNT_DAILY_ONBOARDING_SEARCHES`, default 200, 429 `quota_exceeded`, shown as "Search is taking a break"); the process-wide queue is bounded (12 waiting) and one account may hold at most 2 searches in flight or waiting. Reseeds start no sooner than 2 minutes after the account's previous seed (a queued seed absorbs further edits) and are capped per account per day (`ACCOUNT_DAILY_TASTE_SEEDS`, default 12). Tests: quota and other-account isolation, bounded in-flight, reseed spacing and daily cap (`onboarding.test.ts`). |
| Seed cap applied per attempt, so one job could make 24 Qloo requests (major, and the duplicate minor) | **Fixed.** The 6-request cap is now per job across all attempts: each request is reserved atomically on `taste_seed_runs.qloo_requests_used` (migration `150`) before it is sent; inline retries are off; an attempt that meets 429/5xx/an open circuit stops asking; a retry probes with one request first; once 6 are spent the job ends `partial`/`failed` and the labeled examples fill the rest. Worker tests assert ≤ 6 calls over the whole job under throttling and under timeouts. Trade-off: after a long outage fewer categories may be seeded (the throttled test ends with 2 of 4 ready). |
| Overlapping image/chip picks left saves behind; result depended on removal order (major, and the duplicate minor) | **Fixed.** Removing a pick hands ownership of a still-shared save to the remaining pick, so the last pick to go unsaves it. Tests cover image+chip in both orders, the image whose two tags are both chips (3 picks on 2 saves), two images sharing Wabi Sabi, and a save that pre-dated onboarding (kept). "3 picks on 2 saves" still completes onboarding: each is an explicit choice the person made, and the counter counts choices. |
| Stage-2 appended cards got interleaved ranks and could push published cards out of the first six (major) | **Fixed.** Appended cards rank after every card already published in any category, and never inside the stage-1 rank range, so later stage-1 sections (Eat) still precede them. The worker test asserts the appended rank and that the previously shown cards keep their positions (it fails with the old ranks). |
| Advisory veto removed a published reference; stage-2 references re-sorted the list (major) | **Fixed.** A veto only lowers certainty: the reference stays listed (now qualified, e.g. "Resembles …") in the place it was first shown (`published_certainty`), and stage-2 references come after every stage-1 reference (`enrichment_added`, migration `160`). The worker test now asserts the opposite of the old behaviour. |
| Required onboarding enforced only in the client (minor, reported twice) | **Fixed.** `GET /v1/discoveries` answers 409 `onboarding_required` to the account's own browser and phone while the questionnaire is owed (new error code, added to `error-policy.json` and the iOS/Android policy tables as `reload_state`); the web Discover view goes to `/welcome/taste` on it. Saves and uploads stay allowed (the pending save at sign-up is part of onboarding; the first upload never shows the questionnaire). |
| `food.exclusions` changed through the preferences API did not invalidate feed snapshots (minor) | **Fixed.** `updatePreferences` drops the account's snapshots whenever `food` changes. Test: an excluded Eat card disappears without `refresh`. |
| Stage-1 output was placed in the stage-2 `<user_data>` block unescaped (minor) | **Fixed.** All three prompt builders escape `<`, `>` and `&` as JSON unicode escapes (same JSON value, cannot close the block). Regression tests in `vlm/prompt.test.ts`. |
| `privacyVerifiedAt` set by the build agent before ZDR was confirmed (minor) | **Recorded as a process exception the owner must accept** ([concentrate.md](concentrate.md)): nothing sent can be recalled; the artifacts stay outside the repo and must not be used to deploy; the owner either accepts the exception or discards them and re-qualifies after the operator's confirmation. Only the operator sets the flag from now on. |
| Search results matched picks by display name (minor) | **Fixed.** Search results carry `pick_id`; both pickers match and remove by pick id only. Domain test with two results named "Nina". |
| Settings → Taste "Add more" lacked the image grid (minor) | **Fixed.** The panel shows the group's catalog images above the chips (the amendment's "same pickers" wins over mockup 18). Mock flow test re-adds a removed image pick. |
| README contradicted itself on live qualification (minor) | **Fixed** at the time (README said the two photo roles were qualified live with the privacy gate pending). **Superseded:** those were transport-only passes; after the failed golden-v2 blind run the README says no model role is qualified. |
| ONB-07 reduced motion was claimed as checked but not asserted (minor) | **Fixed.** The mock suite now asserts the screen 15 collage animates by default and has `animation: none` under reduced motion, and screen 14 tiles have no transitions, at all four widths. Native reduced motion is still unverified. |

### Final gate (2026-10-19, after the review fixes)

| Check | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | passes, lockfile unchanged |
| `pnpm typecheck`, `pnpm lint` | pass |
| `pnpm test` | 120 files, 991 tests pass (hermetic: the shell's live provider variables no longer leak into tests) |
| Fresh-database migrate | 28 migrations (including `150_taste_seed_request_count.sql` and `160_enrichment_reference_order.sql`) apply; a second run applies nothing |
| `next build` | passes |
| Playwright mock suite (1440/390/360/320) | 410 passed, 21 skipped (desktop-only screenshot specs), 1 failed: the v1 save-picker test timed out once under load and passed 8 of 8 on `--repeat-each 2` |
| Real-stack v1 and v2 journeys (`playwright.real.config.ts`, `next dev` + worker + media worker, 2.2 stand-ins, `AGENT_REMOTE_CAPTURE_ENABLED=true`) | 6 of 6 (3 widths each) |
| Real-stack 2.2 journeys (`v22-journey.spec.ts`) | 9 of 9 on a fresh database |
| Live-Qloo fidelity run, screens 14–18 (`v22-fidelity.spec.ts`) | 6 of 6 (3 widths × main and Qloo-unavailable); 81 live Qloo requests forwarded by the gate, 12 refused during the simulated outage; every seed run used ≤ 6 requests |
| Android core JVM tests | not rerun: the Android Gradle plugin cannot be resolved offline in this container; the one-line policy change (`onboarding_required` → reload) is uncompiled, like all Swift |

### Gate after the merge (2026-10-19)

| Check | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | passes, lockfile unchanged (no new dependencies) |
| `pnpm typecheck`, `pnpm lint` | pass |
| `pnpm test` | 119 files, 976 tests pass (run without the shell's live provider variables; with `MODEL_FALLBACK`/`CONCENTRATE_*` exported, 7 older tests in `model-readiness.test.ts` and `agent-media-http.test.ts` fail as before the merge) |
| Fresh-database migrate | 26 migrations (including `140_ready_notice.sql`) apply to a fresh database; a second run applies nothing |
| `pnpm build` (`next build`) | passes |
| Playwright mock suite (`pnpm test:e2e`, 1440/390/360/320) | 399 passed, 21 skipped (desktop-only and screenshot-only cases) |
| Android core JVM tests (`:core:test`, plain JVM, JDK 21 toolchain override) | 28 of 28 pass |
| Real-stack v1 journey (`journey.spec.ts`) and v2 journey (`v2-journey.spec.ts`) | 3 of 3 widths each, against `next dev` + worker + media worker with the 2.2 stand-ins (both now answer the questionnaire) |
| Real-stack 2.2 journeys (`v22-journey.spec.ts`) | 9 of 9 (below), on a fresh database |

### Real-stack journeys

`apps/web/e2e/real/v22-journey.spec.ts`, run against `next dev`, the worker and the media worker with local provider stand-ins ([v22-real-stack.md](v22-real-stack.md)): **9 of 9 pass** (3 tests × 1440/390/320). Screenshots are `apps/web/e2e/screenshots/real-v22-*.png`; their names are fixture data.

| Journey | Steps |
| --- | --- |
| Main | anonymous browse and a labeled example, with no questionnaire → sign up → questionnaire: one image, one chip, one live search pick, one exclusion; disabled with its reason until 3 picks → Building your feed → personal Discover with seeded cards → upload → While we look (cards from the feed) → quick read and enrichment → a second upload, leave → "Your photo is ready" → Open → Settings → Taste: remove one pick, add one |
| Qloo unavailable | catalog-only completion; "Search is taking a break. Pick from the ideas above."; "We'll keep building in the background."; seed `retrying`, no invented cards; Qloo back, retry publishes |
| Existing account < 3 saves | asked at sign-in, completes, not asked again at the next sign-in |

### Acceptance (amendment 2.2)

| ID | Status | Evidence / what is missing |
| --- | --- | --- |
| ONB-01 | done, verified-here | Server `required` state, 409 below 3, web gate; anonymous never redirected (real journey). Since the review round the feed API itself refuses a required account (409 `onboarding_required`), so a client that ignores the gate still cannot read the personal feed. |
| ONB-02 | done, verified-here | Picks are saves backed by Qloo ids (catalog or signed search result); image counted once (unit and route tests; the journey checks `picks_count` and Saved for later). |
| ONB-03 | done, verified-here | Catalog-only completion, degraded search, seed retries through 503s and an open circuit, no fabricated cards (real journey, unit tests). |
| ONB-04 | done; latency partial | Request cap (≤ 6 per job, across retries, since the review round) and concurrency (≤ 3) held in every live run. Locally, against live Qloo, the first category came after 1.4 s (Oct 18) and after 4.9, 5.1, 7.8 and 12.6 s (Oct 19, p50 about 6.4 s). That misses 5 s, because Qloo insights took 3.6–13.7 s per call. Not measured on a deployed demo ([latency plan](analysis-latency-plan.md#taste-seed-onb-04-live-qloo)). |
| ONB-05 | done | Exclusions as plan defaults and Eat filter (unit and route tests); the journey checks the exclusion is stored and is not a pick. |
| ONB-06 | done, verified-here | Real journey (sign-in trigger, asked once). |
| ONB-07 | partial | Web: keyboard and 320 px checked by the mock and real suites, axe passes, and reduced motion is asserted by the mock suite (screen 15 collage and screen 14 tiles, since the review round). Screens 14–18 were compared with their mockups on the real stack with live Qloo ([design-fidelity-v22.md](design-fidelity-v22.md)). Native: needs-physical-device. |
| FAST-01 | **unmet on this branch**; model time measured | Model time: the phase-4 transport run on 15 real public test photographs (the owner asked for these instead of owned photos) measured stage-1 p50 2.27 s, p95 4.63 s over 30 calls, and the golden-v2 blind run stage-1 p50 2.2 s, p95 2.9 s. End to end: the one real-stack upload that reached its first useful section in 8.0 s ran on the base branch; on this branch no photo role is qualified (the golden-v2 blind run failed), so every real upload fails closed and no upload reached a first useful section or `complete` ([latency plan](analysis-latency-plan.md)). The end-to-end p95 and the deployed demo are not measured. The ZDR/logging dashboard confirmation is pending. |
| FAST-02 | done | Merge rules and failure isolation (unit and worker tests); since the review round, appended cards rank after every published card and an advisory veto only lowers certainty (the reference stays listed in place). The real journey shows both stages with the fake transport. |
| FAST-03 | done in code; **not qualified** | Effort is sent only when the profile sets it (transport and contract tests). The phase-4 live artifacts from 2026-10-19 (effort `none`, 0 reasoning tokens) are transport-only passes without an eval block, so they do not qualify either role (`missing_eval`). Both photo roles failed the golden-v2 blind run and are not qualified; requalifying them needs a fresh blind set, then the ZDR confirmation. |
| FAST-04 | done, verified-here | The strip only reads the feed snapshot (mock suite counts requests); real journey. |

### Still open after this merge

- **Photo-role qualification.** `vision_photo` (quick read) and `vision_photo_enrich` on `anthropic/claude-haiku-5-5` with effort `none` are **not qualified**: the phase-4 transport pass (2026-10-19) carries no eval block, and the requalification's blind golden-v2 run failed M1, M4 and M11 ([concentrate.md](concentrate.md), [quality plan §16](quality-plan.md#16-requalification-blind-run-plan-steps-46-2026-10-19-fail-photo-roles-stay-off)). Still open: a fresh blind set and a passing blind run, qualification, an end-to-end upload reaching `complete`, the operator's ZDR/no-logging dashboard confirmation and qualification with the confirmed `privacyVerifiedAt`. The automated browser suites still use the fake transport. Profiles not pinned to `atlas_observations_v2` are treated as quick-read profiles, so check deployed profile files.
- **Licensed photography.** The onboarding images are generated mock photos (owner request). Replace them before a public release if generated imagery is not acceptable there.
- **Wear chips.** Qloo has no fashion-style tags for brands, so the Wear chips are style, decor and ambience tags. Whether they are useful signals for brand insights is unverified with live data.
- **Qloo limits.** The limit is per process: the web app and the worker can each hold 3 requests in flight against the same key. Per-account daily caps now bound onboarding search and reseeds; they are counters in PostgreSQL, so they hold across processes.
- **Seed after a long outage.** With the per-job cap of 6, a seed that spent requests during an outage may publish fewer categories once Qloo returns (the rest show labeled examples until the next taste change reseeds).
- **Native review fixes.** The iOS and Android apps were not changed for the review round beyond mapping `onboarding_required` to "reload state"; their Settings → Taste pickers and search-result matching were not re-checked against the web fixes (no toolchain).
- **ONB-06 timing.** The ONB-06 check runs at sign-in only. An account that is already signed in is asked at its next sign-in.
- **Native.** iOS and Android were not compiled (no Xcode, Swift or Android SDK). The Android core module's 28 JVM tests pass. The `firebase-messaging` pin is unresolved offline. The native ready push now has a server-side sender, but it was not delivered to a real device.
- **Web ready watcher.** It is per tab and in memory: it covers analyses started or opened in that tab.
- **Copy.** Native-only retry and error strings are not in `copy.json`.
- **v2 media detail.** "While we look" was driven on the v1 capture result. The v2 media detail strip is covered by the mock suite only, because v2 analysis needs a qualified model on the web side as well.
