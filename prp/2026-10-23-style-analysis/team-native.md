# Native local-validation handoff

Worktree: `/Users/vontariusfalls/culture-atlas-worktrees/factory6-integration`;
branch `factory6/integration`. Validation run: 2026-10-27.

## Findings and fixes

The original two iOS UI tests relied on ambient signed-in/completed-onboarding
state. Neither original skip established a physical-camera limitation.
There was no active API runtime, so those tests could not exercise their
intended screens against a real server.

Added a separate **Debug + simulator-only**, explicitly requested
`-AtlasNativeUITestFixture` composition:

- A test-owned synthetic session uses Keychain service
  `com.cultureatlas.native-ui-fixture`, never the user's session service.
  Its session is reset on each fixture launch.
- Fresh temporary draft/receipt/notice storage and background-transfer
  namespace `com.cultureatlas.native-ui-fixture.uploads` avoid user data/tasks.
  The default production transfer identifiers are unchanged.
- An ephemeral URLSession with a private URLProtocol intercepts every API
  request. Only known GETs to `https://native-ui-fixture.invalid` carrying the
  synthetic fixture bearer succeed; other URLs, methods and credentials fail
  locally without network fallback. APNs registration is disabled for fixtures.
- Normal `SessionStore` → `CaptureController.launch` → `RootView` →
  `OnboardingController.evaluate` → `AtlasAPI` → `FeedView`/`CameraView` paths
  run. No direct assignment to signed-in phase or onboarding gate was added.
- Example feed cards are visibly labeled examples, have
  `evidence_available:false`, and claim no provider provenance.
- `-AtlasNativeUITestSignedOut` omits the session;
  `-AtlasNativeUITestOnboardingRequired` serves incomplete onboarding.
  Regression tests confirm neither reaches the tabs.
- The existing live tests/skips and floating-feed assertions remain. Shared
  floating assertions still sample 16 snapshots, reject duplicate identities
  and overlaps, and require steady upward movement of tracked cards.
- The new camera test navigates the real Capture → This camera path and
  checks the real unavailable/permission fallback and Photos action, with no
  Take photo or Keep controls. It does not inject camera output.

This is **session-fixture/UI qualification**, not proof of email identity,
PKCE exchange, enrollment, real uploads, or live recommendations. Fixture
credentials have no server authority. Release and physical-device builds
cannot activate this fixture.

### Files changed by this workstream

- `/Users/vontariusfalls/culture-atlas-worktrees/factory6-integration/apps/ios/CultureAtlas/App/AppEnvironment.swift`
- `/Users/vontariusfalls/culture-atlas-worktrees/factory6-integration/apps/ios/CultureAtlas/App/CultureAtlasApp.swift`
- `/Users/vontariusfalls/culture-atlas-worktrees/factory6-integration/apps/ios/CultureAtlas/App/ReadyNoticeCenter.swift`
- `/Users/vontariusfalls/culture-atlas-worktrees/factory6-integration/apps/ios/AtlasCapture/Upload/BackgroundTransfer.swift`
- `/Users/vontariusfalls/culture-atlas-worktrees/factory6-integration/apps/ios/CultureAtlasUITests/FeedFloatTests.swift`
- `/Users/vontariusfalls/culture-atlas-worktrees/factory6-integration/apps/ios/CultureAtlasUITests/CameraKeepTests.swift`
- `/Users/vontariusfalls/culture-atlas-worktrees/factory6-integration/apps/ios/README.md`
- `/Users/vontariusfalls/culture-atlas-worktrees/factory6-integration/apps/android/README.md`
- This report.

Existing native style/fixture changes and all other dirty/untracked work were
preserved. Android production/test code was not changed. README status was
corrected to acknowledge the already successful Android build/tests and the
current iOS counts.

## Actual checks

First confirmed with XcodeListWorkspaces that `workspace-cMnynP4SZ1` points
to this worktree's `apps/ios/CultureAtlas.xcodeproj`, not the other Factory
workspace. XcodeListRunDestinations confirmed active scheme `CultureAtlas`,
iPhone 17 / iOS 27.0. All build/test actions used Xcode MCP.

| Check | Passed | Skipped | Failed | Notes |
| --- | ---: | ---: | ---: | --- |
| Xcode BuildProject(buildForTesting:true) | Build succeeded | — | 0 errors | 11.702 seconds |
| Four new fixture UI regressions, targeted | 4 | 0 | 0 | Real shell/feed/camera fallback + both auth/onboarding negative states |
| Full CultureAtlas scheme | 120 | 2 | 0 | 122 total: 116 unit passes, 4 fixture UI passes, 2 original live skips |
| Android prior authoritative validation | 118 | 0 | 0 | 102 core + 16 app/Robolectric; store-debug APK built; not rerun here |
| Native git diff --check | Clean | — | — | Existing and new native edits checked |

Android counts were also reconfirmed read-only from the existing JUnit XML:
18 core suites in `apps/android/core/build/test-results/test` total 102 tests;
3 app suites in `apps/android/app/build/test-results/testStoreDebugUnitTest`
total 16 tests; both have zero skipped/failures/errors. No Gradle run was
repeated.

The two original skips remain **exactly**:

- `CameraKeepTests/testTakePhotoAndKeepOnThisPhone()`:
  “Not signed in with a finished onboarding on this simulator.”
