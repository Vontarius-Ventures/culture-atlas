# Hands-on test guide: audio, phone and Meta glasses capture

For the owner, testing by hand. This guide covers three capture paths. For each one it says how to run it, what correct analysis, storage and suggestions look like, and where to look when something is wrong.

1. **Audio**: Music Mode on the web and the phones.
2. **Phone**: iPhone first (photo, video, audio), then Android if a device is attached.
3. **Meta glasses**: the experimental builds only.

Email sign-up (Resend) is out of scope here. Every step below signs in through the **file mailbox**.

State at the time of writing:

- **Branch:** `factory3/integration`.
- **Stack:** the integration smoke ran on `next dev` with live Qloo, Concentrate and ElevenLabs keys.
- **Feed:** onboarding produced a real Qloo feed.
- **Photo:** Explore read the photo correctly ("Low table beside grid window", resembles shoji screen and chabudai) in about 13 s, with Qloo suggestions.
- **Music Mode:** a spoken "That was Dreams by Fleetwood Mac" matched Fleetwood Mac with six related artists. "Stevie Nicks" then appeared as the second feed card, with the reason "Because you heard Fleetwood Mac."

---

## 0. Run the local stack with live keys (shared by every section)

### 0.1 One-time setup

```sh
cd "/Users/vontariusfalls/culture-atlas-worktrees/factory3-integration"   # or your checkout of this branch
pnpm install --frozen-lockfile
createdb -h localhost -U culture_atlas ca_handtest    # password culture_atlas
mkdir -p ~/ca-handtest/{objects,mail}
```

Create `~/ca-handtest/env.sh`. It layers the secrets file over the repo `.env` and then sets the local overrides. Never commit it and never paste its values anywhere.

```sh
set -a
. "/Users/vontariusfalls/culture atlas/.env"
. /Users/vontariusfalls/culture-atlas-worktrees/.secrets.env
NODE_ENV=development
PORT=3700
# Must be the exact origin the PHONE uses (see 0.3). Sign-in links and signed
# media URLs are built from it. Keep http://localhost:3700 for web-only tests.
APP_BASE_URL=http://localhost:3700
DATABASE_URL=postgres://culture_atlas:culture_atlas@localhost:5432/ca_handtest
STORAGE_DRIVER=local
STORAGE_LOCAL_DIR=$HOME/ca-handtest/objects
IDENTITY_MAIL_DRIVER=file
IDENTITY_MAIL_FILE_DIR=$HOME/ca-handtest/mail
CONCENTRATE_PROFILE_FILE=$PWD/fixtures/concentrate/profiles.json
CONCENTRATE_QUALIFICATION_DIR=$PWD/fixtures/concentrate
# Photo/video analysis: the vision roles are not qualified yet. This demo
# override lets them run, labelled "Experimental reading". It is refused when
# NODE_ENV=production and Compose never passes it.
CONCENTRATE_DEMO_ALLOW_ROLES=vision_photo,vision_video_frame,vision_photo_enrich
# Optional: lets your account open /inspector/<jobId> (fill in after first sign-in).
DEMO_INSPECTOR_ACCOUNT_IDS=
NEXT_TELEMETRY_DISABLED=1
set +a
```

Then migrate. Running it twice is safe.

```sh
. ~/ca-handtest/env.sh && pnpm db:migrate
```

### 0.2 Start the three processes (three terminal tabs, from the repo root)

```sh
. ~/ca-handtest/env.sh && (cd apps/web && pnpm exec next dev --port 3700 -H 0.0.0.0)
. ~/ca-handtest/env.sh && pnpm worker          # jobs: taste seed, feed waves, analysis, Music Mode
. ~/ca-handtest/env.sh && pnpm media-worker    # needs ffmpeg/ffprobe; verifies uploads, makes frames/posters
```

What healthy startup looks like:

- **Worker:** prints `vision_photo: 'qualified [experimental demo override]'` (and the same for `vision_video_frame` and `vision_photo_enrich`). If it prints `not_qualified`, the override env did not load.
- **Media worker:** ends with `started; video qualified`.
- **Why `next dev`:** a production build (`next start`) refuses local storage and the file mailbox by design (`docs/v2-real-stack.md`). Use `next dev` locally.

