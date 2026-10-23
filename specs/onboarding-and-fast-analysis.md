# culture atlas spec amendment 2.2: taste onboarding and fast analysis

Version 2.2 · October 18, 2026 · Amends [the v1 build spec](cultural-discovery-build-spec.md) and the [capture platform v2 package](capture-platform-v2/README.md). Where this document conflicts with either, this document wins. Everything not mentioned here is unchanged.

Evidence for the analysis decisions is in [docs/analysis-latency-plan.md](../docs/analysis-latency-plan.md) (live measurements, October 17, 2026).

## Why this changes

Live tests showed a full photo reading can take 20–60 s on the routes tried first, and even the fast route needs a few seconds plus Qloo time. A new account also has no saves, so its feed is generic until the first analysis lands. The owner decided:

1. New accounts answer a short **taste questionnaire at sign-up**, with a **minimum of 3 picks**.
2. Those picks immediately seed a **personal, Qloo-backed feed**, so there is always something relevant to explore while photos are analyzed.
3. Photo analysis becomes **two-stage**: a fast first reading in about 2–5 s, then background enrichment.

## Changes to existing rules

| Where | Old rule | New rule |
| --- | --- | --- |
| v1 spec, "First visit" | "Do not present a preferences questionnaire before the first discovery." | Anonymous visitors still browse, try examples and upload without any questionnaire. **Creating an account** leads into the taste questionnaire before the account's first personal feed. |
| v1 spec, acceptance "Minimal interface" | "no questionnaire blocks first discovery" | No questionnaire blocks **anonymous** browsing, examples or a first upload. The sign-up questionnaire is required, with the resilience rules below. |
| v1 spec, "Recommendation and memory rules" | Global discovery uses all current explicit saves. | Unchanged; onboarding picks **are** explicit saves (see below), so they join global discovery like any other save. |
| v1 spec, "Performance targets" | First useful section within 10 s p50 / 20 s p95. | Unchanged target, now met by the stage-1 quick read. Stage-2 enrichment is not part of the target. |
| v2 CONCENTRATE.md, roles | `vision_photo`, `vision_video_frame`, `research_text`, `composer`. | Adds `vision_photo_enrich` (stage 2). Profiles gain an optional `reasoningEffort`. |
| v2 SCREEN-CONTRACT.md, inventory | Screens 01–13. | Adds screens 14–17 below. |

The rules that viewing, uploading or opening something is **not** an endorsement, that nothing found in a photo is saved automatically, and that no sensitive personal attributes are inferred, all stay in force.

## Taste questionnaire

### When it appears

- **New accounts:** immediately after account creation (web and native), before landing on the personal Discover feed. If the account was created to complete a save, the intended save is preserved and completed after the questionnaire (it counts as one pick).
- **Existing accounts with fewer than 3 explicit saves:** shown once at next sign-in, with the same minimum.
- **Anonymous visitors:** never. Browsing, examples and a first upload stay open without an account.
- **Afterwards:** editable any time at Settings → Taste (route `/settings/taste`), where picks can be added or removed. Removing below 3 is allowed there; the minimum applies only to completing onboarding.

### What people pick from

One screen on desktop (sections stacked), three short steps on mobile. Copy below is the exact copy; add it to the copy file.

1. **"Pick what catches your eye."** A grid of 12–16 licensed images (outfits, rooms, food, music, film moments). Each image is tied to 1–3 real Qloo tags resolved ahead of time. Tapping an image picks its tags.
2. **"Choose a few favorites."** Chips grouped by **Wear, Play, Watch, Eat**, 6–10 per group, each a real Qloo tag (for example Japandi, Mod revival, wabi-sabi, Sichuan cuisine, film noir). Below the chips, a search field, **"Add an artist, film, brand or place"**, using Qloo entity search; results show name and type only.
3. **"Anything to leave out?"** (optional) Dietary exclusions using the existing plan-constraint vocabulary. Exclusions do **not** count toward the minimum and are not taste.

