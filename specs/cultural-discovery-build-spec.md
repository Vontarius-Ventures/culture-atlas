# culture atlas App and Agent Service Build Spec

> Planned capture platform extension: [v2.1 design specification](capture-platform-v2/README.md). Covers independent multi-user camera/glasses capture, video/uploads, Concentrate, agent access and collection sharing. This is a design handoff; current implementation behavior is unchanged.

Version 1.3 • October 12, 2026 • Product name: culture atlas • Amended by [2.2: taste onboarding and fast analysis](onboarding-and-fast-analysis.md)

Use “culture atlas” exactly, in lowercase, for the consumer wordmark, app title and product references.

This specification defines the consumer app, cultural memory service, and hackathon demo. The product turns a photo into discoveries, lets users gather mixed interests into collections, and creates experiences from those collections. This is the implementation baseline; the product name is culture atlas. It supersedes the earlier virality concept for the initial build. “Collections” is the organizing term in the interface and implementation.

Visual implementation references are in the [design guide](../design/cultural-atlas-v1/DESIGN-GUIDE.md) and [mockup gallery](../design/cultural-atlas-v1/index.html). Read both before building the consumer interface. The guide defines the palette, typography, component rules and responsive layouts; this specification governs behavior and permissions.

## Visual design requirements

The design package is part of this build specification. Building agents must read the guide, inspect the relevant screen images, and use the [design tokens](../design/cultural-atlas-v1/tokens.css) before implementing the consumer interface. Preserve its image-led hierarchy, warm ivory canvas, olive actions, editorial headings, quiet controls and minimal copy. Use reusable native UI components and separate image assets; do not ship mockup screenshots as the interface.

| Surface | Required visual reference |
| --- | --- |
| Desktop discovery | [Discovery grid](../design/cultural-atlas-v1/mockups/01-discover-desktop.png) |
| Collections index | [Collection covers](../design/cultural-atlas-v1/mockups/07-collections-desktop.png) |
| Collection detail and selection | [Mixed collection](../design/cultural-atlas-v1/mockups/02-collection-desktop.png) |
| Item detail and related discoveries | [Item exploration](../design/cultural-atlas-v1/mockups/06-item-desktop.png) |
| Movie-night result | [Film food and music plan](../design/cultural-atlas-v1/mockups/03-plan-desktop.png) |
| Mobile discovery | [Mobile grid](../design/cultural-atlas-v1/mockups/04-discover-mobile-v2.png) |
| Mobile saving | [Collection picker](../design/cultural-atlas-v1/mockups/05-save-mobile-v2.png) |

This specification governs behavior and permissions; the design guide governs canonical tokens, component rules and copy; the images govern composition. Follow the guide's documented corrections where generated details vary. Extend unpictured states using the same components and the guide's state definitions. Record intentional deviations rather than silently restyling or adding consumer data panels. The mockups are design references and do not establish real provider results.

## Product promise

**Capture something you like. Discover more you will like.**

The consumer browses a visual discovery feed, saves appealing items into collections, and creates experiences from them. A collection can contain photos, styles, brands, artists, tracks, films, food ideas, and cultural references together. A cultural reference library supports exploration when requested. Personal agents use the same service and the collections the user grants them access to.

The consumer must never need to understand Qloo, embeddings, entity resolution, confidence scores, or API pipelines. The separate demo inspector makes the implementation visible to judges and developers.

## Audience and use cases

The first audience is curious people who collect visual inspiration from outfits, rooms, cafés, objects, and media. They want discoveries and ideas without organizing a research database themselves.

Primary tasks are capturing inspiration, browsing related discoveries, organizing mixed interests into collections, and creating a movie night from selected collection items. A personal agent can perform these tasks using an authorized account connection. Browsing and collecting should be satisfying even when the user never creates a plan.

Success means someone discovers a useful item, saves it, or uses a generated plan. Time spent reading evidence is not a primary success measure.

## Scope and release boundaries

| Capability | Hackathon release | Later release |
| --- | --- | --- |
| Image intake | Upload, mobile camera input, three supplied sample photos, World Sensor import | Continuous glasses sampling and additional sensors |
| Discovery | Mixed visual feed, item-to-item exploration, optional Wear/Play/Watch/Eat filters; bounded results per analysis | Travel, books, activities, shopping integrations |
| Collections | Create, rename, organize, remove; mixed saved items; private by default | Collaboration, public sharing and richer organization |
| Cultural reference pages | Concise sourced pages for identifiable references | Deeper multilingual research and richer reference navigation |
| Taste memory | Save, remove, hide recommendation, explicit correction | More preference controls and opt-in learning from behavior |
| Combination | Two to five mixed items from a collection; movie-night template | Dinner, standalone playlist, wardrobe, travel and other templates |
| Music | Artist recommendations; up to five verified tracks where a catalog adapter exists | Provider playlist creation and playback |
| Food | Dish ideas plus related cuisines or dining references | Verified recipes, local availability and bookings |
| Agent access | REST API, remote MCP adapter, independent demo agent | Additional third-party agent connections |
| Momentum | Optional provider signal in demo inspector | Consumer trend tools if useful |
| Virality | Deferred | Separate calibrated prediction product |

