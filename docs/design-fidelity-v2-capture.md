# Design fidelity: capture platform v2, references 01–09

This compares the running app with the nine capture references in `specs/capture-platform-v2/design/mockups/`. The comparison applies the SCREEN-CONTRACT visual review corrections, `design/copy.json` and `design/tokens.css`.

Unlike the mock-based screenshots in `apps/web/e2e/screenshots/v2/`, these come from the **real stack** and a **production build**: `next build` then `next start`, the job worker, the media worker (ffmpeg) and PostgreSQL 16. The app's own code and API are not mocked. **The phone and the glasses are.** No phone app ran and no Meta glasses were paired: a scripted Playwright HTTP client stands in for the Android app, declares Meta wearables SDK capabilities it does not have, reports itself `ready`, registers a wearable named `fidelity-glasses` that does not exist, and uploads the project's illustrations with source `meta_glasses`. Every glasses-related pixel in 01, 05 and 08 (the "Meta glasses" source labels and the "● Ready to capture" state) is therefore produced by that script, not by real hardware. Mock SDK runs do not qualify a release (BUILD-AND-ACCEPTANCE DEV-01); the glasses path still needs a physical device run.

Final screenshots are in `apps/web/e2e/screenshots/fidelity/v2-capture/`. Each one is named `<reference>-<width>.png`, where the width is `desktop` (1440 px), `mobile` (390 px, device scale 2) or `narrow` (320 px, device scale 2). Screen 06 is captured viewport-only below 768 px. Each reference was opened next to the screenshot at its own viewport (1440 or 390) and checked for:

- layout grid, column counts and spacing;
- type size, weight and family;
- colours against the tokens;
- radius, icons, button placement and labels;
- copy, image framing and navigation.

The CSS was then corrected and the screens captured again, until only the differences listed below remained. Every width is checked for horizontal scroll. The 320 px captures are not compared to a reference: they show that everything wraps without scrolling.

## How the data was made

`apps/web/e2e/real/v2-fidelity.spec.ts` seeds the library with real requests:

1. A person signs up in the browser with an email link.
2. A scripted stand-in for the Android app (a Playwright HTTP client, not the app) enrolls with a P-256 proof. This is the same HTTP client the native contract fixtures describe.
3. The script registers a fictional wearable (`sdk_reference: fidelity-glasses`; no glasses exist or were paired) and uploads ten items with sources `meta_glasses`, `phone_camera` and `upload`. The `meta_glasses` items are illustrations the script labels as glasses captures.
4. The media worker verifies and prepares every item. Video posters, frames and durations are real ffmpeg output.
5. The owner names each item through `PATCH /v2/media/{id}`, using the titles the references show.

The upload states in 01, 06 and 08 are real client states. They are produced with Playwright routing on the storage `PUT` requests:

- **In flight** ("Uploading 42%"): a held second part, so the transfer stays open.
- **Paused** ("Connection lost. Your file is still selected."): an aborted part, which the client treats as a lost connection.
- **Preparing video**: the media worker really is preparing a 28-second clip.

The screenshot run never alters the data the app returns.

**Images.** The pictures are the project's own illustrations, never pixels from the mockups:

- The existing samples in `apps/web/public/samples/`.
- New scenes drawn by `fixtures/images/generate-capture-illustrations.ts` in `fixtures/capture-v2/`: armchair corner, olive jacket, coast, brick street, courtyard, café interior, lamps, window table and alley.
- New heroes for 02 and 04 in `apps/web/public/capture/`.

The old 02 and 04 heroes were crops of the reference images. They were shipped in the UI, and they have been replaced. Licenses are in `fixtures/images/LICENSES.md`.

**Offline AWS transports.** A production build refuses local media storage and the file mailbox. `scripts/local-aws.ts` runs on loopback and provides an S3-compatible endpoint plus an SESv2 `SendEmail` endpoint, so `next start` can run with `STORAGE_DRIVER=s3` and `IDENTITY_MAIL_DRIVER=ses`:

- **S3 operations:** multipart (including `ListParts` and `ListMultipartUploads`), Range `GET`, `HEAD`, `PUT`, `COPY`, `DELETE`, `DeleteObjects` and `ListObjectsV2`.
- **Browser CORS** that exposes `ETag`.
- **Mail** written in the development mailbox's JSON format.

s3rver was tried first and rejected because it has no `ListParts`. The stand-in is for offline runs only and verifies no signatures. The real S3 and SES paths are still unverified, as `docs/v2-gap-report.md` says.

With the stand-in, the existing real journeys also pass against the production build: `e2e/real/journey.spec.ts` and `e2e/real/v2-journey.spec.ts`, at 1440, 390 and 360 px. Until now `v2-journey` could only run on `next dev`.

### Commands

