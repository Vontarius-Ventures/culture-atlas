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

## Capture platform v2: agents and sharing (screens 10–13)

Authority: the editable HTML mockups in `specs/capture-platform-v2/design/index.html` (sections 10–13) rendered with `specs/capture-platform-v2/design/tokens.css`, the exact copy in `design/copy.json`, and SCREEN-CONTRACT "Agent consent" and "Sharing". The mockups were rendered with Playwright at 1440, 390 and 320 px and compared side by side with the app screenshots at the same widths. App screenshots come from `apps/web/e2e/v2/agents-sharing.spec.ts` against a contract-validated `/v2` mock (`apps/web/e2e/v2/agents-sharing-mock.ts`) and are saved as `apps/web/e2e/screenshots/v2/<screen>-{desktop,mobile,minimum,narrow}.png` (1440, 390, 360, 320 px). The spec also runs an axe WCAG 2 A/AA scan on each screen and checks for no horizontal scroll at every width. Regenerate with:

```sh
cd apps/web && E2E_PORT=3107 pnpm exec playwright test e2e/v2/agents-sharing.spec.ts
```

The mockup's primitives are reproduced exactly in `apps/web/components/views/agent-platform.css`: a 1200 px page with 24 px padding (16 px below 640 px), the `#fffdfa` card with a 1 px line border and 14 px radius, the 13 px muted breadcrumb, a 32 px Georgia heading (28 px on phones) with the browser's 0.83em margins, 18.72 px Georgia panel headings, 16/1.55 system text, 16 px label margins, 12 px-radius buttons with 12×18 px padding and a 44 px minimum, the olive primary button, the quiet 13 px badge, the two equal columns with a 24 px gap and 14 px-radius panels.

| Mockup | Route | Screenshots | Result |
| --- | --- | --- | --- |
| 10 Agents | `/settings/agents` | `10-agents`, `10-agents-revoke-confirm`, `10-agents-rotated-secret` | Title and subtitle from copy.json, olive "Connect agent", then the connection panel ("My research assistant", Connected badge, "View device setup · Read preferences", "Collections: Quiet weekends", "Expires in 24 days · Last used today", Edit permissions / Revoke access) beside "Your activity" ("Read your preferences Today, 10:42", "Viewed Quiet weekends Today, 10:43", "No capture requests"). No secret or credential prefix is listed. |
| 11 Agent permission | `/settings/agents/new` (and `/settings/agents/authorize`) | `11-agent-permission`, `11-agent-permission-expanded`, `11-agent-secret-once` | Agent name field, "What it can do" with the five readable verbs (setup and preferences preselected, nothing else), the phone-permission note, and the Access summary panel ("Setup and preferences only", "No media, microphone or camera access", Expires after 30 days, Connect agent, the shown-once note). The secret is a separate one-time success state. |
| 12 Collection share | `/collections/:id/share` | `12-collection-share`, `12-collection-share-confirm-media`, `12-collection-share-link` | "Share Quiet weekends", "Who can view" (Restricted default), "Invite by verified email" with the `name@example.com` placeholder, "Create invitation link", the divider, both media checkboxes off, the live-change sentence, and the "Currently private" panel with its three sentences and "Save sharing settings". |
| 13 Shared collection | `/shared` | `13-shared-collection`, `13-shared-revoked` | Title, "Shared collection · View only" badge, "Shared by Alex · A few things for slower days.", two discovery panels with "Open details", "2 shared discoveries · Captured photos and videos are not included.", "Save a discovery to my collection". The revoked/expired state shows only `shares.revoked` copy with no titles or thumbnails. |

### Intentional deviations (agents and sharing)

1. **Breadcrumb text.** Every mockup section carries the gallery's category label "culture atlas / Settings and collections". The app shows the real path instead: "culture atlas / Settings" (10), "culture atlas / Settings / Agents" (11), "culture atlas / Collections / Quiet weekends" (12) and "culture atlas / Shared collection" (13). The viewer's breadcrumb is plain text, because a viewer has no private navigation.
2. **Gallery annotations removed.** "Editable HTML mockup · illustrative data" is a gallery note, not product copy, and is not rendered.
3. **App chrome.** Screens 10–12 sit inside the app header and footer (the mockups show only the section). Screen 13 renders without any app navigation, header, footer or Capture action (SCREEN-CONTRACT: no private navigation or owner menus).
4. **Checkbox and field color.** The mockups use the browser's default blue checkboxes and gray field borders. The app uses the olive action token for checkboxes (`accent-color`) and the muted token for field borders, so no untokenized color appears.
5. **Rotate lives under Edit permissions.** The contract requires rotation; the 10 mockup shows only two buttons per connection. "Rotate credential" is inside the Edit permissions panel, behind a confirmation, so the card keeps the mockup's two buttons.
6. **Progressive disclosure on 11.** Media, library scope (Selected collections / Entire library), collection choices and phone selection appear only after "View selected collections" or "Request capture while I allow it" is checked; scope strings are under a closed "Technical details". The default view is the mockup's. The Expires select offers 30, 7 and 90 days (the spec maximum).
7. **Dynamic summaries.** The 11 Access summary and the 12 panel title ("Currently private", "Invitations pending", "Shared with N people", "Link sharing is on") follow the actual selection; the mockup text is the default state.
8. **Link audience on 12.** Choosing "Anyone with the link" replaces the invitation field with the exact notice "Anyone with this link can view the items you include.", a 1/7/30-day expiry (7 default) and a required policy confirmation. The link appears, with "Copy link", only after a successful create; "Copied" is announced only after clipboard success.
9. **Original downloads checkbox.** Checking "Allow original downloads" also checks "Include captured photos and videos" (originals are an additional option), instead of disabling the control; both stay unchecked by default as in the mockup.
10. **Media and details on 13.** When the owner includes media, sanitized photos and videos appear in a "Photos and videos" grid below the discoveries (muted, `preload="none"`, played through the recipient media gateway). "Open details" expands a panel inline (public image, detail line, official link); "Save a discovery to my collection" switches the panels into a save mode for signed-in viewers.
11. **Activity order.** The activity API pages newest first; the panel shows the latest twelve in time order, as the mockup does. With more than one agent, each line is prefixed with the agent's name (it is always present for screen readers).
12. **Screenshot artifact.** Full-page mobile captures show the fixed bottom navigation where Playwright stitched it (as in the 01–09 captures).
