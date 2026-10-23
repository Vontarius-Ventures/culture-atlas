# Native apps (iOS and Android)

Delivery package 3 of `specs/capture-platform-v2/BUILD-AND-ACCEPTANCE.md`:
World Observer's capture code ported into an owned iOS module, an
independent Android implementation, and the shared contract both follow.

## Status, plainly

| Item | State |
| --- | --- |
| iOS Debug (`com.aomg.cultureatlas`) | Compiled, signed with Apple Development (team `U9XG3X374H`), installed on the owner's iPhone 16 (`00008140-000964563AEB001C`). Feed, Boards, item detail and related Qloo cards load live https images. Interests board is filled. Keep part PUTs run in the foreground. PrivacyInfo declares Disk Space `85F4.1` and File Timestamp `C617.1`. Phone camera Keep is proven on this iPhone 16: `media_assets` photo `phone_camera` JPEG 4032×3024 status `ready`, `upload_sessions` `committed` (2026-10-22 19:28). Analysis stays `not_requested` until Explore; vision_photo is still not qualified. Meta glasses fail closed on device (Unavailable; public build has no glasses SDK). Music Keep is still unproven (Music Mode idle on Record). Translations fail closed on Settings: “Translations aren't available in this version.” Library shows the kept photo with vision_photo not_qualified copy. Living feed: `interest_expand` complete for watch then eat then watch; pool is 51 personal cards with https Qloo images (watch 32 pictured). A Debug binary with home-grid floating tiles is built at `/tmp/ca-ios-dd` but not reinstalled while Music Mode is on Record. Device Hub cannot screen-share iOS 26.6.2 (needs 27.0+). XCUITest timed out enabling automation mode. iPhone Mirroring cannot use camera/mic. |
| App Store id `com.cultureatlas.app` | Blocked. Xcode: the identifier cannot be registered to this development team because it is not available. Release also needs Associated Domains and Push on a real App ID. |
| Android store APK (`com.cultureatlas.app`) | Rebuilt 2026-10-22 21:26: `apps/android/dist/app-store-debug.apk` (34M) and `.aab` (12M) include floating feed tiles, debug cert, tunnel API host, no Meta SDK, `FOREGROUND_SERVICE_DATA_SYNC`. Native `.so` PT_LOAD align 16KB (`0x4000`). `adb` is installed (`android-platform-tools` 37.0.1). No Android device attached, so not sideloaded. Play upload keystore is not in the repo. |
| Meta SDK | Public `CultureAtlas` / `store` flavor never link it. `/v2/capabilities` keeps glasses capture off. Experimental targets exist for permitted channels only. |
| Shared contract | `fixtures/native-contract/*.json`, verified against the real server by `apps/web/lib/server/native-contract.test.ts`. |
| Physical-device qualification (DEV-01..03, MED-05 native rows) | Phone camera Keep observed on this iPhone 16 (JPEG ready, upload committed). Glasses capture fail-closed observed on device. Music Keep not yet observed. Discover images are on-device. See "What remains on physical devices". |

## Taste onboarding and ready notices (amendment 2.2)

Package E of [build plan v2.2](build-plan-v2.2.md) brings screens 14, 15, 17
and 18 of [the amendment](../specs/onboarding-and-fast-analysis.md) to both
apps. The decision tables are in `fixtures/native-contract/onboarding.json`
and `ready-notice.json`; wire examples are the `onboarding_*`,
`taste_picks_response`, `push_token_*`, `media_detail_response`,
`analyze_photo_request` and `analysis_*` entries of `messages.json`.

- **Where the questionnaire runs.** After sign-in the app reads
  `onboarding_required` from `/v2/capabilities` and `GET /v1/onboarding/state`.
  `state.required` shows screen 14 full-screen without the tab bar; a failed
  check shows Retry (the questionnaire is required, so it is never skipped on a
  transient error); a server that does not offer native onboarding
  (`not_found`/`scope_denied`) never blocks the app.
