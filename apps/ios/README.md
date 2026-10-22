# culture atlas for iOS

Native client for the culture atlas `/v2` API: photos, videos, and Music Mode
(audio-only capture). Build, test and release steps, and what still has to be
qualified on physical devices, are in [docs/native.md](../../docs/native.md).

**This machine can generate and compile the public app.** App Store submission,
TestFlight, and physical-device qualification have **not** happened. A missing
Apple Development Team does not block a simulator build
(`CODE_SIGNING_ALLOWED=NO`). Put `DEVELOPMENT_TEAM = …` in the untracked
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
  CODE_SIGNING_ALLOWED=NO \
  build

# Unit tests (same destination):
xcodebuild -project CultureAtlas.xcodeproj -scheme CultureAtlas \
  -destination 'platform=iOS Simulator,name=iPhone 17' \
  CODE_SIGNING_ALLOWED=NO \
  test

# Experimental app (links the SDK). Needs a team for a device; not for the store:
xcodebuild -project CultureAtlas.xcodeproj -scheme CultureAtlasExperimental \
  -destination 'generic/platform=iOS' build
```

List simulators with `xcrun simctl list devices available`. If `iPhone 17` is
missing, substitute another iOS 17.2+ simulator name.

Signing: `Config/Signing.xcconfig` is gitignored. Without `DEVELOPMENT_TEAM`,
device installs and store archives fail; simulator builds with
`CODE_SIGNING_ALLOWED=NO` still work.

API host: `ATLAS_API_SCHEME` + `ATLAS_API_HOST` in `Config/Base.xcconfig`
(Release: `https://app.cultureatlas.com`). Debug builds use
`Config/Debug.xcconfig` (`http://localhost:3000`). Do not bake secrets into the
app. `META_APP_ID` and `CLIENT_TOKEN` are injected by CI for the experimental
target only. Copy `Config/Signing.xcconfig.example` to the gitignored
`Config/Signing.xcconfig` when you have a team.

`AtlasCaptureTests` reads `fixtures/native-contract` from the test bundle.

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

## Remaining physical-device and store gates

None of these have been run. Do not treat a simulator compile as App Store
readiness. See `docs/native.md` for the full tables (DEV-01..03, MED-04/05,
AUD01–AUD13, privacy labels).

| Gate | State |
| --- | --- |
| Apple Development Team / device signing | Untracked `Signing.xcconfig`; may be absent |
| Simulator compile of `CultureAtlas` | Intended on this machine after `xcodegen generate` |
| Physical phone mic, interruptions, route loss | Not qualified |
| Verified glasses microphone route (not DAT camera) | Not qualified; public build has no Meta SDK |
| App Store / TestFlight submission | Has not happened |
| Privacy nutrition labels (camera, microphone, photos, email) | Not filed |
| Public binary contains no Meta SDK (`otool -L`) | Must be recorded per release |
| Experimental TestFlight + Meta tester channel | Separate target; blocked on Meta/MFi gates in `docs/native.md` |
