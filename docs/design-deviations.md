# Design deviations and comparison notes

These notes compare the consumer interface with the [design package](../design/cultural-atlas-v1/DESIGN-GUIDE.md). The screenshots in `apps/web/e2e/screenshots/` come from `apps/web/e2e/screenshots.spec.ts` at 1440, 390 and 360 px. They render against the contract-validated mock API and the project's sample illustrations. Each surface was checked against its mockup by image inspection. Regenerate the screenshots with:

```sh
cd apps/web && E2E_PORT=3105 pnpm exec playwright test e2e/screenshots.spec.ts
```

The written tokens in `tokens.css` are applied exactly: canvas `#F8F6F1`, ink, muted, olive `#566347` for primary actions and selection, quiet `#EEEAE2`, divider lines, and a 3 px `#405734` focus ring with 3 px offset. Georgia is the display face and the system UI font is used for controls. Display sizes are 56/1.08 on desktop and 34/1.12 on mobile, item titles 20/1.25 (17 on mobile), and image radii 16/12 px.

## Surface by surface

| Mockup | Screenshot | Result |
| --- | --- | --- |
| 01 Desktop discovery | `01-discover-desktop.png` | Matches the 72 px header (wordmark left, centered nav with an olive underline, Capture right), the 56 px headline, the pill filters and four columns of image-led cards with the Save chip at the upper right. |
| 04 Mobile discovery | `01-discover-mobile.png`, `-minimum` | Two columns with a 12 px gap and 16 px gutters. Bottom nav shows Discover, Collections and Plans; Capture stays in the header. No horizontal scroll at 360 px. |
| 05 Save sheet | `05-save-mobile.png`, `-desktop` | Bottom sheet on mobile and a centered dialog on desktop: item thumbnail, recent collection rows with mini mosaics, current target with an olive check, then New collection, Save for later, and a full-width Save. |
| 06 Item detail | `06-item-desktop.png`, `-mobile` | Two-column open layout with a large image left and title, reason, Save, quiet disclosures and "You might also like" right. Mobile stacks it as a dedicated page with Back. |
| 07 Collections index | `07-collections-desktop.png` | Mosaic covers with shared rounded edges, names with a lock, private item counts, "Saved for later" last, and an outline "New collection" button. |
| 02 Collection detail | `02-collection-desktop.png` | Back link, serif name and description, "Make something" top right, collection filters, three columns on desktop, circular selection controls, and a compact selection bar with the count and "Make a movie night". |
| 03 Movie night | `03-plan-desktop.png`, `-mobile` | The film gets the largest area with its title overlaid, plus "Change film". "For the table" and "Before the credits" sit beside it with outline "Change food" and "Change music". "Inspired by" input tiles follow. Mobile stacks film, food, music and inputs in that order. |

Unpictured states were also captured (`state-first-visit`, `state-processing`, `state-partial`, `state-empty-collection`, `state-settings`) and checked against the guide's state table.

## Intentional deviations

