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
11. **Anonymous saving.** For visitors without an account, the save sheet shows the account prompt ("Create account", which claims the session and the intended save) and a secondary "Save for this visit" (24 hours), instead of the collection list.
12. **Settings entry point.** Agent connections, World Sensor status and privacy notes live at `/settings`, linked from a quiet footer. This keeps them outside primary discovery, and the header stays free of extra icons.
13. **Screenshot artifact.** Full-page mobile captures (`03-plan-mobile`, `state-partial-*`, `state-settings-*`) show the fixed bottom navigation partway down the page. That is how Playwright stitches fixed elements, not a layout bug.

## Accessibility checks

The checks below run in `e2e/item-settings.spec.ts`, `e2e/save.spec.ts` and `components/components.dom.test.tsx`:

- axe finds no serious or critical violations on Discover, Collections, collection detail, item, plan, settings, capture, or the save dialog.
- Keyboard order matches visual order: no CSS column reordering.
- Dialogs trap focus, close on Escape and return focus to the trigger.
- Saves and results are announced politely.
- Reduced motion zeroes the transition tokens; skeletons are static under reduced motion and never shimmer endlessly.
- There is no horizontal scroll at 360 px.
