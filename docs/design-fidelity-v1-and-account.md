# Design fidelity: v1 screens and account screens

This pass compares eleven screens with their references, rendered by the **real stack**: the production build (`next build` and `next start`), the job worker and PostgreSQL 16. No `/v1` or `/v2` mocks were used.

- **v1 references:** `design/cultural-atlas-v1/mockups/01` to `07`, shown with the new four-destination navigation.
- **v2 references:** sections 10 to 13 of `specs/capture-platform-v2/design/index.html`.

Each screen was captured at three widths, and each capture was compared with its reference by image inspection:

- 1440 px (desktop references, viewport 1440×960);
- 390 px (mobile references, Pixel 7 emulation);
- 320 px (the SCREEN-CONTRACT minimum; full page).

The v2 HTML sections were rendered with Playwright at the same widths for that comparison.

Final screenshots are in `apps/web/e2e/screenshots/fidelity/v1-and-account/<screen>-{desktop,mobile,narrow}.png`.

## How to reproduce

```sh
pnpm db:setup && pnpm db:migrate
pnpm exec tsx scripts/seed-fidelity.ts --out .data/fidelity-seed.json
(cd apps/web && pnpm exec next build && pnpm exec next start --port 3410) &
pnpm worker &
cd apps/web && E2E_BASE_URL=http://localhost:3410 pnpm exec playwright test -c playwright.fidelity.config.ts
```

The spec is `apps/web/e2e/fidelity/v1-and-account.spec.ts`. On every screen and at every width it checks:

- that the page does not scroll horizontally;
- the exact Discover order;
- the related cards;
- that the agent activity is real;
- 44 px targets on Discover controls.

Screen 12 revokes any live share first, so it starts from "Currently private". Screen 13 opens a real link share in a separate, signed-out browser context.

### Seeded data (`scripts/seed-fidelity.ts`)

The seed refuses to run with `NODE_ENV=production`. It creates two accounts, both named "Alex", that sign in with a fixture password:

- **`fidelity@example.com` (library):**
  - Discover shows eight cards in mockup order: Vintage racing, Quiet corners, Sunday listening, Around the table, Night wanderings, Sculptural forms, Linen days, Tea rituals.
  - Collections: Slow Sunday (6 items, including one owner photo, so the Photos filter exists), After dark (4) and Everyday favorites (8).
  - Two unfiled saves, shown as Saved for later.
  - A "Motorsport" reference for "Explore the references", and three related cards.
  - A movie night planned from Slow Sunday.
- **`fidelity-account@example.com` (settings):**
  - Quiet weekends (2 items).
  - "My research assistant", limited to Quiet weekends. It then really reads the preferences and that collection through the domain services, so the activity list is genuine (its times are real, not 10:42).

The two accounts are separate so the collections index shows exactly the four covers of mockup 07.

Honesty rules:

- Every seeded item carries `display_metadata.example = true`.
- Recommendations and plan picks use origin `sample`. No `qloo` origin and no `provider_queries` rows are written.
- The UI therefore labels them "Example result" everywhere.
- Images are the project-original illustrations (`fixtures/images/LICENSES.md`). No mockup pixels are used.
- Films and artists have no stand-in picture.

## Changes made in this pass

| Area | Change | Reference |
| --- | --- | --- |
| Header (all pages) | Capture reads "+ Capture" with the plus icon, 44 px tall. | 01, 02, 06, 07 |
| Mobile header (Discover, Collections, Plans and their detail pages) | Capture is an olive pill at the top right, as in 04. The large dock pill is removed on these pages; the dock now carries only upload recovery when uploads exist. Library and Uploads keep reference 08 (Capture pill above the bar, gear for Settings). Settings stays in the footer. Mobile header height is 60 px. | 04 (v1), 08 (v2) |
| Filter pills | They look 36 px tall, as in the mockups, inside a 44 px button (the visible surface is a pseudo-element). Labels are 15 px with 18 px padding. The focus ring is drawn on the visible pill. On phones the pills share the row's width when they fit and scroll when they don't (320 px). | 01, 02, 04 |
| Discover rhythm | The headline sits 12 px under the header, then the filters 16 px below, then the grid 12 px below that. The grid gap is 16 px (it was 24), with 20 px between rows. Mobile rows are 16 px apart. Card title spacing is 10 px. | 01, 04 |
| Display headings | `text-wrap: balance`, so the mobile headline breaks "Find more of / what you love." as in 04. | 04 |
| Pages with Back | The page top padding is 16 px (it was 32), and the heading follows Back 4 px later, so Back and the heading sit where 02, 03 and 06 place them. | 02, 03, 06 |
| Item detail | Two equal columns, and a 6:7 image (between square and 4:5). Save is a plain "Save" button with no icon, 140×48. The "Example result" label moved into the action row. The disclosure rows are 76 px tall, with the chevron inset. "You might also like" sits right under the disclosures. The feed fixtures carry no subtitle line. | 06 |
| Collections index | Covers use one tall tile and two stacked tiles when there are three or more images, otherwise one image (Saved for later). The cover ratio is 8:11. There is 64 px of space above "Your collections". | 07 |
| Collection detail | Heading, description, pills and grid sit higher, as in 02. The "Example result" line sits close under titles that have an item menu. | 02 |
| Movie night | Film and side columns are 1.3:1 with a 28 px gap. The header has 24 px below the summary. On phones the More menu stays beside the heading. | 03 |
| Connected agents (10) | The capability line follows consent order (View device setup · Read preferences). Collection reading is shown by the card's own "Collections: …" line instead of being repeated. Unit-tested in `AgentPlatformView.dom.test.tsx`. | 10 |
| Account screens (10–13) | The mockup gallery's 40 px gap between sections is not repeated under the app header. | 10–13 |
| Test helper | `settleImages` caps its network-idle wait at 10 s. Settings pages poll, so they never go idle, and screenshots used to hang until timeout. | — |