- **Native owner bridge (server, additive).** `/v1` refuses installation
  tokens. `packages/domain/src/authz/native-owner.ts` lists the onboarding,
  taste, Discover, and board operations (`NATIVE_OWNER_OPERATIONS`) on which
  `apiRoute` (`apps/web/lib/server/http.ts`) converts a live installation
  session into its account owner (`sessionId: null`). It rechecks that the
  installation is neither revoked nor ended on every call and requires
  `X-Atlas-Expected-Account` on mutations (`account_mismatch` otherwise); every
  other `/v1` route still answers `scope_denied`. `/v1` errors are flat
  (`{code,message,…}`); both HTTP clients decode the flat and the `/v2` shape.
- **Screen 14 on a phone:** three steps with "Step n of 3", Back from step 2,
  two-column image grid, Wear/Play/Watch/Eat pills with live Qloo search
  (debounced 300 ms, 2–80 characters, results show name and type, "Added"
  state), optional exclusions (12 suggestions plus "Something else", 40
  characters, at most 12), a three-segment progress bar, a polite live
  counter, and "Build my feed" disabled with its reason until 3 picks. Every
  pick is saved as it is made (`POST /v1/onboarding/picks`), so leaving
  mid-way keeps them. "Build my feed" saves changed exclusions, then
  completes; `409 conflict` reloads the state.
- **Screen 15:** collage of the picks, per-category Ready/Looking, polling
  `GET /v1/onboarding/seed` at `poll_after_ms`; it leaves for the app as soon
  as a category is ready (or the seed is complete or not started) and shows
  "We'll keep building in the background." with Done when Qloo is
  unavailable, the job retries or fails, or 20 s pass. Done returns to the
  Feed tab (Discover).
- **Screen 18 (Settings → Taste):** picks grouped by category with Remove
  (below 3 is allowed), Add more with the same pickers through
  `/v1/taste/picks`, and the exclusions editor with Save.
- **Screen 17 (ready notice):** "Explore this photo" on a committed photo
  starts `POST /v2/media/{id}/analysis` and watches that analysis (at most 20,
  for 24 h, per account, ids only). Notification permission is asked at that
  moment. The phone registers its APNs/FCM token with
  `PUT /v2/device/push-token` after sign-in and clears it before sign-out.
  A push is a silent wake carrying only `ref`; invalid payloads are ignored.
  On a wake (and every 5 s while the app is open) the app polls each watched
  analysis: `complete` posts a local notification "Your photo is ready" with
  Open in the background, or the in-app toast with Open and Dismiss in the
  foreground; `failed`/`cancelled` end silently. Open goes to the result page
  of the web app (`result_url`), because the apps have no result view.
- **Push configuration.** iOS: `UIBackgroundModes` gains
  `remote-notification`, the entitlements carry `aps-environment`
  (`APS_ENVIRONMENT`, with `ATLAS_PUSH_ENVIRONMENT` = `production`/`sandbox`
  in `Config/Base.xcconfig`). Android: `firebase-messaging` (version pinned in
  `libs.versions.toml`, not resolvable here), `POST_NOTIFICATIONS`, and
  Firebase options from `-PatlasFcmProjectId/AppId/ApiKey/SenderId` (no
  `google-services.json`); without them push stays off and only the in-app
  toast works.

## What was ported from World Observer

Source: `/home/user/worldcompilersensor` (WorldCompilerSensor). Observer is a
single-operator relay app; culture atlas is multi-tenant, so the port keeps
device logic and drops operator/relay assumptions.

