# Culture Atlas personal graph — build specification

Draft 0.1 · October 27, 2026 · Scoped against repository source; not implemented, deployed, or qualified

## 1. Build decision and outcome

Build a persistent, private interest graph for each account, seeded by the existing onboarding selections and updated by subsequent explicit saves and corrections. Use a shared graph of sourced cultural relationships to generate useful discoveries. Background workers continuously expand a bounded candidate frontier without turning recommendations into preferences.

PostgreSQL remains authoritative. The first delivery uses relational graph tables and existing workers; embeddings and Graphiti are optional follow-on components behind interfaces. No separate database per person is required.

This spec turns the [architecture proposal](ARCHITECTURE.md) into implementation scope. The [framework research](FRAMEWORKS.md) and [integration audit](REPO-AUDIT.md) provide supporting detail. In a conflict with those exploratory notes, this spec's explicit initial-release boundaries govern the proposed build. Existing Atlas permissions, qualification, privacy, and spend rules remain binding.

The user-visible outcome is: choose interests at onboarding, receive connected discoveries, refine those discoveries through ordinary selections, and inspect an honest explanation of why a discovery connects to the selected interests. The graph keeps learning from the person's actions and researching relevant cultural connections in the background.

## 2. Source baseline and dependencies

Repository: `Vontarius-Ventures/culture-atlas`.

- Main: `fb8a10ad774cd9135f284f96531b19ef08fc029e`.
- PR #7: open, unmerged; head `7188184d8ec8b7482652799d97608351188c377a`, branch `factory6/integration`.
- Main is the implementation baseline. The optional photo/style adapter depends on either a separately accepted subset of PR #7 or a subsequent compatible contract. This build does not require merging PR #7 wholesale.
- No deployed environment, live credentials, current database contents, or test execution were inspected. Findings below concern checked source only.

Pinned source references:

