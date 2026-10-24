# Interest feed — feature map

Owner phone session 2026-10-22. Product name is always lowercase **culture atlas**. This map is the implementation contract for the living feed, card detail, source images, and the focus tool. Do not invent Qloo or model results. Do not fake portraits of people or films.

## Product loop

1. Sign-in (this test build uses a file mailbox; no email is sent).
2. Taste onboarding (min 3 picks). Completing starts `taste_seed`.
3. Building screen until a category is `ready`, then land on **Feed** (not Library).
4. Feed shows cards from `GET /v1/discoveries`. Pull-to-refresh asks for a new snapshot. Cards rotate in the visible grid from the pool.
5. Tap a card → `GET /v1/items/{id}` for sourced detail. If related is `none`, the phone explicitly `POST /v1/items/{id}/discoveries` and polls until cached. Similar cards float under the detail and are tappable.
6. Focus-on-area is a tool: arm it, drag a box, confirm. Analysis only runs on the owner's captures.

## Invariants

| Rule | Why |
| --- | --- |
| After onboarding, `GET /v1/discoveries` must not leave the phone with an empty grid because of a failed or empty refresh. | Owner refreshed and the feed disappeared. |
| Server tops a short personal pool up to `FEED_TOP_UP_MIN` (24) with labeled sample items. | Qloo/taste_seed can be slow or empty per category; samples are the honest fallback. |
| Client merge: if the response is empty or errors, keep the cards already on screen. Wipe only on `onboarding_required`. | Tunnel blips and empty rebuilds must not blank the UI. |
| Images are https URLs Qloo actually returned (`imageFromQlooProperties`) or project-original sample files. Never a generated stand-in of a person or film. | Owner asked for real artist/album/source pictures. |
| Destinations are https websites Qloo returned (`destinationFromQlooProperties`) or sample Wikipedia URLs. Never a guessed page. | Detail must have a real source to open. |
| Opening a card never silently generates related. Generation is `POST .../discoveries` (202). | Bounded, explicit, fail-closed. |
| Focus does not start on touch. Arm → box → confirm. Suggestion cards fail closed (nothing sent). | Owner rejected drag-to-analyze. |
| Native phones use `cna_` tokens. Only `NATIVE_OWNER_OPERATIONS` accept them on `/v1`. | Everything else is `scope_denied`. |

## Server data flow

```
onboarding complete
        │
        ▼
taste_seed job  ── Qloo insights per category (wear/play/watch/eat)
        │            copies properties.image + properties.website when https
        ▼
recommendations + discovery_items.display_metadata
        │
        ▼
rebuildFeedSnapshots()  →  feed_snapshots.ordered_item_ids
        │                    is_example_feed if personal pool is empty
        ▼
GET /v1/discoveries[?refresh=true]
        │  refresh=true discards the current snapshot and rebuilds from the pool
        │  (no live Qloo call on page fetch). For accounts it also enqueues
        │  interest_expand (15-minute wave). The worker appends new Qloo cards.
        ▼
DiscoveryCard[]  (image, title, subtitle, is_example, category)

GET /v1/items/{id}
        │  related_state: none | pending | cached
        │  related: at most 6 cached cards
        ▼
POST /v1/items/{id}/discoveries  →  discover_related job  →  poll GET item
```

### Key files

- `packages/domain/src/pipeline/taste-seed.ts` — first interest pass. One insights request per category from onboarding Qloo ids. Publishes cards, then rebuilds snapshots.
- `packages/domain/src/pipeline/interest-expand.ts` — living engine. Pull-to-refresh enqueues one time-bucketed Qloo pass that walks cards already in the pool as new signals and **appends** (never deletes). One category per 15-minute wave. Empty Qloo is a no-op; nothing is invented.
- `packages/domain/src/pipeline/discover-related.ts` — similar suggestions for one item. Qloo insights + eat creative dishes. Writes images/destinations the same way.
- `packages/domain/src/services/discovery.ts` — `getDiscoveries`, `createSnapshot`, `FEED_TOP_UP_MIN`, interleave, hide, food exclusions.
- `packages/domain/src/feed/samples.ts` — labeled example items when the personal pool is empty or short.
- `packages/domain/src/services/items.ts` — `getItem`, `startRelatedDiscovery`. Opening never starts a job.
- `packages/domain/src/services/display.ts` — `imageFromQlooProperties`, `destinationFromQlooProperties` (https only).
- `packages/providers/src/qloo/parse.ts` — `KEPT_PROPERTIES` includes `image`, `website`, `external`.
- `packages/domain/src/authz/native-owner.ts` — phone bridge, including item GET/POST.
- `apps/web/app/v1/discoveries/route.ts`, `apps/web/app/v1/items/[id]/route.ts`, `apps/web/app/v1/items/[id]/discoveries/route.ts`.

