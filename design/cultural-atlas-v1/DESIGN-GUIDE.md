# culture atlas Visual Design Guide

This is the visual reference set for the consumer application in [the build spec](../../specs/cultural-discovery-build-spec.md). The direction is warm, photographic, and editorial. Users browse, save, collect, and create. Cultural research appears when requested, and implementation details remain in the separate demo inspector.

These are concept mockups for review, not working screens or evidence of live recommendations. The product name and wordmark are exactly “culture atlas”, in lowercase. Use the images for composition and this document for exact component dimensions, behavior, and readable copy. Production imagery and reference content must follow the source and licensing rules in the build spec.

## Screen references

| Mockup | Purpose |
| --- | --- |
| [Desktop discovery](mockups/01-discover-desktop.png) | Visual hierarchy, app shell, filtering and mixed discovery cards |
| [Collection detail](mockups/02-collection-desktop.png) | Mixed items, selection and creating an experience |
| [Movie night](mockups/03-plan-desktop.png) | Film, food and music composed into a useful result |
| [Mobile discovery](mockups/04-discover-mobile-v2.png) | Two-column cards and bottom navigation |
| [Save sheet](mockups/05-save-mobile-v2.png) | Saving into an existing or new collection |
| [Item detail](mockups/06-item-desktop.png) | A photo becomes related discoveries with optional deeper context |
| [Collections index](mockups/07-collections-desktop.png) | Covers, names, item counts and unfiled saves |

Open [the visual gallery](index.html) to review the set. Click a mockup to view it at full size. The original generation prompts are saved in `prompts.json`.

## Visual system

The canvas is warm ivory. Images retain their natural colors without a tint. Olive provides selected states and the primary action. Serif headings make this feel like a personal cultural collection; restrained sans-serif controls keep it usable. Avoid decorating the interface with claims, statistics, gradients, social activity, or technical labels.

Canonical tokens are stored in [tokens.css](tokens.css). Values are implementation choices derived from the concept direction, not measurements of an existing application. Their explicit values resolve minor variation between generated screenshots.

| Element | Value |
| --- | --- |
| Canvas | `#F8F6F1` |
| Primary text | `#252823` |
| Secondary text | `#606459` |
| Primary action | `#566347`, ivory text |
| Quiet control | `#EEEAE2` |
| Divider | `#DCDDD3` |
| Focus ring | `#405734`, 3 px with 3 px offset |
| Display type | Georgia, serif; 400 weight |
| UI type | system sans-serif; 400/500/600 weights |
| Desktop page heading | 56 px / 1.08; mobile 34 px / 1.12 |
| Item title | 20 px / 1.25 serif; mobile 17 px |
| Body and controls | 16 px / 1.5; compact caption 14 px |
| Spacing | 4, 8, 12, 16, 24, 32, 48, 64 px |
| Image radius | 16 px desktop, 12 px mobile |
| Button radius | 14 px; filter pills fully rounded |
| Primary control height | At least 44 px |

Use simple outline icons with consistent 1.75 px strokes at 20 px, rounded caps and joins. Icons needed: camera/add, bookmark, arrow, chevron, close, check, collection, plan, more and lock. Text labels remain visible for navigation and essential actions. Use the same icon family across all screens.

## Layout and components

Desktop has a 72 px header, 40–48 px page gutters, and a centered content width capped at 1600 px. The wordmark is left, navigation centered, Capture right. Active navigation uses an olive underline. Do not turn the header into a toolbar filled with search, provider status, or badges.

At 1024 px and above, use four discovery columns; five only when each card stays at least 240 px wide. At 768–1023 px use three. Below 768 px use two, 16 px outer gutters and a 12 px gap. For larger layouts use 16–24 px gaps. Image containers have bounded ratios from square to 4:5; individual photographic crops can vary, while row/reading order remains predictable. Preserve order for keyboard and screen-reader users. The mockups illustrate image priority; do not use CSS column reordering that separates visual and focus order.

DiscoveryCard is an image with a title immediately below, without an additional bordered card shell. Save sits at the upper right over the photo on a solid ivory surface. Keep its contrast independent of image brightness. Hide lives in an item menu/detail, not a second oversized button on every card. Titles are at most two lines; the grid contains no paragraphs.

FilterRow contains All, Wear, Play, Watch, Eat. All is selected on the mixed feed. Collection detail can filter All, Photos, Music, Films, Food, Style. Only supported filters are rendered. On mobile the row can scroll horizontally without scrolling the page horizontally.

CollectionCover is a bounded mosaic of one to four item images with a shared rounded outside edge and narrow internal gaps. Name and item count appear below; no public likes, follower counts or collaboration controls. The virtual Saved for later collection displays unfiled saves and cannot be renamed/deleted. Its item count is private functional information.