The release does not buy, book, publish, export a playlist into an account, or change another agent's memory automatically. Those are separate integrations with their own user instructions. Meta and Instinct are intended integration targets, not promised working integrations. The independently implemented demo agent proves the service boundary.

## Consumer experience

### Navigation and visual direction

Use three primary destinations: Discover, Collections, and Plans. Mobile has bottom navigation and a prominent Capture action. Desktop uses a compact navigation bar and a spacious card layout. Unfiled saves are accessible within Collections. The primary experience is responsive web; glasses capture remains in World Sensor.

Discover is a mixed grid of visual cards, with two columns on small screens and three to five on larger screens. Preserve each image's aspect ratio within bounded card heights. Use stable reading/focus order, explicit Load more pagination, and scroll restoration after closing a detail view. Every card offers Save and opens related discoveries. Optional category filters narrow the grid without replacing the mixed feed as the default experience.

Use a warm neutral background, dark readable type, one restrained accent, large images, generous spacing, and short editorial titles. Cards should feel like discoveries worth opening. Avoid metric dashboards, dense tag clouds, graph visualizations, and technical badges in the consumer interface. System fonts are acceptable; support reduced motion and accessible contrast. Screens must work from 360 px width upward without horizontal page scrolling.

### First visit

Home copy: “Find more of what you love.” Show a small curated visual grid alongside “Take a photo,” “Upload a photo,” and “Try an example.” Sample-backed discovery cards give users a starting point before uploading. A single short notice explains that submitted images are analyzed by AI services. Anonymous visitors never see a preferences questionnaire; creating an account leads into the required taste questionnaire defined in [amendment 2.2](onboarding-and-fast-analysis.md).

Examples cover an outfit, a room, and a café or table setting. They use owned or appropriately licensed images and independently reviewed references. An example immediately produces a real analysis when services are available. Any replayed result is visibly labeled “Example result.”

Visitors receive an isolated temporary session. Saving persistently, creating a collection, or connecting an agent prompts account creation; preserve the current capture and intended save when the session is claimed by the account. Anonymous photos/results expire after 24 hours. Do not show sign-in as a prerequisite to browsing or trying an example.

### Capture and results

1. Choose or take an image. Preview it and optionally crop before submission.
2. Submit using “Discover.” Display the photo with “Finding your next favorites…” while processing.
3. Show a short title, a one-sentence interpretation, and a mixed grid of discoveries. Offer Wear, Play, Watch, Eat as optional filters. Omit filters with no supported results.
4. Return up to three recommendations per supported category, at most 12 per analysis. Initially render six with Load more for the remainder. Each has a title, available licensed imagery or an attractive text treatment, a short reason in its detail view, and Save/Hide actions. Keep the grid visually light.
5. Offer “Explore the references” below the primary results. Offer “Save this inspiration” beside the photo.

A plausible reading uses language such as “A few vintage racing references stood out.” Exact identity claims require stronger evidence than resemblance. If the image has several competing subjects, ask one optional question: “What caught your eye?” with up to three short choices and “The whole photo.” The initial result must still be useful if the user skips it.

Do not automatically save everything found in a photo into the user's taste profile. Viewing, uploading, or opening a reference alone is not an endorsement.

### Recommendation detail

Open a focused detail sheet or mobile detail page with the item, a short explanation, Save, related discoveries, and an external link when a verified destination exists. “Why this?” reveals a plain-language reason and optional sources. No raw scores appear here. Selecting a related item continues exploration across categories while preserving a back path and scroll position.

Related discoveries use the selected item's canonical entities/tags as anchors. Start with a cached set of at most six results across supported categories. Only an explicit “Discover more” action starts another bounded job; opening a card never triggers unlimited background generation. Hide affects the user's feed and related results immediately. A click or prolonged view alone does not change taste memory.

Wear returns brands or style directions, not invented SKU availability or prices. Play returns artists, with verified track picks only when available. Watch returns films with title/year and an optional verified information link; streaming availability requires a separate current source. Eat returns dish ideas and cultural connections; recipe generation and nutrition claims are outside this release.

Food preferences can be entered before generating a plan. Enforce stated exclusions in ingredients and avoid asserting that an idea is allergen-free. Provider recommendations are hints, never proof about ingredients.

### Cultural reference pages

A page opens only when requested and contains: name, short overview, up to three sections about context or influences, related discoveries, and expandable sources. Keep the initial explanation under 150 words and the full initial page under 500 words. Treat this as a growing reference library; never promise that one photo reveals every influence.

Reference types include named objects, creators, works, brands, styles, traditions, places, and cuisine. Distinguish a depicted object from a stylistic resemblance. Recognizing an aesthetic does not establish authenticity, provenance, or the identity/culture of a person in the image.