1. **Imagery is illustrated, not photographic.** Wikimedia Commons was unreachable from the build environment, so the samples are original generated illustrations that keep each image's subject and composition (see `fixtures/images/LICENSES.md`). They look flatter than the concept photos. `fixtures/images/fetch-commons.ts` can swap in public-domain or CC0 photographs later.
2. **"Example result" labels.** The spec requires sample and replayed results to be labeled visibly. Sample cards carry a small muted "Example result" line under the title, and example captures show an "Example result" chip. The mockups show no labels.
3. **First-visit actions on Discover.** New visitors (an example feed) see "Take a photo", "Upload a photo", "Try an example" and the one-line AI notice between the headline and the filters, as the spec's first-visit section requires. Returning users see the mockup's layout without that row.
4. **Mobile Capture placement.** Capture stays in the mobile header, as in mockup 04, rather than becoming a fourth bottom-nav item. The bottom nav keeps the three destinations.
5. **Control heights.** Filter pills and the Save chip's hit area are 44 px to meet the minimum target; the mockup pills look about 36 px. The Save chip's visible ivory surface stays 32 px inside the 44 px button.
6. **Uniform crops in grids.** Discovery and collection cards use square crops; related cards and the item image use 4:5. The guide bounds containers between square and 4:5. Collection detail cards therefore do not use mockup 02's landscape crops, and titles sit beneath the image per the guide's correction.
7. **Five columns.** Discover switches to five columns only at 1680 px and wider, so cards stay well above 240 px. The page shows four at 1440 px, matching the mockup.
8. **Plan page.**
   - There is no "Save plan" button: a plan is stored with its versions when created.
   - The page header has a quiet More menu with "Start over with new choices" and "Delete plan". The account icon from the concept is omitted, per the guide.
   - The film overlay shows title, year and the short reason. The schema has no director field.
   - Two alternates appear as an "Or try" line under the film.
   - When music picks have no licensed images (the usual case for artists), "Before the credits" uses compact rows on desktop too, instead of three portrait tiles.
   - The optional rationale and weak-input disclosure live in a closed "Why these?" disclosure.
9. **Item menus.**
   - Hide is in a "More" menu on the item page, not on cards.
   - Collection cards have a small "More" menu beside the title for "Move earlier", "Move later" and "Remove from collection". This keeps reordering keyboard-accessible without drag and drop.
   - The selection bar adds a quiet "Clear".
10. **Quick save.** The picker always opens, with the remembered last destination preselected, so saving there is one tap on Save; the current target is always visible and can be changed in place. The design guide's separate "Change destination" affordance is therefore covered by the picker itself.
11. **Anonymous saving.** For visitors without an account, the save sheet shows the account prompt ("Create account", which claims the session and the intended save) instead of the collection list. There is no temporary save: the service requires an account to save (403 account_required).
12. **Settings entry point.** Agent connections, World Sensor status and privacy notes live at `/settings`, linked from a quiet footer. This keeps them outside primary discovery, and the header stays free of extra icons.
13. **Screenshot artifact.** Full-page mobile captures (`03-plan-mobile`, `state-partial-*`, `state-settings-*`) show the fixed bottom navigation partway down the page. That is how Playwright stitches fixed elements, not a layout bug.

14. **Real-stack screenshots.** `real-*.png` come from `e2e/real/journey.spec.ts` against the production build and worker with no provider keys. They show the honest states the mockups do not: "Example result" labels, "Related discoveries are taking longer.", unavailable plan sections, and text-treatment cards for films and artists (no licensed images). Sample items whose subject a project illustration actually shows (sesame noodles, linen, a tetsubin, a record player) carry that illustration and lead the first-visit feed. Agent credentials are masked in screenshots.
15. **Toasts over sheets.** While a dialog or bottom sheet is open, the toast moves to the top of the screen so it never covers the sheet's Save button.

## Accessibility checks

The checks below run in `e2e/item-settings.spec.ts`, `e2e/save.spec.ts` and `components/components.dom.test.tsx`:

- axe finds no serious or critical violations on Discover, Collections, collection detail, item, plan, settings, capture, or the save dialog.
- Keyboard order matches visual order: no CSS column reordering.
- Dialogs trap focus, close on Escape and return focus to the trigger.
- Saves and results are announced politely.
- Reduced motion zeroes the transition tokens; skeletons are static under reduced motion and never shimmer endlessly.
- There is no horizontal scroll at 360 px.

## Capture platform v2 (references 01–09)