### 0.3 Make a phone reach the stack

Pick one option and put the same origin in `APP_BASE_URL`. After changing it, restart all three processes.

| Option | `APP_BASE_URL` | Works for | Notes |
| --- | --- | --- | --- |
| Bonjour name on the same Wi-Fi | `http://Mac-mini.local:3700` (`scutil --get LocalHostName` + `.local`) | iPhone | The iOS app allows plain HTTP to local network names (`NSAllowsLocalNetworking`). Allow incoming connections for `node` if macOS asks. |
| LAN IP | `http://192.168.x.y:3700` (`ipconfig getifaddr en0`) | iPhone, usually | Use it if `.local` does not resolve. |
| HTTPS tunnel | `https://<random>.trycloudflare.com` from `cloudflared tunnel --url http://localhost:3700` | iPhone **and Android** | **Required for Android**: the Android app only speaks HTTPS to `atlasApiHost`. The URL changes every time the tunnel restarts. |

Check from the phone's browser: `<APP_BASE_URL>/` should show the culture atlas feed shell.

### 0.4 Sign in (file mailbox)

1. Start sign-in in the app (or at `<APP_BASE_URL>/identity` on the web).
2. Read the newest mail file:

   ```sh
   ls -t ~/ca-handtest/mail | head -1 | xargs -I{} grep -o '[a-z]*://[^" ]*' ~/ca-handtest/mail/{}
   ```

   - **Web:** the link is `<APP_BASE_URL>/identity/callback#…`. Open it in the same browser.
   - **iPhone:** the link is `cultureatlas://identity/callback#…`. Get it onto the phone in one of two ways:
     - Send it from the Mac with `xcrun devicectl device process launch --device <UDID> --payload-url '<link>' com.aomg.cultureatlas`. Get the UDID from `xcrun devicectl list devices`; your iPhone 16 is listed there.
     - Or paste it into a note on the phone and tap it.
   - **Android:** the link is `https://<tunnel host>/identity/callback#…`. App Links are not verified on a tunnel, so open it inside the app with `adb shell am start -a android.intent.action.VIEW -d '<link>' com.cultureatlas.app`.
3. A new account goes through onboarding: pick 3+ tiles, then chips, then exclusions, then "Build my feed". The building screen should show Wear, Play, Watch and Eat flipping to Ready within about 10 s.

### 0.5 Where to look (all paths)

- **Logs:** the three terminal tabs. The worker logs every job stage.
- **Inspector:** `<APP_BASE_URL>/inspector/<jobId>`. It shows the stages, model and Qloo calls for one job. It needs your account id in `DEMO_INSPECTOR_ACCOUNT_IDS`; get the id with `select account_id, email from account_emails;`.
- **Database:** `psql postgres://culture_atlas:culture_atlas@localhost:5432/ca_handtest`. The useful tables are listed in each section.
- **Readiness:** `GET <APP_BASE_URL>/v2/capabilities` while signed in. `availability.analysis`, `availability.music_match` and `availability.meta_glasses` say what the server will allow.

---

## A. Audio capture: Music Mode

### What it does

You record (or pick a WAV), then **Keep**, which stores it privately in your library. Nothing is analyzed until you press **Explore music**. The worker then works through these steps:

1. **Read the recording** from capture-v2 storage.
2. **Fingerprint:** no licensed fingerprint vendor is configured, so this reports `not_configured`.
3. **Transcribe** the speech with ElevenLabs.
4. **Extract artist names** from phrases like "by X", DJ phrases and capitalized names.
5. **Search Qloo.** A Qloo artist only counts if its **full name was heard**. Among same-named artists the most popular wins, and two different heard names stay ambiguous.
6. **Show the match:** "It sounds like {artist}", with the Qloo image, the song and album when known, and up to 6 related Qloo artists.
7. **Save and suggest:** the artist becomes a library item, and a related discovery starts. Its cards join the feed as "Because you heard {artist}."