A counter shows progress: **"3 picks to go"**, **"2 picks to go"**, **"1 pick to go"**, then **"Ready"**. The primary button **"Build my feed"** is disabled until at least 3 picks, and its disabled state explains why: **"Pick at least 3 so your feed starts with you."** Picks across the image grid, chips and search all count. An image that maps to several tags counts as one pick.

### What a pick is

- Every pick is an **explicit save** of a real Qloo tag or entity (a `DiscoveryItem` of kind `style`, `reference`, `artist`, `film`, `brand` or `food`, with the Qloo id in `external_ids`), created through the existing preferences save path with source `onboarding`. It appears in Saved for later like any save, can be unsaved, and contributes to taste exactly like other saves.
- Picks are never invented. The image grid and chips come from a **pre-resolved catalog** (`fixtures/onboarding/catalog.json`) holding real Qloo ids with their retrieval date, refreshed by an operator script. Search results come live from Qloo.
- Exclusions are stored in account preferences (`food.exclusions`), are readable and editable in Settings, apply as defaults in movie-night plans and filter Eat suggestions. They are never shared with providers as identity data.

### Resilience

- **Qloo down at sign-up:** the image grid and chips still work from the cached catalog, so onboarding can always be completed. Search shows **"Search is taking a break. Pick from the ideas above."** The seed job (below) is queued and retried; meanwhile the feed shows the labeled example cards.
- **Leaving mid-way:** picks already made are saved. The questionnaire resumes at next sign-in until the minimum is met.
- **Accessibility:** every pick is a real toggle button with a visible selected state (olive outline and check, not color alone), announced politely; the counter is a live region; the whole flow works by keyboard and at 320 px.

### Seeding the feed ("analysis at sign-up")

Completing onboarding starts a bounded **taste seed job** (`taste_seed`):

- Uses the picks as Qloo `signal.interests.tags` / `signal.interests.entities` and requests results for each category (brands for Wear, artists for Play, films for Watch, places/cuisines for Eat). At most 6 Qloo requests and at most 3 at a time (the hackathon key throttles bursts).
- Writes the results as recommendations into the account's feed pool and builds a new FeedSnapshot; the usual feed rules apply (interleaving, dedupe, hidden suppression, at most 2 consecutive cards of one category).
- While it runs, screen 15 shows **"Building your feed…"** with the user's picks as a quiet collage; it moves to Discover as soon as the first category is ready (target under 5 s), and other categories fill in progressively.
- Never fabricates: if Qloo returns nothing for a category, that category stays empty and the labeled examples fill the gap.

### Agents and privacy

- Onboarding picks are taste: readable only with `taste:read` and the existing grant rules. Exclusions are preferences: readable with `preferences:read`; changing them is an allowlisted ordinary preference under `preferences:write`.
- Onboarding state (started, completed, catalog version) is account data, deleted with the account.

## Fast two-stage photo analysis

Adopt the recommendation in [docs/analysis-latency-plan.md](../docs/analysis-latency-plan.md):

- **Stage 1 (quick read, interactive):** the `VlmQuickRead` schema (title, one-sentence interpretation, 3–5 specific candidates, quality), 512 px image, `maxOutputTokens` 600, 10 s timeout, reasoning effort `none`. Default qualified route: `anthropic/claude-haiku-5-5`. Its candidates go straight to Qloo resolution. Target: first useful section within 10 s p50 / 20 s p95 end to end.
- **Stage 2 (enrichment, background):** the `VlmEnrichment` schema (observations, visible text, confirmations with short rationale, up to 4 extra candidates, regions, uncertainty, competing subjects), 768 px image, `maxOutputTokens` 1200, 20 s timeout, same route by default. Merged deterministically into today's `VlmAnalysis` shape; it adds "Why this?" reasons and extra references without reordering or removing published cards.
- **Video frames** use stage 1 per frame and one stage-2 pass on the best frame.
- **Qloo resolution** is capped at 5 candidates and 3 concurrent requests per analysis.
- **Elorian** is not used for analysis. It stays an operator-only last resort (`MODEL_FALLBACK=elorian`) with a 90–120 s timeout, off by default.
- **Qualification** of both roles must be rerun live on at least 10 real, owned photos (with logos, text and clutter) before production; illustrations alone do not qualify.

