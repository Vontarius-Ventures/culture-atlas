# Design fidelity: spec amendment 2.2, screens 14–18

This compares the running app with the approved HTML mockups for screens 14–18 (`specs/capture-platform-v2/design/html/`). Their captures are in `specs/capture-platform-v2/design/screens/`. The owner approved building against these mockups without a manual review. Screens 01–13 were checked again for regressions.

The app's screenshots are in `apps/web/e2e/screenshots/fidelity/v22/`. Each file has the same name as its mockup capture (`<screen>-<state>-<width>.png`, at 1440, 390 and 320 px, device scale 1), so the two can be opened side by side. Full-page captures follow the mockup script's rule: the viewport grows to the page height, so sticky bars sit at the end of the page.

## How the screenshots were made

They come from the **real stack**. `apps/web/e2e/real/v22-fidelity.spec.ts` (opt-in: `V22_FIDELITY=1`) drives the following, with no `/v1` or `/v2` mocks:

- the web app;
- the job worker;
- the media worker;
- PostgreSQL 16.

Each width signs up its own account in the browser. It then walks through the same states as the mockups: picks, live search, Build my feed, two photo uploads, leaving the page for the ready notice, and Settings → Taste. The picks for screen 18 that the mockup adds beyond the questionnaire go through the same endpoints the pickers use (`POST /v1/taste/picks`, `PUT /v1/onboarding/exclusions`).

### Providers

**Qloo is live.**

- The image grid and the chips come from the committed, pre-resolved catalog (`fixtures/onboarding/catalog.json`).
- Search, the seed job, tag resolution and recommendations are live requests to `hackathon.api.qloo.com`.
- These requests go through `scripts/e2e/qloo-gate.ts`. It forwards each request unchanged and never stores, rewrites or logs data or keys. It is only an outage switch: while it is "down", every route answers HTTP 503 with `Retry-After`.
- The switch is used only to capture the honest "unavailable" states of screens 14 (search) and 15 (building).
- Names, ids and images on screens 14–18 are therefore real Qloo data. The Discover and While we look cards with no licensed picture are drawn as text tiles. Where the feed falls back to the labeled examples, each card says "Example result".

**The vision model is a stand-in.** The worker runs `apps/worker/src/e2e-fake-models.ts`, which returns a fixed reading for the test photo ("Sesame noodle supper"). There is no model spend and the reading is not presented as live. It is set to `E2E_FAKE_QUICK_MS=12000`, so the processing state of screen 16 lasts long enough for a full-page capture.

- The checkpoint's note said 15000. That times out against the stand-in profile's 15 s limit: the quick read fails three times and the capture is marked failed. The spec header now says 12000 and explains why.

**No text model is configured.** The composer and research roles are not set up in this stack. Because of this, the photo result reports `eat: "unavailable"` and `research: "unavailable"`; the spec logs these section states. The result page then shows its honest retry notice (see screen 16).

### Commands

```sh
service postgresql start
psql postgres://culture_atlas:culture_atlas@localhost:5432/postgres -c 'CREATE DATABASE ca_fid_v22b'
export DATABASE_URL=postgres://culture_atlas:culture_atlas@localhost:5432/ca_fid_v22b \
  APP_BASE_URL=http://localhost:3294 SESSION_SECRET=<32+ chars> CREDENTIAL_ENCRYPTION_KEY=$(openssl rand -base64 32) \
  STORAGE_DRIVER=local STORAGE_LOCAL_DIR=$PWD/.data/fid-v22-objects \
  IDENTITY_MAIL_DRIVER=file IDENTITY_MAIL_FILE_DIR=$PWD/.data/fid-v22-mail \
  QLOO_API_URL=http://127.0.0.1:4490 QLOO_API_KEY=<from the gitignored .env> \
  CONCENTRATE_API_KEY= MODEL_FALLBACK= ELORIAN_API_KEY= ANTHROPIC_API_KEY= \
  E2E_FAKE_QUICK_MS=12000 NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt NO_PROXY=127.0.0.1,localhost
pnpm db:migrate
pnpm exec tsx scripts/e2e/qloo-gate.ts --port 4490 &
(cd apps/web && pnpm exec next dev --port 3294) &
(cd apps/worker && pnpm exec tsx src/e2e-fake-models.ts) &
pnpm media-worker &
cd apps/web && V22_FIDELITY=1 E2E_BASE_URL=http://localhost:3294 \
  pnpm exec playwright test -c playwright.real-v22.config.ts e2e/real/v22-fidelity.spec.ts --project desktop
```

