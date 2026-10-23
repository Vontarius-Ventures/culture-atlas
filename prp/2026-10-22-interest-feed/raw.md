> Factory brief. Source: owner phone session 2026-10-22. Next: implement (design folded — owner specified the product).

# Interest feed (iPhone-first)

Owner used culture atlas on the physical iPhone and rejected the current post-sign-in product.

## Requirements

1. **Sign-in honesty.** This test build uses a file mailbox, so no email is sent. Copy must not promise an inbox. The link is opened on the phone.
2. **Onboarding variety.** Step 1 currently stacks five wear photos before play/watch/eat appear. Interleave categories so the first screen has wear, play, watch, and eat. Step 2 currently fills with Wear chips (Japandi, Wabi-sabi…). Mix chips across Wear/Play/Watch/Eat above the fold. **Next turns olive** once 3 picks are selected.
3. **Home is the feed.** After onboarding, land on a living interest feed — not Library. Library stays for captures and boards.
4. **Visual-first Discover/Feed.** Cards are images (or honest typographic posters when no licensed picture exists — never a stand-in of a person or film). Not a text list.
5. **Rename Taste → Interests.** Feature name should signal a person's interests.
6. **Living feed.** Pull-to-refresh; poll when the example feed is still building; pinch-zoom images; highlight a region for analysis (captures only — suggestions fail closed, no invented Qloo/model results); a looking animation while AI works and a finished animation when it returns.
7. **Refresh never empties the grid.** If Qloo/seed has nothing new, keep the cards already shown (samples top up the pool). Client errors keep the previous grid.
8. **Interest engine.** `taste_seed` + rotating shown window. Cards float in and out. Real source images (Qloo https `properties.image`) and destinations (`properties.website`); never invented portraits.
9. **Focus is a tool.** Arm, drag a box, confirm. Tooltips. Not drag-on-touch.
10. **Card detail.** `GET /v1/items/{id}` for sourced copy + destination. Below that, similar suggestions that float and are tappable (`POST /v1/items/{id}/discoveries` then poll). See `feature-map.md`.

## Non-negotiables

- Do not invent Qloo or model results.
- Artists/films never get a fake portrait; use type-on-color if there is no owned picture.
- iPhone first (bundle `com.aomg.cultureatlas`); Android parity in the same factory pass.
- Do not push. Keys stay in gitignored `.secrets.env`.