Users can correct a match with “Something else?” Correction invalidates affected recommendations and queues a new analysis version. Save the user's correction privately; do not overwrite global reference facts.

### Collections and saving

Save opens a compact collection picker showing recent collections, “New collection,” and “Save for later.” Creating a collection requires only a name, capped at 80 characters; a description is optional. Remember the last destination for quick saves, show a short confirmation with Undo, and allow an item to belong to multiple collections. Saving for later leaves the item unfiled. Save a stable item identity so the same film or brand does not create duplicate cards in one collection.

Collections shows cover mosaics, names, and item counts. Opening one displays a mixed visual grid with optional type filters and a “Make something” action. Users can rename a collection, edit its description, reorder items, add an existing saved item, remove a membership, or delete the collection. Removing from one collection preserves other memberships and the saved item. “Unsave everywhere” removes the endorsement and all memberships. Deleting a collection moves items with no remaining memberships to unfiled saves. Hide is a separate recommendation action.

All collections are private in the initial release. There are no public profiles, follower counts, comments, collaboration, or public collection links. Collection organization does not require an explanation of cultural data.

### Creating from a collection

“Make something” opens the available template picker. The first release has “Movie night”; later templates add playlist, dinner, and style direction. Never show an unavailable template as a working action. Movie night accepts two to five selected items from the collection, including captures, films, artists, brands, dish ideas, and references. For larger collections, let the user select up to five and suggest a default diverse selection. One captured photo plus one saved artist is a valid input.

Allow users to mark at most one selected film as “Use this movie”; otherwise it is an inspiration rather than a fixed choice. Other selected items guide the plan, not factual claims about historical connection. If an input lacks usable cultural anchors, offer another item and do not silently invent them.

The plan form has an optional short instruction, dietary exclusions, and a Familiar ↔ Adventurous control with default Balanced. Implement control values as familiar, balanced, adventurous. These are product preferences rather than claims about model certainty.

The result contains one recommended film, two alternates, up to three dishes, and music for before/after the film. Verified tracks are optional; an artist mix is an acceptable music result. Show a short title, one sentence about the combination, and actionable items. Allow replacement of the film, food, or music without regenerating the rest. Save the plan and retain its versions.

Combining items preserves their distinct cultural context. Suggestions that mix influences must describe the combination as a creative choice, without inventing a historical relationship. If one selected item contributes little, explain it briefly in the optional rationale and offer to change the plan. A plan retains a snapshot of its selected items, anchors, constraints, and collection revision; later reordering or membership changes do not silently change an existing plan. Regenerate is an explicit action.

### Error and empty states

| Condition | Consumer behavior |
| --- | --- |
| Unsupported or oversized image | Explain the accepted formats/size and keep the selection available |
| Blurred image or no useful subject | “Try a clearer photo, or tell us what caught your eye.” |
| Ambiguous match | Offer short alternatives; avoid blocking the whole result |
| Qloo unavailable | Retain reference results; say “Related discoveries are taking longer.” Provide retry |
| Research unavailable | Return supported discoveries; omit unverified historical text |
| Partial categories | Show completed categories and one unobtrusive retry action |
| No collections | Show unfiled saves if present; offer “Create a collection,” examples and Capture |
| Empty collection | Offer “Add saved items” and “Discover”; disable plan creation until two usable items are selected |
| World Sensor offline | Show last import status in connection settings; upload/camera remains available |
| Duplicate submission | Reuse the existing job and avoid duplicate cards |

## System architecture

Implement a modular TypeScript service and responsive React/Next.js application in a separate repository. Use PostgreSQL for records, private S3-compatible storage for images, and a database-backed job worker. Pin dependency versions during implementation. Use SQL migrations and a shared schema library for validating API/tool/model input and output.

Modules are Capture Intake, Cultural Compiler, Reference Research, Qloo Adapter, Discovery Feed, Collections, Recommendation Composer, Taste Memory, Agent Gateway, and Demo Inspector. Consumers call application services; provider-specific payloads stay inside adapters. Frontend, REST, and MCP use the same authorization and domain functions.

Suggested repository layout: `apps/web`, `apps/worker`, `packages/domain`, `packages/providers`, `packages/agent-gateway`, `db/migrations`, `fixtures`, and `docs`. Keep the Sensor repository independent.

VLM and text/research providers must be configurable. Select and pin the actual models before implementation based on image support, structured output, cost, and latency. API keys stay server-side. An environment example documents required names without real values.

## Cultural compilation pipeline

