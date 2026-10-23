# Qloo contract probes

The build spec requires contract probes with the hackathon key before dependent features are trusted: resolve one brand, look up one relevant tag, request artist/film/brand/place results, inspect explainability, verify rate limits and confirm permitted response storage. Until a key exists, every Qloo capability reports `unavailable / not_configured`, and the app shows partial states ("Related discoveries are taking longer") instead of invented results.

## Run

```sh
# .env (never commit): QLOO_API_KEY=...   optional QLOO_API_URL (default https://hackathon.api.qloo.com)
pnpm qloo:probe                                    # probes + writes docs/capability-matrix.md
pnpm qloo:probe --brand "Carhartt" --tag workwear  # choose the probe inputs
pnpm qloo:probe --dry-run                          # print only
pnpm qloo:probe --json                             # machine-readable results
```

Without `QLOO_API_KEY` the script exits with code 2 and changes nothing. With a key, it exits with code 1 when a required capability (search, tags, insights, explainability) is unavailable. The key is never printed or written.

## What it checks

`scripts/qloo-probe.ts` uses raw HTTP (`scripts/qloo-probe-lib.ts`), so it tests the documented API itself rather than the adapter's interpretation of it. Requests are paced 250 ms apart.

| Probe | Request | Passes when |
| --- | --- | --- |
| `search.brand` | `GET /search?query=<brand>&types=urn:entity:brand` | At least one entity with an `entity_id` |
| `tags.lookup` | `GET /v2/tags?filter.query=<tag>` | At least one tag id |
| `insights.artist` / `movie` / `brand` / `place` | `GET /v2/insights?filter.type=urn:entity:<type>&signal.interests.entities=<brand id>&feature.explainability=true` | Results for that category |
| `insights.explainability` | Derived from the four insight probes | At least one result names its contributing inputs (`query.explainability`) |
| `insights.tag_signal` | `GET /v2/insights?filter.type=urn:entity:brand&signal.interests.tags=<tag id>` | Tag signals return results (style anchors use tags) |
| `trending` | `GET /v2/trending` with `signal.interests.entities`, `filter.type`, `filter.start_date`, `filter.end_date` | Optional; inspector only |
| `trends.entity` | `GET /trends/entity?entity_id=&start_date=&end_date=` | Optional; inspector only |
| `auth.invalid_key` | `GET /search` with a wrong key | 401/403, confirming the `X-Api-Key` scheme |

Rate-limit headers (`x-ratelimit-*`, `retry-after`) are recorded from every response, along with the number of 429s.

Status per probe: **available** (worked), **degraded** (worked but empty, or rate limited), **unavailable** (denied, failed or unreachable), **skipped** (depended on an earlier probe).

## What it writes

`docs/capability-matrix.md` gets:

- the Status and Result columns of each `qloo.*` row, e.g. `available (probed 2026-10-20)`;
- a generated "Qloo probe results" section between `<!-- qloo-probe:begin -->` and `<!-- qloo-probe:end -->`.

Re-running replaces both, so the file always shows the latest run. Review the diff before committing.

## What it cannot answer (fill in by hand)

- **Storage:** may responses be stored (`provider_queries.results`), and for how long? Until confirmed, the app keeps only ids, names and ranks needed for traceability.
- **Display:** may provider images and metadata be shown publicly? Until confirmed, use licensed or own imagery, or the text treatment.
- **Categories:** which categories the hackathon key covers, if the probes show gaps.

Record the answers in the access table of `docs/capability-matrix.md` and in [privacy.md](privacy.md).

## Grounding rules

Qloo's free-text `/search` and `/v2/tags` return look-alikes: an album for "Racing jacket", a sushi bar for "Smacked cucumber salad", "Honda" for "Honda Civic", a B&B hotel for "Musée du Louvre", a music genre ahead of the decor tag for "neoclassical". The compiler therefore never trusts a name similarity. `packages/domain/src/compiler/grounding.ts` (`GROUNDING_VERSION = 'ground-v2'`, rules in [quality plan §5](quality-plan.md#5-qloo-acceptance-rules-p3-exact)) is pure and decides two things:

**Whether to ask** (`planLookup`, rules Q-TYPE, Q-TAGTYPES, Q-EVIDENCE):