### Native owner operations (phones)

`GET /v1/discoveries`, `GET /v1/items/{id}`, `POST /v1/items/{id}/discoveries`, onboarding/taste, collections. Listed in `fixtures/native-contract/onboarding.json` `auth.operations` and Android `AtlasApi.ONBOARDING_OPERATIONS`.

## Client behavior

### Feed grid (iOS `FeedView`, Android `FeedScreen`)

- Keep `pool` (all known cards) and `shown` (visible window, ~12).
- `load(refresh:)` merges incoming ids in front; empty/error does not clear `pool`/`shown`.
- Pull-to-refresh calls `discoveries(refresh: true)`.
- While `is_example_feed` or `expansion.state == running` (the taste seed still publishing after onboarding: the first snapshot is a few seed cards topped up with examples), poll the first page (no `refresh`, so nothing is demoted) every `expansion.poll_after_ms` (else 8s), bounded; real cards float in and the examples they replace float out. Never needs a reload.
- Every 6s swap one shown card with one waiting in the pool (float in/out). Identity-based animation.
- Visible tiles also drift on a sine (Reduce Motion off). Related rail uses the same motion.
- Visual: `https` (or `/samples`) image, else typographic poster by category.

### Card detail

Loads `GET /v1/items/{id}` and shows:

- Title, subtitle, example label
- `reason` / `why_this.text` (plain language, no scores)
- `destination_url` as “Open source”
- References (qualified vs “Resembles …”)
- Add to a board
- **Similar** rail: cached related cards, floating, tappable → another detail

If `related_state == none`, POST discover-related then poll until `cached`/`none` (cap ~30s). Fail closed: never invent similar cards.

### Focus tool

Not drag-on-touch.

1. Tooltip: pinch zooms; Focus is a separate tool.
2. **Focus on an area** arms the tool (tooltip: only captured photos are analyzed).
3. Drag a box on the picture.
4. **Look at this area** confirms. **Cancel focus** disarms.
5. `kind != capture` → looking animation, then honest copy, nothing sent.
6. Capture → `ReadyNoticeCenter.explore`. Looking / Ready banners unchanged.

## Images (source rules)

Qloo’s documented `properties.image` is `{ url: "https://…" }` (often `images.qloo.com`). The adapter keeps `image` opaque; `imageFromQlooProperties` accepts that object or a string URL and rejects `http://` / relative paths. Cuisine **tags** and composer dishes have no picture field — leave them as posters. Do not invent album/place insight types just to get covers.

JSONB `display_metadata || excluded` overwrites keys, including `"image": null`. Writers must omit `image` when they have none (`forDisplayUpsert`). Capture analysis used to wipe a taste-seed picture on the same canonical item.

Owner override for this build: show https URLs Qloo actually returned, with attribution when present. The capability matrix still lists public Qloo image rights as pending — do not hotlink guessed portraits or sample illustrations as stand-ins.

Wikipedia REST thumbnails are parsed in the research adapter and not stored. Do not fetch them as a silent fallback until Commons file license is attached. Sample artists/films stay typographic until a personal Qloo card replaces them.

Related polling is `GET /v1/items/{id}` (`related_state`). Phones do **not** need `GET /v1/jobs/{id}`.

## What is still honest-unavailable

- Qloo images only appear when the live (or replay) entity actually had an https `properties.image`. Sample artists/films without a project-original picture stay typographic until a personal Qloo card replaces them.
- File mailbox: no real email.
- vision_photo / music.recognize / translations / Meta glasses: named blocks, fail closed.
- Wikipedia thumbnails are not fetched as a fallback. Do not hardcode guessed portrait URLs.

## Phone rebuild

iPhone-first: Debug bundle `com.aomg.cultureatlas`, team `U9XG3X374H`, physical UDID. Reinstall after this map’s client changes. Android parity is in the same sources; sideload when a device is attached.