```sh
pnpm exec tsx scripts/local-aws.ts --dir .data/local-aws &          # S3 :4569, SESv2 :4580
export DATABASE_URL=postgres://culture_atlas:culture_atlas@localhost:5432/<db> APP_BASE_URL=http://localhost:3290 \
  SESSION_SECRET=<32+ chars> CREDENTIAL_ENCRYPTION_KEY=$(openssl rand -base64 32) \
  STORAGE_DRIVER=s3 S3_ENDPOINT=http://127.0.0.1:4569 S3_FORCE_PATH_STYLE=true S3_BUCKET=ca-local \
  S3_ACCESS_KEY_ID=local S3_SECRET_ACCESS_KEY=local AWS_REQUEST_CHECKSUM_CALCULATION=WHEN_REQUIRED \
  IDENTITY_MAIL_DRIVER=ses IDENTITY_MAIL_FROM='culture atlas <no-reply@example.com>' IDENTITY_MAIL_SES_REGION=us-east-1 \
  AWS_ENDPOINT_URL_SESV2=http://127.0.0.1:4580 AWS_ACCESS_KEY_ID=local AWS_SECRET_ACCESS_KEY=local
pnpm db:migrate && pnpm build
pnpm worker & pnpm media-worker &
# Phase "main" (01–08): the operator's experimental glasses rollout is on.
META_GLASSES_QUALIFIED_BUILDS=android@1.0.0 META_GLASSES_ENTITLED_PLATFORMS=android META_GLASSES_ROLLOUT=all \
  pnpm --filter @culture-atlas/web exec next start --port 3290 &
cd apps/web && E2E_BASE_URL=http://localhost:3290 V2_FIDELITY_MAIL_DIR=../../.data/local-aws/mail V2_FIDELITY_PHASE=main \
  pnpm exec playwright test -c playwright.real.config.ts e2e/real/v2-fidelity.spec.ts --project desktop
# Phase "unavailable" (09): restart next start WITHOUT the META_GLASSES_* variables, then:
E2E_BASE_URL=http://localhost:3290 V2_FIDELITY_MAIL_DIR=../../.data/local-aws/mail V2_FIDELITY_PHASE=unavailable \
  pnpm exec playwright test -c playwright.real.config.ts e2e/real/v2-fidelity.spec.ts --project desktop
```

The spec seeds once and keeps its state in `.data/v2-fidelity/` (git-ignored): the session, the phone, persistent browser profiles and the encoded media. To start over, delete that directory.

## Problems the real stack exposed, and fixes

1. **Reference 04 was unreachable in a browser.** Feature flags marked the release channel ineligible whenever there was no installation. A browser has none, so `/settings/devices/glasses` always fell through to 09, even with the rollout configured.
   - Fix: a browser is now release-eligible when the operator has entitled at least one native platform. It still never captures, because the build and device checks remain false.
   - An unknown installation id is not treated as a browser.
   - Tests are in `packages/domain/src/flags/feature-flags.test.ts`.
2. **Failed `/v2` requests left no trace.** Unexpected errors were returned as `internal` without being logged. They are now logged by request id, matching the `/v1` handler, with no request body or credentials.
3. **The 02 glasses line contradicted 04.** It said "See why it is not available yet" whenever the browser could not capture itself, which is always. It now says that only for release or account blockers. One shared helper, `glassesBlocked`, drives both 02 and 09. Review follow-up: the reference copy "Capture with your connected glasses" is shown only when the server says glasses capture is available (never in a browser). A browser whose only reasons are device-local reads "Set up on your phone with the culture atlas app", and a page whose capabilities did not load reads "See what glasses capture needs" (`glassesEntryLine`), so 02 deliberately differs from the reference here.
4. **Sign-in race (noted, not fixed).** Opening `/identity` as the very first request can create two anonymous sessions. The email challenge is bound to one of them and completed from the other, so the link fails with "expired or already used". The spec opens `/library` first. This needs its own fix in session bootstrap.

## Screen by screen