1. Validate actual image bytes, decode safely, apply orientation, strip unnecessary metadata, and produce a derivative bounded to a 2048 px long edge. Accept JPEG, PNG, WebP, and HEIC when the decoder supports it; otherwise show conversion guidance. Upload limit is 15 MiB, with a decoded pixel limit of 40 megapixels. Store original only when required by the selected intake policy.
2. Create a capture and asynchronous job. Cache/reuse by owner, image hash, chosen focus, and compiler version. Hashing never exposes another user's result.
3. Ask the VLM for structured observations, visible text, candidate references, supporting image regions, and uncertainty. Text in images is input data and cannot alter system/tool instructions.
4. Resolve up to eight strongest candidates through Qloo entity/tag lookup. Preserve unmatched descriptive observations. Select at most five useful anchors. Use named interests that the user confirmed when the visual evidence is weak.
5. Research up to five reference pages using primary or authoritative sources. Extract individual claims and source URLs. Clearly separate descriptive visual analysis from sourced history. When support is missing, omit the factual claim or retain it as a qualified interpretation.
6. Query Qloo for supported recommendation categories using real returned IDs. Capture request context, result ranking, and explainability when available. Do not average affinity values from different queries.
7. Compose display recommendations from provider candidates. Hard constraints and hidden items are filtered before presentation. Store evidence linking each item to capture references and provider results. VLM-only creative suggestions remain explicitly identified internally and in the demo inspector.
8. Publish completed sections progressively. Keep partial outputs useful and allow targeted retries. A failed stage must not corrupt already completed capture data.

Bound each job to at most 12 Qloo requests, five researched references, and two retries per provider stage. Retry transient errors with exponential backoff and jitter; honor provider rate limits. Make limits configurable. Skip lower-priority categories/research when a cost or request budget is reached.

## Qloo integration contract

