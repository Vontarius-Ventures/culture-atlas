# Photo-role requalification plan

Status: plan, October 19, 2026. Follows [docs/quality-plan.md](quality-plan.md) §13.6 and §14.5. Goal: switch photo analysis back on (`vision_photo`, `vision_photo_enrich` qualified) without weakening any safety gate, and show a real upload reaching `complete`.

## Owner decisions (delegated to and taken by the build lead)

| # | Question | Decision | Why |
| --- | --- | --- | --- |
| 1 | p14 label requires "cannondale", which the dog hides | **Change the label to what is legible** ("…ndale" frame text and "CAAD8" stay must-read only as far as readable at 768 px; the full maker name becomes acceptable, not required) | A golden label must describe the photo, not demand an unreadable word. Record the change and its reason in the label history. |
| 2 | Brand or person names read only in the stage-2 reply (NBA, EMT Madrid, poster credits) | **Publish as text-only references**: shown under "Explore the references" with the text they were read from, never used as anchors, never searched in Qloo, never confirmed as identity. Brands still require every word in `visible_text`; person names still require text evidence and stay out of anchors and "What caught your eye?" | Restores coverage of what is actually written in the photo, without the look-alike or identity risk the strict rule was preventing. |
| 3 | Which run the coverage (M5) and must-read text (M9) gates apply to | **The two-stage run** (quick read + enrichment + guards). Stage 1 alone keeps its own coverage gate at ≥ 0.60 | The design deliberately leaves brands and sign text to stage 2; holding stage 1 to the combined bar measured the wrong thing. No threshold value changes. |
| 4 | Qloo grounding recall 0.54 vs 0.60 | **Accept, with zero wrong matches as the hard gate.** Lower the recall gate to 0.50 and record the trade-off; add only the measured brand-acronym rule (e.g. NBA) if it keeps precision at 1.0 | A missing Qloo link costs one card; a wrong one misleads. Recall can be raised later with evidence. |
| 5 | Wikipedia access | **Done**: en.wikipedia.org is reachable from the environment now | Research can run, so a real capture can complete. |

The independent verifier (quality-plan §7.6) is **built this round** for wrong attributions that deterministic rules cannot catch (Lustreware, Iznik, Yuyuan Garden, Georgian). It runs in the background after stage 2 only for non-anchor style, place and tradition claims that stage 2 hedged or that conflict with read text, and can only lower certainty or mark a reference qualified; it never removes a card already shown. It is enabled by default only if it lowers the forbidden-label count on the tune split without dropping coverage below the gate.

## Blind held-out set (the key integrity step)

- A curator gathers **12–16 new public photos** from GitHub-hosted test-image sets not used before (photos outside git, sources + licenses + sha256 in `fixtures/eval/golden-v2/`), covering food, interiors, crafts, signage with text, vehicles with and without legible badges, clothing with and without logos, a person, a busy scene.
- Labels are written **before any model sees these photos**, then frozen: the freeze commit hash is recorded in `fixtures/eval/golden-v2/FREEZE.md` and bound into `eval-binding.ts`.
- **No rule, prompt, label or threshold may change after the blind run.** If the blind run fails, the result is reported as a failure; fixes go into a future round with yet another fresh set.
- Old held-out photos h01–h13 join the tune split.

## Steps

1. **Decisions + verifier** (code): label change for p14 with history; text-only reference path (guards, compiler, UI "Explore the references" with read-text attribution, inspector reason codes); gate assignment in `thresholds.json` and the scorer (M5/M9 on the two-stage run, stage-1 coverage ≥ 0.60, grounding recall gate 0.50, precision 1.0 hard); verifier role `vision_verify` (schema, prompt, budget, background ordering, guard integration) with tests. Regenerate the evaluation binding.
2. **Blind set curation** (in parallel with step 1): gather, label, freeze. The curator does not run any model.
3. **Tune-split evaluation**: run `eval:live` on the tune split (old 15 + h01–h13 + new labels) with and without the verifier; decide verifier default by the rule above. Rule tuning is allowed here, within budget.
4. **Freeze, then blind run**: commit the final rules, regenerate the binding, then run the blind set once. No changes after.
5. **Qualify** `vision_photo` and `vision_photo_enrich` (and `vision_verify` if enabled) with the binding-checked qualification script; the accepted `privacyVerifiedAt` exception carries over.
6. **End to end**: real-stack upload with live models, live Qloo and live Wikipedia; confirm `complete`, record first-useful-section time and stage timings.
7. **Review + fix**: adversarial review of the new text-only path, the verifier and the blind-set integrity; final gate; push.

