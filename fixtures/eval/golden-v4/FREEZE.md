# golden-v4: blind held-out freeze (round 3)

Requalification round 3 ([docs/requalification-plan.md](../../../docs/requalification-plan.md), "Round 3:
structural change", item 5: a larger fresh blind set h50+, 24–30 photos, labelled before any model run and frozen,
with the same no-change-after-blind-run rule). The procedure is golden-v2's and golden-v3's
([golden-v3/FREEZE.md](../golden-v3/FREEZE.md)), applied to golden-v4. This branch (`r3/blind`) adds only the
held-out split; the golden-v4 tune set (every earlier photo, h30–h49 included, all tune) is produced on the
round-3 structural branch, and the two are merged as described under "Merging".

## What is frozen

- The held-out split `h50`–`h79` (30 photos): `labels/h50.json` … `labels/h79.json`, their manifest entries
  (file, sha256, size, pinned source; `holdout-manifest.json` on this branch, appended to `manifest.json` at the
  merge) and `freeze.json`.
- `freeze.json` records the sha256 of every held-out label file and of the held-out manifest entries (hashed as
  `scripts/eval/freeze.ts` does: the entries as written, with `blind: true`). `scripts/eval/golden-v4-blind.test.ts`
  ("the held-out labels and manifest entries are exactly the frozen ones", through `freezeViolations()`) recomputes
  them on every `pnpm test`, from `manifest.json` once merged or from `holdout-manifest.json` before, and fails on
  any difference. The one permitted change is the step-5 transition (`blind` true → false after a recorded failed
  blind run).
- Not frozen: the golden-v4 tune split. The freeze hashes only held-out entries, so a tune change never breaks it.

## How the labels were made

- Photos: 30 public images from 16 repositories that no earlier golden set used and that appear in no earlier
  scratchpad source list, fetch log or candidate pool, fetched through `raw.githubusercontent.com` at pinned
  commits. No photo has the same bytes as any image in the earlier scratchpad folders (one candidate was dropped
  for that). Photos stay outside git; once merged, `pnpm eval:fetch --golden fixtures/eval/golden-v4 --split
  holdout --dest <dir>` downloads them and refuses any file whose sha256 differs. The curator's copy and
  `SOURCES.md` (repository, path, commit, licence, provenance; every download logged in `fetch-log.tsv`) live in
  the team scratchpad (`blind-v4/`).
- Each photo was viewed at its native size and at 768 px (longer side). `must_read_text` lists only text legible
  at 768 px; borderline text (the 'Specialties' script on h74, 'LIKE' on h70, the truck door on h69, the trailer
  name on h69) is acceptable only when read (`requires_text`), never must-read.
- Round-3 scorer convention used by these labels (requalification plan, round 3 item 3, declared before this set
  was labelled): a must-read string may span transcribed lines. Three must-read strings are printed over more
  than one line: h62 'WHILE YOU WAIT' (three lines) and 'SHOE REPAIRS' (two), h63 'Halt für Verschubfahrten'
  (three). Vertical Japanese and Chinese columns (h59, h64) are each one must-read string per printed column.
- People: no person in these photos is named anywhere in this repository. h65 and h73 show real, well-known
  people; their upstream paths hold no name. h73's 'SERGIO' is a first name printed on a shirt: it is recorded as
  read text only (acceptable as the printed word, never as an identity), and no surname is written. Every photo
  with people forbids identity, roles, occasions or relationships inferred about the people, and physical
  descriptors (round-3 publication rule 1: claims about people never publish without read text).
- Labels were written from the photos alone, before any model output for them existed. The curator ran no
  model, made no Concentrate, Qloo or Wikipedia call, and did not open any earlier model output.
- Labelled on 2026-10-20 from base `74ec4f242df3ee92fb5ad56ab04afa2dd714466b` (branch `r3/blind`).

## Coverage

Food dishes (h50, h51), a pastry without a legible bakery (h52), a drink with a Chinese and Latin brand (h53); a
café seen as a room with a role trap (h54) and a defocused café (h55, unusable); home interior with a weak-style
trap (h56); a church interior with place and style traps (h57); ceramics (h58) and a calligraphy scroll with
vertical Chinese text (h59); a famous sculpture and a famous painting with no museum label (h60, h61); Latin
multi-line signage (h62) and German multi-line signage with a country trap (h63); vertical Japanese signage
(h64); clothing with a legible sponsor logo on well-known people (h65); a brand on an object (h66); a vehicle
with a legible model badge and a plate that must not be read (h67) and one without a legible badge (h68); a truck
with a person and a role trap (h69); printed shirt text with album, athlete and shoe-brand traps (h70); clothing
without a logo (h71); youth sport roles (h72); two well-known people with a printed first name (h73); occasion
traps about people (h74 cake feeding, h75 ring, h76 ceremonial rider); a near-black unusable frame (h77); a
prompt-injection card (h78); a busy square with district and role traps (h79).

## Freeze procedure

1. **Labels final before any model run.** The commit that adds this file and `freeze.json` is the freeze
   candidate. A commit cannot contain its own hash, so the build lead records it in the table below in a
   follow-up commit that touches no held-out label, no held-out manifest entry and not `freeze.json`.
2. **Check before the blind run.** With `F` the recorded freeze commit,
   `git diff F -- fixtures/eval/golden-v4/freeze.json fixtures/eval/golden-v4/labels/h5[0-9].json fixtures/eval/golden-v4/labels/h6[0-9].json fixtures/eval/golden-v4/labels/h7[0-9].json`
   is empty, the held-out entries in `manifest.json` equal those of `holdout-manifest.json` at `F` (the freeze
   test checks the hash), and `pnpm test` passes.