- `FeedFloatTests/testFeedCardsFloatByIdentityAndNeverOverlap()`:
  the same missing signed-in/completed-onboarding reason.

Neither live test reached its later camera/Reduce Motion checks.
Separately, the new camera fixture test passed and its console confirms
the actual “No camera here” fallback was reached. The original live camera
test ends after tapping Keep; even a future pass alone is not server
upload/commit proof. Its documentation now states that boundary.

Artifacts:

- Build:
  `/var/folders/tf/xywb0t3n2_39nr0h62r1zqlw0000gn/T/ActionArtifacts/default/BuildProject/BuildProject-Log-20261027-092839.txt`
- Targeted summary:
  `/var/folders/tf/xywb0t3n2_39nr0h62r1zqlw0000gn/T/ActionArtifacts/default/RunSomeTests/2D289C8E-1ABB-4C4E-A1C0-255736B7F4F3.txt`
- Full summary:
  `/var/folders/tf/xywb0t3n2_39nr0h62r1zqlw0000gn/T/ActionArtifacts/default/RunAllTests/AF3A9DFD-0B68-4AD2-AE42-E07CDCD69BD9.txt`
- Full console:
  `/var/folders/tf/xywb0t3n2_39nr0h62r1zqlw0000gn/T/ActionArtifacts/default/RunAllTests/test-console-log-2026-10-27T09-30-26-04-00.txt`
- Result bundle:
  `/var/folders/tf/xywb0t3n2_39nr0h62r1zqlw0000gn/T/ActionArtifacts/default/RunAllTests/Test-CultureAtlas-2026.10.27_09-30-26--0400.xcresult`

The only source change after the full run was the camera-test documentation
comment clarifying that tapping Keep is not commit evidence.

## Setup needed for integrated signed-in native validation

1. Coordinator must supply/start an explicitly isolated API, database and
   storage environment with explicit `ENV_FILES`/isolated `DATABASE_URL`.
   Do not migrate an ambient database. No service or migration was started
   in this workstream, and no server-side change was identified or made.
2. Use the development file mail adapter (`IDENTITY_MAIL_DRIVER=file`,
   explicit isolated `IDENTITY_MAIL_FILE_DIR`), not external email auth.
   With the fixture flag **absent**, request a link inside the native app.
   Open that same one-use `cultureatlas://identity/callback#...` on the
   simulator before expiry. Keep the callback/token private.
3. This must exercise the actual email-start/complete PKCE+state+nonce
   validation and P-256 challenge/enroll flow, issuing a real session for
   that isolated backend. No synthetic fixture bearer can substitute.
4. Finish at least three real onboarding picks and Build my feed. Supply
   the catalog/worker/seed prerequisites. For motion validation there must
   be cards and Reduce Motion/VoiceOver must not pause the conveyor.
   Honestly labeled server examples/replay are not live-provider evidence.
5. iOS Debug defaults to `http://localhost:3000`. For a physical phone,
   configure the gitignored `Config/LocalAPI.xcconfig` with a reachable
   trusted HTTPS host/scheme and valid device signing, then use the same
   account/onboarding flow.
6. Android's store build is HTTPS-only. Supply a reachable trusted HTTPS
   API and matching callback/App Link host, including `assetlinks.json`
   appropriate to the installed signing certificate. Check gitignored
   `local.properties`: its `atlasApiHost` overrides `-PatlasApiHost`.
   Robolectric tests do not provision a real device session.
7. For physical Take photo → Keep, record encrypted local draft creation,
   upload progression, and the corresponding committed asset in that
   isolated account's library. The simulator fallback is not that proof.

Android reproduction environment retained from coordinator:
`JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home`,
`ANDROID_HOME=/opt/homebrew/share/android-commandlinetools`.
Relevant Gradle tasks: `:core:test`, `:app:testStoreDebugUnitTest`,
`:app:assembleStoreDebug`.

## Still unqualified / externally required

- **Live native auth/feed/upload integration:** no active API runtime or
  completed signed-in test account supplied; requires the isolated setup
  above. Local file-mail auth need not use paid/external credentials.
- **Physical phone capture/audio/route/interruptions/offline recovery:**
  requires an authorized, unlocked, correctly signed camera/microphone-capable
  phone and actual test execution. Xcode lists a named iPhone destination;
  that is not proof of an installed, signed-in, qualified device, nor a claim
  that no phone exists. No physical-device install/run was attempted.
- **Meta/glasses:** experimental SDK builds, supported registered glasses,
  Meta AI registration/permissions, tester-channel entitlement, real
  reconnect/camera/verified microphone route behavior remain unqualified.
  Public targets and fixture tests do not qualify the experimental adapter.
- **Hardware-backed keys and media:** real Secure Enclave/Android Keystore,
  codec/orientation, background transfers after force-quit/reboot and
  multi-account/multi-device isolation require physical evidence.
- **Providers:** live Qloo/style-role/VLM or song-recognition qualification
  requires permitted credentials/frameworks/hardware and explicit budgeted
  runs. No paid/provider call was made; no production quality conclusion.
- **Cloud/store:** APNs/FCM delivery, TestFlight/App Store/Play distribution,
  release signing/archives/AAB, privacy/store submissions and Meta release
  eligibility remain unperformed and require the owner's credentials and
  explicit approval. No account/auth, cloud action, push, deploy, commit,
  privilege change or unrelated process/worktree manipulation occurred.