The run uses `next dev` because a production build refuses local media storage (`docs/v22-real-stack.md`). The Next.js dev indicator is hidden in every capture, since it is not part of the app.

## How the comparison was done

Every app screenshot was compared with its mockup capture in two ways:

- **Side by side:** the mockup on the left and the app on the right, at full and half scale, with crops of the details (header, result head, toast, chips).
- **Pixel diff:** the per-channel difference with a threshold of 40/255, so anti-aliasing noise is not counted.

In the diff numbers below, "0 px" means no pixel differs by more than that threshold.

## Per-screen verdicts

| Screen | States and widths | Verdict | What differs, and why |
| --- | --- | --- | --- |
| **14 Taste picks** | Desktop one page (1 pick to go, Ready). Phones: step 1, step 2 with search, step 3 disabled and ready. Search unavailable. All at 1440 / 390 / 320. | **Match** | Step 1, step 3 and step 3 disabled at 390 and 320: **0 px** different. Search unavailable: about 5,000 px (chip labels only). Data differences only: (1) Chip labels come from the live-resolved catalog. For example, Wear is Japandi, Wabi-sabi, Minimalist, Vintage, Bohemian, Preppy, Quiet luxury, Art deco where the mockup draws Mod revival, Workwear, Streetwear; Watch has "Coming-of-age". (2) Live search for "nina" returns Qloo's ten results (Nina · Place, Nina · Film …, Nina Simone · Artist), where the mockup drew three, so the desktop page and phone step 2 are 364 px taller. Spacing, type, chips, the tile check mark, counter, footer bar and disabled reason are identical. |
| **15 Building your feed** | Building, Qloo unavailable. All widths. | **Match** | Unavailable: **0 px** at every width. Building: about 3,700 px, because the live seed published Eat first ("Eat · Ready") where the mockup shows Wear first. The collage, title, line and chips are identical. |
| **16 While we look** | Processing state. All widths. | **Close** | Layout, the "From your feed" header, strip, divider and skeleton grid match. (1) The photo is the project's test photo (noodles), not the mockup's illustration. (2) Seeded Qloo cards have no licensed image, so they are text tiles. The feed's labeled example cards carry an "Example result" line, which adds one line under the strip, so "Discoveries" sits 12–20 px lower. |
| **16 More to explore** | Results state with the collapsed strip. All widths. | **Close, not 1:1** | The title, the 20 px reading, the pills (27 px below the reading), the divider (40 px) and the More to explore disclosure measure the same as the mockup. Deliberate differences: (1) **Save this inspiration** under the photo is required by the v1 spec ("beside the photo") but the mockup does not draw it. (2) The pills keep the relation qualifier ("Resembles Wabi Sabi"), because the v1 spec requires a resemblance to be told apart from a depicted object. The mockup shows bare names. "Resembles Cuisine" is the live resolution of the stand-in's "Sichuan cuisine" tag query. (3) The filter shows the categories the run returned: All, Wear, Play, Watch. (4) Eat is `unavailable` in this stack (no composer model), so the honest "Related discoveries are taking longer. · Try again" notice appears. (5) "Load more" and **Explore the references** (also v1 spec) follow the grid. The cards are text tiles (no Qloo images). |
| **17 Ready notice** | Toast over Discover. All widths. | **Match (toast)** | The toast's position, size, thumbnail, copy, Open button and close button line up with the mockup to the pixel at every width; at 320 the thumbnail is dropped in both. The feed under it is the account's live seeded feed (text tiles), not the mockup's illustrations. At 390 the heading wraps "Find more of / what you love.", as in v1 reference 04, which this page follows. Mockup 17 wraps after "you". |
| **18 Settings → Taste** | With "Add more to Watch" open. All widths. | **Match** | At 1440 about 6,600 px differ in 1440 × 1236. Phones match through the Save button. Differences: (1) **Play order.** Mockup 15 puts Nina Simone before Sunday listening in the collage, and mockup 18 lists Sunday listening first. Both follow pick order, so no single run can satisfy both. Screen 15 was kept, and screen 18 shows Nina Simone first. (2) "Coming-of-age" (live tag name). (3) The app's global footer and bottom navigation follow the panel on phones (see below). The phone header now carries the Capture pill, as the mockup does. |