| Ref | Route | Verdict | What was changed in this pass | Remaining differences and why |
| --- | --- | --- | --- | --- |
| 01 Library desktop | `/library` | Close | Title 60 px (references are about 9 % larger than v1's 56 px). | Illustrations instead of photographs. Content is 1200 px wide, not the raster's ~1320 px (the contract's 1200 px and 32 px gutters win). The bar's second line is "42% sent", not "Finishing soon…", because the client cannot know an ETA (v2 deviation 6). The header follows 01 on every page. |
| 08 Library mobile | `/library` | Close | No header rule. Tighter title, subtitle and grid spacing. Filter chips 15 px with 18 px padding. "1 upload paused · Retry" strip at 44 px and 15 px. Capture pill 48 px at 17 px. Bottom navigation labels 12 px, icons 22 px. Corrections applied: "All", plus "Uploading" reached by scrolling. | Chips, strip and pill keep 44 px or more, where the raster draws them at about 28, 34 and 39 px. Items 3 and 4 are Olive layers and Along the coast, as in 01: one library cannot match both references' orders. The navigation change also applies to the v1 pages on phones (one shared bar, as in 08). |
| 02 Source mobile | `/capture` | Close | Header, title (40/1.02), lede (15 px) and option cards (18 px serif title, 13 px line, 12 px gaps) re-proportioned. The smaller inline Experimental badge matches. New illustrated hero. | Illustration. Option subtitles keep a 13 px floor; the raster's are about 12 px. The glasses line reads "Set up on your phone with the culture atlas app" in a browser, not the reference's "Capture with your connected glasses", because no glasses are connected to a browser (SCREEN-CONTRACT: the entry always explains eligibility). |
| 03 Camera mobile | `/capture/camera` | Close | 10 px more top space. Preview radius 12 px. The capture is taken while the timer reads 0:12. | Chromium's fake camera plays an illustration. The flip-camera control is hidden because the test device has one camera. Corrections: "Recording on this phone" until the recording is finalised. "Microphone on" was turned on explicitly in the run; the default is off. |
| 04 Glasses connect | `/settings/devices/glasses` | Close | Pill Experimental badge. Title 41 px. Smaller step lines and foot note. New illustrated hero. Reachable on the real stack after fix 1. | On a phone the primary action is "Open the culture atlas app", not "Continue with Meta AI": Meta AI registration happens in the native app, and a browser never pairs. A desktop gets "Continue on your phone" with a signed link. "About experimental access" is added under "Use this camera instead", because the contract requires the Experimental label to link to an explanation. |
| 05 Glasses ready | `/settings/devices/{id}` | Divergent (composition) | The device card now matches: icon, name and "● Ready to capture" on one line, with the connection line below. Section title 21 px and text 15 px. The duplicate "Remove this phone" section was removed (Remove stays on the devices list, where 04's disconnect lives). Mode buttons are 44 px. | The live glasses preview, about a third of the reference, is absent: a browser cannot stream the glasses camera. The shutter and the remote-capture switch are disabled, with the reason shown, because arming happens only on the phone. The name is "Meta glasses", not "Ray-Ban Meta", because the devices API does not expose the wearable's name. Back goes to "Devices". The "● Ready to capture" state comes from the server's real 30 s heartbeat rule, but the heartbeat is sent by the scripted phone stand-in with self-reported readiness; no glasses were connected. |
| 06 Uploads desktop | `/uploads` | Close | Title 60 px. One rule above the footer instead of two. | The extra quiet actions (Clear, Pause, Cancel) are required behaviour (v2 deviation 5). File sizes are the illustrations' real sizes (KB). The clips are WebM, because Playwright's Chromium has no MP4 demuxer to read a duration. Header (see 01). The global footer is shown. |
| 07 Video detail | `/library/media/{id}` | Close | Aside title 50 px on one line. Moments sit in one row of four, with more reachable by scrolling and aligned to the player. The chosen moment's real frame becomes the player's still. The seeded clip cycles four scenes, so the moments differ as in the reference. Top spacing reduced. | "This video cannot play in this browser…" appears because Playwright's Chromium has no H.264 decoder; Chrome and Safari play it. "Explore" is disabled with its reason because no model is qualified (no keys). The subtitle is the capture date, not model-written text (v2 deviation 7). Moment times are the media worker's real timestamps (0:03, 0:08, 0:13, 0:18). Header (see 01). |
| 09 Glasses unavailable | `/capture/glasses` | Close | Body 15 px. "Already captured…" 14 px. About link 15 px. | Illustrations. The three photos are the owner's three newest real photos. |

**Overall.** Seven references are close, 05 diverges in composition for the platform reason above, and none is pixel-identical. Three things apply to every screen:

- **Fonts.** The test machine has no Georgia, so headings render in the fallback serif, and Inter stands in for the system sans.
- **Text and target floors.** The references draw secondary sans text at about 11–12 px and controls under 44 px. The app keeps 13 px text and 44 px targets (SCREEN-CONTRACT).
- **Images.** They are illustrations until licensed production photography is supplied.

## Checks run

- `pnpm test`: 104 files, 791 tests passed.
- Typecheck and ESLint on every changed file.
- Mock Playwright suites (`pnpm exec playwright test`, 4 projects): 319 passed, 5 skipped.
- Real journeys against the production build with the local transports: `journey.spec.ts` and `v2-journey.spec.ts`, 6 of 6 passed.
- The fidelity spec: both phases passed.

Updated mock screenshots in `apps/web/e2e/screenshots/v2/`, and the phone-width v1 screenshots, show the new heroes and the shared bottom navigation.
