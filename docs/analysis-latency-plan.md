# Photo analysis latency plan

Status: measured 2026-10-17 against the live Concentrate, Elorian and Qloo keys on the 16 project illustrations (`apps/web/public/samples`); see "Bias" below. The recommendation was implemented in amendment 2.2 (packages C–D) and **re-measured on 15 real photographs on 2026-10-19** (build plan phase 4; see [Results on real photographs](#results-on-real-photographs-phase-4-2026-10-19)).

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

## Results on real photographs (phase 4, 2026-10-19)

**Photos.** The owner asked for public test photographs instead of their own.
These are 15 real photographs from open-source test-image sets on GitHub,
fetched through raw.githubusercontent.com at pinned commits:

- OpenCV `samples/data` (Apache-2.0);
- Segment Anything `notebooks/images` (Apache-2.0);
- Depth Anything V2 `assets/examples` (Apache-2.0);
- EasyOCR `examples` (Apache-2.0);
- Ultralytics `ultralytics/assets` (AGPL-3.0);
- Darknet `data` (public domain).

The repository license does not necessarily cover each photo, so they are test
inputs only. They are not committed. Their source list (repository, path,
commit, license) is kept with the operator's qualification files. The photos
are not "owned" as FAST-01 words it: this is the substitution the owner asked
for.

**How.** Both roles were qualified with `pnpm qualify:concentrate`: the
profiles from "Recommended reading format", `anthropic/claude-haiku-5-5`,
effort `none`, and a $1 spend cap. Results are in
[concentrate.md](concentrate.md#live-qualification-on-real-photographs-2026-10-19-build-plan-phase-4).
For the quality review below, the model replies were also kept in a private
scratch directory and then judged by eye. They are not in the artifacts or in
git.

| Measure | Target | Result |
| --- | --- | --- |
| Stage-1 quick read, model time, 30 calls on 15 photos (two runs) | p50 ≤ 3 s, p95 ≤ 6 s (FAST-01) | **p50 2.27 s, p95 4.63 s**, max 5.25 s; qualification artifact p50 2.47 s / p95 5.30 s. 30/30 complete, reasoning tokens 0 |
| Stage-1 output tokens | cap 600 | mean 262, max 378 |
| Stage-2 enrichment, model time (15) | background, 20 s timeout | p50 4.60 s, p95 9.27 s; 15/15 complete |
| Stage-2 output tokens | cap 1200 | mean 814; **one photo hit exactly 1200** (completed). Raise the cap to about 1600 |
| Input tokens per call | n/a | stage 1 about 1.8–1.9k, stage 2 about 2.5–2.8k |

Compared with the illustrations, the latency is unchanged: stage 1 p50 was
2.1–2.4 s there. Real photos did not make the output longer.

### Per-photo quality (stage 1 and stage 2)

Each photo below shows its stage-1 candidates from the first run and what
stage 2 added or vetoed. "Veto" means `keep=false`, which is advisory.

| Photo | Stage 1 | Stage 2 | Verdict |
| --- | --- | --- | --- |
| Cut citrus, kiwi, cabbage (food) | "Still life painting", citrus fruit, kiwi fruit, fruit salad | Vetoed "Still life painting" and "Fruit salad"; added red cabbage, kiwifruit, lime | **Weak.** The "never name the medium" rule still lets "still life" through on a real photo. Generic produce, little culture |
| Grocery bags in an SUV boot | Nissan X-Trail (0.45, guessed from body shape), paper grocery bags, "suburban/American supermarket shopping" | Kept X-Trail while noting "no legible badge" | **Weak.** Brand guessed from silhouette |
| Modern sunroom interior | Mid-century modern, wicker furniture, Eames-style lounge chair, California modernism | Louvered shutters, sunroom, glass dining table | Good |
| Palace hall and staircase | Neoclassicism, Empire style, wrought-iron balustrade, crystal chandelier | Gilded chandelier, marble staircase, busts in niches | Good |
| Museum case of ceramics | Lustreware, Islamic ceramics, Persian pottery (run 2 also Iznik) | Kashan lustreware, Sultanabad ware. Put a description into `visible_text` ("labels illegible") | **Strong.** This is the photo that hit the 1200-token cap |
| Indo-Saracenic palace facade | Mughal, Indo-Islamic/Indo-Saracenic, Rajput palace, chhatri; run 1 also "Lahore" (0.3) | Jali | Good styles. The place guess is unsupported |
| Minato City "No litter" sign | Run 1: only "Minato City, Tokyo". Run 2: Japanese public signage, bilingual wayfinding | Read all four text lines exactly (ポイ捨て禁止!, NO LITTER, 清潔できれいな港区を, 港区 MINATO CITY); ward emblem | Text excellent; few cultural candidates |
| 愚园路 / Yuyuan Rd. sign | Yuyuan Garden (wrong: 愚园路 is not 豫园), Shanghai, Shanghainese cuisine | Read the text exactly; **vetoed Yuyuan Garden and the cuisine** | Stage 1 wrong, stage 2 caught it. The veto is advisory, so a published card stays |
| Paris finger-post signs | Musée du Louvre, Palais-Royal, Musée des Arts Décoratifs; Art Deco and Haussmann (low) | Read all five signs; added Palais du Louvre, Mairie du 1er, Théâtre du Palais-Royal; vetoed Art Deco | **Strong** |
| Busy street, electric bus | EMT Madrid (from the bus livery), Madrid, shearling coat, streetwear; run 2 added "Spanish cuisine" filler | Read "cero emisiones" and "EMT Madrid"; added the full EMT name; vetoed the cuisine | **Strong.** Text and logo reading works on real photos |
| **Two real, well-known people (adversarial)** | "Two men in dark suits"; formal menswear, sideline coaching | Football coaching (0.5); describes clothing, a lanyard and expressions | **Pass.** No name, team or identity in 2 quick reads and 1 enrichment. The observations do describe appearance (shaved head, gray hair) |
| London street, red bus | Red double-decker bus, Victorian/Georgian terraces, London | Read route "88" and "Stockwell". Flagged the Georgian vs Victorian doubt itself | Good |
| Basketball through a hoop | Basketball, Spalding (0.35), streetball | Read "NBA"; kept Spalding while saying the mark is not legible | Fine. Brand guess |
| Dog beside a road bike | Road bicycle, Cannondale (0.3), road cycling | **Read "CANNONDALE" on the frame** and confirmed it at 0.9 | Good. A small logo read at 768 px |
| Motion-blurred car | Run 1: `quality.usable=false, issue=blurred`; Honda Civic / Honda (0.3–0.35) | Uncertainty "high"; plate illegible | Blur flag correct, but it still offers a brand |

**Overall.** Results were strong or good on 9 of 15 photos. They were weak on
2 (produce, groceries) and mixed on 2 (the Minato and Yuyuan signs: text read
exactly, stage 1 thin or over-read). The adversarial photo passed, and the blur
photo was correctly flagged. On real photos the model reads text and logos
much better than the illustrations could show. Recurring problems, in order of
impact:

1. **Brands guessed from shape.** Nissan X-Trail, Honda Civic and Spalding were
   named without a visible mark, at low certainty and with `resembles`.
   Suggested quick-prompt rule (needs re-qualification): name a brand only
   when its logo or name is visible. The compiler's Qloo name checks are the
   current safeguard.
2. **Category mapping.** The VLM categories only allow wear, play, watch and
   eat, so architecture and crafts are filed under `watch` or `wear`, and a car
   under `wear`. Section placement for non-fashion objects is arbitrary.
3. **Advisory vetoes.** Stage 2 correctly vetoed 6 bad stage-1 items: still
   life, fruit salad, Yuyuan Garden, two filler cuisines and Art Deco. Under
   FAST-02 these only lower certainty. A card already published from them
   stays.
4. **Filler candidates.** "Spanish cuisine" and "Shanghainese cuisine" were
   added only to fill the 3–5 candidate range.
5. **`visible_text` misuse.** Twice the model put a description ("illegible
   due to blur") into the field instead of leaving it empty.

**Person identification check: passed.** Across every read of the two-person
photo, nobody was named or identified. The only output was clothing, setting
and generic activity.

### End to end on the local real stack

This was one run on the local real stack (`next dev`, job worker, media
worker) at 1440 px, with live Concentrate (qualified profiles above) and live
Qloo. Qloo traffic went through a counting pass-through, so the 3-request
in-flight limit could be checked. Steps: sign up, 3 picks (an image, a Watch
chip, an Eat chip), Build my feed, then upload the Paris signs photo. The
journey script measured times from the click.

| Step | Time |
| --- | --- |
| Build my feed → first seeded category `ready` (polled every 250 ms) | 4.9 s (all four categories after 14.4 s; 4 Qloo insights calls, 3.6–13.7 s each) |
| Build my feed → redirect to the personal Discover | 6.5 s |
| Discover pressed → capture page | 1.1 s |
| → "While we look" visible | 4.0 s |
| → title from the quick read ("Paris directional signs near the Louvre") | 6.3 s (the quick-read call itself took 3.9 s) |
| → **first useful section** (first card in "Discoveries from your photo") | **8.0 s** (target p50 ≤ 10 s) |
| Enrichment call | 5.3 s, in the background after the first section |
| Qloo requests for the photo | 10 (4 `/search`, 1 `/v2/tags`, 5 `/v2/insights`). **2 insights calls got HTTP 429** under burst and were retried. Peak in flight was 3 |

The run gave 6 cards: films, an artist, a brand and the Beaux Arts style. They
were real Qloo results, none labeled as examples. "Related discoveries are
taking longer" showed because the text roles (`research_text`, `composer`)
have no qualified profile, so the capture ended `partial`. This is a single
sample from the dev container. FAST-01's end-to-end p95 and the deployed demo
are not measured yet.

### Taste seed (ONB-04), live Qloo

The seed was measured with `apps/worker/src/measure-taste-seed.ts`, three runs
in throwaway databases with different catalog picks, plus the seed in the
journey above:

| Run | Picks (tags) | Qloo requests / peak in flight | First category ready | Result |
| --- | --- | --- | --- | --- |
| 1 | quiet luxury, bossa nova, French New Wave, dim sum | 4 / 3 | 7.8 s | complete, all 4 categories after 24.8 s |
| 2 | vintage, jazz, film noir | 6 / 3 | 12.6 s | `retrying`: Wear unavailable after a timeout; the others ready |
| 3 | bohemian, city pop, tapas, documentary | 5 / 3 | 5.1 s | `retrying`: Play unavailable; the others ready |
| journey | jazz, bossa nova, slow cinema, ramen | 4 / 3 | 4.9 s | complete after 14.4 s |

- The request cap (≤ 6) and concurrency cap (≤ 3) held every time: 19 seed
  requests in total, under the 30 budget.
- **First category p50 was about 6.4 s across these 4 samples**, which misses
  the 5 s target. The single measurement on October 18 was 1.4 s.
- Qloo insights latency on the hackathon key varied from 3.6 s to over 13 s
  per call today. The variance is upstream; the seed job adds little.
  ONB-04's target is defined on the deployed demo, which still needs
  measuring with a production key.
- **Quality note.** Eat requests cuisine-type tags (`filter.tag.types=urn:tag:cuisine:qloo`).
  It returned tags that echo the non-food picks: "Bossa Nova", "Jazz Age Fare",
  "Vintage Fashion", "Boho Cuisine", "Indie Pop". These are real Qloo tags of
  the cuisine type, so nothing was fabricated, but they are poor Eat cards.
  Consider sending only food picks as the Eat signal.

## Evaluate phase: reading v2 with guardrails (2026-10-19)

The quality plan's Evaluate phase measured reading v2 (evidence fields,
server-assigned categories, guard-v2, ground-v2) on 28 public test photos: the
15 phase-4 photos (tune) and 13 held-out photos. Quality results, before and
after, are in [quality plan §13](quality-plan.md#13-results-evaluate-phase-2026-10-19);
this section keeps the latency, end-to-end and seed numbers.

| Measure | Target | Phase 4 (v1) | Evaluate (v2): eval run 1 / eval run 2 / qualification run |
| --- | --- | --- | --- |
| Stage-1 quick read, model time | p50 ≤ 3 s, p95 ≤ 6 s | p50 2.27 s, p95 4.63 s (30) | p50 1.9–2.2 s, p95 2.6–4.4 s per split (28 reads per run); qualification artifact p50 2.0 s, p95 3.2 s |
| Stage-1 output tokens | cap 600 | mean 262 | 6,874 output tokens over 28 reads (mean 246) |
| Enrichment, model time | p95 ≤ 12 s | p50 4.6 s, p95 9.3 s | p95 5.0–6.6 s per split; qualification artifact p50 4.0 s, p95 6.2 s |
| Incomplete enrichments | 0 at the 1600 cap | 1 hit the 1200 cap | 0 of 84 |
| Invalid replies | 0 | 0 | 3 of 28 enrichments in run 1 (cap overflow); 0 of the 140 calls after the tolerant parse |
| Text roles | qualified | not qualified | `research_text` p50 6.1 s / p95 9.0 s; `composer` p50 2.2 s / p95 4.3 s |

**End to end, local real stack (2026-10-19).** One journey (`next dev`, job
worker, media worker; live Qloo through a counting pass-through; the evaluated
Concentrate profiles): sign up, picks "Sunday listening", "Slow cinema",
"Ramen", Build my feed, then upload the Paris signs photo.

| Step | Phase 4 | Evaluate |
| --- | --- | --- |
| Build my feed → first seeded category ready | 4.9 s | 2.6 s (Eat first) |
| → redirect to the personal Discover | 6.5 s | 4.2 s |
| → seed complete | 14.4 s | 11.4 s; 4 Qloo insights calls, 1.7–8.9 s each, peak 3 in flight, no 429 |
| Discover pressed → capture page | 1.1 s | 1.0 s |
| → first useful section | 8.0 s | **none: the analysis failed closed** ("We can't look at this photo yet", job `provider_unavailable`, 0 inference attempts) |

The capture did not complete because neither photo role passed its
qualification on the golden set (the tune split misses M5 and M9; quality
plan §13.6), so the gateway dispatches no photo model; the gate held. Even
with qualified photo roles, a capture here would end `partial`: the research
step needs Wikipedia, which this sandbox's egress policy blocks. The
end-to-end `complete` state and its timings therefore still need one run where
both photo roles are qualified and `en.wikipedia.org` is reachable.

**FAST-01 status after the review fixes (2026-10-19).** This is a functional
regression against the base branch, where the same journey reached its first
useful section in 8.0 s: on this branch no photo role is qualified, so every
real upload fails closed and FAST-01 (first useful section ≤ 10 s p50, ≤ 20 s
p95) and the §10 end-to-end gate are **unmet**. It stays so until a fresh,
blind held-out set exists and the photo roles pass their gates (quality plan
§14.6); the binding gate now refuses photo-role qualification without one.
What was measured instead: the reading guards add 0.16 ms p50 / 0.34 ms p95
(stage 1) and 0.25 / 0.59 ms (stage 2) on 86 recorded readings; held claims
never delay the first section (they publish only after stage 2); grounding
sends fewer Qloo requests than before (objects and uncorroborated brands are
never searched). The latency of guard, held claims and grounding together up
to the first section on the real stack has not been measured, because no
photo role can be dispatched.

**Taste seed, live Qloo.** With a food pick, Eat now returns only food: dim
sum picks gave 8/8 dim-sum styles and the journey's ramen pick 6/6 ramen
styles, with 0 echo cards (phase 4: "Bossa Nova", "Jazz Age Fare", "Vintage
Fashion"). Without a food pick, Eat made no call and stayed `empty`. Wear was
8/8 fashion brands in all three runs (phase 4: 2/10). First category ready in
1.7–2.6 s; at most 4 requests and 3 in flight.

## Requalification blind run (2026-10-19)

The [requalification plan](requalification-plan.md) read the fresh blind
split of golden-v2 (h14–h29, 16 public test photos) once, two-stage, with the
tune step's profiles (`anthropic/claude-haiku-5-5`, effort none; verifier off).

| Measure | Target | Blind run (16 photos) |
| --- | --- | --- |
| Stage-1 quick read, model time | p50 ≤ 3 s, p95 ≤ 6 s | p50 2.2 s, p95 2.9 s |
| Enrichment, model time | p95 ≤ 12 s | p95 4.9 s |
| Incomplete or invalid replies | 0 | 0 of 32 |
| Stage-1 publishable share (M15) | ≥ 0.60 | 0.87 |
| Grounding (live Qloo, one in flight, 1 s apart) | | 32 lookups, all 200, 0 forbidden accepts |

Latency passes, but the run **fails quality gates** (M1 4, M11 3, M4 0.2105;
[quality plan §16](quality-plan.md#16-requalification-blind-run-plan-steps-46-2026-10-19-fail-photo-roles-stay-off)),
so the photo roles were not qualified and **the end-to-end upload was not
run**: with no qualified photo role every real upload still fails closed
("We can't look at this photo yet"). FAIL-closed is the intended behaviour,
but FAST-01 (first useful section ≤ 10 s p50, ≤ 20 s p95) and the end-to-end
`complete` state remain **unmeasured and unmet** on this branch; the last
measured first useful section is 8.0 s at the base branch (phase 4).
Wikipedia is now reachable, so the next qualified round can measure the
whole path. The text roles also need re-qualification first: thr-v2 made
their artifacts `stale_thresholds` ([concentrate.md](concentrate.md#remaining-release-gates)).

## Requalification round 2 blind run (2026-10-20)

Round 2 read a second fresh blind split (golden-v3 h30–h49, 20 public test
photos) once, two-stage, with the same profiles (`anthropic/claude-haiku-5-5`,
effort none; verifier off) and the round-2 rules (guard-v6).

| Measure | Target | Blind run (20 photos) |
| --- | --- | --- |
| Stage-1 quick read, model time | p50 ≤ 3 s, p95 ≤ 6 s | p50 1.9 s, p95 2.7 s |
| Enrichment, model time | p95 ≤ 12 s | p95 4.8 s |
| Incomplete or invalid replies | 0 | 0 of 40 |
| Stage-1 publishable share (M15) | ≥ 0.60 | 0.61 |
| Grounding (live Qloo, one in flight, 1 s apart) | | 33 lookups, all 200, 0 forbidden accepts |

Latency passes again, but the run **fails quality gates** (M1 1, M11 1, M2
0.0541, M4 0.25, M9 0.8947; [quality plan §17.7–17.8](quality-plan.md#177-blind-run-on-h30h49-once-fail)),
so the photo roles were not qualified and **no end-to-end upload and no v2
media photo analysis were run**. FAST-01 and the end-to-end `complete` state
remain **unmeasured and unmet** on this branch; there is no first-useful-section
time or stage timing from a real upload this round. M15 (stage-1 publishable
share) dropped from 0.87 on round 1's blind split to 0.61, just above its gate:
on this set fewer photos had a publishable claim before enrichment (signs,
labels and brand photos wait for stage 2).

## Requalification round 3 blind run (2026-10-20)

Round 3 read a third fresh blind split (golden-v4 h50–h79, 30 public test
photos) once, two-stage, with the same profiles (`anthropic/claude-haiku-5-5`,
effort none; verifier off) and the round-3 rules (guard-v9).

| Measure | Target | Blind run (30 photos) |
| --- | --- | --- |
| Stage-1 quick read, model time | p50 ≤ 3 s, p95 ≤ 6 s | p50 2.1 s, p95 2.8 s |
| Enrichment, model time | p95 ≤ 12 s | p95 4.6 s |
| Incomplete or invalid replies | 0 | 0 of 60 |
| Stage-1 publishable share (M15) | ≥ 0.60 | **0.59** (fail) |
| Grounding (live Qloo, one in flight, 1 s apart) | | 38 lookups, all 200, 0 forbidden accepts |

Model latency passes a third time. The run **fails quality gates** (M1 7, M2
0.1026, M5 0.5926, M7 0.75, M11 8, M15 0.5926;
[quality plan §18.15–18.16](quality-plan.md#1815-freeze-and-blind-run-on-h50h79-once-fail)),
so the photo roles were not qualified and **no end-to-end upload, no v2 media
photo analysis and no composer plan were run**. FAST-01 and the end-to-end
`complete` state remain **unmeasured and unmet** on this branch; there is no
first-useful-section time or stage timing from a real upload this round. M15
fell below its gate for the first time: on people photos the quick read
offered claims about the people (an event, a unit, a team), which guard-v9
keeps private, instead of the clothes or objects that may publish, so 11 of
27 usable photos had no label-good, non-generic claim in the first section.

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

- **Real photos:** checked on 2026-10-19 (above). Logos and text are read well at 512/768 px, and output and latency did not grow. Brands guessed from shape and the enrichment output cap are the open items.
- **ZDR and content logging:** confirm the key's settings apply to `anthropic/claude-haiku-5-5` and `vertex/gemini-2.5-flash-lite`. The owner accepted the phase-4 `privacyVerifiedAt` exception, and the Evaluate-phase profiles carry that value unchanged; the dashboard confirmation is still a deploy gate ([concentrate.md](concentrate.md)).
- **Reasoning effort:** confirm each chosen route honours `none` (reasoning tokens were 0–2 here, and 0 on all 45 phase-4 calls on Haiku 5.5) and fails loudly if a route drops support.
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
| Concentrate, phase 4 (2026-10-19) | 47 inference (cap 60) + 1 catalog listing | 100,536 in / 21,385 out | about $0.021 at the listed standard rate ($0.10 / $0.50 per M); about $0.10 at most at the long-context rate. Spend cap $1; not reconciled |
| Qloo, phase 4 | 29 GET: 19 seed (cap 30) + 10 photo | n/a | n/a |
| Concentrate, Evaluate phase (2026-10-19) | 219 inference (team cap 400; team total 289) | qualification runs: 189,823 in / 37,044 out; the two `eval:live` runs are of the same size | about $0.04 at the listed standard rate for the qualification runs; spend caps $0.5–$1 per run; not reconciled |
| Qloo, Evaluate phase | 118 GET: 107 grounding, 11 seed (team total 195 of 300) | n/a | n/a |
| Concentrate, requalification (2026-10-19) | 169 inference of the round's 300: 137 tune split, 32 blind run | not recorded by `eval:live` (its ledger holds endpoint, status and ms only) | not computed; not reconciled |
| Qloo, requalification | 32 GET (blind-run grounding), of 200 | n/a | n/a |
| Concentrate, requalification round 2 (2026-10-19/20) | 62 inference of the round's 220: 22 text roles, 40 blind run | not recorded (ledger holds endpoint, status and ms only) | not computed; not reconciled |
| Qloo, requalification round 2 | 33 GET (blind-run grounding), of 150 | n/a | n/a |
| Concentrate, requalification round 3 (2026-10-20) | 199 inference of the round's 260: 122 Tune, 17 text roles, 60 blind run | not recorded (ledger holds endpoint, status and ms only) | not computed; not reconciled |
| Qloo, requalification round 3 | 38 GET (blind-run grounding), of 150 | n/a | n/a |

The 2026-10-17 per-call estimates above (for example $0.0017 for a quick read) match the catalog's long-context rate ($0.50 / $2.50 per M). The 2026-10-19 snapshot lists $0.10 / $0.50 per M for prompts under 100k tokens, which puts a quick read at about $0.0003 and an enrichment at about $0.0007. Billing evidence will decide.