### Test script (web first: fastest loop)

1. Open `<APP_BASE_URL>/capture/music` on a laptop or phone browser.
2. **Spoken test.** Say clearly: "That was Feeling Good by Nina Simone." Record it with "Turn on microphone", or make a file with:

   ```sh
   say -o /tmp/nina.wav --data-format=LEI16@16000 "That was Feeling Good by Nina Simone."
   ```

   Then pick it with the file chooser.
3. Check the review screen. It should show the real length (for example "0:02 recording").
4. Press **Keep**. "Saved to your library." should appear. Then press **Explore music**.
5. **Expected result** in about 5-10 s:
   - an animated "Listening for a match…";
   - the match card "It sounds like Nina Simone" with a Qloo photo;
   - a swipeable "If you like Nina Simone" row of up to 6 artists, for example Sarah Vaughan, Dinah Washington and Ella Fitzgerald;
   - the main button turns into **See your feed**.
6. Tap **See your feed**. Within about 10 s, related cards (Play and sometimes Watch, Wear or Eat) appear near the top. Open one: its reason reads "Because you heard Nina Simone."
7. **Negative tests.** In every case below nothing may be invented:
   - **Speech with no artist** ("buy milk and eggs"): "No reliable match. Nothing was invented: culture atlas only shows catalog ids Qloo returned."
   - **A real song with no spoken name:** also "no match". This is expected, because fingerprinting is not configured (see the limits below).
   - **A non-WAV file:** a clear "Use a WAV file" message.
8. **On the iPhone** (after section B is set up): Capture, then **Music**, then Record, Stop, **Keep**, then **Explore music**. You should get the same match card and feed result as on the web; on iOS the result opens in the in-app result sheet.
9. **On Android:** Capture, then Music. You should get the same result on the native result screen.

### What correct storage looks like (SQL)

```sql
-- The recording and its analysis
select id, kind, status, byte_size, created_at from media_assets where kind='audio' order by created_at desc limit 3;
select state, error_code from audio_analysis_requests order by created_at desc limit 3;
select component, state, reason from audio_analysis_components order by updated_at desc limit 3;
-- What was heard and what Qloo id it resolved to
select status, name, qloo_entity_id from audio_entity_resolutions order by created_at desc limit 3;
select artist_name, artist_catalog_id, match_status from recognized_recordings order by created_at desc limit 3;
-- Suggestions it produced
select id, status, source, source_label from discovery_jobs where source='music_mode' order by created_at desc;
select r.category, di.title, r.display_reason from recommendations r
  join discovery_items di on di.id=r.discovery_item_id
  join discovery_jobs j on j.id=r.discovery_job_id where j.source='music_mode' order by r.rank;
```

The recording bytes live under `$STORAGE_LOCAL_DIR/capture-v2/…`.

### When it's wrong

| Symptom | Look at | Likely cause |
| --- | --- | --- |
| "We couldn't read this recording" / `storage_unavailable` | worker log; `ls $STORAGE_LOCAL_DIR/capture-v2` | The worker was started with a different `STORAGE_LOCAL_DIR` than the web server. Use the same `env.sh` for both. |
| Always "no match", transcript empty | `audio_analysis_components.reason` (`transcript_unavailable`) | `ELEVENLABS_API_KEY` missing or out of credit |
| `ambiguous_artist` | `audio_entity_resolutions.status='ambiguous'` | Two different artist names were heard in the same clip. Say only one. |
| `no_matching_artist` | worker log `resolve-qloo` stage | The heard name didn't match a Qloo artist's full name (for example "Fleetwood" alone). |
| Match shown but no feed cards | `jobs` where `type='discover_related'`; worker log | Qloo budget or timeout. The match still stands. |
| Explore button missing | `/v2/capabilities` → `availability.music_match` | Off unless both the Qloo and ElevenLabs keys are present |

### Known limits

