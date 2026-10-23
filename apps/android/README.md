# culture atlas for Android

Native capture client for the culture atlas `/v2` API, written independently
of the iOS app against the same contract fixtures. Broader native notes live in
[docs/native.md](../../docs/native.md).

Product name is **culture atlas**. Application id `com.cultureatlas.app`
(store) and `com.cultureatlas.app.experimental` (Meta DAT flavor).

## Status

| Module | State |
| --- | --- |
| `core/` | Pure Kotlin/JVM. `./gradlew :core:test` runs on a plain JDK 17+ with no Android SDK. Reads `fixtures/native-contract`. |
| `app/` store flavor | Source complete for camera, Music Mode, uploads, onboarding, ready notices. **Not assembled in this environment:** no `ANDROID_HOME` / Android SDK 35 and Google Maven is required for AGP, AndroidX, CameraX, WorkManager and Firebase. |
| `app/` experimental flavor | Meta Wearables DAT binding in `app/src/experimental/…/MetaDatBinding.kt` is **unverified** against the SDK. Do not treat it as qualified. |

Music Mode (amendment 2.3) is audio-only. Capture → Music opens a recorder that
never starts CameraX or a camera session (`AudioRecord` PCM WAV). It asks for
`RECORD_AUDIO` only and works if camera permission is denied (AUD01). Keep
saves an encrypted local draft and does **not** start analysis. Explore music
uploads WAV (`POST /v2/media/audio`) then `POST /v2/media/{id}/analysis` with
`contract_version: 2` and `music_match` only. Speech / ElevenLabs stay off.
Imported files use `POST /v2/uploads` with `kind: audio` if a reservation is
needed. The recognizer may return honest unavailable/partial until a music ID
provider exists.

## Build and test

JDK 17+ is required. This machine had no Android SDK; OpenJDK 17 is enough for
core tests.

```sh
cd apps/android
# Once, if gradlew is missing:
gradle wrapper --gradle-version 8.14.3

./gradlew :core:test                        # JVM only; no Android SDK
./gradlew :app:testStoreDebugUnitTest       # Robolectric: shell Back/transitions, screens; needs the SDK
```

`:app` unit tests render Compose on the JVM (Robolectric + Roborazzi). They check
system Back through the shell host, the Feed keeping its conveyor across tabs, the
card detail order, and the native result screen, and write review screenshots to
`app/build/outputs/roborazzi/` (evidence, not golden files).

`:app` is included only when `ANDROID_HOME`, `ANDROID_SDK_ROOT`, or
`local.properties` `sdk.dir` is set, so a missing SDK does not fail core tests.

When an Android SDK 35 install and Google Maven access exist:

```sh
export ANDROID_HOME=/path/to/sdk            # platforms;android-35 and build-tools
./gradlew :app:assembleStoreDebug           # public flavor, no Meta SDK
./gradlew :app:assembleExperimentalDebug    # Meta SDK flavor; confirm MetaDatBinding first
```

API host: `-PatlasApiHost=…` (default `app.cultureatlas.com` in
`gradle.properties`). No secrets belong in the APK; FCM options are empty unless
CI passes `-PatlasFcm*`. Experimental Meta app id / client token come from
`META_APP_ID` / `META_CLIENT_TOKEN` environment variables, never from source.

## Music Mode entry points

- Capture tab → **Music** (`MusicScreen`, `AudioCaptureController` PCM WAV)
- Library row for an audio draft → **Keep** (local, no analysis) then **Explore music**
  (`POST /v2/media/audio`, then analysis `music_match` only; poll
  `GET /v2/media/{id}/analysis/{analysisId}`)
- Music screen → **Upload an audio file** (WAV keep path; other types stay local
  until qualified)

`AudioCaptureController` has no CameraX / camera imports. Phone camera capture
stays on Capture → This camera. Store-flavor glasses entry still explains that
glasses capture is unavailable. A Bluetooth headset is labeled as a headset,
never as glasses, unless a verified glasses microphone route exists (this
store build does not claim one).

## Remaining Play / device gates

These are not done here and must not be inferred from source landing:

- Sideload `dist/app-store-debug.apk` (store debug, HTTPS-only) onto a physical
  Android phone; this Mac has `adb` but no device attached
- Play Console: paste `play/data-safety.json`, upload keystore (not the debug
  cert), and a Play AAB signed with that keystore
- `assetlinks.json` is served on the live API host for the debug cert fingerprint
- Physical AUD01–AUD03 (camera-off instrumentation, route loss, codecs)
- Experimental Meta DAT compile, license copy into the experimental APK, and
  Play / Meta tester-channel eligibility (`docs/native.md`)
- Server schema2 audio upload and analysis (`kind: audio`, `music_match`);
  Explore will keep the local recording if the host rejects audio