| Candidate | Lookup |
| --- | --- |
| object | none (`object_not_searched`). A brand-like object whose brand was read in the photo is searched as a brand by its maker word (ground-v3: never a colour or material; "Blue Bottle Coffee cup" is not searched as "blue"). |
| brand | `/search` with `urn:entity:brand`, only when corroborated: the guardrails' G-BRAND-CORROBORATE, or (until they run) every brand word of the name as a whole word of the reading's `visible_text` (ground-v3: a make read on a badge never vouches for a model guessed from the shape). Otherwise none (`brand_not_corroborated`). |
| creator / work | `/search` with artist, director, person, author / movie, album, book, tv_show |
| place | `/search` with destination, locality, place, only with read text, `depicted`, or certainty ≥ 0.5 |
| cuisine | `/v2/tags` with `urn:tag:cuisine:qloo`, "cuisine"/"food" removed from the query, only when `depicted` or certainty ≥ 0.5 |
| style / tradition | `/v2/tags` with `urn:tag:decor:qloo`, `urn:tag:style:qloo`, `urn:tag:setting:qloo`; `urn:tag:genre:music` first only for music, `urn:tag:genre:media` + `urn:tag:subgenre:qloo` first only for film |
| medium words (still life, painting, …) | none, unless a labelled work or creator was read |

A reference the user named in a correction is the evidence itself: it is searched with its type, or across every type when it has none.

**Whether a result is the candidate** (`acceptMatch`, rules Q-NAME, Q-SUBSET, Q-PLACE, Q-DOUBT): the result must have an allowed type and the same canonical token set (`canonicalTokens`: case, accents, punctuation and filler such as "style", "architecture", "cuisine", "the", "du" ignored; non-Latin names compared verbatim). A brand may add only a corporate suffix ("Cannondale Bicycles"). A shorter name is rejected (`Q-SUBSET`). Places may match an aka; among exact places the destination is preferred, then the locality, then the venue; same-named places in different localities, or a place without popularity, are rejected (`Q-PLACE`). Two different exact entities are a doubt (`Q-DOUBT`), except (ground-v2) that a film or music work or creator takes the one exact match of its medium's type (movie/album, director/artist); two such matches stay a doubt. Tag families never accepted: occupation, place category/genre, specialty dish, menu highlight, ambience, offerings, amenity, nearby attraction, neighborhood characteristics, keyword, good-for. A rejected or doubtful candidate is kept under its own name with no Qloo id and never anchors. Every resolve query stores `query_context.accept = { matched, rule, reason, grounding_version }`; a skipped lookup writes no query, and its reason is in the `resolve` trace stage (`grounding`).

Recommendations: Wear insights (compiler and taste seed) send `filter.tags=urn:tag:genre:brand:fashion`. Taste-seed Eat is asked with food picks only and post-filtered ([quality plan §6](quality-plan.md#6-taste-seed-fixes-p3-exact)).

**Measured (2026-10-19).** Offline, on the diagnose phase's 46 recorded live responses to real-photo candidates: 12 accepted, every one the right Qloo entity or tag (the one claim-level error, "Art Deco" read off a sign, is the guardrails' to hold); 11 of 14 correct groundings found (missed on purpose: Shanghai at 0.4 certainty, "Les Arts Décoratifs" vs "Musée des Arts Décoratifs", "Islamic" for "Islamic ceramics"). The previous similarity matcher accepted look-alikes on the same data (23 false accepts of 34 in the diagnose count). Live, 21 requests through the real adapter:

- 13 typed tag lookups (style, tradition, cuisine, music, film): 11 accepted, each the expected tag in the expected family (Mid Century Modern, Neoclassical, Empire Style, Mughal Architecture, Indo-Saracenic, Haussmannian and Victorian Architecture as decor; Bossa Nova as a music genre and Film-noir as a media genre for those domains; Shanghainese and Dan Dan Noodles as cuisines). The other two stay unmatched on purpose: "Islamic ceramics" (only the shorter "Islamic" exists) and "Streetwear" (no style tag). No `aesthetic` tag family appeared in any response, so none is requested.
- Seed insights with mixed onboarding picks: Play 15/15 artists, Watch 15/15 films (type-correct share 1.00, so no rule change); Wear with the fashion filter 15/15 fashion brands, and 10/10 on the compiler path from two decor anchors; Eat with food-only signals and the post-filter 5/5 cuisine cards.

**Evaluate phase (2026-10-19, live, 107 lookups on the guarded candidates of 28 golden photos).** 26 accepted, every one hand-checked as the candidate (grounding precision 1.00); 0 forbidden accepts; 0 references under a doubtful name. Recall on candidates whose correct item was in Qloo's top 5 was 14/26 (0.54, gate 0.60): reject-on-doubt costs the film poster's credited names (several same-named "person" entities), EMT Madrid (no popularity), Stockwell (several localities), NBA (acronym) and two one-word-shorter decor tags. Details in [quality plan §13.4](quality-plan.md#134-qloo-grounding-live-iterations-1-and-2).

The raw responses stay in the team scratchpad until Qloo's storage terms are confirmed.

## Related

- The adapter-level probe from the providers stream, `pnpm tsx scripts/probe-qloo.ts [--record]`, exercises `packages/providers/src/qloo/client.ts`. With `--record` it saves sanitized real responses for labeled "Example result" replay. Only use `--record` after storage rights are confirmed.
- Contract tests run against shape-only fixtures in `fixtures/qloo/contract/`, which are never shown to users.