| Observer | culture atlas | Kept | Removed or changed |
| --- | --- | --- | --- |
| `Wearables/MetaWearablesService.swift` | `apps/ios/AtlasGlasses/MetaWearablesAdapter.swift` | Meta AI registration hand-off, SDK camera permission, session lifecycle, preview, pause recovery, stream revival with the 2 s restart floor (DAT issue #231), photo with 5 s timeout, bounded clips, frame-stall telemetry | Continuous observation stream, rolling evidence segments, live broadcast tap, operator "Glasses" row, mock-device toggle, device names in telemetry |
| `Wearables/ClipRecorder.swift` | `apps/ios/AtlasCapture/Wearables/ClipRecorder.swift` | HEVC passthrough, keyframe-gated open, monotonic DTS rebase, software decoder | Always writes fragmented MP4 (2 s fragments) so a disconnect or crash leaves a playable file; reports `interrupted` |
| `Library/LibraryStore.swift` (photo/clip persistence) | `AtlasCapture/Store/DraftStore.swift` + `EncryptedFile.swift` | Per-item metadata JSON beside the media, atomic writes | Relay links, retention sweep of evidence, global identity. Media is AES-GCM encrypted per account; drafts are listed only for their owner |
| `Library/LibraryUploader.swift` + `Upload/BackgroundUploadManager.swift` | `AtlasCapture/Upload/UploadCoordinator.swift` + `BackgroundTransfer.swift` | Background `URLSession` with stable identifiers and `taskDescription` identity, Wi-Fi-only gate via `NWPath.isExpensive` | Relay declare/PUT protocol and its in-memory upload identity. Replaced by `/v2/uploads` multipart with persisted `client_capture_id`, upload id, receipts and idempotency keys |
| `Security/KeychainStore.swift` | `AtlasCapture/Identity/KeychainStore.swift` | Narrow generic-password wrapper | Items are this-device-only and readable after first unlock (background work) |
| Relay pairing, QR codes, `AppModel`, operator approval | (none) | | Replaced by email sign-in, P-256 installation enrollment and native sessions (`AccountService`, `InstallationIdentity`, `SessionStore`) |

Android is an independent implementation of the same rules (no shared
Swift source): `apps/android/core` holds the protocol and policies,
`apps/android/app` the platform code. Its glasses video path differs because
the Android SDK delivers decoded frames: `SegmentedClipEncoder` encodes H.264
into ~2 s MP4 segments that are each complete files, then remuxes them
losslessly into one MP4; after a crash, `recover` joins the closed segments.

SDK license obligations are listed in `apps/ios/THIRD_PARTY_NOTICES.md`.
The iOS experimental target copies the SDK's license files into the app
bundle at build time and fails the build if none is found. Do the same for
Android before distributing the experimental flavor (copy the license from
the resolved artifact into `app/src/experimental/assets/`).

## Protocol the apps implement

All of it is pinned in `fixtures/native-contract` (see its README) and
exercised end to end by the TS contract test.

1. **Sign-in.** `POST /v2/identity/email/start` with PKCE (S256), `state` and
   `nonce` (32 random bytes each) persisted on the phone. The email link opens
   `cultureatlas://identity/callback#…` (iOS) or the verified App Link
   `https://app.cultureatlas.com/identity/callback#…` (Android). The app checks
   `state`/`nonce` and calls `email/complete`, which returns the verified
   account UUID and a five-minute enrollment grant.
2. **Enrollment.** One installation identity per account: a public UUID and a
   non-exportable P-256 key (Secure Enclave / Android Keystore, StrongBox when
   present). `POST /v2/devices/enrollment/challenge`, sign
   `culture-atlas-enroll-v1 LF nonce LF installation_public_id LF platform LF
   sha256hex(grant)`, send the IEEE P1363 signature (Android converts from
   DER). **Every UUID on the wire is lowercase**: the server verifies the signature over the
   installation id string exactly as the body carries it (the contract test
   proves an uppercase body with a lowercase-signed payload is refused). A
   revoked phone (`token_revoked`) gets a new installation identity once.
3. **Session.** Access (`cna_`, 10 min) and refresh (`cnr_`) tokens live only
   in Keychain/Keystore-encrypted storage. Refresh persists a new 32-byte
   `refresh_request_id` with the old token before sending; a lost response is
   retried with the same id inside 60 s; anything else signs out locally.
4. **Uploads.** A draft gets its `client_capture_id` before any network call.
   `POST /v2/uploads` (persisted idempotency key) → `GET /v2/uploads/{id}` →
   send missing parts using the server's `part_size` (server receipts win) →
   `POST …/complete` with a persisted key. Every mutation carries
   `X-Atlas-Expected-Account` = the draft's owner, so a switched credential
   fails with `account_mismatch` before any effect. Wi-Fi only unless the
   person chooses mobile data for an item. iOS PUTs parts in the foreground
   while the app is open (background `URLSession` remains for process-death
   completions). Android uses WorkManager (`UNMETERED` by default) with OkHttp.
5. **Remote capture.** Arming is local and explicit: open a capture session,
   report a fresh `ready` + `foreground` status (the server refuses to arm
   otherwise), arm for at most 600 s for individually selected agents. Poll
   `GET /v2/device/commands` only while armed and in the foreground. A receipt
   is persisted before any shutter; duplicates resend the stored ack; a crash
   with no saved file acks `unknown`; expired commands are skipped; Stop works
   after the arm window. Backgrounding reports `background`, which disarms.
6. **Sign-out / switch.** Stop capture and recording, disarm and end the
   session, stop polling, cancel transfers, lock pending drafts, call
   `POST /v2/identity/switch` (`token_revoked`/`token_expired` there mean
   "already signed out"), clear credentials. The person chooses Keep on this
   phone (drafts stay encrypted and hidden until the same account signs in;
   re-enrolling the same installation key unpauses that account's uploads) or
   Delete local drafts.

### Local draft encryption format (both platforms)

`"CAE1"` · chunk size (UInt32 BE) · plaintext length (UInt64 BE), then per
chunk `nonce(12) · ciphertext · tag(16)` with AES-256-GCM and additional data
`"culture-atlas-draft-v1" · chunk index (UInt64 BE) · plaintext length (UInt64
BE)`. Parts are decrypted into a short-lived file just before transfer. Keys:
one per account, Keychain (this device only) or Android Keystore. Android
excludes all app files from backup and device transfer.

## Build and test

### Server-side contract (runs here)

```sh
pnpm vitest run apps/web/lib/server/native-contract.test.ts
```

### iOS

Requirements: Xcode 16+, XcodeGen, iOS 17.2+ device for camera/glasses work.

```sh
cd apps/ios
xcodegen generate
# Public build (no Meta SDK) and its unit tests:
xcodebuild -project CultureAtlas.xcodeproj -scheme CultureAtlas \
  -destination 'platform=iOS Simulator,name=iPhone 16' test
# Experimental build (links the SDK through Swift Package Manager):
xcodebuild -project CultureAtlas.xcodeproj -scheme CultureAtlasExperimental \
  -destination 'generic/platform=iOS' build
```

`AtlasCaptureTests` reads `fixtures/native-contract` from the test bundle.
Signing: put `DEVELOPMENT_TEAM = …` in the untracked
`apps/ios/Config/Signing.xcconfig`. The API host is `ATLAS_API_HOST` in
`Config/Base.xcconfig` (override per environment in CI). `META_APP_ID` and
`CLIENT_TOKEN` are injected by CI for the experimental target; empty means
Meta Developer Mode.

### Android

Requirements: JDK 17+, Android SDK 35, network access to Google Maven,
Maven Central and (experimental flavor) GitHub Packages for the Meta SDK
(`GITHUB_ACTOR` / `GITHUB_TOKEN` with `read:packages`).

Without the Android SDK, the `:core` sources and tests can still be compiled
and run on any JVM with a minimal standalone Gradle build that applies
`kotlin("jvm")` and `kotlin("plugin.serialization")` 2.1.0, adds
`apps/android/core/src/{main,test}/kotlin` as source directories, depends on
the versions in `libs.versions.toml` from Maven Central and sets the
`atlas.fixtures` system property to `fixtures/native-contract`. That is how
the 28 core tests were run for amendment 2.2.

```sh
cd apps/android
gradle wrapper --gradle-version 8.14.3     # once, creates gradlew and the wrapper jar
./gradlew :core:test                        # JVM only, reads fixtures/native-contract
./gradlew :app:assembleStoreDebug           # public flavor, no Meta SDK
./gradlew :app:assembleExperimentalDebug    # Meta SDK flavor (confirm MetaDatBinding first)
```

API host: `-PatlasApiHost=…` (default in `gradle.properties`). Android App
Links need `/.well-known/assetlinks.json` listing both application ids and
signing certificates. iOS Associated Domains (Release entitlements
`applinks:app.cultureatlas.com`) need
`/.well-known/apple-app-site-association` on that host. This API serves both
routes; Apple and Google only fetch them from the durable production host, not
from a `trycloudflare.com` tunnel. The debug iOS custom scheme
`cultureatlas://` still needs no server file.

## Release channels and store eligibility gates

Feature inclusion is mandatory; public activation is conditional
(PRODUCT-AND-ARCHITECTURE "Experimental release policy"). Each platform has a
public build that never contains the Meta SDK and an experimental build that
does.

| Build | Channel | Contains Meta SDK | Glasses at runtime |
| --- | --- | --- | --- |
| iOS `CultureAtlas` | App Store | No | Entry visible, explains unavailability (screen 09) |
| iOS `CultureAtlasExperimental` | TestFlight (internal/external testers) plus Meta's release channel for testers | Yes | Only if server capabilities allow it |
| Android `store` flavor | Google Play production | No | Entry visible, explains unavailability |
| Android `experimental` flavor | Play internal testing / closed testing, or Meta's tester channel | Yes | Only if server capabilities allow it |

Server policy stays authoritative. The gate reads the capability keys the
apps send at enrollment and in every `PUT /v2/device/status` heartbeat
(heartbeats merge keys, so a heartbeat that omits one keeps its last value):
`meta_glasses_sdk` (or the spec's `meta_wearables_sdk`) proves the SDK build,
and `meta_wearables_supported_os` is assumed true for an SDK build unless the
app sends `false` (`fixtures/native-contract/capability-gate.json`,
`device_capability_keys`).

Owner checklist for a glasses hand test:

1. Build the `CultureAtlasExperimental` scheme (or the Android `experimental`
   flavor) with `ATLAS_META_DAT` and the MWDAT MetaAppID/ClientToken, or Meta
   Developer Mode.
2. `META_GLASSES_QUALIFIED_BUILDS='ios@<CFBundleShortVersionString> (<CFBundleVersion>)'`
   exactly as the app reports its version, `META_GLASSES_ENTITLED_PLATFORMS=ios`,
   and `META_GLASSES_ROLLOUT=all` (or `allowlist` with
   `META_GLASSES_ROLLOUT_ACCOUNT_IDS`).
3. Register the glasses in the Meta AI app and grant camera permission; the
   phone reports the wearable with `POST /v2/device/wearables`.
4. Glasses audio additionally needs `META_GLASSES_AUDIO_QUALIFIED=true`, the
   wearable's `audio` capability and the phone's `microphone_permission` and
   `glasses_microphone_selected` keys.

Gate checklist. Record evidence, owner and next check date for each row
before submitting (BUILD-AND-ACCEPTANCE "Platform release gates"); a runtime
Experimental badge never satisfies a store or SDK restriction, and mandatory
SDK declarations must not be removed to pass review.

| Gate | Platform | Evidence to record | Owner | Next check |
| --- | --- | --- | --- | --- |
| Meta developer terms and app registration for the exact bundle/application ids | both | Meta app id, approved ids, terms version | _unassigned_ | before first experimental build |
| iOS MFi / external-accessory and PPID publishing status for `com.meta.ar.wearable` (Meta's Sept 28 response says DAT 1.0 did not resolve it; TestFlight plus release channel for testers) | iOS | Link to Meta's current statement, App Review correspondence | _unassigned_ | before each TestFlight external group and any App Store submission |
| TestFlight external testing review of the experimental build | iOS | Build number, review result | _unassigned_ | per build |
| Google Play policy for the Meta SDK, Bluetooth permissions and data safety form | Android | Play Console declaration, review result | _unassigned_ | before closed testing |
| SDK license notices shipped in the experimental artifact | both | Bundle listing / APK asset listing | _unassigned_ | per build |
| Public builds contain no SDK binary | both | `otool -L` / dependency report of the store artifact | _unassigned_ | per release |
| Privacy labels (camera, microphone, photos, email) | both | App Store privacy answers, Play data safety | _unassigned_ | per release |

Do not infer Android eligibility from iOS, or either from SDK availability. If
glasses distribution stays blocked, ship the public camera/upload builds; do
not mark the whole product blocked.

## What remains on physical devices

Mock or simulator runs never qualify these (DEV-01).

| ID | Run on | Pass condition |
| --- | --- | --- |
| DEV-01 | Two people, each with their own supported Meta glasses and phone, iOS and Android separately | Each registers their own glasses through Meta AI; camera permission prompt and denial paths; reconnect after glasses sleep, phone Bluetooth off/on and app relaunch; test photo lands in the right account's library |
| DEV-02 | Armed phone + agent connection | No capture without local arming, without permission, with stale heartbeat (>30 s), after command expiry, or after agent revocation; duplicate command delivery yields one capture or an explicit `unknown`; Stop works after the arm window |
| DEV-03 | Phone camera and glasses | Disconnect, backgrounding, incoming call and low storage mid-recording keep the valid part (iOS fragments; Android camera keeps CameraX-finalized files, glasses keep closed segments) and mark it interrupted; silent video stays silent; the microphone starts only after explicit permission and toggle |
| MED-04 (native) | Airplane mode, force-quit, reboot | Offline captures stay local; uploads resume from server receipts with no duplicate asset; expired part URLs are refreshed; a paused upload resumes only after the same account signs back in |
| MED-05 (native) | iOS and Android devices | Phone and glasses outputs play after server preparation with correct orientation, duration and audio state |
| TEN-01/02 (native) | Two accounts, separate phones and networks, founder machines and Observer relay off | Independent capture/upload; switching accounts mid-upload never reassigns a draft, command or storage key |

Known device-level limits to confirm: Android CameraX recordings cut by
process death are not recoverable (only interruptions that CameraX finalizes
are kept); iOS background transfers are subject to system scheduling and
cannot be guaranteed while the app is suspended.

## Server dependencies and gaps that block native use

These are outside `apps/ios`, `apps/android` and `fixtures/native-contract`:

1. **Device command routes** `GET /v2/device/commands` and
   `POST /v2/device/commands/{id}/ack` are routed (`apps/web/app/v2/device/commands/**`,
   `captureV2Route`, `contract.json` `server: routed`). Only an enrolled
   installation `cna_` session may claim or ack; cookies and agent tokens are
   refused. Covered by `device-commands-http.test.ts` and
   `production-runtime.test.ts`.
2. **Production identity wiring** (gap report G1, G2, G8):
   `apps/web/lib/server/runtime.ts` registers `CaptureIdentityAdapter`,
   `resolveNativePrincipal`, `endCaptureAuthority` and the mail adapter from
   env. Enrollment and `cna_` calls work when identity is configured
   (`production-runtime.test.ts`). Mail/identity misconfiguration fails closed
   (`503 service_unavailable` / no adapter) and does not pretend to deliver.
3. **Agent names for the arming sheet**: `GET /v2/agent-connections` with a
   `cna_` bearer returns a read-only list of `{id, client_name, scopes}` for
   active agents that may command that installation (`arming-agents-http.ts`).
   Cookie sessions still get the owner Settings DTO. Creating/narrowing
   connections stays owner-only (`scope_denied` for installations).
4. **Expired or aborted uploads keep their `client_capture_id`**: a new
   `POST /v2/uploads` with the same id returns the dead upload. The apps
   recover by assigning a new client capture id (nothing was committed, so no
   duplicate asset can result); a server-side restart rule would be cleaner.
5. **Glasses capabilities**: `/v2/capabilities` stays glasses-off unless the
   operator sets the qualification env (`META_GLASSES_QUALIFIED_BUILDS`,
   `META_GLASSES_ENTITLED_PLATFORMS`, `META_GLASSES_ROLLOUT`). Client query
   flags are ignored. Do not treat an experimental phone build as a server
   gate. `production-runtime.test.ts` covers both the default-off response and
   an explicit activation.
6. **Push wake-ups for remote commands** are not sent by the server yet; the
   apps poll commands only while armed in the foreground.
7. **Ready-notice wake-ups (amendment 2.2):** wired on the server since the
   phase-3 merge. An analysis records the enrolled phone that requested it
   (`media_analysis_requests.started_by_installation_id`; never for web,
   agent or backfill requests). When the worker publishes the reading, it calls
   `devicePush.wakeInstallation` for that phone only. Delivery through real APNs
   and FCM to a device has not been observed (no credentials or device here).
8. **Result view:** the apps open the web result page for "Open"; that page
   needs a browser session, so a person who never signed in on the web sees
   the sign-in page first.

## Remaining credentials for App Store / Play testing

Named missing items. Features that depend on them fail closed and do not invent results.

| Credential / qualification | Blocks | Evidence |
| --- | --- | --- |
| App Store bundle `com.cultureatlas.app` on team `U9XG3X374H` | Store-signed iOS / TestFlight of the production id | `xcodebuild -configuration Release`: identifier cannot be registered because it is not available |
| Apple Distribution certificate | App Store / TestFlight upload | `security find-identity -p codesigning` lists only Apple Development |
| Play upload keystore | Play AAB / Console upload | Not in the repo; store debug APK uses the Android debug cert |
| Durable public hostname | Production identity, App Links, signed media URLs that survive a process restart | `app.cultureatlas.com` does not resolve (no A/CNAME). Current API is a Cloudflare quick tunnel (`trycloudflare.com`); `~/.cloudflared` has no named-tunnel login. Well-known files are served on the tunnel but stores will not treat it as `app.cultureatlas.com` |
| Real identity mail (not `IDENTITY_MAIL_DRIVER=file`) | Store-review sign-in that must send email | This test build writes sign-in links to a local mailbox file |
| Qualified `vision_photo` artifact | Photo Explore / Concentrate image analysis | Role is catalog-compatible (`not_qualified`); Library hides Explore and states that |
| Licensed fingerprint / catalog vendor | `music.recognize` | Health: `unavailable` / `not_implemented`. `GET /v2/capabilities` `availability.music_match` is on only when ElevenLabs and Qloo keys are present (artist-from-transcript). Otherwise Explore is hidden and the phone says nothing was invented. Recording still works. |
| Meta glasses qualification env and SDK channel | Glasses capture | Public binary contains no SDK; server hard-codes glasses gates off |
| Phone unlock / iPhone Mirroring allow | Operator-driven camera Keep on the physical iPhone | Device Hub: iOS 26.6.2 cannot screen-share (needs 27.0+). XCUITest: `Timed out while enabling automation mode.` iPhone Mirroring: camera and microphone are unavailable while mirroring; the session is locked behind the Mac login. Take photo must be done on the phone. |
