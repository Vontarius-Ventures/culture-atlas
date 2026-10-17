# Photo analysis latency plan

Status: proposal, measured 2026-10-17 against the live Concentrate, Elorian and Qloo keys. Nothing in production code has changed yet. The measurements use the 16 project illustrations (`apps/web/public/samples`), not real photos. See "Bias" below.

## Summary

1. **The slow reading was mostly a route problem, plus reasoning defaults, not the schema.** The earlier qualification runs used DeepInfra routes, which ran at about 20–55 tok/s plus queueing, and `openai/gpt-5-nano` at its default reasoning effort. The OpenAI, Vertex and Anthropic routes on Concentrate, with `reasoning.effort` set to `none`/`minimal`, return a reading in 2–3 s. They return even today's full `VlmAnalysis` in 4–10 s. `deepinfra/mistral-small-3.2` still took 11–19 s with the slim schema.
2. **A slimmer first reading is faster and gives better candidates.** On the same route (Claude Haiku 5.5), the fast schema made more specific, more searchable candidates than the full schema: "dan dan noodles" against "Noodle soup", and "Viennese coffee house culture, Wiener Geflecht chair" against "Café-style coffee and pastry breakfast". The full schema spends its tokens on ids, boxes and rationale, and its candidates turn generic.
3. **Recommendation: use a two-stage reading.**
   - **Stage 1, quick read:** `anthropic/claude-haiku-5-5` with `reasoning.effort=none`, a 512 px image, the 5-candidate schema below and `max_output_tokens` 600. It measured 30/30 complete, p50 2.1–2.4 s, p95 2.6–4.6 s, about $0.0017 per photo. Its candidates were the best of every cheap route.
   - **Stage 2, enrichment:** a background call on the same route that adds observations, rationale, regions, visible text and up to 4 more candidates. It measured p50 4.7 s at about $0.003.
   - The first useful section is then about 2.5 s of vision plus Qloo time. That is well inside 10 s p50 / 20 s p95.
4. **Elorian is not worth it, even for stage 2.** It took about 55 s per image, one of 4 requests timed out at 120 s, and each request used 25–75k input and 11–16k output tokens. It ignored `max_completion_tokens` and `reasoning_effort`. Its quality is good, but `claude-sonnet-5` on Concentrate gives comparable enrichment in 11–13 s, with the ZDR terms known.
5. **UX:** keep the photo screen live while the reading runs. Add a "While we look" strip that comes from the existing discovery feed snapshot: reviewed example cards (labeled) for new users, and save-connected cards for returning users. It needs no new generation and no questionnaire. Reveal sections progressively, and show an in-app "Your photo is ready" notice (push on native) when a background analysis finishes. Optional taste picks come only after the first discovery, are skippable, and are saved as explicit endorsements of real Qloo tags.

## Measured variants

All Concentrate calls used the Responses API, with `text.format` json_schema strict and the schema built by `structuredOutputContract()`. Output was validated by zod after `decode()`, and calls ran sequentially from the dev container. Pass means `status=completed` and a zod-valid output. Costs are estimates from the catalog snapshot's list prices.

