# golden-v2: blind held-out freeze

Requalification plan step 2 ([docs/requalification-plan.md](../../../docs/requalification-plan.md),
"Blind held-out set"). This file says what is frozen, how the freeze is
checked and what may happen after the blind run.

## What is frozen

- The held-out split `h14`–`h29` (16 photos): `labels/h14.json` … `labels/h29.json`,
  their entries in `manifest.json` (file, sha256, size, pinned source) and
  `freeze.json`.
- `freeze.json` records the sha256 of every held-out label file and of the
  held-out manifest entries. `scripts/eval/labels.test.ts` ("the held-out labels
  and manifest entries are exactly the frozen ones") recomputes them on every
  `pnpm test` and fails on any difference.
- Not frozen: the tune split (`p01`–`p15` and `h01`–`h13`, moved to tune because
  they stopped being blind in the Evaluate phase). Tune labels may still change
  in plan steps 1 and 3; the p14 decision (plan decision 1) lands on
  `labels/p14.json` here as well as in golden-v1.

## How the labels were made

- Photos: 16 public photographs from eight repositories that golden-v1 never
  used, fetched through `raw.githubusercontent.com` at pinned commits. Photos
  stay outside git; `pnpm eval:fetch --golden fixtures/eval/golden-v2 --split
  holdout --dest <dir>` downloads them and refuses any file whose sha256 differs.
  The curator's copy and `SOURCES.md` (repository, path, commit, licence,
  provenance) live in the team scratchpad (`blind-v2/`).
- Each photo was viewed at its native size and at 768 px. `must_read_text` lists
  only text legible at 768 px; where a sign breaks a name over lines, single
  words are used. Plates that are legible are `must_not_read_text`.
- Labels were written from the photos alone, before any model output for them
  existed. The curator ran no model, made no Concentrate, Qloo or Wikipedia
  call for these photos, and did not open any earlier model output.
- Labelled on 2026-10-19 from base `59dc32ad60ee0e487248f840ea924db815438336`.

## Freeze procedure

1. **Labels final before any model run.** The commit that adds this file and
   `freeze.json` is the freeze candidate. A commit cannot contain its own hash,
   so the build lead records it in the table below in a follow-up commit that
   touches no held-out label, no held-out manifest entry and not `freeze.json`.
2. **Check before the blind run.** With `F` the recorded freeze commit,
   `git diff F -- fixtures/eval/golden-v2/freeze.json fixtures/eval/golden-v2/labels/h1[4-9].json fixtures/eval/golden-v2/labels/h2[0-9].json`
   is empty and `pnpm test` passes (the freeze test above).
3. **Who may look.** Anyone tuning rules, prompts, lexicons, the scorer or
   thresholds (plan steps 1 and 3) does not open the held-out photos or labels
   and does not run a model on them. Tuning uses `--split tune` only.
4. **Bind, then run once (plan step 4).** Commit the final rules; bind golden-v2
   for the photo roles (`BOUND_CODE['golden-v2']` in `scripts/eval/binding.ts`,
   `REQUIRED_GOLDEN_SET` → `golden-v2`) and regenerate `EVAL_BINDING`
   (`pnpm eval:binding --write`), which pins the golden-v2 digest including these
   labels. Then run the blind split once:
   `pnpm eval:live --golden fixtures/eval/golden-v2 --split holdout …`. Record the
   binding commit and the run below.
5. **No changes after the blind run.** No rule, prompt, lexicon, scorer, label or
   threshold changes after the blind run. If it fails, the result is reported as a
   failure with the failing gate; fixes go into a future round with yet another
   fresh set (`h30`+), and `h14`–`h29` then move to tune as `h01`–`h13` did.
6. **Label errors found later** are reported next to the result, never fixed in
   place: editing a held-out label after the run ends its blindness.

## Known limits of these labels (written before any run)

- h18 (kitchen) has no expected reference: it is a restraint case.
- h19 (ceramic head) expects only "Pre-Columbian"; named cultures are unlabelled
  because the source does not state the culture.
- h22 (street with Japanese signs) leaves "Tokyo" unlabelled; Tokyo districts
  other than 日本橋 are forbidden.
- h26 (roadster): the make counts only if "MG" is read; at 768 px the badge is
  not legible.
- "Ramen" on h22 is acceptable only as read text; a cuisine-typed claim still
  counts under `cuisine_without_food`, as on h10.

## Record

| Event | Commit or run | Date | By |
| --- | --- | --- | --- |
| Labels written, freeze candidate | `9e24243e454725e2541e9901fd779bd133167ac2` (the commit adding this file) | 2026-10-19 | blind-set curator |
| Freeze commit recorded | `9e24243e454725e2541e9901fd779bd133167ac2`; checked with step 2 (empty diff, freeze test passing) after the merge into the build branch | 2026-10-19 | build lead (tune step) |
| Binding with golden-v2 (rules frozen) | `b2cf11ac7d7ac76ec1e5ae2e70a650074c4423a6`: photo roles require golden-v2; `EVAL_BINDING` pins golden-v2 `e4289b6f9923…`, photo code `6b227a3c6b02…` (unchanged from the tune step's final rules, guard-v5), thresholds `9d43471b818b…` (thr-v2). Freeze check (step 2) re-run on it: empty diff against `9e24243`, `pnpm test` passing. No rule, prompt, label, lexicon, scorer or threshold may change from this commit on. | 2026-10-19 | build lead (blind step) |
| Blind run (once) | `eval:live --split holdout`, two-stage, verifier off, code `303b29b` (the freeze above plus this table's freeze row), 32 Concentrate + 32 Qloo calls. **FAIL**: M1 4, M4 0.2105, M11 3; every other live gate passes (docs/quality-plan.md §16). Nothing changed afterwards; photo roles not qualified. Label observations made after the run are in §16.3 and were not applied. | 2026-10-19 | build lead (blind step) |