Use `/search` for canonical entities, `/v2/tags` for valid taxonomy entries, and `/v2/insights` for related entities/tags with selected interest inputs. Explainability can identify contributing input entities. Qloo supports structured cultural inputs; VLM image interpretation precedes those inputs. [Official API guide](https://github.com/qloo/docs-public/blob/main/reference/insights-api-deep-dive.md), [entity search](https://github.com/qloo/docs-public/blob/main/reference/get-search.md), [tag lookup](https://github.com/qloo/docs-public/blob/main/reference/get-tags.md).

Qloo affinity is relative relationship strength normalized per query. Retain scores and query context for internal ranking and inspection; never relabel them as adoption, identity, or virality probabilities. [Score interpretation](https://github.com/qloo/docs-public/blob/main/docs/interpreting-affinity-scores.md).

Qloo does not establish every historical claim, identify a photographed garment by itself, supply every dish/recipe or song, or guarantee current product/streaming availability. Films and brands can be direct resolved candidates. Artist affinities can anchor music selection; cuisine/place references can guide dish ideas through the composer. Supplementary catalog/research evidence must remain distinguishable from Qloo evidence.

Optional trend requests use entity history or supported trending routes only after verifying access. Trend unavailability must not block discovery. [Trend overview](https://github.com/qloo/docs-public/blob/main/reference/api-overview.md).

Before implementing dependent features, run contract probes with the hackathon key: resolve one brand, look up one relevant tag, request artist/film/brand/place results, inspect explainability, and verify rate limits and permitted response storage. Maintain a capability matrix. Treat undocumented or inaccessible capabilities as unavailable, and adjust adapters without presenting simulated results as live data. Confirm data/image display and caching rights before publicly retaining provider material.

## Recommendation and memory rules

Within each provider query, order by its ranking; apply explicit exclusions first. Across sources, combine ranked candidates using rank-based fusion rather than raw-score averaging. Add diversity by category and reference origin. Familiar favors the strongest connections; Adventurous draws from a wider set of supported candidates while retaining at least one meaningful anchor. These rules require fixture evaluation before release.

Every displayed item has either a traceable provider connection or a creative rationale based on supported references. The agent must not fabricate Qloo results to fill three cards. Fewer good results are acceptable.

Saving an inspiration creates an explicit endorsement of the capture as a whole and its current selected focus; its resolved anchors contribute weighted taste inputs. Saving an individual item endorses only that item. Saving it into additional collections never multiplies its global taste weight. Collection-specific recommendations use that collection's items; global discovery uses all current explicit saves. Collection names/descriptions can guide a requested plan but do not establish new facts or preferences.

Hide creates an exclusion for that item, not a dislike for an entire culture/category. Undo/unsave updates the derived profile immediately. Removing a collection membership affects the collection's context but preserves the global endorsement. Corrections are versioned. There is no automatic inference of sensitive personal attributes.

The Discover feed draws from reviewed sample items for new users and a bounded pool of supported recommendations connected to explicit saves for returning users. It interleaves categories, deduplicates canonical items, suppresses hidden items, and avoids more than two consecutive cards of one category when alternatives exist. A cursor carries feed revision and position for stable pagination. Fetching another page consumes existing results, not a new generation job; refresh or explicit discovery can refill the pool. Do not import another user's private capture into a feed.

## Data model

Use UUID primary keys, UTC timestamps, owner checks on all private records, and soft deletion only where needed for job coordination. External references use explicit provider namespaces.

| Record | Required fields and relationships |
| --- | --- |
| Account | id, auth_subject, created_at, preferences, retention_policy |
| Session | id, account_id nullable, expires_at; captures belong to one session or account |
| Capture | id, owner, source upload/camera/sensor/sample, private_object_key, hash, captured_at optional, received_at, focus, status, active_analysis_id |
| Analysis | id, capture_id, version, compiler_version, observations, candidates, section_statuses, warnings, created_at |
| Reference | id, canonical_name, type, external_ids, revision; share only public facts, never private image context |
| CaptureReference | analysis_id, reference_id, relation depicted/resembles/user_selected, evidence_region, certainty, resolution_status |
| Claim | id, reference_id, text, claim_type factual/interpretive, source_ids, reviewed_at, revision |
| Source | id, URL, title, publisher, retrieved_at, allowed_display_metadata; do not store entire articles by default |
| ProviderQuery | id, analysis_id/plan_id/discovery_job_id as mutually exclusive parent, provider, sanitized request, results, retrieved_at, cache_expiry, query_context, trace_id |
| Recommendation | id, analysis_id/plan_id/discovery_job_id as mutually exclusive parent, discovery_item_id, category, title, external_ids, display_reason, source_ids, provider_query_ids, contributing_reference_ids, destination_url optional |
| DiscoveryItem | id, owner or public sample flag, kind capture/style/brand/artist/track/film/food/reference, canonical_key, capture_id/reference_id optional, display_metadata, resolved_anchor_ids, created_at; recommendations point to these stable identities |
| SavedItem | id, owner, discovery_item_id, saved_at; unique owner+item; absence of memberships means unfiled |
| Collection | id, owner, name, description optional, revision, created_at, updated_at; private visibility |
| CollectionItem | collection_id, saved_item_id, position, added_at; unique collection+item; owner must match |
| FeedSnapshot | id, owner/session, taste_revision, ordered_item_ids, created_at, expires_at |
| PreferenceEvent | id, owner, action save/remove/hide/unhide/correct, target_type, target_id, payload, created_at |
| Plan | id, owner, source_collection_id optional, selected_item_ids, constraints, exploration, status, active_version |
| PlanVersion | id, plan_id, version, collection_revision, input_snapshot with item/anchor IDs and revisions, fixed_film_id optional, film/food/music sections, rationale, recommendation_ids, created_at |
| Job | id, owner, type, state, stage, attempt, available_at, lease_expiry, budget, error_code, result_id |
| AgentConnection | id, owner, client_name, hashed credential, scopes, allowed_collection_ids, library_access none/selected_collections/all, expires_at, revoked_at |
| SensorConnection | id, owner, configured origin, encrypted viewer credential, cursor, enabled, last_success_at |

Derived taste profiles are rebuildable views over current preferences. Include profile revision in recommendation cache keys. Keep analyses immutable; activate new versions after corrections. A factual reference can be shared publicly while user associations remain private.

Use canonical provider IDs to merge duplicate brands, artists, tracks and films within an owner. Captures stay distinct by capture ID; food/style ideas without canonical IDs use a stable normalized identity tied to their supported references. A DiscoveryItem retains originating evidence links; Recommendation stores context-specific reasons and rank. Expanding an item's related discoveries uses a separate discovery job/context rather than pretending it belongs to a capture or plan. ProviderQuery and Recommendation therefore accept a discovery_job_id as an alternative parent. A public reference may appear in many private collections without exposing their associations.

## REST service

All routes use `/v1`. Validate JSON against versioned schemas; reject unknown mutation fields. Browser sessions use secure HttpOnly cookies and CSRF protection. Agent calls use scoped bearer credentials. Anonymous sessions can only access their own temporary records and cannot access agent or Sensor connection routes.

| Route | Behavior |
| --- | --- |
| `POST /captures` | Multipart image or owned upload ID, optional focus; returns 202 with capture_id/job_id |
| `GET /jobs/{id}` | State, public progress stage, completed sections, structured error |
| `GET /captures/{id}` | Active analysis, consumer summary, references and recommendations |
| `POST /captures/{id}/corrections` | Candidate correction/focus update; queues new analysis, returns 202 |
| `DELETE /captures/{id}` | Deletes private media/associations and derived personal data |
| `GET /references/{id}` | Concise reference content and claim sources; no other users' context |
| `POST /preferences` | Explicit save/hide/remove/unhide action with target ID |
| `GET /saved` | Cursor-paginated inspirations/items |
| `GET /discoveries` | Stable cursor-paginated mixed feed, optional category filter; no implicit generation |
| `GET /items/{id}` | Owned or approved public item detail and cached related results |
| `POST /items/{id}/discoveries` | Explicit bounded related-discovery job; returns 202 |
| `GET /collections` | Owned collections with covers/counts; agent visibility restricted to grants |
| `POST /collections` | Creates a private named collection |
| `GET /collections/{id}` | Collection revision and cursor-paginated mixed items |
| `PATCH /collections/{id}` | Updates name/description with expected_revision |
| `DELETE /collections/{id}` | Removes collection/memberships; retains saved items and existing plans |
| `PUT /collections/{id}/items/{item_id}` | Saves the accessible item if needed and adds membership idempotently |
| `DELETE /collections/{id}/items/{item_id}` | Removes this membership only |
| `PUT /collections/{id}/order` | Ordered membership IDs and expected_revision; same members exactly once |
| `GET /taste` | Current explicit interest summary and revision |
| `POST /plans` | Collection ID and two to five member item IDs, template movie_night, optional fixed film, constraints, exploration; snapshots inputs and returns 202 |
| `GET /plans/{id}` | Current plan and section states |
| `POST /plans/{id}/replacements` | Section and optional instruction; queues replacement preserving other sections |
| `DELETE /plans/{id}` | Removes private plan |
| `POST /agent-connections` | Creates an account-owned connection with selected scopes; credential shown once |
| `DELETE /agent-connections/{id}` | Revokes immediately |
| `POST /sensor-connections` | Operator setup using an allowed origin and encrypted viewer credential |
| `DELETE /sensor-connections/{id}` | Disables import and removes credential |
| `GET /demo/traces/{job_id}` | Authorized developer/demo-owner trace; never general public traces |

Example plan request: `{collection_id: collection_uuid, expected_revision: 3, item_ids: [photo_item_uuid, artist_item_uuid], template: "movie_night", constraints: {dietary_exclusions: ["peanuts"], instruction: "A relaxed evening"}, exploration: "balanced"}`. Optional `fixed_film_item_id` must identify one of the selected film items. Validate membership, ownership/access and usable anchors before starting. A stale collection revision returns 409 and invites review of the changed inputs. Constraint strings are treated as user input, validated for size, and never executed.

`GET /saved` exposes canonical saved items and membership IDs. `POST /preferences` save/remove actions create/delete SavedItem; remove means unsave everywhere and clears memberships. Collection membership deletion does not call preference remove. Concurrent collection edits use expected_revision; successful mutations increment it. Collection deletion detaches source_collection_id from saved plans while retaining the plan's input snapshot. An item deletion for privacy follows the stricter lifecycle rules below.

Mutation requests accept `Idempotency-Key`. Scope reuse to principal+route, retain request hash and response for 24 hours, and return conflict for a changed payload under the same key. Standard errors contain `code`, safe `message`, `retryable`, and `request_id`. Use 400 invalid input, 401 unauthenticated, 403 scope denied, 404 missing/not-owned, 409 conflict, 413 upload limit, 429 quota, and 503 temporary outage. Never disclose private record existence through authorization errors.

Jobs use queued/running/partial/complete/failed/cancelled states with leased worker ownership. The browser polls at 1.5 seconds while active, backs off after 15 seconds, and stops when complete or the tab is hidden. Same input and version reuse an existing job. Losing a worker lease permits safe recovery; stage writes are idempotent.

## Agent interface

Publish a remote MCP endpoint backed by the same domain services. The first demo uses manually issued, expiring account connection tokens. Document bearer configuration for compatible clients; do not claim universal MCP client support. Add standards-compliant OAuth discovery/consent for broad public agent adoption after the controlled demo.

Scopes: `captures:read`, `captures:write`, `collections:read`, `collections:write`, `taste:read`, `taste:write`, `plans:read`, `plans:write`. Defaults are read-only; the account owner chooses write scopes and either specific collections or the whole library. Granting selected collections permits only their items, compiled context, related discoveries, and plans derived entirely from granted items. Do not expose unfiled saves, other collections, or the global taste profile through a selected-collection connection; `get_taste` must be collection-scoped in that mode. New collections do not automatically join a selected grant. Removing an item or revoking a collection grant removes that access immediately, including access to dependent plans. Agents may create a collection only with collections:write and whole-library access; the new collection is covered by that grant.

A write scope authorizes an action type, but tool instructions still require an explicit user preference before saving a like/dislike. Adding an already saved item to a granted collection requires collections:write; adding an unsaved item also requires taste:write. Plan creation requires plans:write, collections:read, and access to all selected inputs. Connection setup explains the readable/writable data and supports immediate revocation. Capture scopes on a selected-collection connection apply only to captures in those collections or uploads created by that connection; they do not bypass its grant restrictions.

A selected-collection agent cannot perform global unsave, global hide/unhide, or delete a capture because those actions can affect ungranted contexts. It can remove a membership from a granted collection with collections:write. Global preference removal, global feed access, and destructive capture actions require whole-library access plus the corresponding write scopes. All item, job, cached-result, trace, and plan reads enforce the current grant rather than trusting an ID obtained earlier. Allowed related discoveries remain tied to their granted origin; revealing them never reveals private associations outside that grant.

Tools: `analyze_capture`, `get_job`, `get_capture`, `explore_reference`, `get_taste`, `record_preference`, `list_collections`, `get_collection`, `create_collection`, `add_collection_item`, `remove_collection_item`, `discover_related`, `create_plan`, `get_plan`, and `replace_plan_section`. Inputs/outputs mirror REST schemas, including collection IDs/revisions and mixed item IDs. `analyze_capture` accepts an owned upload ID; a client uploads bytes via REST rather than passing arbitrary URLs or filesystem paths. Tools return concise structured results with IDs and optional evidence references. Job-starting tools return immediately and instruct the client to check `get_job`.

Default agent responses include useful content, short reasons, and `evidence_available`; expanded evidence is explicitly requested. Agents cannot query the global database for another user's memory, connect Sensor credentials through tool arguments, or change source facts. Scope violations, expired tokens, and revoked connections have matching REST/MCP behavior.

## World Sensor adapter

The existing Sensor implementation captures JPEG, persists photos locally, uploads assets, and exposes authenticated viewer list/content routes. Use that asset boundary rather than changing capture internals. [Sensor capture](https://github.com/Vontarius-Ventures/WorldCompilerSensor/blob/8639b3b52cc163074c7e4ebaf6e948ae2c4890df/WorldCompilerSensor/Wearables/MetaWearablesService.swift#L714), [shared asset API](https://github.com/Vontarius-Ventures/WorldCompilerSensor/blob/8639b3b52cc163074c7e4ebaf6e948ae2c4890df/Shared/Assets.swift).

For the demo, an operator configures a trusted relay origin and viewer credential server-side. An opt-in “Import new photos” connection polls committed `kind=photo` assets every 10 seconds while active. Deduplicate by connection+asset_id and verify bytes where a declared hash exists. Preserve captured_at separately from received_at. Paginate through newly seen assets; first connection imports only explicitly selected existing photos. Subsequent polls import new photos without treating them as liked.

The backend may not reach the private relay. In that case run a small outbound bridge beside it: fetch using the viewer credential locally, then upload to the public application using a restricted capture-write token. Do not expose the relay or viewer credential publicly. The bridge reuses the same deduplication key. Polling and bridge are implementation choices, not existing Sensor webhooks.

Allow only configured origins. Reject arbitrary URLs, redirects to internal/unapproved hosts, oversized responses, and unexpected content types. Capture works when analysis/import is offline; reconnect retries without duplicate results. Do not modify the Sensor evidence chain.

## Privacy and retention

Authenticated captures persist until deletion; users can choose to discard the photo after compilation while retaining selected references. Default agent access includes compiled results only; original-image access requires a separate explicit grant and is deferred for the demo. Storage is private and image links are short-lived. Strip location metadata unless the user separately supplies location for a feature.

Delete requests immediately revoke image access, remove preference links and personal recommendations associated with the capture, remove affected saved items/memberships and collection cover references, cancel unfinished jobs, and recompute taste. Independently saved canonical items supported by other evidence can remain, with deleted private context removed. Plans that depended on a deleted capture are removed for the initial release. Workers check deletion before publishing results. Shared public source facts may remain, without private associations. Physically purge application media/records within 24 hours; encrypted backup expiry is at most 30 days and disclosed in settings.

Do not use photos or private preferences for training. Logs contain IDs, timings, request counts, and safe errors, not raw images, credentials, or complete private prompts. Provider retention behavior must be documented before release; do not promise deletion from providers beyond their actual supported policy.

## Demo inspector and presentation

The consumer demo is the real app. An owner-controlled “Show how it works” view displays the photo, visual observations, resolved Qloo IDs, relevant query inputs/results, source-backed references, saved taste changes, and the separate agent's service calls. Redact tokens and private deployment details. The inspector is optional and never appears automatically in the consumer flow.

Demonstration sequence: capture/import an outfit; browse its mixed discoveries; save the photo and an artist into a named collection; analyze a room and add it; open the collection and make a movie night from selected mixed items; grant the separate demo agent access to that collection and ask it to suggest a replacement film. Open the inspector to show Qloo's contribution and the shared service boundary.

At least one displayed discovery in each live demo path must be traceable to a successful Qloo response. If Qloo is down, show replay/sample labeling and partial state honestly. An optional comparison removes Qloo signals and shows which recommendations change; label it a feature comparison, not a measured performance claim.

## Performance and operational targets

These are build targets, measured on the deployed demo: show an initial useful section within 10 seconds at p50 and 20 seconds at p95; finish bounded full analysis within 45 seconds at p95; saved reference views load within one second at p95; plans finish within 25 seconds at p95. Upload transfer time is measured separately. After 45 seconds preserve available sections and show retry for unfinished work. Enforce a 60-second worker deadline per analysis attempt.

Start with five concurrent jobs, ten analyses and five plans per anonymous session/day, and configurable account quotas. Add per-IP abuse limits without merging anonymous users' data. Provider budgets and circuit breakers prevent unlimited generation; images are not retained in rate-limit logs.

Track completion rate, time to first useful result, save rate, collection creation/revisit, related-discovery use, plan creation/use, corrections, provider errors, cost per analysis, and Qloo-supported result coverage. Product events exclude image contents, collection titles/descriptions, and sensitive preference details. Fixture acceptance thresholds below are quality gates, not claims about real-world accuracy.

## Verification and acceptance

| Area | Release acceptance |
| --- | --- |
| Consumer flow | A new visitor can browse, try an example, upload, save to a collection after account creation, select mixed items, and create a plan on mobile and desktop |
| Visual discovery | Mixed grid, category filters, stable pagination, back/scroll restoration and related items work; Load more alone incurs no new provider generation |
| Design fidelity | Compare rendered screenshots for all seven reference surfaces against the design package; check hierarchy, copy, typography, palette, image framing, controls and spacing; follow documented corrections and record intentional deviations |
| Collections | Mixed items, multiple memberships, rename/reorder, duplicate-save prevention, Undo, unfiled saves, membership removal and unsave-everywhere match the specified behavior |
| Minimal interface | Main cards have no raw scores/provider terminology; sources are optional; no questionnaire blocks anonymous browsing, examples or a first upload (sign-up questionnaire per [amendment 2.2](onboarding-and-fast-analysis.md)) |
| VLM boundaries | Tested on clear, blurred, ambiguous, multicultural, logo-free, and adversarial-text images; no image instruction triggers tools |
| Reference quality | Review 20 licensed test images; every displayed historical claim has a supporting source; uncertain identifications stay qualified |
| Qloo grounding | Every item labeled internally as Qloo-derived links to a real returned candidate/query; unsupported categories remain partial |
| Preferences | Upload alone never changes taste; save/remove/correct/hide produces the specified scoped effect |
| Combination | Photo+artist and film+food inputs work; every selected item contributes or is disclosed as weak in optional rationale; fixed film/exclusions enforced; input snapshots survive collection edits; section replacement preserves other sections |
| Resilience | Inject 429/timeouts/empty results into every adapter; bounded retries, recoverable jobs, no fabricated results |
| Tenant isolation | Two accounts and two anonymous sessions cannot read/mutate each other's captures, collections, saved items, plans, jobs, preference records, or traces |
| Lifecycle | Delete during a running job prevents publication and removes dependent private data; revoked agent tokens fail immediately |
| Agent integration | Independent client reads a granted collection, discovers related items, creates a plan, and replaces one section; ungranted/unfiled items and global taste stay inaccessible; membership/grant revocation restricts dependent plans immediately |
| Sensor | Real or qualification-environment photo imports end-to-end; offline recovery and pagination cause no skipped new assets or duplicates |
| Accessibility | Keyboard flows, focus handling, screen-reader labels/status, contrast, reduced motion, and 360 px layout checked |
| Demo packaging | Public licensed code, complete setup instructions, externally accessible demo, sample inputs, and honest provider status |

Use unit tests for preference folding, collection membership/ordering and identity deduplication, ownership/grant checks, rank fusion, idempotency, and job transitions; adapter contract tests for provider shapes; integration tests for isolation/deletion/revocation and mixed-item plan snapshots; browser tests for the main journeys. Keep a real-provider smoke check separate from replayed fixtures. Review cultural claim support manually; model agreement alone is not validation.

Visual acceptance requires browser-rendered checks at 1440 px desktop, 390 px mobile, and the 360 px minimum. Inspect implementation screenshots alongside the corresponding mockups; functional checks alone do not satisfy design fidelity. Check additional unpictured states against the guide's component/state rules. Fix accidental clipping, unreadable text, incorrect control labels and unexplained layout/color drift before release.

## Build sequence

1. Read the design package and inspect its seven reference screens; establish shared tokens and component inventory. Complete provider/access probes, image licenses, deployment choice, and repository setup. Verify Qloo storage/display rights and choose model providers. Deliver the capability matrix and environment template.
2. Upload → async compilation → one real Qloo-derived category → visual discovery grid and item detail. Deploy the vertical slice immediately.
3. Mixed discovery/related exploration, reference research, partial states, account/session ownership, and collections with saving/reordering/removal.
4. Collection selection with mixed items → movie-night composition → section replacement. Add evidence and quality fixtures.
5. REST/MCP connection tokens with collection grants and independent demo agent. Validate permissions before enabling writes.
6. World Sensor adapter/bridge, inspector, accessibility, quotas, deletion checks, load/latency measurement, and submission packaging.

Complete phases in order; later work must not block the usable upload experience. Finish the public demo before optional tracks, trends, or third-party agent integrations. The hackathon lists October 30, 2026 at 11:45 p.m. EDT and requires an externally published application plus public licensed source. [Official requirements](https://qloo.devpost.com/).

## Definition of done

A consumer can browse useful visual discoveries, capture inspiration, organize mixed interests into private collections, and create a coherent movie night from selected collection items. A separate agent can use a granted collection through the same service. The inspector demonstrates real Qloo contributions and sourced references. The app is externally accessible, the public repository can be run from its instructions, and the release acceptance checks pass.

The consumer interface follows the linked visual design package, and desktop/mobile screenshot comparisons satisfy the design fidelity acceptance check.