Selected collection cards have a subtle olive outline and check. A compact selection bar appears only after selection, containing the count and Make a movie night. Reserve space so it does not obscure cards or the mobile bottom navigation. Use explicit keyboard-accessible selection controls rather than making Save and selection fight over the same click target.

Desktop detail is an open two-column layout: large image left, name/actions/related discoveries right. Mobile uses a dedicated detail page with Back. Explore the references and Why this are quiet disclosure actions, closed by default. Full cultural pages reuse the same shell and typography with a narrower reading width, optional source disclosure and related cards. Do not add a diagram or evidence dashboard to these pages.

The save picker is a focused dialog on desktop and a bottom sheet on mobile. It contains recent collection rows, New collection, Save for later, and Save. The current target is clear. New collection opens a name input in the same surface. Save closes the picker and shows a short confirmation with Undo. Quick save to the most recent collection has an explicit Change destination affordance.

The movie-night page gives the film the largest visual area and places food/music beside it. Mobile stacks film, food, music and input thumbnails in that order. Change film, Change food and Change music update only their section. Artist rows are recommendations, not playback controls. Illustrative film/music/food content in the concepts is not an endorsement of a real Qloo result.

## Required states beyond the screenshots

| State | Treatment |
| --- | --- |
| Capture preview | Photo, optional crop, Discover button; no analysis settings panel |
| Processing | Preserve photo; one sentence and quiet skeleton cards; reduced-motion mode uses static placeholders |
| Partial discovery | Completed cards remain; small retry action for unfinished results |
| Empty collection | Short invitation, Add saved items and Discover actions |
| Plan selection | Two to five mixed items, optional instruction/exclusions, Familiar–Adventurous choice, create button |
| Saved confirmation | Brief toast with collection name and Undo; announce politely to screen readers |
| Agent connection | Account setting with collection choices and access controls, outside primary discovery flow |
| Demo inspector | Separate authorized route/view; never opens automatically |

Do not synthesize new marketing sections to fill empty states. Follow the build spec's error copy and data behavior. Reference pages remain available when research is supported; a resemblance is phrased as a resemblance.

## Motion and accessibility

Use 160–220 ms transitions for hover/selection and sheet entrance. Images do not zoom dramatically; no parallax or endless shimmer. Respect reduced motion. Every control has a visible focus state and at least a 44 px hit target. Bottom navigation reserves safe-area space. Dialogs trap focus, close with Escape, and return focus to the triggering Save button. Announce results and saves without reading the whole feed aloud.

## Instructions for building agents

Read the build spec and this guide before implementing. Use real HTML/CSS components and separate image assets; a generated screenshot is never the application UI. Implement the app shell, card, filter, collection cover, picker, selection bar, item detail and plan sections as reusable components. Use semantic headings and exact functional labels from this guide/spec. Do not reproduce accidental generated lettering or decorative product logos as verified application data.

Match the mockup's hierarchy, open layout, image framing, palette and visual density. The written tokens are canonical where images vary. Keep real text and controls selectable and responsive. Obtain appropriately licensed production media or generate standalone replacements that preserve each image's composition; do not slice a concept screen into clickable regions. No extra consumer explanations, technical badges or statistics may be added to fill space.

Check at 1440 px desktop and 390 px mobile, plus the 360 px minimum in the build spec. Compare screenshots with the corresponding mockups using image inspection. Review navigation, typography, spacing, colors, card framing, button placement, modal behavior and responsive order. A successful functional test does not substitute for visual comparison. Record deliberate changes rather than silently restyling.

## Source precedence

Visual review covered navigation/copy, image framing, typography, palette, saving, collection selection and mobile layout. Mobile Save controls were revised to use bookmarks and titles beneath images. Small remaining concept variations are resolved as follows: use canonical olive and sans-serif UI controls on every page; omit the extra account icon shown in the plan concept; put collection card titles beneath the image as on Discover instead of the collection concept's overlay; keep the save sheet's background identical to the actual discovery view. The collection detail uses three columns on desktop, while discovery and the wide collections index use four. Desktop music can use three small image cards, switching to compact rows on mobile. Movie details may overlay their single feature image with sufficient contrast; ordinary discovery titles stay underneath.

The saved references were inspected as images. No application implementation or interactive browser fidelity check is claimed by this concept handoff.

The build spec governs functionality and permissions. This guide governs tokens, component rules and exact interaction labels. Mockups govern the visual composition. If a generated detail conflicts with either written document, follow the written rule and record the difference. These concepts remain available for user revision; do not describe them as approved until the user accepts the direction.