- **No fingerprinting:** there is no licensed fingerprint vendor, so a song with no spoken artist name ends in "no match" by design.
- **Search phrases:** whole sentences are never sent to Qloo. Only extracted name phrases are.
- **Library:** audio recordings do not appear in the server library grid on iOS or Android, because the server lists photos and videos only. They show as local rows.
- **Simulator mic:** iOS microphone recording fails on the simulator. The real-phone behaviour is unverified, and the iOS app logs the recorder's reason.

---

## B. Phone capture (iPhone first, then Android)

### B.1 Install the debug build on your iPhone (team U9XG3X374H)

The Debug configuration already uses bundle id `com.aomg.cultureatlas`, because the store id is not available to this team.

```sh
cd apps/ios
cp Config/Signing.xcconfig.example Config/Signing.xcconfig
#   edit: DEVELOPMENT_TEAM = U9XG3X374H
cat > Config/LocalAPI.xcconfig <<'EOF'
ATLAS_API_SCHEME = http:
ATLAS_API_HOST = Mac-mini.local:3700
EOF
# For a tunnel instead:
#   ATLAS_API_SCHEME = https:
#   ATLAS_API_HOST = <random>.trycloudflare.com
xcodegen generate
open CultureAtlas.xcodeproj
```

Both `Signing.xcconfig` and `LocalAPI.xcconfig` are gitignored. Don't commit them.

In Xcode:

1. Choose the **CultureAtlas** scheme, the **Debug** configuration and your iPhone as destination, then Run.
2. The first time, on the phone: Settings → General → VPN & Device Management → trust the developer certificate.
3. Turn on Settings → Privacy & Security → Developer Mode.

Check that `ATLAS_API_HOST` matches `APP_BASE_URL` (0.3). Then sign in (0.4).

### B.2 Test script

1. **Feed:** the cards drift slowly. Drag to scrub, and flick to coast.
   - The refresh button and a long pull ("Release for fresh picks") both send `GET /v1/discoveries?…refresh=true`, visible in the web log.
   - The feed never empties, and new cards arrive within about a minute.
2. **Card:** tap a card and it zooms into the detail view. Check that:
   - the hero is a full-width 4:5 picture;
   - the serif title appears once;
   - the reason names your actual picks;
   - the Similar rail runs edge to edge.

   Tap "Add to board". You should get a success haptic and the banner "Added to {board} · View".
3. **Photo:** Capture → Camera → shoot → **Keep**. The upload runs while the app is open. Then press **Explore**.
   - About 10-25 s later, the in-app result sheet shows what the photo resembles, then Eat, Wear, Play and Watch suggestions.
   - Library shows the photo in the server grid.
   - The notification or toast opens the same sheet, not Safari.
4. **Video:** record 5-10 s, then Keep. The media worker prepares about 6 frames, a poster and a playback stream (about 2 s for 6 s of 720p).
   - Open it from Library: playback works.
   - Explore analyzes the frames, which takes longer than a photo.
5. **Audio:** follow the Music Mode steps in section A, on the phone.
6. **Offline:** turn on Airplane mode, capture, Keep. The draft stays local. Turn Airplane mode off: the upload resumes with no duplicate.

### B.3 Android (only if a device is attached: `adb devices`)

The public flavor is `store`. It requires the HTTPS tunnel from 0.3.

```sh
cd apps/android
echo "atlasApiHost=<random>.trycloudflare.com" >> local.properties   # gitignored, host only, no scheme
./gradlew :app:assembleStoreDebug
adb install -r app/build/outputs/apk/store/debug/app-store-debug.apk
```

Sign in with the `adb shell am start …` command from 0.4, then run the same script as B.2.

Android specifics:

- **Back:** system Back walks the Similar history and returns to Feed before the app closes.
- **Tabs:** switching tabs keeps the same feed cards.
- **Results:** the result screen is native, and "Open the full page on the web" is only a secondary link.

### What correct storage and suggestions look like (SQL)