## While the reading runs

- **Screen 16, "While we look":** during processing, a strip of 4–6 cards from the account's current FeedSnapshot (seeded by onboarding picks, so personal from day one; labeled examples for anonymous visitors). Fetching it never starts a new generation. It collapses into "More to explore" when the first result section lands; no animation under reduced motion.
- **Progressive reveal:** title and interpretation, then references, then category sections, as today.
- **Screen 17, ready notice:** if the user leaves the page, an in-app toast **"Your photo is ready"** with **"Open"** when the analysis completes (title badge while hidden); on native, a push through the existing push abstraction, only for analyses the user started.

## New screens

| Ref | Route | Contract |
| --- | --- | --- |
| 14 Taste picks | `/welcome/taste` (web), native onboarding | Image grid, category chips with search, optional exclusions, counter, disabled-with-reason primary button, Back. Desktop one page; mobile three steps with a step indicator. No bottom navigation. |
| 15 Building your feed | `/welcome/building` | Picks collage, "Building your feed…", auto-advance when the first category is ready; honest state if Qloo is unavailable ("We'll keep building in the background."). |
| 16 While we look | processing state of capture result and v2 media detail | Strip of 4–6 feed cards under the photo, collapses on first result. |
| 17 Ready notice | global toast / native push | "Your photo is ready" + Open; polite announcement. |
| 18 Taste settings | `/settings/taste` | Current picks grouped by category with remove, add more (same pickers), exclusions editor. |

No generated mockups exist for these. Before UI implementation, produce editable HTML mockups in `specs/capture-platform-v2/design/` using the existing tokens and v1 component rules (DiscoveryCard, FilterRow, chips as filter pills, olive selection outline and check), screenshot them at 1440 / 390 / 320, and implement 1:1 against those.

## Acceptance additions

| ID | Pass condition |
| --- | --- |
| ONB-01 | A new account cannot reach the personal feed without at least 3 picks; anonymous browsing, examples and first upload never show the questionnaire. |
| ONB-02 | Every pick is a SavedItem backed by a real Qloo id (catalog or live search), visible in Saved for later, unsavable, and counted once even when an image maps to several tags. |
| ONB-03 | With Qloo unavailable, onboarding still completes from the cached catalog; search reports unavailable; the seed job retries; no fabricated cards. |
| ONB-04 | The seed job makes at most 6 Qloo requests with at most 3 concurrent; the first category appears on Discover within 5 s p50 on the deployed demo. |
| ONB-05 | Exclusions apply as plan defaults and filter Eat suggestions; they never count as picks. |
| ONB-06 | Existing accounts with fewer than 3 explicit saves see the questionnaire once at next sign-in; others never do. |
| ONB-07 | Keyboard, screen reader, 320 px and reduced motion pass on screens 14–18; screenshots match their HTML mockups. |
| FAST-01 | Stage-1 quick read p50 ≤ 3 s and p95 ≤ 6 s of model time on ≥10 real owned photos; first useful section ≤ 10 s p50 / 20 s p95 end to end. |
| FAST-02 | Stage-2 enrichment never reorders or removes published cards; vetoes only lower certainty; failures leave stage-1 results intact. |
| FAST-03 | Reasoning effort is sent only when the qualified profile sets it; both roles are qualified with real artifacts before dispatch. |
| FAST-04 | "While we look" never starts generation and shows only feed snapshot cards (labeled examples where applicable). |