### Differences across the whole app (not specific to 14–18)

- **Global footer.** "Settings · Your collections are private." appears under every page. The mockups for 14–18 leave it out. It was accepted in the v1 and v2 fidelity passes and is kept.
- **Gap above the footer on phones.** `.main` reserves the bottom-nav height, `.page` adds 48 px and the footer adds a 64 px top margin, which leaves about 176 px of empty canvas above the footer on every phone page. It is visible at the end of the full-page phone captures for 16 and 18. It was not changed here because it affects every phone page and the mobile dock spacing.
- **Library icon in the bottom bar.** The app uses the stacked-photos icon from v2 reference 08. Mockups 14–18 draw a single image icon. Reference 08 is kept.
- **The ⋯ menu on the result page.** "More options for this photo" holds Delete photo. The mockup leaves it out.

## Fixes made in this pass

These come on top of checkpoint `b19b4f2`. That checkpoint already contained:

- the reference pills under the reading;
- the 20 px reading;
- the 16 px phone top padding on the result page;
- the Capture pill in the phone header for `/settings/taste`;
- the empty status line removed from the Taste panel.

All of these were re-verified here. New in this pass:

1. **Text tiles collided with the Save chip at 320 px.** This was a regression from the checkpoint and is now fixed.
   - Cause: the checkpoint stopped long titles being cut mid-line with `flex-shrink: 0`. On 130 px tiles, the bottom-aligned column then climbed under the Save chip: "In the Mood for Love" and "Nina Simone" sat behind it.
   - Fix:
     - Tiles reserve the chip band at the top (52 px on desktop, 46 px on phones).
     - Content uses `justify-content: safe flex-end` with `overflow: hidden`, so any overflow goes down and is clipped instead of going up.
     - The subtitle is clamped to two lines.
     - Below 360 px the subtitle is left out, and the title keeps two lines with an ellipsis.
   - Effect: in-bounds layouts look the same as before. Desktop and 390 captures of 01–13 are pixel-identical.
2. **Screens 10–13 could not be reached with the fidelity seed.** Since amendment 2.2, the account-settings fixture account (two saves, no onboarding row) was sent to `/welcome/taste` at sign-in, which is the ONB-06 behavior. `scripts/seed-fidelity.ts` now records both fixture people as having finished the questionnaire.
3. **The quick-read delay in the fidelity run** was corrected, as described above.

## Regression check, screens 01–13

**Real stack.** `e2e/fidelity/v1-and-account.spec.ts` was re-run on the same stack with a fresh `scripts/seed-fidelity.ts` seed: 30 of 30 pass. Against the committed captures from the production build (`fidelity/v1-and-account/`):