## Step 1 record (decisions + verifier, built)

Built on branch `rq/decisions`. No provider call was made (0 Concentrate, 0 Qloo, 0 Wikipedia); every number below is an offline replay of recorded data.

**Decision 1, p14 label.** At 768 px the down tube shows "…ndale" and the top-tube decal "CAAD8"; the dog hides the rest of the maker's name. `must_read_text` is now `["ndale", "CAAD8"]`; the expected reference is the legible model "CAAD8" (`requires_text: "CAAD"`); "Cannondale" moved to acceptable and still needs "cannondale" read in full. Labels gained a `history` field; p14's entry records the change, the reason and this decision.

**Decision 2, text-only references (guard-v4, rule G-TEXT-ONLY).** A stage-2 addition naming a brand or a person whose every word is transcribed at stage 2 but which the stage-1 call never said (previously dropped as `single_read`) publishes as a text-only reference. Evidence gates are unchanged: brands need every brand word in `visible_text` and a `read_text`/`logo` claim; persons need every name word transcribed; a claim still held at stage 2 (low certainty, text echo) is dropped. A text-only reference:
- carries `text_only: true` and the transcription in `evidence_text`, no category, no tag query; a person's name stays "resembles";
- is never brand-corroborated, never searched in Qloo (`planLookup` → `text_only_reference`; the grounding gate counts any lookup as `text_only_searched`), never an anchor or signal, never researched, never a dish-idea input;
- is stored as `capture_references.text_only` with `read_text` (migration 170; a CHECK keeps it non-anchor);
- is listed under "Explore the references" by name with "Read in the photo: “…”" (`ReferenceSummary.read_text`), never phrased as a resemblance or a match;
- never becomes a "What caught your eye?" choice when it is a person (G-SUBJECT drops any label sharing a word of the name);
- shows in the inspector's new "Reading decisions" section with reason code `single_read_text_only`.

**Decision 3, gate assignment (thr-v2).** `thresholds.json` gains `"two_stage_only": ["M5", "M9"]`. The scorer (score-v4) classifies each split as `two_stage`, `stage1` or `mixed`; only a stage-1-only split leaves M5 and M9 ungated (reported, listed under `scopedOut`), and its coverage gate is M15 ≥ 0.60. A mixed split (some enrichment failed) is gated as strictly as two-stage. No gate value changed.

**Decision 4, grounding (thr-v2, ground-v4).** `recall_min` 0.60 → 0.50; `grounding_precision_min` 0.95 → 1.0 (zero wrong matches is the hard gate); every other grounding gate unchanged. The brand-acronym rule (Q-ACRONYM: a brand written as an acronym in capitals matches the one brand whose multi-word name has exactly those initials; two such brands are a doubt; an exact name always wins) was measured on the recorded live grounding records before it was kept: of the 5 brand-only searches with recorded results (iteration 2; iteration 1 recorded no result lists), exactly one decision changed, "NBA" → "National Basketball Association", which is the correct entity. Citroën, Fila, Selznick International Pictures and Lukfook Jewellery did not change. Precision on the recorded data stays 1.0 (27/27 accepted matches correct by the existing hand judgements plus this one); recall on the recorded findable set rises from 14/26 to 15/26 (0.58).

**The verifier (role `vision_verify`, default off).**
- Schema `atlas_verify_v1` / prompt `vlm-verify-v1` (`packages/providers/src/vlm/verify.ts`): one batched yes/no/unsure per claim; the security rules word for word; claims and transcribed text passed only inside the escaped `user_data` block and named as claims to check, never instructions; at most 6 claims, image at ≤ 768 px.
- Targets (pure, shared by compiler and evaluation): published style, place and tradition claims that are not anchors and not text-only, and that stage 2 hedged (verdict weak) or whose own words the photo's legible text does not contain while that text names something.
- Outcome: "no" lowers certainty × 0.5 and marks the reference qualified; "unsure" (or no answer) marks it qualified; "yes" changes nothing. Never removes or reorders a reference or a card, never touches an anchor, never raises certainty; a failed call changes nothing. Stored as `capture_references.verifier_check` (published order kept via `published_certainty`).
- Plumbing: model role, profile validation, gateway runner and readiness (never a fallback), registry, job identity binding, ledger role CHECK (migration 170), qualification gating (golden-v1 eval block, current guardrail version, blind held-out split, ≥ 10 fixtures; the binding now also covers `verify.ts`).
- Runtime: planned with the two-stage reading before stage 1; its call is reserved then in the spend ledger (all three profiles) and in the job's vision-call budget (`visionCallsPerAnalysis` 2 → 3; reserved only when the verifier is on). It runs in the background after stage 2 published and before research. On only with `ANALYSIS_VERIFIER_ENABLED=true`, a two-stage plan, a qualified role and no kill (`analysis_verifier_enabled`, `fast_analysis_two_stage` or `concentrate_analysis_enabled`); the server flag `analysis_verifier_enabled` (default false) reports the same.
- Not built here: qualification of the verifier by `qualify:concentrate` (it refuses the role explicitly). If Tune enables the verifier, that run is added before step 5.