| Ref | Existing source | Verified behavior / integration consequence |
| --- | --- | --- |
| R1 | [services/onboarding.ts](https://github.com/Vontarius-Ventures/culture-atlas/blob/fb8a10ad774cd9135f284f96531b19ef08fc029e/packages/domain/src/services/onboarding.ts) | Picks use ordinary explicit saves; bundled tags count as one pick; completion and taste edits can queue seeding |
| R2 | [services/preferences.ts](https://github.com/Vontarius-Ventures/culture-atlas/blob/fb8a10ad774cd9135f284f96531b19ef08fc029e/packages/domain/src/services/preferences.ts) | Preference events, taste revision, saves/hides and rebuilds already exist |
| R3 | [services/taste.ts](https://github.com/Vontarius-Ventures/culture-atlas/blob/fb8a10ad774cd9135f284f96531b19ef08fc029e/packages/domain/src/services/taste.ts), [library/taste-fold.ts](https://github.com/Vontarius-Ventures/culture-atlas/blob/fb8a10ad774cd9135f284f96531b19ef08fc029e/packages/domain/src/library/taste-fold.ts) | Current taste is derived from current saves and anchors; upload/view/open alone do not endorse anything |
| R4 | [library/anchors.ts](https://github.com/Vontarius-Ventures/culture-atlas/blob/fb8a10ad774cd9135f284f96531b19ef08fc029e/packages/domain/src/library/anchors.ts) | Uses active capture-analysis anchors; unresolved fallback is explicitly optional and must not become accepted factual support |
| R5 | [pipeline/taste-seed.ts](https://github.com/Vontarius-Ventures/culture-atlas/blob/fb8a10ad774cd9135f284f96531b19ef08fc029e/packages/domain/src/pipeline/taste-seed.ts) | Existing Qloo candidate retrieval, category policy, budgets, display metadata and provenance |
| R6 | [services/interest-expand.ts](https://github.com/Vontarius-Ventures/culture-atlas/blob/fb8a10ad774cd9135f284f96531b19ef08fc029e/packages/domain/src/services/interest-expand.ts), [pipeline/interest-expand.ts](https://github.com/Vontarius-Ventures/culture-atlas/blob/fb8a10ad774cd9135f284f96531b19ef08fc029e/packages/domain/src/pipeline/interest-expand.ts) | Existing expansion uses recommendation-pool cards as signals; throttled reads/refreshes enqueue work; 4 Qloo requests and 45 seconds per attempt |
| R7 | [services/discovery.ts](https://github.com/Vontarius-Ventures/culture-atlas/blob/fb8a10ad774cd9135f284f96531b19ef08fc029e/packages/domain/src/services/discovery.ts) | Feed selection, saved suppression, samples, stable snapshots and recommendation-context lookup need a new parent path |
| R8 | [compiler/research.ts](https://github.com/Vontarius-Ventures/culture-atlas/blob/fb8a10ad774cd9135f284f96531b19ef08fc029e/packages/domain/src/compiler/research.ts) | Public references/claims/sources already exist; refresh deletes old claim rows, unsuitable as immutable graph proof |
| R9 | [composer/store.ts](https://github.com/Vontarius-Ventures/culture-atlas/blob/fb8a10ad774cd9135f284f96531b19ef08fc029e/packages/domain/src/composer/store.ts), [001_init.sql](https://github.com/Vontarius-Ventures/culture-atlas/blob/fb8a10ad774cd9135f284f96531b19ef08fc029e/db/migrations/001_init.sql), [120_taste_seed.sql](https://github.com/Vontarius-Ventures/culture-atlas/blob/fb8a10ad774cd9135f284f96531b19ef08fc029e/db/migrations/120_taste_seed.sql) | Recommendations and provider queries have exactly one parent; graph runs require coordinated schema/writer/read changes |
| R10 | [services/items.ts](https://github.com/Vontarius-Ventures/culture-atlas/blob/fb8a10ad774cd9135f284f96531b19ef08fc029e/packages/domain/src/services/items.ts), [services/cards.ts](https://github.com/Vontarius-Ventures/culture-atlas/blob/fb8a10ad774cd9135f284f96531b19ef08fc029e/packages/domain/src/services/cards.ts) | Existing Why this disclosure and card mapping; caller must enforce resource grants before shared mapping |
| R11 | [schemas/common.ts](https://github.com/Vontarius-Ventures/culture-atlas/blob/fb8a10ad774cd9135f284f96531b19ef08fc029e/packages/domain/src/schemas/common.ts), [enums.ts](https://github.com/Vontarius-Ventures/culture-atlas/blob/fb8a10ad774cd9135f284f96531b19ef08fc029e/packages/domain/src/enums.ts) | Consumer categories remain Wear/Play/Watch/Eat; nullable category/reference kind already exist; consumer DTOs exclude raw scores/provider values |
| R12 | [PR #7 evaluation](https://github.com/Vontarius-Ventures/culture-atlas/blob/7188184d8ec8b7482652799d97608351188c377a/prp/2026-10-23-style-analysis/evidence-method-evaluation.md) | Cultural relevance remains below target; previous photos are tuning/transfer evidence, not fresh qualification |

### Consequences discovered in the repo

1. Extend current preference semantics; do not create a second system of likes.
2. Existing expansion is a useful frontier mechanism, but recommendations in its pool cannot become confirmed personal graph support.
3. Persist immutable graph evidence independently of replaceable `claims` rows.
4. Add graph runs as a real recommendation/query parent; do not disguise them as taste seeds.
5. Reuse existing consumer categories and nullable reference cards. Internal art/interior/technique concepts need not become new global UI filters.
6. Native identity and v1 operation authorization differ. Main has a live-installation owner bridge for an explicit v1 allowlist, including onboarding/picks/feed/item operations; it does not cover every taste/preference operation. Preserve that bridge. New owner graph endpoints need an explicit native-capable v2 policy.
7. Main's privacy notes still mark account deletion end-to-end confirmation as incomplete. Graph FK cascades cannot establish a consumer account deletion journey. This is a production release dependency, tracked separately from projection correctness.

## 3. Release boundaries

### Required initial release

- Private account graph seeded from current onboarding picks and saves.
- Deterministic, reversible preference projection with source support.
- Shared canonical identities, typed cultural assertions, versioned evidence, and validation states.
- Candidate frontier and bounded automatic exploration, including worker-driven refresh while the app is closed.
- Evidence-based personal ranking and faithful Why this explanations.
- A small sourced cultural corpus covering art, sculpture/ceramics, and interiors, alongside existing Qloo identities.
- Settings → Taste interest summary and controls for suppressing/restoring tentative inferred interests and pausing background discovery.
- Browser, iOS and Android rendering compatibility and minimal native controls; existing save/remove/hide actions retain their meaning.
- Backfill, rollout flags, deletion/revocation, telemetry, regression fixtures, and fresh-holdout evaluation.

Materialization is account-only initially. Anonymous browsing retains existing behavior. After `services/accounts.ts` claims an anonymous session, enqueue account reprojection from the merged current saves and exclusions in the claim transaction; do not create or migrate a second anonymous graph. Canonical duplicate merging must not duplicate support.

### Separate follow-on scope

- Interactive node-link graph explorer, arbitrary user-written agents, collaborative/social graphs, collaborative filtering across users, graph neural network training, passive click/dwell learning, and unconstrained web crawling.
- Free-text autobiographical memory and inferred personal identity/demographics.
- Arbitrary user-defined contexts and new concept-exclusion controls. Initial context is global taste plus existing collection scope; a collection is not automatically a global preference multiplier.
- Automatic photo analysis or new model qualifications. The graph can consume authorized existing analysis, but it cannot enable analysis on its own.
- Graphiti in the production critical path. Its integration is a bounded comparison package after the deterministic baseline exists.

## 4. Product and correctness requirements

| ID | Required behavior |
| --- | --- |
| PG-01 | Completing onboarding produces confirmed interests corresponding to the actual selected choices. A multi-tag choice is one evidence group. |
| PG-02 | Save/remove/hide/unhide/correction update support with current Atlas semantics. Duplicate saves, retries and extra collection memberships never multiply endorsement. |
| PG-03 | Viewing, uploading, analyzing, recommending and background expansion do not create confirmed interests. |
| PG-04 | Automatic growth adds candidate possibilities and validated cultural knowledge. Derived affinities remain visibly distinct from explicit interests. |
| PG-05 | Unsave withdraws support; item hide excludes that item only. Existing independent support remains. |
| PG-06 | Every graph-derived recommendation has a supported cultural path and a private relevance path, checked separately. |
| PG-07 | Same spelling is not identity or semantic equivalence. Concepts preserve domain/sense; a brand-level attribute is not item-level proof. |
| PG-08 | Private graphs, captures, evidence, embeddings and explanations remain account- and grant-scoped throughout retrieval, jobs, caching and deletion. |
| PG-09 | An unsupported candidate cannot be admitted merely to fill a rail, satisfy diversity, or match a user's interests. |
| PG-10 | Confirmed interests persist until edited. Tentative affinities and frontier candidates may expire. |
| PG-11 | Source correction, revoked support and account deletion prevent stale publication and future reads, including through old feed snapshots. |
| PG-12 | Readiness, empty results, failed research, paused budgets and pending projections are truthful states; no fake graph or readiness counters. |
| PG-13 | Existing photos, saves, collections and API clients continue working while graph features are disabled or unavailable. |

## 5. Domain and data contract

Use graph-specific tables with Atlas UUIDs and typed FKs. Reuse `cultural_references`, `sources`, `discovery_items`, `saved_items`, `preference_events`, and existing analysis records. Do not duplicate every reference into an unrelated canonical catalog.

Proposed schema names below are normative design targets; migration numbers must be reserved from the actual branch at implementation time. Main currently ends at migration 180, while PR #7 contains later style work; do not assume the next number is 190.

| Record | Minimum fields and constraints |
| --- | --- |
| `graph_nodes` | `id`, optional unique `cultural_reference_id`, `node_kind`, `domain`, `sense_key`, label, status, revision. Kinds cover entity/work/concept/feature; existing reference-backed identities are reused. |
| `graph_external_ids` | `provider`, `external_id`, `node_id`, match status/version, provenance. Unique provider+external ID. Ambiguous identities remain proposals. |
| `graph_source_revisions` | Existing `source_id`, document/version hash, retrieval time, allowed metadata, retention policy and source-family key. No unrestricted article storage. |
| `graph_evidence` | Source revision, locator, permitted excerpt/structured value, validation method/version, support type, expiry. Content retention obeys source terms. |
| `graph_assertions` | Subject/predicate/object, domain, evidence scope, status, validity times, recording/supersession times, revision. Only shared, public-source facts go here. |
| `graph_assertion_support` | Assertion+evidence FKs, supports/refutes role, derivation/source-family grouping. Prevent duplicate extraction from inflating independent support. |
| `personal_graph_state` | Account PK/FK, target/applied taste revisions, projection revision, deletion/reset generation, queued/running/ready/failed state, timestamps. |
| `personal_interest_edges` | Account, target node or owner discovery-item FK, explicit/derived origin, confirmed/tentative/suppressed state, support summary, policy version, revision. Enforce exactly one target form. |
| `personal_interest_support` | Account-scoped edge FK, active saved-item/pick-group/reference/analysis support, originating event ID when known, dependency versions. Composite FKs enforce ownership. |
| `graph_private_links` | Account+capture/analysis/observation identifiers, supported interpretation and revision. Optional style adapter; never copied into shared assertion text. |
| `graph_runs` | Account FK, job FK, run kind, input taste/generation/policy revisions, bounded budget, publication state and timings. |
| `graph_frontier` | Account+run, candidate identity, intent, support-root IDs, path versions, state, expiry, dedupe key. |
| `recommendation_graph_proofs` | Recommendation FK unique per proof version, owner/run, private support IDs, shared assertion/evidence versions, intent, reason template/version, validity state. |
| `graph_outbox` | Unique logical event key, account, target revision/generation, job intent, dispatch state. Written transactionally with existing preference changes. |

Existing `recommendations` and `provider_queries` gain `graph_run_id` as an additional mutually exclusive parent. Update their one-parent checks, typed writers, owner joins, purge behavior, test fixtures and read paths together. Do not introduce a consumer recommendation origin called `graph`: storage method is not provenance. Keep existing origins (`qloo`, `research`, `catalog`, etc.) with correct source/query evidence.

Graph-derived Qloo cards retain real provider IDs and query records. Independently sourced cultural discoveries may use existing `reference` cards with nullable category and `research` origin after validation. This is a deliberate extension beyond Qloo-only style-rail eligibility, scoped to the new graph route; existing style/vision qualification rules remain unchanged. Preserve provider usage rights and do not present a catalog-level source as a visual-match source.

### Predicate policy v1

Allow `CREATED_BY`, `ABOUT`, `USES_TECHNIQUE`, `HAS_ATTRIBUTE`, `DOCUMENTED_ASSOCIATION`, and provider-qualified `AUDIENCE_AFFINITY`. Private interpretations may use `VISUALLY_RESEMBLES`; confirmed user actions use explicit selection/support records. No generic `RELATED_TO` assertion may justify a factual explanation. It can exist only as an untrusted retrieval hint outside the validated assertion set.

Each predicate defines compatible endpoint kinds, allowed evidence scope and its explanation template. `DOCUMENTED_ASSOCIATION` additionally requires a named subtype. `ABOUT` needs candidate subject-matter evidence. `VISUALLY_RESEMBLES` needs private observation support and independent candidate-side evidence. Provider affinity must never render as shared visual style or documented historical influence.

Assertion states: proposed → validated, disputed, or rejected; validated → superseded/retracted/disputed. Validators store decisions and versions. LLM confidence or model agreement alone cannot promote an assertion.

## 6. Preference projection and transaction semantics

Current saves and explicit exclusions remain authoritative; `personal_interest_edges` are rebuildable projections, not an independent ledger of truth.

1. Preserve the existing preference mutation transaction and synchronous taste summary update.
2. In the same transaction, write/upsert a graph outbox row for the effective taste revision. No-op preference actions create no new support.
3. The projector reads current state and applies support at a consistent account revision. Acquire the existing account lock strategy or introduce one consistently; never publish a mixed revision.
4. While graph projection lags, the old taste response remains available. Graph responses expose pending status; removal/hide/suppression takes effect immediately by filtering current authoritative support at read/publication time.
5. Onboarding choices with several tags share one support group. Current `created_save` and inherited-save behavior remain intact.
6. Graph feature contributions begin with current `taste-fold.ts` item/anchor semantics. Derived feature interests are lower-strength tentative edges, capped across duplicate evidence groups. Weights are internal policy inputs, not user-visible confidence probabilities.
7. Saving a capture preserves selected focus and currently valid analysis support. Unmatched references never become accepted factual assertions. Correction or active-analysis changes dirty the relevant projection even if no save changes.
8. Explicit-edge removal uses existing save/pick removal, not a new graph-only delete that leaves saves behind.
9. Suppress/restore applies only to a tentative derived edge; it does not erase saved objects or hide all objects with that feature. A suppression marker persists across rebuilds until restored or reset.

Collections can scope support for authorized reads but do not independently add global weight. Initial release does not infer preferences from unsaved collection auto-fill or feed items.

## 7. Evidence ingestion and retraction

Adapt `compiler/research.ts` through a graph evidence writer without making its replaceable `claims.id` the durable proof identity. Preserve existing reference pages while storing source/evidence revisions for accepted graph assertions.

Initial supported evidence methods:

- Deterministic provider metadata, used only for the relation/scope the provider actually supplies.
- Curated source passage plus identity and predicate validation.
- Machine extraction linked to a checked passage and a predicate-specific validation decision; disputed/ambiguous extractions remain proposals.

The pilot corpus must be source-backed and versioned. It is acceptable to curate it initially; claiming an autonomous verifier is accurate without qualification is not acceptable. Require a reviewed corpus manifest recording sources, IDs, permitted use, relation coverage and validation status. Choose sources to fill known art/interior gaps rather than importing a huge unreviewed graph.

Private observations remain in owner-scoped records and are fetched only for an authorized analysis. Public research receives canonical public names/IDs, not photos, private event histories, account identity or private reasoning. Approved source domains and bounded provider adapters govern fetches; extraction text cannot issue tool instructions or arbitrary fetches.

On retraction, mark dependent proofs/frontier rows invalid in the same authoritative invalidation path and queue derived rebuilds. Reads revalidate current dependency versions. A stale displayed card may remain saved as an item, but its unsupported reason must disappear. Retain independent evidence support; do not globally delete a cultural entity because one source became invalid.

## 8. Automatic growth and job model

Add typed jobs `project_interest_graph`, `expand_interest_graph`, and `research_graph_relation` to `enums.ts`, payload schemas in `jobs/types.ts`, dedupe helpers in `jobs/dedupe.ts`, and the handler registry in `pipeline/index.ts`. Use the existing queue leases, heartbeats, retries, cancellation and idempotency infrastructure. Extend `services/jobs.ts` visibility for new result types; a polling request is checked against current authority.

The existing `interest_expand` path remains available for non-cohort users. For graph-enabled accounts, route the trigger through the graph planner and disable the legacy paid expansion for the same account/window. Do not run both budgets independently.

Triggers:

- Effective onboarding/save/remove/hide/unhide/correction and derived-edge control changes dirty projections.
- Successful projection schedules one deduplicated expansion if background discovery is enabled.
- A bounded worker sweeper scans eligible stale accounts even when their app is closed, so growth does not depend solely on feed reads. Use cursor batches and `next_refresh_at`; it is application infrastructure, not a desktop-chat automation.
- Feed refresh can request a due wave, but feed reads perform no inline model/provider work. Existing cards remain usable during expansion failures.

### Proposed initial limits

| Limit | Initial target / rule |
| --- | --- |
| Expansion traversal | At most 2 approved cultural relation hops from current explicit roots; 200 traversed assertions per run |
| Candidate output | At most 40 candidates evaluated per run; 500 active frontier rows per account; deduplicate before charging more work |
| Expansion provider allowance | At most 4 Qloo HTTP attempts, including retries, across the logical run; 45-second deadline; share existing throttle/global quotas |
| Trigger coalescing | At most one active expansion per account; periodic refresh no more than once per 15 minutes; mutations coalesce to latest revision |
| Research breadth | At most 2 source documents and 10 proposed assertions per relation job |
| Paid research | Off until account/global daily budgets and a qualified provider role are explicitly configured; use existing persistent reservation ledger; unknown charges remain counted |
| Candidate freshness | 7-day initial frontier expiry, shortened by source/provider rights or evidence validity; no indefinite stale pool growth |

These are build defaults to validate, not measured capacity or authorization to spend. No production or scratch spend cap is raised by this spec. Model calls for graph extraction require a separately bound and qualified role or an existing role whose contract is proven compatible; do not silently reuse research/composer qualification for a new prompt.

Every job checks owner existence, applicable feature kills, generation and input/dependency revisions before dispatch and before publication. Expansion and paid research additionally check the background-discovery setting and remaining budget. Pausing discovery must not stop preference projection, suppression, source retraction, cleanup or deletion; those continue to reflect current authoritative state. Run budget counters survive retries. Serialize account publication and compare the current taste revision; obsolete outputs may be retained only as non-published diagnostic/cached public research where permitted. Never retry a 402/spend pause as an uncontrolled loop.

## 9. Candidate admission, ranking and feed integration

Initial intents: similar form/design, about selected subject, documented cultural connection, and personal audience affinity. Each intent has a reviewed path template. A graph path is not automatically transitive.

The required main-compatible capture adapter consumes current resolved/user-confirmed active reference IDs through `library/anchors.ts` and existing analysis records. It supports about-subject/documented-connection paths with preserved uncertainty; it cannot manufacture localized visual evidence that main does not contain. Rich observation/form/palette matching and `VISUALLY_RESEMBLES` publication remain disabled until the optional PR #7-compatible adapter and its independent evidence tests are accepted. Photo analysis itself remains subject to its existing role qualification and availability.

Admission requires canonical identity, compatible candidate form/domain, valid evidence for every asserted relation, active user support, permitted source retention and current access. Candidate generation may use semantic retrieval, but embedding proximity is never enough to validate an assertion.

Rank only admitted candidates. Use versioned internal features: explicit-root relevance, relation specificity, evidence quality, novelty, repetition, context and diversity. Retain existing exclusions and canonical dedupe. Do not use a high personal-preference score to admit a weak photo connection. Photo connection and personal interest relevance remain distinct decisions.

Integrate `graph_run_id` into `buildSavedPool`, `recommendationContexts`, item ownership checks, card loading and source disclosure. Choose the latest successfully published compatible graph run, not merely the newest queued/partial run. A failed refresh must not wipe the existing pool. For graph-enabled accounts, old invalidated seed/expand recommendations must not re-enter through the legacy CTE paths. Existing photo, Music Mode and owner-triggered related paths continue under their own current authorization; graph-derived reasons require fresh proof.

Keep stable feed pagination, per-owner dedupe, saved/hidden suppression, nullable categories and clearly labeled examples. Revalidate graph proof/exclusions before serving graph cards from an existing snapshot. An invalid graph card is skipped; new candidates wait for a new snapshot. This prevents stale reasons without shuffling the remaining cursor order.

Store the chosen recommendation ID in its feed snapshot context (a side table or compatible extended snapshot representation), so the Why this disclosure reads the proof used for that ordering. The current latest-per-item lookup must not substitute another run's reason silently.

## 10. API, agents and client scope

Keep existing v1 preference and onboarding requests backward compatible. No provider IDs, raw affinity values, private graph paths, or raw extractor outputs enter ordinary consumer cards.

Proposed owner/native API (new explicit operations in the current operation-policy system):

| Endpoint | Contract |
| --- | --- |
| `GET /v2/me/interest-graph` | Status, taste/projection revisions, bounded paginated interest summary, explicit/derived origin, background setting; no model/provider calls |
| `PATCH /v2/me/interest-graph/settings` | Owner or authorized installation sets background discovery enabled/disabled; optimistic revision precondition |
| `PATCH /v2/me/interest-graph/interests/{id}` | Suppress/restore a derived interest only, with expected revision; cross-owner ID is 404; explicit interest returns typed action-required directing to existing save/pick control |
| `GET /v2/me/recommendations/{id}/connection` | Current minimal reason, relation kind, scoped personal selection summaries and permitted source links; no raw score or hidden supporting items |

Define Zod request/response schemas, errors, cursor bounds and typed clients before parallel client implementation. Mutations reject unknown fields, are idempotent by desired state and require `If-Match`/expected revision; stale updates return 409 or the repo's established precondition convention consistently. Reads require current owner/native authorization and never accept an arbitrary account ID from the client.

No new raw graph tools or external-agent scopes in the initial release. Existing agents retain their current taste/preferences permissions without automatic broadening. Selected-collection agents continue receiving support derived only from current granted collection resources; global graph endpoints are denied. Internal workers use server-created account job context, not an LLM-selected tenant ID. New native-capable routes must not assume v1 operation admission already permits installations.

Reuse item `why_this` text and sources for older clients. Additive structured connection fields may be exposed only after their schemas and authorization are implemented. All reason paths must revalidate grants; loading a public cultural node does not authorize the private edge to it.

Client work is limited to existing Settings → Taste and Why this surfaces. Show confirmed interests as selections and tentative interests as suggested connections. Use plain copy such as “Based on things you saved” and “Don't use this connection.” Pause stops new paid discovery and cancels pending account expansion/research at their next safe checkpoint; local removal, reads and deletion remain available. Do not display a graph-network animation as evidence of learning.

## 11. Privacy, deletion and concurrency

Every private graph/support/frontier/proof row has an account FK and owner-bound foreign keys to private inputs. Account deletion must cascade or explicitly purge these records and prevent queued/running work from recreating them. A graph generation/deletion fence is checked under the publication transaction.

Add graph dependencies to current capture deletion, correction, account lifecycle, collection-grant revocation, snapshot invalidation and purge paths. Existing DB deletion and privacy behavior must be traced rather than assumed complete. Raw private text must not be copied into audit logs, provider-query metadata, framework episodes or source documents without an existing permitted purpose.

**Account deletion release prerequisite:** implement and verify a product-authorized account deletion journey, or land its separately scoped account-lifecycle dependency before production activation. The graph package supplies account purge/cancellation hooks and tests, including leased-job fencing and removal of external projections, but cannot declare the existing account product flow complete. Resolve the owner-facing request/authentication path, media deletion, outstanding work, retention and completion reporting in that dependency. Local development and shadow projection may proceed before this prerequisite; production release may not.

For source invalidation and private preference removal, invalidate authoritative proof before asynchronous cleanup. Caches use owner+grant/context+generation+projection/policy revisions; no cache entry can outlive live access checks. An optional external framework projection receives deletion/revocation commands, but failure there cannot keep authoritative reads open.

Add row-level security only after checking actual DB runtime roles and every affected service query; RLS is defense in depth, not a substitute for current owner predicates. Framework group IDs are not authorization. Define retention and backup deletion behavior in the runbook without promising immediate erasure from immutable backups that the deployment does not support.

## 12. Migration, flags and rollback

1. Reserve migration IDs against the implementation branch. Add tables, FK/indexes, new recommendation/query parent constraints and compatible nullable columns. No rewriting old recommendations as graph-proven results.
2. Ship code with all graph flags off. Add server flags to the feature defaults, shared spec JSON, killable flag constraints and parity tests together.
3. Backfill current active saves, onboarding support groups, exclusions and resolved anchors per account in checkpointed batches. Never reconstruct unsupported historical interests from exposure logs or manufacture precise event timestamps. Record `origin: backfill_current_state` in internal lineage where no event provenance survives.
4. Lock/capture taste revision, build, compare revision and retry if changed; tail live mutation outbox before marking ready. Verify count/support parity with current taste fold.
5. Enable shadow projection for a small cohort; no changed recommendations and no paid research. Compare deterministic outputs, deletion and access behavior.
6. Enable graph candidate publication and revised Why this only for a verified cohort. Prevent simultaneous legacy paid expansion for the cohort.
7. Enable bounded autonomous refresh/research after quality and operational gates, with separate account/global budget controls.

Flags: `interest_graph_projection_enabled`, `interest_graph_discovery_enabled`, `interest_graph_research_enabled`, and optional `interest_graph_framework_shadow_enabled`; default false. User pause is a separate per-account preference, not a permission grant. Global/per-account kills disable new graph work. Reads and deletion continue.

Rollback disables graph publication/workers and stops optional framework ingestion while retaining private saves and the old taste model. Filter graph-run recommendations from legacy reads; rebuild snapshots from currently eligible legacy sources with honest examples if needed. Already known-invalid cultural claims must remain suppressed rather than being resurrected by rollback. Do not drop graph/evidence tables in the emergency rollback path.

## 13. Build packages and dependency order

| Package | Main deliverables | Depends on | Acceptance |
| --- | --- | --- | --- |
| A — Contracts and schema | Ontology/predicate policy, migrations, graph run parent, Zod/API fixtures, auth operation definitions | Source baseline | Constraint and backward-compatibility tests; client contract agreed |
| B — Preference projection | Outbox hooks across all effective mutations, support grouping, backfill, suppression, status | A | Parity, undo, retries and concurrent-mutation tests |
| C — Evidence library | Versioned sources/evidence, typed assertion validator, retraction dependencies, corpus manifest | A | Source replacement/retraction tests; reviewed pilot corpus |
| D — Discovery worker | Frontier, bounded traversal, admission/ranking, scheduler sweep, shared quotas | B+C | No self-endorsement; no duplicate spending; stale job fencing |
| E — Feed and clients | Graph parent/read integration, pinned proof context, Why this, taste summary, native routes/controls | A+B+D | Real journeys on browser/iOS/Android; old clients remain compatible |
| F — Operations and qualification | Flags, deletion hooks, observability, rollback, frozen evaluation and fresh holdout | Cross-cutting from A; verified account deletion journey before production | Operational tests plus quality gates below |
| G — Optional Graphiti comparison | Internal adapter, pinned dependency/license, replay-only ingestion/query/delete comparisons | B+C, independent of production switch | Demonstrated value over SQL baseline before runtime adoption |

Repository targets: proposed `packages/domain/src/interest-graph/{model,projector,identity,evidence,admission,ranking,proofs,store}.ts`; new thin services and pipeline handlers in existing corresponding directories; provider/framework adapter under `packages/providers`; extend worker registry and existing routes/clients. Follow repository conventions instead of creating a parallel app or an unrestricted autonomous-agent server.

Graphiti must remain behind an adapter with `ingestApprovedRecords`, `findCandidatePaths`, `invalidate`, and `deleteAccountProjection`. Atlas IDs, account scope and evidence revisions survive round trips. Framework output is a proposal until Atlas validates it. Keep Python/runtime and graph-store dependencies out of core deployments unless the comparison justifies them. Apache AGE and pgvector installation are optional, separately tested deployment changes, not schema prerequisites.

## 14. Verification and release gates

### Behavioral and isolation suite

Required integration cases: bundled onboarding pick; existing independent save; duplicate mutation/outbox delivery; save/remove/save and Undo; hide/unhide; corrected/changed active analysis; same entity across collections; anonymous session claim and canonical dedupe; unresolved anchor; unsaved feed card; derived suppression surviving rebuild; graph pause during a run; provider failure/402; retry budget; source refresh/retraction; mismatched concept sense; brand-versus-item proof; account deletion during provider call; cross-account IDs; revoked collection grant; stale snapshot; native v2 permission; currently allowed native v1 bridge and denial outside its allowlist; graph-off fallback; and old-client response decoding.

Use deterministic providers for the full suite. Live paid evaluation is a separate, budgeted activity, never an automatic test side effect. Run the repository's relevant unit/integration/type/lint/build checks, plus browser and native checks for changed clients. A test process exiting nonzero is a failure even if its assertion count looks green.

### Quality evaluation

Recover the exact historical Connections 7/24 and five-gate artifacts before claiming to improve or pass that benchmark. They were not found in the inspected main/PR #7 artifacts. Keep its original rubric/denominators if recovered. Do not substitute the following proposed release gates under the old name.

Compare three frozen variants: existing retrieval, curated source-backed retrieval without graph traversal, and graph-assisted retrieval. Historical failed photos are regression/tuning inputs. Use at least 40 fresh holdout photos covering initial domains and at least 20 predeclared onboarding/preference journeys; report every failure/empty result in denominators. Keep personal relevance separate from photo connection usefulness. Two independent reviewers inspect relevant source photos and candidate material; assess reasons separately from relevance to avoid circular scoring.

Photo evaluation initially uses the required main-compatible reference adapter and an explicitly available/qualified analysis route. Unavailable analysis counts as unavailable, not a successful graph match. Deterministic replays verify graph logic only and cannot qualify live photo usefulness. A+B can ship as shadow infrastructure without photo qualification; claiming the full discovery release or improvement to Connections requires the photo gate below. Enabling the richer visual adapter later requires its own fresh evaluation rather than inheriting the reference-only result.

Proposed gates for this release:

1. **Preference correctness:** all deterministic event/reversal/support-group/isolation cases pass; no system output creates a confirmed interest.
2. **Evidence faithfulness:** at least 95% of reviewed connection explanations supported by their full evidence path; zero unsupported identity/provenance claims or private-data leaks. Report sample sizes and intervals.
3. **Useful discovery:** photo-level useful coverage improves at least 15 percentage points against the frozen existing baseline, with mean connection relevance at least 7/10. Also report useful-personal-discovery coverage per journey and per domain. These are proposed targets; do not claim causal/significant improvement from a small descriptive difference.
4. **Coverage and resilience:** evidence-only pruning cannot count as success by itself. Report empty-result rate, useful-card totals, repetitions, source coverage and transfer results; no major domain regression may be hidden by the pooled mean. Fresh corpus collection must be expanded if intervals remain too wide to assess the intended improvement.
5. **Operational safety:** current grant checks and deletions pass, run budgets are durable, paused/deleted accounts cannot publish, failures preserve eligible existing feed, and rollback succeeds.

Proposed performance targets: local preference projection p95 within 5 seconds after commit under the agreed test load; graph summary/proof p95 under 500 ms excluding network; graph-specific local feed overhead under 250 ms p95; bounded Qloo expansion within its 45-second deadline. Record hardware, corpus sizes, concurrency, queue load and cold/warm conditions. These are acceptance targets to measure, not current performance claims.

## 15. Observability and implementation deliverables

Metrics: target/applied taste revisions and lag; outbox age; candidates admitted/rejected by rule; useful discoveries per run; source freshness/retractions; proof invalidations; all-route eligibility misses; duplicate jobs; calls/retries; reserved/unknown versus billed spend; grant denials; purge lag; paused-account publication attempts. Log IDs and rule/version codes, not photos or private interest text.

The completed implementation must include migrations, compatibility fixtures, typed endpoints, domain/pipeline code, client updates, a licensed/source-backed pilot corpus manifest, backfill tooling, deletion/rollback runbooks, framework comparison results if package G runs, and a quality report with frozen inputs and honest pass/fail outcomes.

## 16. Decisions reserved for implementation planning

This draft proposes a scope rather than authorizing a production cutover. Before coding starts, record the implementation base branch, migration reservations, pilot corpus/source permissions, source validation method, model role compatibility/qualification, exact paid daily allowances, and client contract version. Graphiti adoption is conditional on package G results. The graph explorer, passive behavior learning and cross-user recommendation training remain separately scoped.

The first reviewable build slice is A+B: a private graph accurately representing current onboarding and saves, growing and reversing with explicit actions, with no changed live recommendation behavior. C+D then establish whether the graph produces genuinely better cultural discoveries before E/F enable it for users.