- **27 of 30 are pixel-identical** (0 px), once the dev indicator is hidden. The spec now hides it.
- `10-agents-desktop` and `10-agents-narrow` differ only in the relative activity times. The committed files were kept.
- `01-discover-narrow` changed on purpose (fix 1) and was recommitted.
- Navigation (header, active tab, phone bottom bar, Capture placement), Discover and the collection, plan, item, save and sharing screens did not change.

**Mock suite.** `pnpm exec playwright test` (all 13 files, 420 tests at desktop, mobile, minimum and narrow): **399 passed, 21 skipped (by design), 0 failed** with 2 workers.

- An earlier run with 4 workers had one failure: `v22/flows.spec.ts` "the while_we_look_enabled kill switch hides the strip" at narrow.
- Under that load, the capabilities read took longer than the strip's deliberate 4 s bound. The strip fetched the feed, then hid when the kill switch arrived.
- The test passed 12 of 12 times on its own (`--repeat-each 3`) and in the 2-worker run. This is a timing sensitivity of the test under heavy dev-server load, not a layout regression.

**Capture result (state-partial / state-processing mock shots).** These changed as intended: reference pills under the reading, a larger reading, and the "Example result" label now after the pills. The "Example result" label is still shown on every example capture. `capture.spec.ts` checks the pills, and it checks the label in "try an example is labeled Example result".

**Real v22 journey.** `e2e/real/v22-journey.spec.ts` (fake Qloo, model stand-in): **9 of 9 pass** at 1440, 390 and 320. The refreshed `real-v22-*` captures show the 320 px text-tile fix: the kind label is no longer under the Save chip, and titles end in an ellipsis instead of being cut mid-line.

**Other checks.**

- `pnpm test`: **976 of 976 pass** in a hermetic environment.
- In this session's shell, which exports live provider variables (`CONCENTRATE_*`, `ELORIAN_*`, `QLOO_*`), 7 readiness tests fail (`apps/web/lib/server/model-readiness.test.ts`, `agent-media-http.test.ts`), because they read the live configuration. Commit `67f0559` on `claude/wizardly-cannon-yu8trw` ("Keep tests hermetic from live provider credentials") already fixes that. This branch was cut from `2816e1a`, before that commit.
- `pnpm typecheck` and `pnpm lint` are clean.

## Re-run after the review fixes (2026-10-19)

After the 2.2 review round the live-Qloo run above was repeated on a fresh database (same commands, `ca_fid_v22c`): 6 of 6 pass at 1440, 390 and 320. The captures in `apps/web/e2e/screenshots/fidelity/v22/` were refreshed. 81 Qloo requests went through the gate (12 more were refused during the simulated outage); no model was called (stand-in reading).

| Screen | Verdict after the fixes | What changed |
| --- | --- | --- |
| 14 Taste picks | **Match** (unchanged) | Only live data differs between runs (Qloo search results and their order). |
| 15 Building your feed | **Match** (unchanged) | The seed now has a per-job cap of 6 requests across retries; the "unavailable" state is identical. |
| 16 While we look / More to explore | **Close, not 1:1** (unchanged verdict) | An advisory stage-2 veto no longer removes a reference, and references stage 2 adds are listed after the stage-1 ones, so the pills can show one more qualified reference ("Resembles Film-noir" in this run). Cards stage 2 appends rank after every card already shown. |
| 17 Ready notice | **Match (toast)** (unchanged) | None. |
| 18 Settings → Taste | **Close** (was Match) | "Add more" now shows the group's catalog images above the chips, because the amendment says "add more (same pickers)" and wins over mockup 18, which draws chips and search only. Two columns of image tiles on phones, 140 px tiles on desktop. Everything above and below the panel is unchanged. |

## Not covered

- **Native screens (iOS/Android onboarding, Settings → Taste, ready push).** No Swift or Android toolchain is available here, so they were not built or captured.
- **The production build.** Not captured for screens 14–18, because it needs the S3 path for media.
- **Live model readings.** The reading on screen 16 is the fixed stand-in. The live two-stage reading was qualified separately (phase 4).