Authority: `specs/capture-platform-v2/SCREEN-CONTRACT.md`, `design/copy.json`, `design/tokens.css` and the nine generated references in `specs/capture-platform-v2/design/mockups/`. Screenshots come from `apps/web/e2e/v2/screens.spec.ts` and `apps/web/e2e/v2/camera.spec.ts` at 1440 (`-desktop`), 390 (`-mobile`), 360 (`-minimum`) and 320 (`-narrow`) px and are saved to `apps/web/e2e/screenshots/v2/`. They render against a contract-validated `/v2` mock (`apps/web/e2e/v2/mock-v2.ts`); the media in them are crops of the generated references (`apps/web/e2e/v2/fixtures/make-fixtures.sh`), used as test fixtures only. Each screenshot was compared with its reference at the same viewport. Regenerate with:

```sh
cd apps/web && E2E_PORT=3105 pnpm exec playwright test e2e/v2/screens.spec.ts e2e/v2/camera.spec.ts
```

Copy is exact: `apps/web/components/v2/copy.ts` mirrors `design/copy.json`, and `copy.test.ts` fails on drift. The written corrections are applied instead of the raw images: the mobile filter reads "All", not "All active", and "Uploading" is reachable by scrolling the filter row (08). The remote-capture text reads "Allow selected devices and agents to request capture for 10 minutes" (05). The camera shows "Recording on this phone" until the recording is finalized (03). The microphone is off until the person turns it on (03).

### Surface by surface

| Reference | Route | Screenshot | Result |
| --- | --- | --- | --- |
| 01 Library desktop | `/library` | `01-library-desktop` | Same hierarchy and tokens: 56 px serif title, serif muted subtitle, olive "Upload files", pill filters (All/Photos/Videos/Uploading), "Select" checkbox on the right, the "Today" group, four 4:3 image tiles per row with a real checkbox, play badge and duration on videos, serif title and "Source · Status" lines. The floating "N files uploading / View uploads →" bar sits at the bottom. |
| 08 Library mobile | `/library` | `01-library-mobile`, `-minimum`, `-narrow` | Wordmark, gear "Settings", serif title, pill filters, two-column square tiles with source lines, the "1 upload paused · Retry" strip, the olive Capture pill above the four-item bottom bar (Discover, Library, Collections, Plans). |
| 02 Source mobile | `/capture` | `02-source-mobile`, `-desktop` | "‹ Back · culture atlas" header, title, lede, rounded hero image, three option cards (This camera, Meta glasses + Experimental, Upload files) with chevrons, privacy line. |
| 03 Camera mobile | `/capture/camera` | `03-camera-*`, `03-camera-review-*` | Close, "This camera ⌄" source menu, rounded preview with the dark "● Recording 0:12" pill, microphone row with "60 sec max", Photo/Video segmented control with an olive underline, red stop shutter, "Stop recording", workflow note. |
| 04 Glasses connect | `/settings/devices/glasses` (and `/capture/glasses` when only device-local reasons apply) | `04-glasses-connect-*` | Experimental pill, title, lede, hero, three numbered steps with dividers, full-width olive primary button, availability note, "Use this camera instead". |
| 05 Glasses ready | `/settings/devices/{id}` | `05-glasses-ready-*` | Title, "Experimental", device card with a live "● Ready to capture" state from a fresh heartbeat, photo/video pill switch, round shutter, "Camera ready · Audio off", the "Capture from your browser" section with the corrected sentence and the "Allow remote capture" switch. |
| 06 Uploads desktop | `/uploads` | `06-uploads-*` | Title, sans subtitle, outline "+ Add files", rows with thumbnail, name, "Photo · 3 MB" / "Video · 42 sec", a Ready check + Open, an "Uploading 62%" bar + Cancel, a dotted "Preparing video", the amber "Upload paused / Connection lost. Your file is still selected." + Retry, the footer "Uploading does not start analysis." and "← Back to library". |
| 07 Video detail | `/library/media/{id}` (`/library/{id}` redirects) | `07-video-detail-*` | "← Back to library", a video with a dark control bar (play, scrubber, `0:12 / 0:42`, mute, full screen), "Meta glasses · 42 sec · Audio off", "Moments in this video" with the selected moment outlined. On the right: the serif title, olive "Explore this moment/video", "Save to collection", the exact selected-moments sentence, "Choose a moment", and the Details and More rows. |
| 09 Glasses unavailable | `/capture/glasses` | `09-glasses-unavailable-*` | Back arrow + wordmark, "Meta glasses" with a quiet Experimental pill, line-drawn glasses, "Not available yet", the exact copy, "Use this camera", "Upload files", "About experimental access", and "Your library is unchanged." with three of the owner's own photos. |