## Screen by screen

The "Match" column is our own verdict after the last screenshots: **exact** means no meaningful difference, **close** means the same composition with the listed deviations, **divergent** means a visibly different composition.

| Screen | Screenshots | Remaining differences | Match |
| --- | --- | --- | --- |
| 01 Discover (desktop) | `01-discover-desktop` | (1) Four destinations plus a Settings link, where the mockup shows three destinations. (2) "Example result" under each title. (3) Cards are square; the mockup's first row is slightly taller than wide. (4) Gutters are 48 px against about 41 px in the scaled mockup (the guide allows 40–48). | close |
| 04 Discover (mobile) | `01-discover-mobile`, `-narrow` | (1) Four-item bottom bar (Discover, Library, Collections, Plans, with v2 icons) instead of three. (2) "Example result" lines. (3) Pills are 36 px tall, where the raster's are about 27 px. (4) Square cards; the raster's are slightly landscape. | close |
| 02 Collection detail | `02-collection-*` | (1) Titles sit beneath the images on square crops (design guide correction), not overlaid on landscape crops. (2) Extra quiet "…" menus: the collection menu next to "Make something" and an item menu per card. (3) "Clear" in the selection bar. (4) "Example result" lines. | close |
| 03 Movie night | `03-plan-*` | (1) The film panel is the dark text treatment: there is no licensed still. (2) Music is compact rows, not three portraits: there are no licensed artist photos. (3) The film line shows "2000" without the director: `FilmPick` has no director field. (4) There is no "Save plan": a plan is stored when created, and the More menu sits there instead. (5) "Example result" labels. (6) The extra open-link button. | close |
| 05 Save sheet (mobile) | `05-save-mobile`, `-narrow` (also `-desktop`, a dialog) | (1) The sheet covers the bottom navigation, which the mockup leaves visible below the sheet. The sheet is modal, so the bar would be inert anyway. (2) The Save label uses the sans-serif UI font (guide: sans-serif controls). | close |
| 06 Item detail | `06-item-*` | (1) The "…" menu (Hide) and the "Example result" chip in the action row. (2) "Discover more" under the related cards. (3) Save chips on related cards (guide: Save on every DiscoveryCard). (4) Related crops are 4:5; the mockup's are slightly taller. | close |
| 07 Collections index | `07-collections-*` | (1) The lock is an outline icon, not filled (guide: one outline icon family). (2) The heading is about 12 px higher than in the scaled mockup. | close (near exact) |
| 10 Connected agents | `10-agents-*` | (1) Real breadcrumb "culture atlas / Settings" instead of the gallery label. (2) Real activity times. (3) App header and footer around the section. (4) On phones, the app's Capture dock (v2 reference 08) overlaps the card's lower edge until scrolled. | close |
| 11 Agent permission | `11-agent-permission-*` | (1) Real breadcrumb. (2) The closed "Technical details" disclosure (scope strings, SCREEN-CONTRACT). (3) Olive checkboxes and muted field borders instead of browser defaults. | close |
| 12 Collection share | `12-collection-share-*` | (1) Real breadcrumb "culture atlas / Collections / Quiet weekends". (2) Olive checkboxes. | close (near exact) |
| 13 Shared collection | `13-shared-collection-*` | (1) No "Save a discovery to my collection" button: it appears only when a shared item is a public catalog (Qloo) item, and the fixtures are not, honestly. (2) An "Example result" chip on each panel. (3) Real breadcrumb "culture atlas / Shared collection". | close |

## Deviations that cannot be removed, and why

1. **"Example result" labels.** Every seeded item is a fixture and is labeled as the spec requires. The mockups show no labels.
2. **No photographs of real films or performers.** Licensing rules forbid stand-ins and Wikimedia is unreachable. The film panel and the artists therefore use the text treatment. This shrinks the photographic weight of 03.
3. **Illustrations instead of photographs.** The images are project-original illustrations with the mockups' subjects and composition. They are flatter than the generated concept photography.
4. **Four destinations and a Settings link.** The v2 contract requires them (Discover, Library, Collections, Plans; Settings secondary). The v1 mockups predate them.
5. **44 px targets.** Pills and Save chips keep the mockups' smaller visible surface inside 44 px hit areas. Buttons ("+ Capture", Save, "New collection") are at least 44 px tall, where the mockups' are about 36–40 px.
6. **Written rules over generated details.** Where the images conflict with the design guide (overlay titles in 02, landscape crops, serif button labels, the filled lock, the plan's account icon), the guide wins, as its "Source precedence" section requires.
7. **The share viewer's save action.** It exists only for public catalog items. Showing it for fixture items would invent provider identity.

## Not changed

- The **v2 capture references 01–09** are outside this pass. Library and Uploads keep their reference 08 header and dock; see `docs/design-deviations.md`.
- **Responsive breakpoints, tokens and copy** are unchanged.

## Re-run after merging both fidelity branches (final gate)

The `fidelity/v2-capture` branch also changed the shared mobile bottom bar (12 px labels, 22 px icons) and `v2.css`, so this suite was run again on the merged tree (production build, worker, fresh database, `scripts/seed-fidelity.ts`): 30 of 30 captures pass at 1440, 390 and 320 px with no horizontal scroll. The mobile screenshots now show the v2 bottom-bar proportions under the v1 "+ Capture" header pill; the verdicts in the table above are unchanged (all close; 07 and 12 near exact).
