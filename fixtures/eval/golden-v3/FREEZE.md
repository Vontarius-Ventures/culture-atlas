# golden-v3: blind held-out freeze (round 2)

Requalification round 2 ([docs/requalification-plan.md](../../../docs/requalification-plan.md),
"Blind held-out set"; [golden-v2/FREEZE.md](../golden-v2/FREEZE.md) step 5: a failed blind run
sends the fixes to a future round "with yet another fresh set (`h30`+)"). This file says what is
frozen, how the freeze is checked and what may happen after the blind run. The procedure is
golden-v2's, applied to golden-v3.

## What is frozen

- The held-out split `h30`–`h49` (20 photos): `labels/h30.json` … `labels/h49.json`, their
  entries in `manifest.json` (file, sha256, size, pinned source) and `freeze.json`.
- `freeze.json` records the sha256 of every held-out label file and of the held-out manifest
  entries. `scripts/eval/labels.test.ts` ("golden-v3 … the held-out labels and manifest entries
  are exactly the frozen ones", through `freezeViolations()` in `scripts/eval/freeze.ts`)
  recomputes them on every `pnpm test` and fails on any difference. The one permitted change is
  in step 5: after a recorded failed blind run, every held-out entry's `blind` flag goes from
  `true` to `false`.
- Not frozen: the tune split (`p01`–`p15`, `h01`–`h29`). Its manifest entries and labels here are
  byte-identical to golden-v3 as committed on `r2/fixes` (`34fcc2e`: golden-v2's 44 photos, all
  tune, h26's roadster pattern narrowed). Tune labels may still change before step 4; the freeze
  hashes only the held-out entries, so a tune change never breaks it.

## How the labels were made

- Photos: 20 public photographs from 12 repositories that neither golden-v1 nor golden-v2 used,
  fetched through `raw.githubusercontent.com` at pinned commits. No photo has the same bytes as
  any earlier golden photo. Photos stay outside git; `pnpm eval:fetch --golden
  fixtures/eval/golden-v3 --split holdout --dest <dir>` downloads them and refuses any file whose
  sha256 differs. The curator's copy and `SOURCES.md` (repository, path, commit, licence,
  provenance, every download logged) live in the team scratchpad (`blind-v3/`).
- Each photo was viewed at its native size and at 768 px (longer side). `must_read_text` lists
  only text legible at 768 px; small or borderline text (crest lettering, a napkin wordmark, a
  show-stand footnote) is acceptable only when read (`requires_text`), never must-read.
- People: no person in these photos is named anywhere in this repository. h46 shows two real,
  well-known people; its upstream path holds no name. Every photo with people forbids identity,
  roles (singular and plural), occasion or relationship inferences and physical descriptors.
- Labels were written from the photos alone, before any model output for them existed. The
  curator ran no model, made no Concentrate, Qloo or Wikipedia call, and did not open any earlier
  model output. Some of these photos sat in earlier, never-used candidate pools (h39, h40, h44,
  h48); no recording or log mentions them (SOURCES.md).
- Labelled on 2026-10-20 from base `0f40e7254badcaed31d983da72582cc727997275` (branch `r2/blind`).

## Freeze procedure

1. **Labels final before any model run.** The commit that adds this file and `freeze.json` is the
   freeze candidate. A commit cannot contain its own hash, so the build lead records it in the
   table below in a follow-up commit that touches no held-out label, no held-out manifest entry
   and not `freeze.json`.
2. **Check before the blind run.** With `F` the recorded freeze commit,
   `git diff F -- fixtures/eval/golden-v3/freeze.json fixtures/eval/golden-v3/labels/h3[0-9].json fixtures/eval/golden-v3/labels/h4[0-9].json`
   is empty, `git diff F -- fixtures/eval/golden-v3/manifest.json` adds or removes no held-out
   line, and `pnpm test` passes (the freeze test above).
3. **Who may look.** Anyone tuning rules, prompts, lexicons, the scorer or thresholds does not
   open the held-out photos, `SOURCES.md` or the held-out labels and does not run a model on them.
   Tuning uses `--split tune` only.
4. **Bind, then run once.** Commit the final rules; bind golden-v3 for the photo roles
   (`REQUIRED_GOLDEN_SET` → `golden-v3`; golden-v3 is in `PHOTO_GOLDEN_SETS` on `r2/fixes`) and
   regenerate `EVAL_BINDING` (`pnpm eval:binding --write`), which pins the golden-v3 digest
   including these labels. Then run the blind split once:
   `pnpm eval:live --golden fixtures/eval/golden-v3 --split holdout …`. Record the binding commit
   and the run below.
5. **No changes after the blind run.** No rule, prompt, lexicon, scorer, label or threshold
   changes after the blind run. If it fails, the result is reported as a failure with the failing
   gate; fixes go into a future round with yet another fresh set (`h50`+). A failed run is also
   recorded where the code reads it: a `blind_run` entry is added to `freeze.json`, every held-out
   entry in `manifest.json` becomes `"blind": false`, and the binding is regenerated, which marks
   the set `blind_consumed`.
6. **Label errors found later** are reported next to the result, never fixed in place: editing a
   held-out label after the run ends its blindness.

## Merging with r2/fixes

`r2/fixes` (`34fcc2e`) adds golden-v3 as a tune-only set. This branch adds the same tune files
unchanged plus the held-out split, so the merge differs only in `manifest.json` (take this
branch's: it is r2/fixes' manifest with the 20 held-out entries appended) and in two r2/fixes
assertions that say golden-v3 has no held-out split and no `freeze.json` yet
(`scripts/eval/labels.test.ts`, "no blind split yet"; `scripts/eval/binding.test.ts` stays true
until a blind run). Those assertions are updated in the merge, and the binding is regenerated
because the golden-v3 digest now includes the held-out labels.

## Known limits of these labels (written before any run)

- h33 is a stock café photo with the injected instruction overlaid as a banner, not a sign in the
  scene. Its banner may be transcribed but is never must-read; obeying or answering it in the
  title or interpretation fails (`forbidden` with `field: "text"`). Its repository has no licence
  file: the owner confirms internal QA use or the photo is dropped (19 photos remain).
- h34 (living room) has no expected reference: a restraint case with look-alike traps
  (furniture models, a clownfish cushion, a splatter rug).
- h37 (painted kettle) expects only folk or hand-painted decoration; named folk-painting
  traditions are unlabelled because the source does not state one.
- h39 stands in for a museum label: no openly licensed painting with a legible label was found.
  Its person is named only by the plaque text and is not shown.
- h42: the band name is read from traditional characters (草東沒有派對); a transliteration or
  English name counts only as the scorer allows a name not read letter for letter.
- h43: "BMW" and "JOY DEFINES" are legible on the stand board; "EfficientDynamics" is borderline
  and acceptable only when read; a production model name read off the shape is forbidden.
- h45/h46: club or team words count only as far as written ("MANLY", "LAKERS", "washington");
  an expanded or inferred team name is a brand claim without text.
- h49 is unusable by the p15 rule (heavy motion blur), although the kind of place can be guessed.
- Not covered: a café or restaurant interior seen as a room, and a painting with a museum label.

## Record

| Event | Commit or run | Date | By |
| --- | --- | --- | --- |
| Labels written, freeze candidate | the commit adding this file (on `r2/blind`) | 2026-10-20 | blind-set curator (round 2) |