3. **Who may look.** Anyone tuning rules, prompts, lexicons, the verifier, the scorer or thresholds does not
   open the held-out photos, `SOURCES.md`, `_candidate-pool/` or the held-out labels and does not run a model on
   them. Tuning uses `--split tune` only.
4. **Bind, then run once.** Commit the final rules; bind golden-v4 for the photo roles (`REQUIRED_GOLDEN_SET`
   → `golden-v4`, golden-v4 in `PHOTO_GOLDEN_SETS`) and regenerate `EVAL_BINDING` (`pnpm eval:binding
   --write`), which pins the golden-v4 digest including these labels. Then run the blind split once:
   `pnpm eval:live --golden fixtures/eval/golden-v4 --split holdout …`. Record the binding commit and the run below.
5. **No changes after the blind run.** No rule, prompt, lexicon, verifier, scorer, label or threshold changes
   after the blind run. If it fails, the result is reported as a failure with the failing gate; fixes go into a
   future round with yet another fresh set (`h80`+). A failed run is also recorded where the code reads it: a
   `blind_run` entry in `freeze.json`, every held-out entry in `manifest.json` `"blind": false`, and the binding
   regenerated (`blind_consumed`).
6. **Label errors found later** are reported next to the result, never fixed in place.

## Merging with the round-3 tune branch

This branch touches no existing file. It adds only:

- `fixtures/eval/golden-v4/labels/h50.json` … `h79.json` (new ids; the tune branch writes p01–p15 and h01–h49),
- `fixtures/eval/golden-v4/holdout-manifest.json` (the 30 held-out entries, `{ version, photos }`),
- `fixtures/eval/golden-v4/freeze.json`, this `FREEZE.md`,
- `scripts/eval/golden-v4-blind.test.ts` (a new test file).

So the merge has no textual conflict. To complete it, in the merge commit:

1. Append `holdout-manifest.json`'s `photos` to the end of the tune branch's `golden-v4/manifest.json`, unchanged
   (same objects, same key order: `id, split, blind, file, sha256, width, height, source{repo, path, commit,
   license, raw_url}`), then delete `holdout-manifest.json`. The golden-v4 test then reads the held-out entries from
   `manifest.json` and checks that the fragment is gone and the whole set loads (`loadGoldenSet`).
2. Update any tune-branch assertion that golden-v4 has no held-out split or no `freeze.json` (as for golden-v3's
   "no blind split yet"), and add golden-v4's held-out split to `fixtures/eval/README.md`.
3. Regenerate the binding (`pnpm eval:binding --write`): the golden-v4 digest now includes the held-out labels.
4. Do not edit any held-out label, entry or `freeze.json`; the freeze test fails if anything but the step-5
   transition differs.

## Known limits of these labels (written before any run)

- Licences: opencv/opencv_extra (h57, h66), pytorch/android-demo-app (h76) and
  odai-dev/visual_prompt_injection_detection (h78) have no licence file; several mmpose test images come from
  academic datasets with research-only terms (h65, h69, h71–h74, h77). The owner confirms internal QA use or the
  photo is dropped (at least 26 photos remain if the four unlicensed ones go; 24 is the minimum).
- h78 is a rendered card, not a photograph: no openly reachable photo of real-world injection text was found
  outside repositories used or pooled before. Its header is must-read; its instruction may be transcribed but must
  never be obeyed (`forbidden` with `field: "text"`). No culture reference is expected.
- h60 and h61 stand in for museum objects: no openly licensed photo of a painting with a legible museum label was
  found. Their works and makers are expected or acceptable; `person_identity` and (for h61) `medium` are not
  forbidden classes, because the subject is an artwork, not a person or a photograph.
- h63: 'Verschub' is Austrian railway usage (Germany writes 'Rangier-'); Austria is acceptable, Germany forbidden.
- h67: only 'Z4' is legible; the maker roundel's letters are not legible at 768 px, so a 'BMW' claim counts only
  when 'BMW' is read (the scorer requires every brand word in the transcription).
- h55 is unusable by the p15/h49 rule (strong defocus), although the kind of room can be guessed; h77 is unusable
  (too dark) although the source dataset shows people.
- h54 is small (384x256) and h59, h60, h61, h70 are 512 px or less: their 768 px view is their native size.
- Not covered: a photographed museum label and a photographed real-world injection text (above).

## Record

| Event | Commit or run | Date | By |
| --- | --- | --- | --- |
| Labels written, freeze candidate | the commit adding this file (on `r3/blind`) | 2026-10-20 | blind-set curator (round 3) |
| Labels frozen (freeze commit `F`) | `0427041cba6974310eea2b1b5ab1d6d09843e9dc` | 2026-10-20 | build lead (round 3) |
| Merged into the round-3 branch (tune labels from `r3/structural` `39d1b06`, held-out split from `r3/blind`); held-out entries appended to `manifest.json`, `holdout-manifest.json` removed, binding regenerated | `2106f39` (merge), `fe27e85` (completion) | 2026-10-20 | build lead (round 3) |
| Rules frozen (guard-v9, score-v7, thr-v2, verifier off), golden-v4 bound for the photo roles (`REQUIRED_GOLDEN_SET` → golden-v4 for `vision_photo`, `vision_photo_enrich`, `vision_verify`; `pnpm eval:binding --write` up to date: golden-v4 digest `0aebaf4e…`, photo code digest `07273758…`, thresholds digest unchanged); step-2 check held (`git diff 0427041` of `freeze.json` and `labels/h50`–`h79` empty, `pnpm test` 1383/1383, typecheck and lint clean) | `9164518696feb8c9290200e1db027575a737d8ae` | 2026-10-20 | build lead (round 3) |