| # | Route (effort) | Schema | Image | Pass | p50 / p95 | In / out tok (mean) | ≈ $/call | Accuracy notes |
|---|---|---|---|---|---|---|---|---|
| 1 | anthropic/claude-haiku-5-5 (none) | fast | 768 | 16/16 | 2.4 / 4.6 s | 1980 / 338 | 0.0018 | **Best.** Strong on 14/16, partial on 2: dan dan noodles, smashed cucumber salad, Isamu Noguchi, linen shirt-dress, Viennese coffee house + Wiener Geflecht, chochin lantern, mezze/muhammara |
| 2 | anthropic/claude-haiku-5-5 (none) | fast | **512** | 8/8 | **2.1 / 2.6 s** | 1649 / 329 | 0.0017 | Same quality as 768 (smacked cucumber + Sichuan chili oil, chabudai, Mod style) |
| 3 | anthropic/claude-haiku-5-5 (none) | fast + medium/generic rule | 512 | 6/6 | 2.2 / 2.8 s | 1757 / 300 | 0.0016 | Fewer generic items (oi muchim, gochugaru). "Flat illustration aesthetic" still leaked once |
| 4 | vertex/gemini-2.5-flash-lite (none) | fast | 768 | 16/16 | 1.9 / 2.9 s | 1804 / 305 | 0.0005 | Fastest and cheapest. Read the linen shirt and the blazer as "Lab coat", the cucumber salad as "Gazpacho"; generic food. Good on interiors |
| 5 | vertex/gemini-2.5-flash-lite (none) | fast + rule | 512 | 4/4 | 1.6 / 2.4 s | 1877 / 282 | 0.0005 | The rule did not fix the lab-coat misread |
| 6 | openai/gpt-6-luna (none) | fast | 768 | 16/16 | 2.3 / 3.3 s | 1151 / 165 | 0.0002 | Misreads scenes ("Monument Valley", "Limbo", "Trench coat", "Ramen"); many style-only candidates |
| 7 | openai/gpt-5.4-nano (none) | fast | 768 | 3/3 | 2.5 / 2.8 s | 1151 / 212 | 0.0003 | Hallucinated ("paper cutout heart balloons"). Rejected |
| 8 | openai/gpt-5-nano (minimal) | fast | 768 | 3/3 | 2.1 / 2.8 s | 1294 / 256 | 0.0001 | Completes now (the earlier failures were default effort), but the candidates are odd ("Air Raid Shelters poster", "Smeg fridge"). Rejected |
| 9 | openai/gpt-5.6-luna (none) | fast | 768 | 3/3 | 2.7 / 3.7 s | 1151 / 195 | 0.0004 | Good on tea, wrong on the outfit and the noodles |
| 10 | vertex/gemini-2.5-flash (none) | fast | 768 | 3/3 | 2.7 / 2.9 s | 1804 / 247 | 0.0021 | Good outfit read (Mod, Harrington, RAF roundel, Fred Perry); noodles read as ramen |
| 11 | deepinfra/mistral-small-3.2 | fast | 768 | 3/3 | 13.0 / 19.1 s | 1046 / 311 | 0.0002 | The route itself is slow; outfit read as "Football kit". Rejected |
| 12 | anthropic/claude-haiku-5-5 (none) | slim (single call) | 768 | 8/8 | 3.5 / 5.6 s | 2461 / 580 | 0.0027 | Candidates as good as fast, plus observations and rationale |
| 13 | anthropic/claude-haiku-5-5 (none) | full (today's `VlmAnalysis`) | 768 | 8/8 | 5.3 / 10.0 s | 3417 / 1023 | 0.0043 | Fits the 30 s attempt, but candidates are generic ("Noodle soup", "Flat illustration style", 2–3 candidates) |
| 14 | vertex/gemini-2.5-flash-lite (none) | full | 768 | 8/8 | 4.1 / 5.5 s | 2246 / 1494 | 0.0015 | Generic ("Minimalism" as the only candidate for the alley) |
| 15 | openai/gpt-5-nano (minimal) | full | 768 | 2/2 | 4.5 / 5.1 s | 1808 / 814 | 0.0002 | Completes, but vague |
| 16 | anthropic/claude-haiku-5-5 (none) | stage-2 enrich | 768 | 3/3 | 4.7 / 4.8 s | 2554 / 790 | 0.0033 | Adds RAF roundel, Harrington, liangpi. Conservative: flags weak stage-1 items |
| 17 | anthropic/claude-sonnet-5 (none) | stage-2 enrich | 768 | 3/3 | 11.4 / 12.8 s | 2553 / 1033 | 0.0154 | Richest (The Who / Mod, Harrington, zhajiangmian, casbah). Names real people as creators |
| 18 | Elorian elorian-1-agent | stage-2 enrich (schema in prompt) | 768 | 2/4 valid | about 55.6 s for the 3 that finished; 1 timed out at 120 s | 25–75k / 11–16k (9–12k reasoning) | not in ledger | Good (liangmian, Marrakech medina). Ignored `reasoning_effort=low` and `max_completion_tokens=6000`; 1 of 3 completed replies did not follow the JSON shape |

Earlier baseline (`docs/concentrate.md`): the full schema at the native 1000×1250 size passed 2/16 on gpt-5-nano (default effort), 3/16 on DeepInfra gemma-3-27b, 3/16 on DeepInfra mistral-small-3.2 and 6/16 on Elorian (60 s limit).

### Per-image candidates (fast schema, 768 px)

| Image | Haiku 5.5 | Gemini 2.5 flash-lite | GPT-6 luna |
|---|---|---|---|
| tea-rituals | tetsubin, matcha, tea ceremony, wabi-sabi, Japandi | chawan, matcha, tetsubin, ikebana, wabi-sabi | tetsubin, matcha, tea ceremony, wabi-sabi, ikebana |
| outfit | Le Mans racing jacket, Mod parka, RAF roundel | Harrington jacket, Mod style, target insignia | café racer jacket, Mod fashion, racing livery |
| sesame-noodles | **dan dan noodles, sesame noodles, Sichuan** | ramen, pho | ramen, udon |
| cafe | espresso, Viennese coffee house, Wiener Geflecht chair, croissant | coffee cup, croissant, café | cappuccino, croissant, Parisian café |
| cucumber-salad | **smashed cucumber salad**, oi muchim | gazpacho, cucumber soup | cucumber salad |
| linen-days | linen, shirt dress, Japandi | **lab coat** | **trench coat** |
| softer-silhouette | linen blazer, rattan, Japandi | **lab coat**, rattan | dress shirt |
| night-wanderings | medina alley, lantern festival, film noir | lantern festival, Dark Academia | **Monument Valley** |
| rainy-alley | chochin lantern, Chinese lantern festival | red lantern festival, haunted house | **Limbo** |
| room | Japandi, shoji, ikebana, wabi-sabi, tatami | shoji, wabi-sabi, ikebana | mid-century modern, Japandi |
| sculptural-forms | Japandi, wabi-sabi, **Isamu Noguchi** | Japandi, biomorphism, Muji | minimalist interior |
| late-night-cinema | cinema marquee, film noir, Art Deco | movie theater, art gallery | art gallery, Art Deco marquee |
| sunday-listening | turntable, vinyl, mid-century, Danish modern | vinyl, mid-century | vinyl, Bauhaus |
| something-to-share | radish salad, mezze, muhammara | salad, radish | garden salad, crudités |
| around-the-table | tomato soup, Mediterranean, flatbread with dip | soup, condiments | tomato soup, gazpacho |
| blossom-branch | sakura, hanami, wagashi | sakura, hanami, ukiyo-e | sakura, sumi-e |

### Qloo resolvability

The stage-1 Haiku candidates (8 images, 35 names) went to `/search` for names and `/v2/tags` for style/tradition types, with 700 ms between calls: 34/35 returned something, at p50 90 ms and p95 241 ms per call. Tags resolve cleanly (Wabi Sabi, Japanese Tea Ceremony, Mod Revival, Mid Century Modern, Scandinavian Minimalism, Chinese Cuisine). Free-text `/search` for object-like names returns look-alikes ("Racing jacket" → an album, "Smacked cucumber salad" → a sushi bar). The compiler's acceptance checks must keep rejecting these, and the prompt should keep favouring tag-shaped names.

**Rate limit:** the same 35 calls run back-to-back gave 21 that came back empty or failed in about 46 ms each. That is consistent with burst throttling on the hackathon key. Cap resolve concurrency at 2–3 and keep the existing resilience retry.

### Bias: these are illustrations

- **The rendering medium leaks into candidates** ("flat vector illustration"). An explicit rule reduces this but does not remove it.
- **No logos or text** were present, so `depicted`, `visible_text` and brand recognition were not exercised. Simplified garments misled flash-lite. Small logos may need more than 512 px, so stage 2 should stay at 768–1024.
- **Latency is probably representative.** Image tokens depend on pixel size, which was fixed. Busier real photos may produce more output, and the fast schema caps that at 5 candidates.
- **One subject per image**, so `competing_subjects` was never exercised.
- **The accuracy judgement is the specialist's** (it viewed the images; there is no labeled ground truth). The ranking Haiku > Gemini flash ≈ flash-lite > GPT-6 luna > nano routes is directional.

## Recommended reading format

### Stage 1: `VlmQuickRead` (interactive)

```ts
VlmQuickRead = z.object({
  title: z.string(),            // <= 6 words (prompt), max 60 chars
  interpretation: z.string(),   // one sentence, <= 20 words, max 160 chars
  candidates: z.array(z.object({
    name: z.string(),           // specific, searchable, max 80 chars
    type: z.enum(VLM_REFERENCE_TYPES),
    relation: z.enum(['depicted', 'resembles']),
    certainty: z.number().min(0).max(1),
    categories: z.array(z.enum(VLM_CATEGORIES)).max(4),
    tag_query: z.string().nullable(),   // taxonomy phrase for style/tradition/cuisine, else null
  })).max(5),                   // prompt asks for 3-5
  quality: z.object({ usable: z.boolean(), issue: z.enum(['blurred','no_subject','too_dark','unsupported_content']).nullable() }),
})
```

The security rules stay unchanged. Two new prompt rules:
- "Read the subject as if it were a photo; never name the rendering medium or drawing style."
- "Skip generic objects unless named as a specific type, style or tradition."

Profile: `anthropic/claude-haiku-5-5`, `reasoningEffort: 'none'`, `maxOutputTokens: 600` (measured max 389), `maxDimension: 512`, `timeoutMs: 10_000`, with one retry inside the 30 s attempt budget.

### Stage 2: `VlmEnrichment` (background)

```ts
VlmEnrichment = z.object({
  observations: z.array(z.object({ text: z.string(), kind: ObservationKind })).max(5),
  visible_text: z.array(z.string()).max(8),
  confirmed: z.array(z.object({ name: z.string(), rationale: z.string() /* <=15 words */, keep: z.boolean() })),
  additional_candidates: z.array(Stage1Candidate.extend({ rationale: z.string() })).max(4),
  regions: z.array(z.object({ label: z.string(), box: Box })).max(4),
  uncertainty: z.object({ overall: z.enum(['low','medium','high']), notes: z.array(z.string()).max(3) }),
  competing_subjects: z.array(z.string()).max(3),
})
```

The input is the same image at 768 px plus the stage-1 title and candidate names inside the `user_data` DATA block. Profile: Haiku 5.5, effort none, `maxOutputTokens: 1200` (measured max 893), `timeoutMs: 20_000`. Sonnet 5 is the richer option (11–13 s, about 5× the cost).

Merge rules (deterministic, domain side):
- `toVlmAnalysis(quick, enrichment?)` builds today's `VlmAnalysis` with synthetic ids, so the compiler, `validateVision`, the inspector and the v2 frame aggregation stay unchanged.
- `keep=false` is advisory. It lowers certainty and moves the reference out of "Explore the references", but never removes cards that are already shown. It flagged "dan dan noodles" in one test, so vetoes are noisy.
- Additional candidates are resolved through Qloo and appended to references. They fill category slots only where a category has fewer than 3 results, and never reorder published cards.

### Fallbacks

- **Stage 1:** a second qualified profile on `vertex/gemini-2.5-flash-lite`, used only when the Haiku profile is unavailable. Profiles currently pin one provider with empty `allowedFallbackProviders`, so this is an explicit runner policy change for the operator to decide.
- **Elorian:** last-resort operator fallback only, with a 90–120 s timeout. Never for stage 1 or the default stage 2.

### Minimal alternative

Switch the `vision_photo` profile to Haiku with `reasoningEffort` none and keep the full schema: p95 about 10 s plus Qloo. It meets the targets, but it is about 2.5× slower, uses about 2.5× the tokens, and gives less specific candidates. Do it as step 1 regardless.

## Recommended UX

### Spec constraints

- No preferences questionnaire before the first discovery. A taste pick at sign-up before any discovery is therefore out; an optional, skippable pick after the first discovery is allowed.
- Viewing or uploading is not an endorsement. A pick must be an explicit save: labeled, with Undo, and written through the existing preferences save path.
- Qloo results must be real. The meanwhile panel shows either the reviewed samples (labeled "Example result", never counted as Qloo results) or existing Qloo-backed save-connected recommendations. Picks must be real Qloo tag or entity ids.
- Fetching a feed page never starts generation, so the panel reads the existing FeedSnapshot.

### Flow

1. **Discover pressed.** The photo shows with "Finding your next favorites…" (unchanged) while stage 1 runs.
2. **0–3 s: "While we look" strip.** It shows 4–6 cards from `getDiscoveries`: labeled samples for new users, the save-connected snapshot for returning users. Cards open the normal detail sheet; Save is the usual explicit save. The strip collapses into "More to explore" once the first section lands, with no animation under reduced motion.
3. **About 3–6 s: progressive reveal.** Title and interpretation, then references, then category sections, using the existing `publishForCapture` and `section_statuses`.
4. **About 5–15 s: stage 2 lands quietly.** "Why this?" rationales, regions for the inspector, extra references, and an optional "What caught your eye?" row. No layout jumps.
5. **The user leaves.** Show an in-app toast or title badge, "Your photo is ready". On native, send a push through `device-push.ts`, only for jobs the user started.
6. **After the first discovery, optional taste picks.** A dismissible card, "Tell us a few favorites", with Qloo `/v2/tags` chips per category (cached) plus the photo's resolved tags. Each tap is an explicit save with Undo; Skip hides the card for good. Picks feed the next FeedSnapshot. It is also available in Settings → Taste.

## Implementation steps

| # | Step | Files | Effort |
|---|---|---|---|
| 1 | Add `reasoningEffort` to `ModelProfileSchema` (part of the profile hash and qualification). Send `reasoning:{effort}` only when set, as the spec requires that unqualified effort settings never be sent. Add tests | `packages/providers/src/concentrate/profiles.ts`, `transport.ts`, `transport.test.ts`, `contract.test.ts` | 0.5 d |
| 2 | Add the `VlmQuickRead` schema, prompt and `toVlmAnalysis()`. Make `ConcentrateVlm` use it for `vision_photo` with 5 candidates at 512 px. Set `LIMITS.vlmCandidatesToResolve` 8→5 and cap Qloo resolve concurrency at 2–3 | `packages/providers/src/vlm/types.ts`, `vlm/prompt.ts`, `concentrate/providers.ts`, `packages/domain/src/enums.ts`, `compiler/analyze.ts` | 1–1.5 d |
| 3 | Add a `vision_photo_enrich` role (`ModelRole` union; `parseModelProfiles` max 4→5), the `VlmEnrichment` schema and prompt, and an `enrich` stage in `CaptureCompiler` after `recommend`. It merges, resolves additions and publishes through `publishForCapture`. Reserve the budget for both calls | `packages/providers/src/model-gateway/types.ts`, `concentrate/profiles.ts`, `concentrate/providers.ts`, `packages/domain/src/compiler/analyze.ts`, `compiler/budget.ts`, `pipeline/analyze-capture.ts` | 2 d |
| 4 | v2 worker: quick read per frame, then enrichment once on the photo or best frame, within the 90 s photo deadline | `apps/worker/src/media-analysis.ts`, `packages/domain/src/capture-v2/analysis-run.ts` | 1 d |
| 5 | Qualification: teach the script the two roles and effort, rerun live on ≥10 real owned photos (logos, labels, clutter), update `docs/concentrate.md` | `scripts/qualify-concentrate*.ts`, `docs/concentrate.md` | 0.5–1 d |
| 6 | "While we look" strip in the processing state | `apps/web/components/views/CaptureResultView.tsx` (processing branch around line 250), `apps/web/components/v2/MediaDetailView.tsx` | 1 d |
| 7 | Completion notice: web toast and badge; native push | `apps/web/components/v2/UploadStatusBar.tsx`, `upload-store.ts`, `packages/domain/src/services/device-push.ts`, worker completion hook | 1 d web, +1 d native |
| 8 | Optional post-first-discovery taste picks | `packages/domain/src/services/preferences.ts`, `taste.ts`, new API route, UI card | 2–3 d |

Totals: steps 1–5 about 5–6 d; steps 6–7 about 2–3 d; step 8 about 2–3 d (can be deferred).

## Risks and what still needs verifying

- **Real photos:** check logos, text, `depicted`, `visible_text` at 768/1024 px, and that output (and so latency) does not grow too much.
- **ZDR and content logging:** confirm the key's settings apply to `anthropic/claude-haiku-5-5` and `vertex/gemini-2.5-flash-lite`. This is still an open gate.
- **Reasoning effort:** confirm each chosen route honours `none` (reasoning tokens were 0–2 here) and fails loudly if a route drops support.
- **Qloo burst throttling** is now the biggest risk to the 10 s target. Confirm the production key's limits.
- **Stage-2 vetoes** can contradict stage 1. Keep them advisory and log agreement rates.
- **Two calls per photo:** stay within the three-attempt cap per frame/role and reserve both calls in the ledger.
- **Measurement venue:** latencies were measured from the dev container. Re-measure upload → first section end to end on the deployed demo.

## Spend tally

| Service | Requests (cap) | Tokens | Cost |
|---|---|---|---|
| Concentrate | 113 (120) | 213,471 in / 54,026 out | about $0.20 at list prices |
| Elorian | 4 (25) | 3 completed: 169,213 in / 42,430 out (33,407 reasoning); 1 timeout, usage unknown | not in the Concentrate ledger |
| Qloo | 74 GET | n/a | n/a |