### Intentional deviations (v2)

1. **Content width.** The contract specifies a 1200 px centered content width with 32 px gutters. References 01, 06 and 07 are scaled compositions whose content spans about 1320 px at 1440. The v2 pages use 1200 px. Their header and footer use the same width, so the wordmark lines up with the content. The v1 Discover, Collections and Plans pages keep their 1600 px width.
2. **One header for every page.** References 01, 06 and 07 place the navigation differently (centered; left-aligned; Capture as a plain link next to Settings, with an account icon). The shell follows reference 01 on every page: wordmark, four centered destinations, an olive Capture button and a Settings link. The contract says Capture is a separate primary action. The account icon from 07 is not shown. This supersedes v1 deviation 4: Capture is now an olive pill above the four-item mobile bottom bar, as in reference 08.
3. **Minimum control size.** The mobile filter chips, Capture pill and recovery strip use 44–52 px heights, not the raster's smaller pixel heights (contract: 44 px minimum controls). Desktop filter chips are 36 px.
4. **Mobile "Select".** Reference 08 shows no selection control. Selection is required, so a text "Select" button sits at the end of the scrolling filter row. On desktop, each tile shows a checkbox, as in 01.
5. **Uploads extras.** A quiet underlined secondary action sits under the main button: "Pause" while uploading, "Cancel" while paused, "Clear" when ready. The task requires pause, retry and cancel, and the reference shows one button per row. Before any upload, the page shows a drop zone.
6. **Upload bar wording.** Reference 01 says "Finishing soon…". That is an estimate the client cannot know. The bar shows the verified percent sent, or "Preparing your files" once all bytes are sent. Server preparation never shows a fabricated percent.
7. **Video detail subtitle.** "Wood, warm light, and familiar places." in 07 would be model-written text. The library has no description field, and v2 never runs analysis without a request. The subtitle shows the capture date instead. When an owner has not set a title, the title reads "Video from Oct 17" rather than an invented name.
8. **Explore availability.** When `GET /v2/capabilities` reports analysis unavailable (no qualified model), "Explore this video" is disabled with a reason underneath. The 07 screenshot uses the analysis-available fixture.
9. **Glasses on the web.**
   - Browsers never pair glasses, so the 04 primary button is "Continue on your phone" on desktop. It creates a signed, 10-minute, account-bound link (`POST /capture/handoff`) shown as a QR code and a copyable URL.
   - On phones the button is "Open the culture atlas app" (`cultureatlas://capture/glasses`). The native app is not built yet, so that link does nothing today.
   - 05 has no live glasses preview: a browser cannot stream the glasses camera. The shutter and the remote-capture switch are shown disabled, with the reason, because arming happens only on the phone.
   - 09 adapts its sentence to the actual blocking reason (release, country/account, device, permission). The full reason list is under "About experimental access".
10. **Camera imagery.** Camera screenshots use Chromium's fake camera (a green test pattern), not a photograph. The flip-camera button appears only when the device has more than one camera, so the single fake device hides it.
11. **Desktop source chooser.** There is no desktop reference for 02. At 1024 px and wider, the title, lede and options sit beside the image so all three options are visible without scrolling.
12. **Hero images.** The 02 and 04 heroes in `apps/web/public/capture/` are crops of the generated references. Replace them with licensed production photography before public release.
13. **Screenshot artifact.** Full-page mobile captures (04, 05, 07, 09) show fixed elements where Playwright stitched them. The uploads mobile capture is viewport-only for that reason.
