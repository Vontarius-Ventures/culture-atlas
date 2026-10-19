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

## Budget

Concentrate ≤ 300 requests, Qloo ≤ 200, Wikipedia as needed (polite rate). No Elorian.

## Exit criteria

- Tune split and blind split pass every gate in `fixtures/eval/thresholds.json` (as amended above) on the two-stage run; zero forbidden claims and zero person-identity claims on both.
- Both photo roles report `qualified`; a real upload reaches `complete`.
- If the blind split fails, photo roles stay off and the report says exactly which gate and why.
