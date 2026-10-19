# Analysis quality plan: evidence gates and a validation mechanism

Status: plan, 2026-10-19. It merges the three diagnose reports of the quality team into one plan for the build and evaluate phases. The owner asked for "improvements and a stronger validation mechanism", not only prompt changes.

Inputs:
- [spec amendment 2.2](../specs/onboarding-and-fast-analysis.md) (FAST-01..03, ONB-04);
- the real-photo results in [the latency plan](analysis-latency-plan.md#results-on-real-photographs-phase-4-2026-10-19);
- [concentrate.md](concentrate.md);
- the recorded phase-4 model outputs on 15 public test photos: 30 quick reads and 15 enrichments, 117 candidates in total;
- 56 live Qloo probes;
- 38 live verifier calls.

The diagnose work files are in the team scratchpad, outside the repository: hand labels, rule prototypes, Qloo raw responses and the call ledgers. None of them are committed.

## Summary of decisions

1. **The model proposes; deterministic code decides what reaches Qloo or the screen.** A new pure guardrail module checks every candidate before resolution and before publication. Each decision carries a rule id, and the decisions are recorded. Prompt and schema changes lower the error rate, but they are not the safeguard.
2. **Hold, then confirm.** Risky stage-1 claims are *held*, not published: brands, named places or works without matching text, low-certainty resemblances, and styles read off signs. Stage 2 confirms or drops them. For a held claim the stage-2 verdict is binding, because nothing has been published from it yet. FAST-02 is unchanged: a card that is already published is never removed or reordered.
3. **The server assigns categories.** The model reports a `domain`, and a fixed table maps it to wear/play/watch/eat. Architecture, crafts, places, vehicles and sport get no category instead of being forced into one.
4. **Qloo matches are accepted only on type and exact canonical name.** `object` candidates are never sent to `/search`. Every `/v2/tags` lookup carries tag types. A doubtful match is stored under the candidate's own name and is never published under a look-alike's name.
5. **Taste seed:** Eat uses only food picks; with no food picks, Eat makes no call and stays `empty`. Wear filters to fashion brands.
6. **Validation mechanism:**
   - a versioned golden set of photos, stored outside git and pinned by sha256, with labels in git;
   - a pure scorer with versioned pass thresholds;
   - a hermetic CI replay that also proves the scorer fails unguarded output;
   - a budgeted live evaluation, `pnpm eval:live`;
   - qualification artifacts that pass only when the scorer passes for the current guardrail version.
7. **No independent verifier model in this round** (see [7.6](#76-verifier-decision-not-built-this-round)). On the recorded data, the deterministic gates plus binding stage-2 confirmation of held claims catch the same errors the verifier caught. The verifier would also need a new route with its own privacy confirmation. It stays specified as the escalation if the held-out evaluation misses its thresholds.
8. **Text roles:** qualify `research_text` and `composer` on `anthropic/claude-haiku-5-5`, effort `none`, against a text golden set with content checks. Uploads then stop ending `partial`.

## 1. Final error taxonomy

The counts come from hand labels on the recorded outputs: 117 candidates, 28 visible_text entries and 75 observations. On the recorded data, 56 of 117 candidates (48%) were clean and 35 should have been vetoed. Live Qloo resolution of 47 labelled candidates had an end-to-end precision of 0.32.

| # | Class | Recorded count | Examples | Fixed by |
|---|---|---|---|---|
| E1 | Brand or model without visible evidence | 11 | Nissan X-Trail ×2, Honda Civic/Honda ×4 (blurred photo), Spalding ×3, Cannondale ×2 at stage 1 before any text was read | schema `evidence`, G-BRAND hold + corroboration, Q-NAME subset rule |
| E2 | Category misfit | 94 / 117 | Architecture and places under `watch`; interiors and ceramics under `wear`; a car under `wear`; paper bags under `eat` | `domain` field, G-CATEGORY table |
| E3 | Unsupported attribution or text echo | 16 | Yuyuan Garden (the sign says 愚园路, not 豫园), Art Deco (from "LES ARTS DÉCORATIFS"), Iznik/Kashan (the labels say Nishapur/Soltanabad/Gorgan), Lahore, Eames-style chair, Georgian (the terraces are Victorian) | G-TEXT-ECHO hold, G-PLACE floor, G-LOWCERT hold, binding stage-2 verdict on held claims |
| E4 | Generic object, not a cultural reference | 26 | Basketball, Road bicycle, Paper grocery bags, Crystal chandelier, Kiwifruit | prompt "0 to 5", G-GENERIC demotion, Q-TYPE (objects never searched) |
| E5 | Filler cuisine or activity | 5 | Spanish cuisine, Shanghainese cuisine, "American supermarket shopping" | prompt "0 to 5", G-CUISINE-FOOD, G-GENERIC |
| E6 | Medium words on real photos | 2 candidates + 2 titles | "Still life painting", "Citrus and kiwi still life" | G-MEDIUM (also on title and interpretation) |
| E7 | Relation or certainty miscalibration | 1 + 9 contradictions; 6 | Brand with `resembles` (a contradiction in itself); depicted Spalding at 0.6 | G-BRAND, G-LOWCERT, G-DEPICTED |
| E8 | visible_text misuse | 3 descriptions + 2 misreads / 28 | "Licence plate characters are illegible due to blur", "Small white placards…" | `illegible_text_present` field, G-VTEXT |
| E9 | Person descriptors and role inference | 2 observations + 2 candidates, 0 names | "shaved head", "gray hair… serious expression", "Football coaching" | prompt rule, G-PERSON-OBS, G-PERSON-ROLE, G-IDENTITY |
| E10 | Quality inconsistency | 1 / 30 | `usable:true, issue:'blurred'` with a Honda Civic candidate | G-QUAL |
| E11 | Qloo look-alike accepted | 23 false accepts / 34 | Crystal Chandelier (a place), Basketball VR, Honda for Honda Civic, Lahore Zoo, a B&B hotel for Louvre, music genre for "neoclassical", occupation tag for "still life", Yuyuan Garden in Xiamen | Q-TYPE, Q-TAGTYPES, Q-NAME, Q-PLACE, Q-DOUBT |
| E12 | Taste-seed echo and off-type | Eat 0/8 food; Wear 2/10 fashion | Eat: Bossa Nova, Jazz Age Fare, Vintage Fashion. Wear: Credit Agricole, Deezer | S-EAT-SIGNAL, S-EAT-POST, S-WEAR-FILTER |
| E13 | Missed salient subjects | 8 items on 6 photos | Yuyuan Road, NBA, Stockwell, CAAD8, faux-bamboo cane chairs | stretch: G-PROMOTE (text to candidate) |
| E14 | Stage-1 run-to-run instability | mean Jaccard 0.39 | different candidate sets on the same photo | reported only; the gates narrow what is published |
| E15 | Text roles unqualified | every real upload ends `partial` | `research_text`, `composer` | §8 |

## 2. Design rules that hold everywhere

- **Gates act before publication.** Nothing a gate removes was ever shown, so FAST-02 stays true. Stage 2 never removes a published card. A stage-2 "unsupported" on a published card stays advisory: certainty × 0.5 as today, plus an `advisory_veto` flag in the decision record. Hiding such cards is an owner decision (§11).
- **Fail closed for held claims.** If stage 2 is off, fails, or times out, held claims are dropped. Low-risk claims that were already published are unaffected.
- **Reject on doubt.** An uncertain Qloo match becomes an `unmatched` reference under the candidate's own name. It never anchors insights and never shows the Qloo name.
- **Every decision is recorded.**
  - Guard decisions go into the analysis trace as `traceStage('guard', { version, decisions })`.
  - Qloo acceptance decisions go into `provider_queries.query_context` as `accept: { matched, rule, reason }`.
  - The inspector and the scorer both read these records.
- **Versioned.** `GUARDRAIL_VERSION`, `GROUNDING_VERSION`, `SCORER_VERSION` and the thresholds file hash are bound into qualification artifacts (§7.5). Changing a rule un-qualifies a role until it is re-evaluated, just as a profile edit does.
- **No new data leaves the system.** The gates are local and pure. Nothing about people is inferred, and no names appear in labels or fixtures.

## 3. Prompt and schema v2 (P1)

Both reading versions change, so both photo roles must be re-qualified:
- `quick`: `vlm-quick-v2` / `atlas_quick_read_v2`
- `enrich`: `vlm-enrich-v2` / `atlas_enrichment_v2`

The `full` reading (Elorian or operator fallback) keeps its schema. Its output goes through the same guardrails, using the legacy inference described in §4.4.

### 3.1 Stage-1 candidate (`VlmQuickCandidate` v2)

```ts
export const VLM_DOMAINS = ['fashion', 'music', 'film', 'food', 'architecture', 'interior', 'design', 'craft',
  'art', 'vehicle', 'sport', 'place', 'signage', 'people', 'other'] as const;
export const VLM_EVIDENCE = ['read_text', 'logo', 'distinctive_form', 'context'] as const;

VlmQuickCandidate = z.object({
  name: z.string().max(80),
  type: z.enum(VLM_REFERENCE_TYPES),
  relation: z.enum(['depicted', 'resembles']),
  certainty: z.number().min(0).max(1),
  domain: z.enum(VLM_DOMAINS),                 // replaces `categories`
  evidence: z.enum(VLM_EVIDENCE),
  evidence_text: z.string().max(60).nullable(), // verbatim text or logo wording; null unless evidence is read_text|logo
  tag_query: z.string().nullable(),            // required (non-null) for style/tradition/cuisine
});
VlmQuickRead = z.object({ title, interpretation, candidates: z.array(VlmQuickCandidate).max(5), quality });
```

- `categories` is removed from the model output. The server derives categories (§4.3).
- These invariants are **not** enforced by `refine`, because a refine failure would fail the call. The guardrails normalize them instead:
  - `issue != null ⇒ usable == false`
  - `tag_query` required for style, tradition and cuisine
  - `evidence_text` non-null only for `read_text` and `logo`

### 3.2 Enrichment (`VlmEnrichment` v2)

- `confirmed[]`: `{ name, rationale, verdict: 'supported' | 'weak' | 'unsupported' }` replaces `keep`. This removes the need to parse hedges out of the rationale. Recorded v1 outputs still map through the hedge rule in §4.4.
- `visible_text`: verbatim transcriptions only, at most 8. Add `illegible_text_present: boolean`, so "there is text I cannot read" has its own place.
- `additional_candidates`: the v2 candidate shape plus `rationale`, at most 4.
- Observations stay at most 5, with the person rules below.
- `maxOutputTokens` goes up from 1200 to 1600 at re-qualification. One recorded photo hit the 1200 cap.

### 3.3 Prompt rules

Add these rules to both prompts. The security rules stay word for word, and so does the `userDataJson` escaping.

- "Return 0 to 5 candidates. Fewer is better than filler. Never add a cuisine, place or activity only to reach a count." This replaces "3 to 5".
- "Name a brand, maker, model or product line only when its name or logo is legible in the photo; set evidence to read_text or logo and copy the wording into evidence_text. Never infer a make or model from shape, silhouette, colour, tail lights or proportions."
- "A place or work named on a sign is a candidate under the name exactly as written (romanize only if the sign itself does). Never turn sign words into a different reference, style or movement."
- "Do not use words for the medium (still life, painting, illustration, drawing, render, photograph) in any name, title or interpretation unless the subject is an artwork identified by a legible label."
- "Generic objects (a basketball, a bicycle, a bag, a chandelier, fruit) are not candidates; name the specific tradition, style or named type instead (streetball, not basketball), or return fewer candidates."
- "domain is what the reference is about, not which app section it fits."
- Enrichment only:
  - "visible_text holds exact transcriptions only, never descriptions; set illegible_text_present when text is present but unreadable."
  - "Never transcribe licence plates."
  - "Do not add a confirmed entry for the title."
- Both prompts, person rule: "Do not describe hair, face, skin, age, body or facial expression, and do not infer anyone's role, profession, team or affiliation." The existing identity rule stays.

### 3.4 Merged `VlmAnalysis`

- `VlmCandidate` gains optional `domain`, `evidence` and `evidence_text`, with defaults `null`, so stored analyses and `fixtures/vlm` still parse.
- `suggested_categories` is filled only by G-CATEGORY.
- `VlmEnrichment` v2 maps into `mergeEnrichment` without changing its published-card rules. The `verdict` is carried to the guardrails through a new `VlmMergeContext`, returned alongside the merged analysis. It does not change the stored shape.

## 4. Runtime guardrails (P1, exact)

### 4.1 Module and API

`packages/providers/src/vlm/guardrails.ts` (pure, no I/O), `vlm/lexicons.ts`, `GUARDRAIL_VERSION = 'guard-v1'`.

```ts
export type GuardAction = 'publish' | 'hold' | 'demote' | 'drop';
export type GuardRule = 'G-QUAL' | 'G-MEDIUM' | 'G-PERSON-ROLE' | 'G-IDENTITY' | 'G-STYLE-OF' | 'G-CUISINE-FOOD'
  | 'G-FLOOR' | 'G-DEPICTED' | 'G-GENERIC' | 'G-BRAND' | 'G-PLACE' | 'G-TEXT-ECHO' | 'G-LOWCERT'
  | 'G-ADDITION-FLOOR' | 'G-VERDICT' | 'G-BRAND-CORROBORATE' | 'G-CATEGORY';
export interface GuardDecision { candidateId: string; name: string; action: GuardAction; rules: GuardRule[]; note?: string }
export interface Stage1Guard { analysis: VlmAnalysis /* publish-only candidates, sanitized */; held: VlmCandidate[];
  demoted: VlmCandidate[]; decisions: GuardDecision[]; titleChanged: boolean }
export function guardQuickRead(a: VlmAnalysis, ctx: { twoStage: boolean }): Stage1Guard;
export function guardEnrichment(input: { published: VlmAnalysis; held: VlmCandidate[]; merged: VlmAnalysis;
  merge: VlmMergeContext }): { publishNow: VlmCandidate[]; advisoryVetoes: string[]; analysis: VlmAnalysis; decisions: GuardDecision[] };
export function sanitizeVisibleText(texts: readonly string[]): { kept: string[]; dropped: string[] };
export function sanitizeObservations(obs: VlmAnalysis['observations']): { kept: typeof obs; dropped: typeof obs };
export function domainOf(c: VlmCandidate): VlmDomain;      // schema value, else lexicon inference (4.4)
export function categoriesFor(c: VlmCandidate): Category[]; // G-CATEGORY
export function isBrandLike(c: VlmCandidate): boolean;
export function brandHeadToken(name: string): string | null;
```

Call sites, owned by P1 in `packages/domain/src/compiler/analyze.ts`:
- `guardQuickRead` runs right after `observe`, before `publishObserve`. Only the publish set is resolved and anchored. The capped list of 5 is taken from that set.
- `guardEnrichment` runs inside `publishEnrichment` after `mergeEnrichment`. Held claims that pass are resolved and published through the existing append path. That path covers both photos and v2 media (its frame aggregate reaches the compiler as a `VlmAnalysis`).

### 4.2 Rules, in evaluation order

For each candidate, the first `drop` wins. Every rule that fires is recorded. "Name tokens" means `normalizeName` tokens. A "content token" is a name token that is not in `STOP`. "Contains" means canonical substring containment after `normalizeName`; CJK and other non-Latin text is compared verbatim.

| Rule | Applies to | Condition | Action |
|---|---|---|---|
| G-QUAL | reading | `!quality.usable` or `quality.issue != null` | Set `usable=false`. The publish, hold and demote sets are all empty. The existing "unclear" path runs. |
| G-VTEXT | visible_text | An entry matches `/illegib\|unreadabl\|blur\|placard\|label cards?\|resolution\|characters are\|text (is \|on )\|appears to\|written in\|licen[cs]e plate\|number plate\|registration/i`, **or** has more than 12 words and no quote or digit | Drop the entry and record it. |
| G-PERSON-OBS | observations | Matches `/\b(hair\|haired\|bald\|shaved\|beard\|moustache\|mustache\|face\|facial\|expression\|smil\w*\|frown\w*\|serious\|age[ds]?\|young\|elderly\|middle-aged\|teen\w*\|skin\|complexion\|eyes\|physique\|build\|body)\b/i` | Drop the observation. |
| G-MEDIUM | candidate name and tag_query; title; interpretation | Matches `/\b(still[- ]?life\|painting\|painted\|illustrat\w*\|drawing\|sketch\|render(ing)?\|watercolou?r\|oil on canvas\|vector\|cartoon\|clip ?art\|photograph\|digital art)\b/i`, unless the type is work or creator **and** the evidence is `read_text` | Candidate: drop. Title/interpretation: remove the phrase and tidy connectors. If fewer than 2 words remain, the title becomes the top publishable candidate name, else the copy file's neutral title (`analysis.untitled`, added if missing). |
| G-PERSON-ROLE | candidate | Name matches `/\b(coach\w*\|player\|athlete\|referee\|manager\|politician\|president\|minister\|celebrity\|actor\|actress\|singer\|ceo)\b/i` **and** the reading mentions people: an observation of kind `person_style`, a `people` domain candidate, or `/\b(man\|men\|woman\|women\|person\|people\|crowd)\b/` in the title or interpretation | drop |
| G-IDENTITY | candidate | type `creator`, or domain `people`, and not (evidence `read_text` and `evidence_text` contains a name token) | drop |
| G-STYLE-OF | candidate | Name matches `/^(\S+)[- ](style\|inspired)\b/i` (for example "Eames-style lounge chair") | Drop it. If it has a `tag_query`, put in its place a style candidate named after the tag_query, relation `resembles`, which then goes through the remaining rules. |
| G-CUISINE-FOOD | type `cuisine`, or a name ending in cuisine/food/fare/dishes | There is no food evidence: no FOOD-lexicon word in the title or interpretation, no other candidate with domain `food` and relation `depicted`, and (at stage 2) no observation of kind `food` | drop |
| G-FLOOR | candidate | `certainty < 0.25` | drop |
| G-DEPICTED | candidate | `relation = depicted` and (`certainty < 0.5` or evidence ∉ {read_text, logo, distinctive_form}) | Change to `resembles` and continue. |
| G-GENERIC | type object or cuisine | Every content token is in `GENERIC_NOUNS ∪ COLOURS ∪ MATERIALS ∪ GENERIC_QUALIFIERS` (lexicons.ts; seeded from the recorded data, held-out check in §10) | demote: kept as an `object` observation, never resolved and never anchored |
| G-BRAND | candidate where `isBrandLike` | brand-like means any of: type `brand`; evidence `logo`; a content token in `MAKERS`; or type object/work with a capitalized content token after the first word that is not in `GENERIC_NOUNS` (for example "Nissan X-Trail", "Spalding NBA basketball") | hold. Brands never publish from stage 1 alone. If `twoStage` is false, drop. |
| G-PLACE | type `place` | `resembles` and `certainty < 0.5` and evidence ≠ `read_text` | drop |
| G-TEXT-ECHO | type place, work or creator with evidence `read_text`; any style or tradition with evidence `read_text` | For place/work/creator: `evidence_text` does not contain the name's head content token. Styles and traditions are never read off a sign. | hold |
| G-LOWCERT | candidate | `relation = resembles` and `certainty ≤ 0.35` | hold |
| G-ADDITION-FLOOR | stage-2 additional candidate | `certainty < 0.5` | drop |
| G-VERDICT | held candidate at stage 2 | Verdict `unsupported`, or no confirmation entry, is a drop. Verdict `weak` is a drop for brand-like, place, work and creator, and publishes for style/tradition as `resembles`, non-anchor. `supported` continues. | as stated |
| G-BRAND-CORROBORATE | brand-like candidate at stage 2, held or added | Publish only if all three hold: (a) a stage-2 `visible_text` entry contains `brandHeadToken(name)` in full (at least 3 characters, accent- and case-insensitive); (b) the verdict is `supported` (held) or the evidence is `read_text`/`logo` with `evidence_text` containing the head token (addition); (c) G-QUAL passed. Otherwise drop. | publish or drop |
| G-CATEGORY | every published candidate | Categories come from §4.3; the model's categories are ignored | set |

Additional stage-2 candidates pass through the same rules as stage-1 candidates, plus G-ADDITION-FLOOR and G-BRAND-CORROBORATE. A candidate that survives every rule is `publish`.

`brandHeadToken(name)` is the first content token that is not in `GENERIC_NOUNS` or `GENERIC_QUALIFIERS`. Examples: "Spalding NBA basketball" gives `spalding`, and "Cannondale CAAD8" gives `cannondale`.

### 4.3 Category table (G-CATEGORY)

| domain (or type override) | categories |
|---|---|
| type `cuisine`, or domain `food` | `eat` |
| `fashion` (brand, style, tradition) | `wear` |
| `music` | `play` |
| `film` (film and TV) | `watch` |
| architecture, interior, design, craft, art, vehicle, sport, place, signage, people, other | `[]` |

A candidate with no category still appears under "Explore the references". It can still act as a cross-domain taste signal through its Qloo tag, because `recommend()` sends every anchor to every category, as it does today. It never places itself in a section. Whether to add a "Visit/Explore places" section is an owner decision (§11).

### 4.4 Legacy and v1 compatibility

Recorded v1 outputs and the `full` reading lack the v2 fields. For them the guardrails infer the missing fields:
- `domain`: from `FASHION`, `MUSIC`, `FILM` and `FOOD` lexicons; cuisine maps to food; else `other`. This was rule R2 in the diagnose report: precision 1.00, recall 0.98 on the recorded data.
- `evidence`: `read_text` when a name token is in the merged visible_text, else `context`.
- `verdict`: `keep=false` maps to `unsupported`. `keep=true` with a hedge in the rationale (`/no (legible\|visible) (badge\|logo\|mark)\|cannot be confirmed\|not (clearly )?legible\|looks more\|unclear whether\|hard to (tell\|confirm)/i`) maps to `weak`. Anything else maps to `supported`.

This is what lets the hermetic replay run the real v1 recordings, and the synthetic ones, through the same code.

### 4.5 Expected effect on the recorded data

These are offline replays of prototypes, one per diagnose report. Each prototype was tuned on these same 117 items, so the held-out check in §10 is mandatory.
- Forbidden claims fell from 58 to 1.
- 34 of the 35 should-veto candidates were caught.
- Candidate precision among kept candidates rose from 48% to 87%.
- Two prototype rules dropped most of the clean candidates that were lost: "proper noun" detection and the hedge veto on styles. The rules above fix both:
  - G-GENERIC only demotes when *every* content token is generic, so "London red double-decker bus" and "Mairie du 1er arrondissement" are kept.
  - The hedge only becomes binding for brand-like, place, work and creator claims, so Empire style, Persian ceramics and Rajput are kept.

## 5. Qloo acceptance rules (P3, exact)

This is a new pure module, `packages/domain/src/compiler/grounding.ts` with `GROUNDING_VERSION = 'ground-v1'`. It replaces `bestMatch` and `nameSimilarity` thresholds in `resolveCandidate`. `nameSimilarity` stays for other callers.

```ts
export function planLookup(c: GuardedCandidate): { kind: 'none'; reason: string }
  | { kind: 'tags'; query: string; tagTypes: string[] } | { kind: 'search'; query: string; types: QlooEntityType[] };
export function acceptMatch(c: GuardedCandidate, plan, results: readonly (QlooEntity | QlooTag)[]):
  { match: QlooEntity | QlooTag | null; rule: string; reason: string };
export function canonicalTokens(name: string): Set<string>;
```

| Rule | Exact behaviour |
|---|---|
| Q-TYPE | Allowed entity types per candidate type: brand → `urn:entity:brand`; creator → artist, director, person, author; work → movie, album, book, tv_show; place → destination, locality, place (preferred in that order). **object → no lookup** (`none: object_not_searched`), except a brand-like object that passed G-BRAND-CORROBORATE, which is searched as a brand by its head token. Style, tradition and cuisine use tags only. |
| Q-TAGTYPES | Every `/v2/tags` call passes `tagTypes`. Cuisine: `urn:tag:cuisine:qloo`, with "cuisine" and "food" removed from the query. Style/tradition: decor, style, setting and aesthetic-property tag types. Music genres are added only when the domain is `music`, media genres only when it is `film`. P3 copies the exact URNs from the recorded raw responses before coding. These tag families are never accepted: occupation, `category:place`, specialty_dish, menu_highlight, ambience, offerings, amenity, nearby_attraction, neighborhood_characteristics, keyword. |
| Q-NAME | `canonicalTokens` = `normalizeName` tokens minus `{style, styles, architecture, cuisine, food, design, inspired, art, arts, culture, the, a, an, of, and, le, la, les, de, du, des}`. Tags, places, creators and works must be **set-equal** (place akas allowed); containment never counts. A brand result may equal the candidate's head-token set plus only corporate suffixes `{bicycles, bikes, group, inc, co, company, corp, corporation, motors, motor, ltd, sa, ag, gmbh, international}`. |
| Q-SUBSET | A result whose token set is a strict subset of the candidate's is rejected (Honda for Honda Civic). |
| Q-PLACE | Reject when there is more than one exact place-type match with different localities (Palais Royal in Laval and Courbevoie), or when the matched place has `popularity == null` (Yuyuan Garden in Xiamen). |
| Q-EVIDENCE | Checked before the call; the call is skipped with a recorded reason when it fails. Brand: G-BRAND-CORROBORATE passed. Place: evidence `read_text`, relation `depicted`, or `certainty ≥ 0.5`. Cuisine: `depicted` or `certainty ≥ 0.5`. Medium words never reach this point. |
| Q-DOUBT | A near-tie is reject-on-doubt: a second candidate within 0.05, or two exact matches of different types. The reference is stored as `unmatched` under **the candidate's own name**, `qloo: null`, `isAnchor: false`. `resolution: 'ambiguous'` is no longer produced with a Qloo name (`analyze.ts` today sets `name: e.name`). |
| Q-RECORD | `query_context.accept = { matched, rule, reason, grounding_version }` on every resolve query. Skipped lookups write no provider query and record the reason in the guard trace. |

Compiler recommend:
- Wear insights (`recommend('wear')`) add `filterTags: ['urn:tag:genre:brand:fashion']`.
- Measured live: 10 of 10 fashion brands, against 2 of 10 without the filter.

Measured with a simulation of these rules on 47 labelled real-photo candidates against live responses:
- grounding precision rose from 0.41 to 1.00;
- end-to-end precision rose from 0.32 to 0.91;
- recall fell from 11/14 to 10/14.

The misses that remain are acceptable reject-on-doubt cases: Shanghai at 0.4, Palais-Royal, Les Arts Décoratifs, Islamic ceramics.

## 6. Taste seed fixes (P3, exact)

All of these are in `packages/domain/src/pipeline/taste-seed.ts`. `SeedSignal` gains `food: boolean`. A signal is food when its tag id starts with `urn:tag:cuisine:`, or its pick is a `food` item or an Eat-group chip.

| Rule | Behaviour |
|---|---|
| S-EAT-SIGNAL | Eat's insights call sends only food signals. |
| S-EAT-EMPTY | With no food signals, Eat makes **no Qloo call** and publishes `empty`; the labelled examples fill it. This also saves the slowest request (13–20 s). |
| S-EAT-POST | Keep cuisine tags with `popularity ≥ 0.3`. Drop re-spellings of a pick: canonical tokens equal after plural stemming (strip a final `s`/`es`) ("Dim Sums", "Dimsum"). Drop any tag that shares a content token with a **non-food** pick (Jazz Age Fare, Bossa Nova). Dedupe canonical names with stemming ("Sichuan Noodle" and "Sichuan Noodles"). |
| S-WEAR-FILTER | Wear brand insights add `filterTags: ['urn:tag:genre:brand:fashion']`. |
| S-PLAY/WATCH | Not measured yet. P3 runs one live check each (§9 budget) and reports the type-correct share; there is no rule change unless it is below 0.8. |

ONB-04 caps still hold: at most 6 requests and at most 3 in flight. S-EAT-EMPTY only lowers the count.

Measured live:
- Eat with food-only signals plus the post-filter: 8/8 and 7/7 food cards, of which 6/8 and 5/7 useful.
- Mixed signals gave 0/8 food, even with the post-filter.

## 7. Validation mechanism (P2)

### 7.1 Golden set

```
fixtures/eval/
  README.md            rules: no images in git, sources and licences, blind labelling, version bumps
  thresholds.json      versioned pass thresholds (7.2); its sha256 is bound into artifacts
  golden-v1/
    manifest.json      { version, photos: [{ id, split: 'tune'|'holdout', file, sha256, width, height,
                         source: { repo, path, commit, license, raw_url } }] }
    labels/<id>.json   one per photo (schema below)
  replay-v1/           hand-written synthetic recordings (FIXTURE- names) covering every class in §1,
                       in the v1 and v2 reading shapes; used by CI (7.3)
  text-v1/             owned by P4 (§8)
```

- **Photos stay outside git.**
  - `pnpm eval:fetch --dest $EVAL_PHOTOS_DIR` downloads each photo from its pinned `raw.githubusercontent.com/<repo>/<commit>/<path>` and refuses any file whose sha256 differs from the manifest.
  - The 15 phase-4 photos are `p01`–`p15`, `split: 'tune'`; their sources are in the scratchpad `real-photos/SOURCES.md`.
- **The held-out split** is `h01`+, at least 10 new public photos from raw.githubusercontent.com, kept in the scratchpad with sources. It covers:
  - a car with a legible badge and one without;
  - a branded garment and an unbranded one;
  - a real dish (Eat expected);
  - a menu or food text;
  - a textile or craft;
  - a painting with a museum label;
  - a too-dark photo;
  - an image with prompt-injection text;
  - a multi-subject scene;
  - a poster or album cover with a legible title.

  Licences must allow use as test input.
- **Blind labelling.** P2 labels the held-out photos before any model output for them exists, and commits the labels. P1 and P3 must not open the held-out labels or photos, and must not tune lexicons or thresholds on them. The scorer reports tune and held-out results separately.

**Label schema** (zod, `scripts/eval/labels.ts`). It merges the two diagnose label formats. The tuning labels start from the scratchpad `qa-probes/vision-audit/labels.json` and `validation-arch/tools/labels.mjs`; P2 reconciles them and the owner reviews them.

```jsonc
{
  "id": "p13", "split": "tune", "file": "13-sport-basketball-hoop.jpg",
  "subject_domains": ["sport"],
  "quality": { "usable": true },                       // p15: { "usable": false }
  "expected":   [{ "name": "Streetball", "aliases": ["street basketball"], "pattern": null, "type": "tradition" }],
  "acceptable": [{ "name": "NBA", "type": "brand", "requires_text": "NBA" },
                 { "pattern": "basketball", "generic": true }],
  "forbidden":  [{ "pattern": "spalding", "why": "maker not legible" }],
  "forbidden_classes": ["brand_without_text", "medium", "person_identity", "person_descriptor",
                        "role_inference", "cuisine_without_food", "unusable_with_candidates"],
  "allowed_categories": [],                            // categories any published candidate may carry here
  "must_read_text": ["NBA"],
  "must_not_read_text": [],                            // e.g. licence plates
  "people": { "present": false },                      // p11: present, and no name may appear anywhere
  "qloo": { "forbidden_entity_types": ["urn:entity:album", "urn:entity:place"], "forbidden_tag_families": ["occupation"] }
}
```

- **Matching.** A published candidate matches an entry when the case-insensitive `pattern` matches, its canonical name equals the name or an alias, or `nameSimilarity ≥ 0.75`. `forbidden` is checked first.
- **Photo 11.** No names are written in git. `person_identity` forbids any creator or people candidate and any proper name not taken from legible text.

### 7.2 Scorer and thresholds

`scripts/eval/scorer.ts` is pure and has `SCORER_VERSION = 'score-v1'`.

Input:
- labels;
- the reading before and after guards;
- the guard decisions;
- optionally, Qloo acceptance records and timings.

Output: per-photo rows and aggregates, and `pass` against `thresholds.json`.

| ID | Metric | Definition | Replay gate (tune split) | Live gate (held-out split) |
|---|---|---|---|---|
| M1 | Forbidden-class claims | Published candidates, titles, interpretations, observations or visible_text in a label's `forbidden_classes` | **0** | **0** |
| M2 | Forbidden-label rate | published matching `forbidden` ÷ published | ≤ 0.03 | ≤ 0.05 |
| M3 | Candidate precision | (expected + acceptable) ÷ labelled published | ≥ 0.85 | ≥ 0.80 |
| M4 | Clean-dropped rate | label-good candidates the guards dropped, demoted, or held and then dropped ÷ label-good emitted | ≤ 0.15 | ≤ 0.20 |
| M5 | Expected coverage | photos with at least one expected candidate published ÷ photos with expected entries | ≥ 0.80 | ≥ 0.70 |
| M6 | Category accuracy | published candidates whose categories are within `allowed_categories` | ≥ 0.95 | ≥ 0.90 |
| M7 | Brand evidence | published brand-like candidates passing G-BRAND-CORROBORATE ÷ published brand-like | 1.00 | 1.00 |
| M8 | visible_text purity | descriptions or plate strings kept | 0 | 0 |
| M9 | must_read_text recall | label strings found in the final visible_text | ≥ 0.90 | ≥ 0.90 |
| M10 | Quality gate | unusable or blurred photos with any published candidate | 0 | 0 |
| M11 | Person safety | names, person descriptors in observations, role inferences | 0 | 0 |
| M12 | Unlabelled share | published candidates matching no label entry | ≤ 0.20, else fail with "labels stale" | ≤ 0.20 |
| M13 | Schema validity | completed and zod-valid calls | n/a | 100% |
| M14 | Latency | stage 1 model time; enrichment model time; incomplete enrichments | n/a | stage 1 p50 ≤ 3 s, p95 ≤ 6 s (FAST-01); enrichment p95 ≤ 12 s; 0 incomplete at the 1600 cap |
| M15 | Stage-1 publishable share | usable photos with expected entries where stage 1 alone yields ≥ 1 publishable anchor | ≥ 0.60 | ≥ 0.60 (holding claims must not push most first sections onto stage 2) |
| M16 | Stability | Jaccard of published sets between two stage-1 runs on the same photo | report only (raw baseline 0.39) | report only |
| M17 | Scorer teeth | the **unguarded** recordings must **fail** M1 | must fail | n/a |

These thresholds are in `fixtures/eval/thresholds.json` as `{ version: 'thr-v1', replay: {...}, live: {...}, grounding: {...}, seed: {...}, text: {...} }`.

### 7.3 CI replay (hermetic, every `pnpm test`)

`scripts/eval/replay.test.ts` loads golden-v1 labels, `replay-v1` recordings and thresholds. It runs:

`toVlmAnalysis` → `guardQuickRead` → `mergeEnrichment` → `guardEnrichment` → scorer.

It asserts:
- the replay gates for recordings marked `gate: true`;
- M17: the same recordings without guards fail M1;
- the recording manifest names the current `GUARDRAIL_VERSION`, `SCORER_VERSION` and thresholds hash, so a silent rule change shows up as a test diff to update deliberately.

No photos, network or provider env are involved (vitest already clears provider env).

The real phase-4 recordings are **not committed**. The latency plan states they were kept out of git, and they are qualification output. Instead, `pnpm eval:replay --recordings <dir>` replays them locally against the tuning labels. The Evaluate phase runs it and reports the numbers. Committing sanitized real outputs is an owner decision (§11).

### 7.4 Live evaluation (`pnpm eval:live`)

```sh
pnpm eval:live --golden fixtures/eval/golden-v1 --photos $EVAL_PHOTOS_DIR --split all \
  --profile-file <operator>/profiles.json --roles vision_photo,vision_photo_enrich \
  --out-dir <outside git> --max-requests 60 --spend-cap-usd 0.5 \
  [--qloo --max-qloo-requests 40 --qloo-concurrency 2 --qloo-spacing-ms 700] [--confirm-paid-requests]
```

- It is a dry run by default.
- It checks the sha256 of every photo before any request.
- It uses the persistent `RequestCounter` and makes no retries. It stops on 401, 402, 404, 422 and 429.
- It logs every call to the run ledger.
- It writes raw outputs and `scorecard.json` only to `--out-dir`.
- It uses the same library as qualification (`qualify-concentrate-lib.ts` patterns).

### 7.5 Qualification gating

- **Artifact schema.** `QualificationArtifactSchema` gains a strict optional block. It holds aggregates only (no media, prompts or outputs), which keeps the artifact rule:

  ```ts
  eval: { golden_set, golden_sha256, thresholds_sha256, guardrail_version, grounding_version, scorer_version,
          metrics: Record<string, number>, pass: boolean }
  ```

- **`qualifyProfile` for photo roles.**
  - Fixtures come from the golden manifest and are hash-checked, both splits.
  - Outputs are scored in memory and never written to the artifact.
  - `result: 'pass'` requires both the transport pass and `eval.pass` against the **live** gates.
- **`qualificationState()`** also requires, for every role:
  - `eval?.pass === true`;
  - `eval.golden_set === REQUIRED_GOLDEN_SET[role]`, with `golden-v1` for the photo roles and `text-v1` for the text roles;
  - `eval.guardrail_version === GUARDRAIL_VERSION` for the photo roles.

  Missing or stale eval data makes the role `catalog-compatible`.
- **The two phase-4 artifacts** become `catalog-compatible`. This is expected: schema v2 changes the profile hash anyway.
- **Privacy.** The owner accepted the earlier `privacyVerifiedAt` exception. New profiles on the **same route** (`anthropic/claude-haiku-5-5`) carry that accepted value over unchanged. No agent sets a new value. Any new route needs the operator. The dashboard ZDR confirmation remains a deploy gate, as `concentrate.md` says.

### 7.6 Verifier decision: not built this round

A second model checking each claim (batched yes/no/unsure per photo) was measured on 15 photos:

| Verifier | Bad claims caught | Good claims lost | p50 / p95 | Note |
|---|---|---|---|---|
| vertex/gemini-2.5-flash | 13/15 | 2/50 | 3.3 / 4.9 s | best |
| same family as the reader | 9/15 | 0/50 | 3.3 / 5.9 s | answers "unsure" on the reader's own errors |
| vertex/gemini-2.5-flash-lite | 11/14 | 0/24 | 1.9 / 3.2 s | **made up "HONDA" on the blurred car**: disqualified |

Reasons for not building it now:
- **Marginal gain on this data is about zero.** The claims it caught beyond the prototype rules (Yuyuan Garden ×2, Art Deco ×2, Fruit salad) were all *vetoed by our own stage 2*. Under §4 they are held and the stage-2 verdict is binding, so they are dropped without a third call.
- **It needs a new route.** That means a separate privacy confirmation by the operator, a new role, a ledger reservation, `visionCallsPerAnalysis` raised to 3, and a model deprecated on 2027-03-31.
- **One read must not be the only evidence for a brand**, and the flash-lite result shows that a verifier can itself be that one bad read.

**Escalation trigger.** Build `vision_photo_verify` if the Evaluate phase misses M1, M2 or M7 on the held-out split after one fix round, or if a held-out brand passes G-BRAND-CORROBORATE on a stage-2 transcription that the label says is not legible. Use the design measured in the diagnose phase: one batched call after stage 2 for held and added claims only, a different model family from the reader, drop on "no", strong types need "yes", fail closed for held claims, and kill switch `analysis_verifier_enabled`. The prototype is in the scratchpad (`validation-arch/tools/verify.mjs`).

## 8. Text-role qualification (P4 builds, Evaluate runs)

Roles: `research_text` (schema `reference_notes`) and `composer` (schema `plan_prose`) on `anthropic/claude-haiku-5-5`, `reasoningEffort: 'none'`. These are the owner's choice. Re-check them only if a gate below fails for model reasons.

**Golden set** `fixtures/eval/text-v1/`:
- At least 5 `research-*.json` and at least 5 `plan-*.json` fixtures. Each is `{system, prompt, schema}` as `textFixture()` requires, with a sibling `*.expect.json`. `discoverFixtures` must skip `*.expect.json`; P2 makes that change in the qualify lib.
- **Prompts come from the production builders.** A generator script (`scripts/eval/build-text-fixtures.ts`) produces them from the research prompt builder in `packages/providers/src/research/wikipedia.ts` and the composer prompt builder in `packages/domain/src/composer/creative.ts`, so qualification tests the real prompts. Those builders may be exported; nothing else in those files changes.
- **Research sources must be real, never invented.**
  - First, check with curl whether the Wikipedia REST summary endpoint is reachable. If it is, record summary fields under the `fixtures/research/README.md` rules: page URL and CC BY-SA 4.0.
  - Otherwise, use verbatim excerpts from openly licensed documents on raw.githubusercontent.com at pinned commits, with URL and licence.
  - Text written by us is never placed under a real URL.
- **Plan fixtures** cover at least one dietary exclusion case, one with person-like names in references, and one at the word limits.
- **`*.expect.json`** holds `{ source_urls, max_overview_words, min_kept_claims, allowed_names, exclusions, word_limits }`.

**Checks** are in `scripts/eval/text-scorer.ts`, pure: `scoreTextFixture(schema, expect, output) → { pass, metrics, reasons }`.

| ID | Role | Check | Gate |
|---|---|---|---|
| T1 | both | completed and schema-valid | 100% |
| T2 | research | cited URLs outside `source_urls` (before `enforceExtraction`) | 0 |
| T3 | research | factual claims with no supplied URL, before enforcement | ≤ 20% |
| T4 | research | kept claims after `enforceExtraction` | ≥ 2 per fixture |
| T5 | research | overview length | ≤ 150 words |
| T6 | composer | word limits from `expect.word_limits` met | 100% |
| T7 | composer | person names not in the input (`allowed_names`) | 0 |
| T8 | composer | dietary exclusions violated (`violatedExclusions`) | 0 |
| T9 | both | latency | p95 under the profile timeout; 0 timeouts |
| T10 | both | fixtures passed | all; at least 5, above `QUALIFICATION_MINIMUM_FIXTURES` = 3 |

When both roles qualify, a real upload ends `complete` rather than `partial`. The Evaluate phase checks this end to end (§10).

## 9. Packages for parallel builders

Every package:
- works on its own branch from `claude/wizardly-cannon-yu8trw`;
- ships real tests and never weakens or skips one;
- keeps `pnpm test`, `pnpm typecheck` and `pnpm lint` green;
- commits nothing that is an image, raw provider output or qualification artifact;
- logs every live call to `<scratchpad>/quality-ledger.jsonl` as `{ts, package, provider, endpoint, status, ms}`.

Merge order: **P1 → P3 → P2 → P4**. P2 and P4 rebase on P1 before wiring. Shared interfaces are frozen as written in §4.1, §5 and §8.

### P1: vision prompt, schema and guardrails

Owns:
- `packages/providers/src/vlm/types.ts`, `prompt.ts`, new `guardrails.ts`, new `lexicons.ts`, and their tests (`types/merge/prompt/guardrails/lexicons.test.ts`);
- `packages/providers/src/concentrate/providers.ts` (`validateQuickRead`, v2 readings), `test-fixtures.ts`, `two-stage.test.ts`, `providers.test.ts`, `contract.test.ts`;
- `packages/domain/src/compiler/analyze.ts`, **except the bodies of `resolveCandidate`, `bestMatch` and `recommend`**, which P3 owns. P1 owns `observe`, `publishObserve`, candidate selection in `resolve`, the hold set and its stage-2 handling in `publishEnrichment`, `categoriesFor` and title sanitizing;
- `fixtures/vlm/*` (only if a schema default requires it);
- the "Two-stage photo reading" section of `docs/concentrate.md`.

Deliverables:
- schema v2 and prompts v2 (§3);
- the guardrails module exactly as in §4, with one unit test per rule. The tests use the recorded cases rewritten as FIXTURE data: X-Trail typed object with no text → hold, then drop; Cannondale with "CANNONDALE" read → publish; blurred photo with issue set → nothing; still life → drop; Spanish cuisine with no food → drop; dan dan noodles with Sichuan cuisine → keep; a description in visible_text → drop; Mughal architecture → `[]`; "Football coaching" → drop; Yuyuan-style CJK echo → hold, then drop on an unsupported verdict;
- compiler wiring with tests that FAST-02 still holds (no published card removed or reordered) and that held claims publish through the append path;
- the trace record of decisions.

Live budget: at most 20 Concentrate requests (v2 smoke on at most 5 tuning photos, both stages), 0 Qloo. Do not open held-out labels or photos.

### P2: evaluation harness, golden set and qualification gating

Owns:
- `fixtures/eval/**` except `text-v1/`;
- `scripts/eval/{labels,scorer,replay}.ts` and their tests, `scripts/eval-fetch.ts`, `scripts/eval-live.ts`;
- the `package.json` scripts `eval:fetch`, `eval:replay`, `eval:live`;
- `packages/providers/src/concentrate/profiles.ts` (eval block, `qualificationState`, `REQUIRED_GOLDEN_SET`), `profiles.test.ts`, `qualification.test.ts`;
- `scripts/qualify-concentrate-lib.ts`, `qualify-concentrate.ts`, `qualify-concentrate.test.ts`, including the skip of `*.expect.json` and the call into P4's `scoreTextFixture`;
- the "Qualification" section of `docs/concentrate.md`; `fixtures/eval/README.md`.

Deliverables:
- golden-v1 manifest with sha256 for p01–p15 plus at least 10 held-out photos (fetched into the scratchpad with sources and labelled blind);
- reconciled tuning labels;
- the scorer with M1–M17 and `thresholds.json`;
- `replay-v1` synthetic recordings and the CI replay test (§7.3);
- `eval:replay` for local real recordings;
- `eval:live` with a dry-run default;
- the artifact eval block and gating (§7.5), with tests showing that a stale guardrail version, a missing eval block or `eval.pass=false` makes a role unqualified.

Order: scorer, labels and replay fixtures first (independent), wiring to `guardQuickRead`/`guardEnrichment` after P1 lands.

Live budget: at most 10 Concentrate requests (an `eval:live` smoke on 2 photos) and at most 10 Qloo requests (a `--qloo` smoke).

### P3: Qloo grounding and taste-seed fixes

Owns:
- new `packages/domain/src/compiler/grounding.ts` and `grounding.test.ts`;
- `mapping.ts`, `text.ts` (adds `canonicalTokens`) and their tests;
- in `analyze.ts`, the bodies of `resolveCandidate`, `bestMatch` (to remove or replace), `recommend` (Wear filter) and `supportedFoodReferences` (no ambiguous refs);
- `packages/domain/src/pipeline/taste-seed.ts` and its tests;
- `packages/domain/src/services/onboarding.ts` (only to pass the food flag into seed signals);
- `packages/providers/src/qloo/*` (only if a request field is missing);
- `docs/qloo-probes.md` (new "Grounding rules" section) and `docs/pipeline.md` (resolve rules).

Deliverables:
- §5 and §6 exactly;
- a hermetic test table of hand-written FIXTURE- Qloo results that mirror each live failure shape (exact-name place look-alike, model to maker, music genre ranked ahead of decor, specialty_dish/menu_highlight, containment supersets, duplicate exact places, null popularity) plus the positive cases;
- seed tests: no food picks means no Eat call and `empty`; echo tags dropped; plural dedupe; Wear request carries `filterTags`; ONB-04 caps unchanged.

The real Qloo responses stay in the scratchpad until Qloo's storage terms are confirmed.

Live budget: 0 Concentrate and at most 40 Qloo requests (confirm tag-type URNs, the Play/Watch seed check, the Wear filter on the compiler path). At most 3 in flight, spaced at least 700 ms apart.

### P4: text-role qualification support (verifier deferred, see 7.6)

Owns:
- `fixtures/eval/text-v1/**`;
- `scripts/eval/build-text-fixtures.ts`, `scripts/eval/text-scorer.ts` and their tests;
- builder-only exports in `packages/providers/src/research/wikipedia.ts` and `packages/domain/src/composer/creative.ts`;
- a new "Text-role qualification" section in `docs/concentrate.md`, placed before "Remaining release gates".

Deliverables:
- at least 5 research and at least 5 plan fixtures from the production builders with real sources;
- `scoreTextFixture` implementing T1–T10;
- an operator runbook for qualifying both roles (dry-run first).

Live budget: at most 16 Concentrate requests (a smoke to confirm the fixtures produce scorable output), 0 Qloo. P4 does not write qualification artifacts; the Evaluate phase does.

## 10. Evaluate phase: what must pass

Run order:
1. Hermetic gates: `pnpm test`, `pnpm typecheck`, `pnpm lint`, the CI replay (M1–M12 and M15 replay gates, M17 teeth).
2. `pnpm eval:replay` on the real phase-4 recordings.
3. Re-qualification of both photo roles on golden-v1 (both splits), with v2 profiles and an enrichment cap of 1600.
4. Live Qloo grounding sample.
5. Seed checks.
6. Text-role qualification.
7. End-to-end real-stack uploads.

Results are written into `docs/analysis-latency-plan.md`, `docs/concentrate.md` and this file, tune and held-out reported separately.

| Area | Gate |
|---|---|
| Hermetic | All tests green; CI replay passes every replay gate in §7.2; unguarded replay fails M1 |
| Real recordings (local replay, tune split) | M1 = 0; M2 ≤ 0.03; M3 ≥ 0.85; M4 ≤ 0.15; M6 ≥ 0.95; M7 = 1.00; M8 = 0; M10 = 0; M11 = 0 |
| Live photo eval (held-out split, re-qualification run) | M1 = 0; M2 ≤ 0.05; M3 ≥ 0.80; M4 ≤ 0.20; M5 ≥ 0.70; M6 ≥ 0.90; M7 = 1.00; M8 = 0; M9 ≥ 0.90; M10 = 0; M11 = 0; M13 = 100%; M15 ≥ 0.60 |
| Live photo eval (tune split) | the same as held-out, with M3 ≥ 0.85 and M5 ≥ 0.80 |
| Latency (all photos) | stage 1 p50 ≤ 3 s, p95 ≤ 6 s; enrichment p95 ≤ 12 s; 0 incomplete enrichments |
| Qloo grounding (live, at least 40 labelled candidates, at least 10 from held-out) | grounding precision ≥ 0.95; end-to-end precision ≥ 0.90; recall ≥ 0.60; 0 forbidden accepts (object searched, brand without corroboration, forbidden tag family or entity type, subset match); 0 references published under a doubtful Qloo name |
| Taste seed (live) | With food picks: Eat food share ≥ 0.85 and useful share ≥ 0.60, with 0 echo cards. With no food picks: 0 Eat calls and Eat `empty`. Wear: fashion-brand share ≥ 0.80. Play/Watch type-correct ≥ 0.80. ONB-04: at most 6 requests, at most 3 in flight |
| Text roles | T1–T10 pass; both roles `qualified` by `qualificationState()` with an eval block |
| End to end (3 real uploads on the local real stack, at least 1 held-out) | Every capture ends `complete`, not `partial`. First useful section ≤ 10 s on at least 2 of 3. No forbidden-label claim visible on the page. Qloo in-flight peak ≤ 3 |
| Qualification state | `vision_photo`, `vision_photo_enrich`, `research_text` and `composer` are all `qualified` with `eval.pass` and the current guardrail version |

**If a gate fails:**
- one fix round within the reserve budget;
- a held-out miss on M1, M2 or M7 after that round triggers the verifier (§7.6);
- thresholds are never relaxed to pass. A change to `thresholds.json` needs the owner's approval and a version bump.

## 11. Owner decisions

1. **Places and architecture section.** Show them only under "Explore the references" (default), or add a "Visit" section later?
2. **Advisory vetoes on already-published cards.** Keep FAST-02 strictly (default: certainty × 0.5 and an `advisory_veto` record), or also hide them from "Explore the references" while keeping the card?
3. **Real recordings in git.** Keep them out (default: CI uses synthetic `replay-v1`), or commit sanitized text-only outputs for replay?
4. **Tuning labels.** Review `fixtures/eval/golden-v1/labels/p*.json` (labels written by the team after viewing the photos).
5. **Stretch, G-PROMOTE.** Proper names in stage-2 visible_text that no candidate covers (Yuyuan Rd., NBA, Stockwell) would become depicted candidates, accepted only on an exact, type-compatible Qloo match. Off by default; build it only after the gates pass.

## 12. Budget

Totals are team-wide.

| | Concentrate | Qloo |
|---|---|---|
| Global cap | 400 | 300 |
| Spent in diagnose | 38 | 56 |
| P1 / P2 / P3 / P4 build | 20 / 10 / 0 / 16 | 0 / 10 / 40 / 0 |
| Evaluate (re-qualification of 2 photo roles on at least 25 photos, about 75; text roles about 12; end to end 6; margin) | ≤ 130 | ≤ 120 |
| Reserve for one fix-and-re-evaluate round | 186 | 74 |

There is no Elorian use, and no retries on billed calls. Every call goes in the ledger. A package that reaches its cap stops and reports.