```sql
select id, kind, source, status, byte_size from media_assets order by created_at desc limit 5;   -- source: phone_camera / browser_camera / upload / meta_glasses / browser_microphone
select kind, state, error_code from capture_work order by created_at desc limit 5;              -- verify_upload / prepare_media / analyze_media
select kind, byte_size, duration_ms from media_derivatives where asset_id='<id>';               -- poster, frames, playback
select state, error_code, started_by_installation_id from media_analysis_requests order by created_at desc limit 3;
select state, error_code from media_analysis_frames where analysis_id='<analysis id>';
select a.title, a.interpretation from analyses a join captures c on c.active_analysis_id=a.id order by c.created_at desc limit 3;  -- compiled reading
select r.category, di.title, r.display_reason from recommendations r join discovery_items di on di.id=r.discovery_item_id
 where r.analysis_id=(select active_analysis_id from captures order by created_at desc limit 1) order by r.category, r.rank;
select platform, app_version, capabilities, last_seen_at from mobile_installations;           -- the phone's heartbeat
```

Spend control: every model call is a row in `inference_attempts`. Check it if Explore says "temporarily unavailable".

### When it's wrong

| Symptom | Where | Likely cause |
| --- | --- | --- |
| Sign-in link opens nothing on the phone | the mail file's link scheme | iPhone needs `cultureatlas://…`. Use the `devicectl --payload-url` command. On Android, use `adb shell am start`. |
| "This phone couldn't store your sign-in…" | Xcode console | The build was unsigned or ad-hoc. Install a Debug build signed with team U9XG3X374H. |
| Upload stuck at 0% | web log for `PUT …/parts`; `upload_sessions` | `APP_BASE_URL` is not reachable from the phone. Signed part URLs are built from it. |
| "Exploration is not available on this server yet." | worker startup lines; `/v2/capabilities` | `CONCENTRATE_DEMO_ALLOW_ROLES` is missing, or `NODE_ENV=production` |
| Photo found but few or odd suggestions | `/inspector/<jobId>`; `job_stages` (`recommend:*` with `no_anchors`, then `enrich:recommend:*`) | The first pass found no Qloo anchors, so the enrichment pass filled them. Some brand picks are weak; this is a known open item. |
| Video never "ready" | media-worker log; `capture_work` `kind='prepare_media'` | ffmpeg/ffprobe missing, or an unsupported codec |

### Known limits

- **Photo reading is experimental:** the vision roles are not qualified (the tune split failed its gates), so photo and video analysis only run through the demo override and are labelled "Experimental reading".
- **Android photo suggestions:** `GET /v1/captures/{id}` is not yet in the phone allow-list (`packages/domain/src/authz/native-owner.ts`). The Android result screen therefore falls back to the `/v2` summary for photos.
- **Push:** there are no APNs/FCM credentials locally, so ready notices appear only while the app is open.
- **iOS reference wording:** `DiscoverView.swift` still has the inverted "Resembles X" wording that Android fixed.

---

## C. Meta Ray-Ban glasses capture

Glasses only work in the **experimental** builds, and only when the server allows them. The public `CultureAtlas` scheme and the Android `store` flavor never contain the Meta SDK. Their Glasses entry explains that glasses are unavailable.

### C.1 Server: turn the glasses gate on for your phone (add to `env.sh`, restart)

```sh
META_GLASSES_QUALIFIED_BUILDS='ios@1.0.0 (1)'   # exactly "<platform>@<CFBundleShortVersionString> (<CFBundleVersion>)" the app reports
META_GLASSES_ENTITLED_PLATFORMS=ios              # ios,android for both
META_GLASSES_ROLLOUT=all                         # or allowlist + META_GLASSES_ROLLOUT_ACCOUNT_IDS=<your account id>
META_GLASSES_AUDIO_QUALIFIED=true                # only if you also test the glasses microphone
```

The gate reads the phone's capability keys:

- **SDK build:** `meta_glasses_sdk` (the apps' key) proves an SDK build.
- **Supported OS:** assumed true unless the app sends `false`.
- **Heartbeats** merge keys rather than replacing them.

Check `select app_version, capabilities from mobile_installations;`. It should contain `meta_glasses_sdk: true`. Then check `/v2/capabilities` → `availability.meta_glasses.available: true`.

### C.2 Build the experimental iPhone app

1. **Meta registration:** the Meta Wearables Device Access Toolkit package is fetched by SPM from `github.com/facebook/meta-wearables-dat-ios`. Either:
   - register the app in the Meta developer portal and set `META_APP_ID` and `CLIENT_TOKEN`; or
   - leave them empty and turn on **Developer Mode** for the glasses in the Meta AI app.
2. **Bundle id:** `com.cultureatlas.app.experimental` is not available to team U9XG3X374H (same as the store id). Override it at build time with an id your team owns:

   ```sh
   cd apps/ios && xcodegen generate
   xcodebuild -project CultureAtlas.xcodeproj -scheme CultureAtlasExperimental -configuration Debug \
     -destination 'platform=iOS,id=<UDID>' -allowProvisioningUpdates \
     DEVELOPMENT_TEAM=U9XG3X374H PRODUCT_BUNDLE_IDENTIFIER=com.aomg.cultureatlas.experimental \
     META_APP_ID=<id or empty> CLIENT_TOKEN=<token or empty> build
   ```

   Then install from Xcode, or run `xcrun devicectl device install app --device <UDID> <path to .app>`.
3. **Info.plist:** the experimental app's `Info-Experimental.plist` already contains:
   - the `MWDAT` keys and the `cultureatlas-glasses://` callback;
   - the Bluetooth usage strings;
   - `UISupportedExternalAccessoryProtocols`.

   Do not remove them.

### C.3 Test script

1. **Pair:** pair the glasses with the phone in the **Meta AI** app and grant camera permission to culture atlas when asked.
2. **Check availability:** in culture atlas, open Capture → **Meta glasses**. It should say Ready, not "Not available yet". The phone reports the wearable with `POST /v2/device/wearables`; check it with `select * from wearable_connections;`.
3. **Photo:** take one with the glasses, from the app's shutter or the glasses' capture button while the session is open. It uploads as a normal photo with `source='meta_glasses'`. Explore it as in B.2.
4. **Video:** record a short clip from the glasses. It should play from Library after preparation.
5. **Audio (optional):** in Music, choose the glasses microphone. It appears only when an input port is verified (name + HFP/LE). If it can't be verified, the screen says **Glasses microphone unavailable** and offers the phone mic. A take is never labelled "glasses" when it fell back to the phone.
6. **Reconnect:** put the glasses to sleep, toggle Bluetooth and relaunch the app. Capture should recover without a sign-in.

### What correct looks like

- `media_assets.source = 'meta_glasses'` for glasses captures.
- An analysis and suggestions exactly as for phone photos.
- **Before** the env is set: `/v2/capabilities` reports glasses unavailable (`build_unsupported` / `device_unsupported`), and a glasses upload gets `403 scope_denied`. That refusal is correct, not a bug.

### When it's wrong

| Symptom | Where | Likely cause |
| --- | --- | --- |
| Still "Not available yet" | `/v2/capabilities` reasons; `mobile_installations.capabilities` | The `META_GLASSES_QUALIFIED_BUILDS` string doesn't exactly match the app version, the public scheme was installed, or the server wasn't restarted |
| SDK registration callback never returns | Xcode console (MWDAT) | `cultureatlas-glasses://` scheme or MetaAppID mismatch, or Developer Mode is off in Meta AI |
| `403 scope_denied` on upload | web log | The gate is closed for this installation (see the first row) |

### Known limits

- **Not run end to end:** a glasses capture has never been run here, because no glasses were attached. The server side was proven with a simulated client using a real P-256 enrollment, the apps' capability key and the operator env. The physical-device gates in `docs/native.md` (DEV-01..03) remain open.
- **Android experimental flavor:** it needs a `GITHUB_TOKEN` with `read:packages` to fetch the Meta SDK. It has not been built here.
- **Distribution:** TestFlight and the Meta release channel are blocked on the Meta/MFi gates listed in `docs/native.md`.

---

## Cleanup after a session

```sh
# stop the three processes with Ctrl-C in their tabs, then if you want a clean slate:
dropdb -h localhost -U culture_atlas ca_handtest && rm -rf ~/ca-handtest/objects ~/ca-handtest/mail
```
