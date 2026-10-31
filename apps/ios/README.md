# culture atlas for iOS

Native client for the culture atlas `/v2` API: photos, videos, and Music Mode
(audio-only capture). Build, test and release steps, and what still has to be
qualified on physical devices, are in [docs/native.md](../../docs/native.md).

**This machine can generate and compile the public app.** App Store submission,
TestFlight, and physical-device qualification have **not** happened. A missing
Apple Development Team does not block a simulator build: sign ad hoc
(`CODE_SIGN_IDENTITY=- CODE_SIGNING_ALLOWED=YES`). Do not use
`CODE_SIGNING_ALLOWED=NO`: it strips the Keychain entitlement, so sign-in
fails with errSecMissingEntitlement (-34018). Put `DEVELOPMENT_TEAM = …` in the untracked
`Config/Signing.xcconfig` only when you need a device or store-signed binary.

| Path | Contents |
| --- | --- |
| `AtlasCapture/` | Reusable capture module (no Meta SDK import): wire models, onboarding and ready-notice rules, email sign-in + PKCE, Secure Enclave enrollment, Keychain session store, encrypted drafts, multipart uploader, remote commands, phone camera, **Music Mode** (`MusicCapture`, `AudioRoutePolicy`; never `AVCaptureDevice` video) |
| `AtlasGlasses/` | Experimental Meta Wearables DAT adapter |
| `CultureAtlas/` | SwiftUI app: sign-in, Library, Capture source chooser (This camera / **Music** / Meta glasses / Upload), camera with Retake/Keep, Music recorder (screen 19) and audio detail (screen 20), glasses screens 04/05/09, taste onboarding (14–15, 18), ready notices (17) |
| `AtlasCaptureTests/` | XCTest suites driven by `fixtures/native-contract`, plus Music Mode route policy |
| `project.yml` | XcodeGen spec: `CultureAtlas` (public, no SDK) and `CultureAtlasExperimental` (SDK) targets |

The public `CultureAtlas` target never links the Meta SDK. Leave the experimental
target as documented in `project.yml` and `docs/native.md`.

## Generate, build, and test

Requirements: Xcode 16+, [XcodeGen](https://github.com/yonaskolb/XcodeGen),
iOS 17.2+ (simulator is enough to compile; camera/glasses/mic routes need a
device).

```sh
cd apps/ios
xcodegen generate

# Public app (no Meta SDK). Prefer a simulator when no Development Team is set:
xcodebuild -project CultureAtlas.xcodeproj -scheme CultureAtlas \
  -destination 'platform=iOS Simulator,name=iPhone 17' \
  CODE_SIGN_IDENTITY=- CODE_SIGNING_ALLOWED=YES \
  build

# Unit tests (same destination):
xcodebuild -project CultureAtlas.xcodeproj -scheme CultureAtlas \
  -destination 'platform=iOS Simulator,name=iPhone 17' \
  CODE_SIGN_IDENTITY=- CODE_SIGNING_ALLOWED=YES \
  test

# Experimental app (links the SDK). Needs a team for a device; not for the store:
xcodebuild -project CultureAtlas.xcodeproj -scheme CultureAtlasExperimental \
  -destination 'generic/platform=iOS' build
```

List simulators with `xcrun simctl list devices available`. If `iPhone 17` is
missing, substitute another iOS 17.2+ simulator name.

Signing: `Config/Signing.xcconfig` is gitignored. Without `DEVELOPMENT_TEAM`,
device installs and store archives fail; ad-hoc signed simulator builds
(`CODE_SIGN_IDENTITY=- CODE_SIGNING_ALLOWED=YES`) still work.

API host: `ATLAS_API_SCHEME` + `ATLAS_API_HOST` in `Config/Base.xcconfig`
(Release: `https://app.cultureatlas.com`). Debug builds use
`Config/Debug.xcconfig` (`http://localhost:3000`). Do not bake secrets into the
app. `META_APP_ID` and `CLIENT_TOKEN` are injected by CI for the experimental
target only. Copy `Config/Signing.xcconfig.example` to the gitignored
`Config/Signing.xcconfig` when you have a team.

`AtlasCaptureTests` reads `fixtures/native-contract` from the test bundle.

## Isolated simulator UI regressions

`CultureAtlasUITests` includes four deterministic fixture tests: floating-feed
identity/motion/non-overlap, camera-unavailable fallback, missing-session
sign-in, and incomplete-onboarding gating. They launch the **normal app shell**
with `-AtlasNativeUITestFixture` (Debug simulator builds only). Setup seeds a
synthetic session in a separate Keychain service, uses fresh temporary drafts
and separate transfer identifiers, and disables APNs registration. A private
ephemeral `URLSession` intercepts every API request; only known authenticated
fixture GETs succeed and all other requests fail without network fallback.
Cards are explicitly example results, not live Qloo/provider output.

`-AtlasNativeUITestSignedOut` omits that session;
`-AtlasNativeUITestOnboardingRequired` returns incomplete onboarding. Neither
can reach the real tabs. The fixture does not set the controller phase or
onboarding gate directly, and is compiled out of Release and device builds.
These tests need no API, mailbox, provider credentials or camera output. They
do **not** validate email proof, installation enrollment, uploads or production
recommendations.

The original live feed and physical-camera tests remain separate. Both still
skip without a signed-in account with finished onboarding; the camera test
has not reached its hardware check in that state. For integrated validation,
provide an explicitly isolated API/database/storage environment, use its
development file mailbox (`IDENTITY_MAIL_DRIVER=file`,
`IDENTITY_MAIL_FILE_DIR`), and sign in through the app's email/PKCE callback and
enrollment flow. Complete the real taste questionnaire and obtain feed cards.
Do not reuse fixture credentials or bypass onboarding. The iOS simulator can
then test a live feed, but actual Take photo → Keep needs a camera-capable,
signed phone and upload/commit evidence. No API runtime was started for the
fixture tests.

## Style reading (experimental)

Photo results show the server's **style reading** (aesthetic chips, measured
palette, era, materials, construction, details, mood) and the rails it drives
(**More like this** per subject, then Wear / Play / Watch / Eat), per
`prp/2026-10-23-style-analysis/design.md` section F. The app loads
`GET /v1/captures/{id}` and polls every 1.5 s until every section and rail is
terminal (`AtlasCapture/Style/CaptureStyleViewModel.swift`). Every claim's text
is the server's `display` string; an uncertain claim without one is dropped,
never shown bare. Readings from unqualified roles carry the `Experimental`
badge and note (analysis screen, reading header, capture button, rail caption,
"Why this").