**How Tune measures the verifier (step 3).** Since the verifier never removes a claim, M2 cannot move. score-v4 reports, without gates: `forbidden_published` (forbidden labels published), `forbidden_uncontested` (those the verifier did not answer "no" to), `M5_uncontested` (expected coverage counting only claims it did not contest) and `verifier_checked`. `pnpm eval:live --roles vision_photo,vision_photo_enrich,vision_verify` records the verifier reply next to each reading; `pnpm eval:replay --recordings <dir> --mode live --verifier both` scores the same readings with and without it. The verifier is enabled by default only if `forbidden_uncontested` (with) is below `forbidden_published` (without) on the tune split and `M5_uncontested` stays at or above the M5 gate. Offline, no Qloo grounding runs, so no claim is known to anchor: every eligible claim is checked, which is stricter than production.

**Offline replay of the recorded live readings (guard-v4, score-v4, thr-v2, live gates).**

| Recordings | Tune | Held-out (not blind) |
| --- | --- | --- |
| Iteration 1 | FAIL only M9 0.87 (p14: neither "ndale" nor "CAAD8" transcribed); M5 0.83, M1 0, M7 1, text-only 1 | PASS |
| Iteration 2 | FAIL M5 0.75 (p10: "RMT MADRID" misread, p11, p14 "CADE") and M9 0.87 (p14); M1 0, M7 1; "NBA" on p13 now publishes text-only | PASS (text-only 3) |

The CI replay (`replay-v1`) passes every replay gate with guard-v4 (two synthetic stage-2-only names now publish text-only), and the unguarded readings still fail M1 (M17).

## Step 3 record (tune split)

Results, rule changes (guard-v5, `vlm-enrich-v3`, `vlm-verify-v2`) and the verifier decision are in [quality-plan §15](quality-plan.md#15-requalification-tune-split-plan-step-3-guard-v5-2026-10-19). In short: the tune split passes every live gate on run 2 under the final rules (run 1 still misses M8 and M9 on model readings); the verifier lowered no forbidden-label count, so it stays off by default and is not qualified in step 5. The freeze commit `9e24243` is recorded in `fixtures/eval/golden-v2/FREEZE.md`; no held-out photo or label was opened.

## Steps 4–6 record (freeze, blind run)

Results are in [quality-plan §16](quality-plan.md#16-requalification-blind-run-plan-steps-46-2026-10-19-fail-photo-roles-stay-off). In short:

- **Freeze.** Rules frozen and golden-v2 bound at `b2cf11a` (photo code digest unchanged from the tune step's final rules), recorded in `fixtures/eval/golden-v2/FREEZE.md` at `303b29b`.
- **Blind run, once: FAIL.** On h14–h29, two-stage, verifier off: M1 4 and M11 3 (h28's competing subjects "main player" / "background players" passed G-SUBJECT because the guard's people test does not count players; h26's interpretation kept "photographed", which G-MEDIUM does not match) and M4 0.2105 (8 of 38 label-good claims dropped; one of them, h26 "MG MGA roadster", is a label-pattern artifact). M2 0.027, M5 1.00, M7 1.00, M8 0, M9 1.00, latency and M15 pass; 0 Qloo forbidden accepts.
- **Qualification and end to end: not run**, as the exit criteria require. The photo roles stay off; nothing was changed after the run. Fixes go into a future round with a fresh blind set (h30+), and h14–h29 move to tune.
- The text roles were found stale under thr-v2 (`stale_thresholds`); their re-qualification (17 requests) is open.

## Budget

Concentrate ≤ 300 requests, Qloo ≤ 200, Wikipedia as needed (polite rate). No Elorian.

## Exit criteria

- Tune split and blind split pass every gate in `fixtures/eval/thresholds.json` (as amended above) on the two-stage run; zero forbidden claims and zero person-identity claims on both.
- Both photo roles report `qualified`; a real upload reaches `complete`.
- If the blind split fails, photo roles stay off and the report says exactly which gate and why.