Fixture preview (Debug builds only), for screenshots without a server:

```sh
SIMCTL_CHILD_ATLAS_STYLE_FIXTURE_IMAGE="$PWD/../web/public/samples/outfit.jpg" \
  xcrun simctl launch <device> com.aomg.cultureatlas -AtlasStyleFixture [-AtlasStyleFixtureHighlight]
```

## Music Mode

Capture → **Music** (screen 19). Audio-only: camera stays off, no
`AVCaptureSession` / `AVCaptureDevice` video on this path. Microphone permission
is requested on Record. If camera permission is denied, Music Mode still works
(AUD01).

1. Choose a microphone. Glasses appear only when an *input* port is verified
   (name + HFP/LE). Bluetooth playback alone is not enough. If glasses cannot be
   verified, the screen says **Glasses microphone unavailable** and offers this
   phone. It never silent-falls-back while labelling the take as glasses.
2. Record → Stop (120 s cap). Elapsed time and Record/Stop are written in words,
   not colour alone. Playback never autoplays with sound.
3. **Keep** stores an encrypted local draft. **Explore music** (screen 20)
   authorizes upload and `music_match` analysis. Speech stays off.

## On-device song recognition (ShazamKit, optional)

When the recording finishes, the app tries to recognize the song on-device in
the background (`AtlasCapture/Audio/ShazamSongRecognizer.swift`). A recognized
song becomes the `client_recognition` hint on the analyze request — the artist
name and title the vendor returned, nothing else: no audio, transcript, or
confidence leaves the phone. The hint never decides the match: the server
searches its own catalog for the recognized artist and only a catalog result
resolves (the same rule as the fingerprint and transcript tiers). When it
resolves, the paid transcription tier is skipped; when it does not, everything
behaves exactly as before. Android and the web do not send the hint; the field
is optional on the contract.

**The repo builds and tests without the framework.** Apple distributes ShazamKit
behind developer sign-in, so the xcframework is never vendored. All ShazamKit
code sits behind `#if canImport(SHShazamKit)`
(`SongRecognizerFactory.isShazamKitAvailable` reports which build you have);
CI and simulator runs compile the unavailable path, and
`ClientRecognizedSongTests` covers the wire shape and the honest no-hint
answer.

To enable it in your own build:

1. Download ShazamKit from developer.apple.com (Apple ID required).
2. Drag `ShazamKit.xcframework` into the Xcode project → the **AtlasCapture**
   target (which owns the recognizer) → *Frameworks, Libraries, and Embedded
   Content* → **Embed & Sign**.
3. Re-run `xcodegen generate` **after** adding it to `project.yml`
   (`dependencies: - framework: path/to/ShazamKit.xcframework`) so the checked-in
   project stays reproducible; `canImport(SHShazamKit)` then compiles the
   recognizer in.

## Remaining physical-device and store gates

None of these have been run. Do not treat a simulator compile as App Store
readiness. See `docs/native.md` for the full tables (DEV-01..03, MED-04/05,
AUD01–AUD13, privacy labels).

| Gate | State |
| --- | --- |
| Apple Development Team / device signing | Untracked `Signing.xcconfig`; may be absent |
| Simulator build/tests of `CultureAtlas` | Xcode MCP, iPhone 17 / iOS 27: **120 passed, 2 skipped, 0 failed / 122** (116 unit + 4 fixture UI passes). Both original live UI tests skipped for missing signed-in/completed-onboarding state, not hardware. No store/device qualification. |
| Physical phone mic, interruptions, route loss | Not qualified |
| Verified glasses microphone route (not DAT camera) | Not qualified; public build has no Meta SDK |
| App Store / TestFlight submission | Has not happened |
| Privacy nutrition labels (camera, microphone, photos, email) | Not filed |
| Public binary contains no Meta SDK (`otool -L`) | Must be recorded per release |
| Experimental TestFlight + Meta tester channel | Separate target; blocked on Meta/MFi gates in `docs/native.md` |
