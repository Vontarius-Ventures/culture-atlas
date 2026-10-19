# Evaluation fixtures (docs/quality-plan.md §7)

The validation mechanism for photo readings: a hash-pinned golden set, a scorer
with versioned pass thresholds, a hermetic CI replay and a budgeted live
evaluation. Qualification of the photo roles requires a passing evaluation on
this set (`docs/concentrate.md`, "Qualification").

```
fixtures/eval/
  README.md          this file
  thresholds.json    versioned pass gates (thr-v2); its sha256 is bound into artifacts
  golden-v1/
    manifest.json    { version, photos: [{ id, split, file, sha256, width, height, source }] }
    labels/<id>.json one hand-written label per photo (schema: scripts/eval/labels.ts)
  golden-v2/         tune = p01-p15 + h01-h13; held-out = h14-h29 (no longer blind: its blind run failed)
    manifest.json, labels/<id>.json   as in golden-v1
    FREEZE.md        the freeze procedure for the blind split
    freeze.json      sha256 of every held-out label and manifest entry (checked by labels.test.ts),
                     plus the blind_run record that consumes the split (scripts/eval/freeze.ts)
  golden-v3/         round 2: every golden-v2 photo as tune (h14-h29 included), h26 label fixed;
                     no held-out split yet (a fresh blind h30+ split is added before any photo role qualifies)
  replay-v1/         hand-written synthetic readings (FIXTURE- ids) used by CI
  text-v1/           text-role prompts and content checks (owned by the text package, §8)
```

## Rules

- **No images in git.** Photos live outside the repository. `pnpm eval:fetch
  --dest $EVAL_PHOTOS_DIR` downloads each one from its pinned
  `raw.githubusercontent.com/<repo>/<commit>/<path>` URL and refuses any file
  whose sha256 differs from the manifest. The test suite fails if an image
  file appears under `fixtures/eval`.
- **No model outputs in git.** `replay-v1` holds hand-written readings in the
  v1 and v2 shapes, modelled on the error classes of §1 but not copied from any
  model. Real recordings (phase 4, `eval:live` runs) stay outside git and are
  replayed locally with `pnpm eval:replay --recordings <dir>`.
- **Sources and licences.** Every photo records its repository, path, commit
  and repository licence. The photos are public test inputs from open-source
  repositories, used as local evaluation inputs only, never as product imagery.
  Individual photos may carry their own provenance. The OOTDiffusion garments
  (h03, h04) are CC BY-NC-SA 4.0: the owner confirms that internal QA use is
  acceptable, or they are replaced.
- **No person names.** Photo p11 shows two real, well-known people. Its labels
  forbid identity, role and descriptor claims without naming anyone, and its
  manifest entry withholds the upstream path (which is a person's name): the
  operator copies the photo from the private sources list and `eval:fetch`
  verifies its sha256.
- **Held-out split, no longer blind.** `h01`–`h13` were chosen from public
  repositories and labelled after viewing each photo and before any model
  output for them existed. They were blind only until the first live run:
  rules and the scorer were then changed after held-out failures were
  inspected (the licence plate on h01, "painted" on h07, the film poster h09,
  "Nathan Road" on h10; docs/quality-plan.md §13). Each is marked
  `"blind": false` in the manifest. A held-out photo stays blind (`true`) only
  while nothing is tuned on its outputs; photo roles qualify only with at least
  10 blind held-out photos, so a fresh set (h14+) is needed before they can.
  The scorer reports tune and held-out separately. Not yet covered: a painting with a legible museum label
  and a photo with prompt-injection text (no suitable openly licensed photo was
  found this round).
- **golden-v2: a fresh blind split.** Requalification (docs/requalification-plan.md)
  moves `h01`–`h13` into the tune split (labels unchanged apart from `split`;
  an `h*` photo may move to tune, a held-out photo is always `h*`) and adds a
  blind held-out split `h14`–`h29`: 16 new photos from eight repositories that
  golden-v1 never used (food, interiors, a craft object, Latin and Japanese
  signage, vehicles with and without legible badges, clothing with and without
  legible logos, one real well-known person whose identity must not be claimed,
  a busy street). Their labels were written before any model saw the photos and
  are frozen: `freeze.json` pins them and `FREEZE.md` gives the procedure (record
  the freeze commit, bind golden-v2, run the blind split once, change nothing
  afterwards). The blind run on 2026-10-19 failed (M1, M4, M11): `freeze.json`
  records it (`blind_run`), h14–h29 are `"blind": false`, and the binding marks
  golden-v2 `blind_consumed`, so no photo role can qualify on golden-v2 any more;
  the next round needs a fresh blind set (`h30`+). golden-v1 stays as it was for
  `replay-v1` and earlier artifacts.
  The photo on h27 shows a real person; its upstream path holds no name, and no
  name is written in this repository.
- **golden-v3: round-2 tune labels.** After the failed blind run
  (docs/quality-plan.md §16–17) `h14`–`h29` join the tune split in a new set:
  golden-v3 holds the same 44 photos and labels as golden-v2, every one with
  `split: "tune"`, except that h26's expected "Classic roadster" pattern is
  anchored to the body type (the unanchored "roadster" counted "MG MGA roadster",
  a make read off the shape, as label-good); h26's `history` records the change.
  golden-v2 and its frozen files are not edited. golden-v3 has no held-out split
  and no `freeze.json` yet, and the photo roles still require golden-v2, so no
  photo role qualifies until a fresh blind split (`h30`+) is labelled, frozen
  and bound as `FREEZE.md` describes.
- **Version bumps and the binding.** Editing a label, the manifest,
  `thresholds.json`, a scorer, a text fixture or prompt builder, or any guard
  rule changes `EVAL_BINDING` (`pnpm eval:binding`; the test suite fails until
  `pnpm eval:binding --write` is run). `qualificationState()` compares every
  artifact's eval block with that binding, so the regenerated binding
  un-qualifies every role scored on the old inputs. A threshold change needs
  the owner's approval and a new `thr-v*` version; thresholds are never
  relaxed to make a run pass. A new photo or relabelled split is a new
  `golden-v*`.
- **Label history.** A label edited after it was first written records the
  change in its `history` (date, change, reason, and the decision that
  allowed it). p14 is the first: its must-read text and expected reference
  were changed to what is legible at 768 px (docs/requalification-plan.md
  decision 1). h26 in golden-v3 is the second (its roadster pattern, round 2).
- **thr-v2** (docs/requalification-plan.md decisions 3 and 4). `two_stage_only`
  lists the metrics gated only on a two-stage scorecard (M5, M9): a split
  scored on stage 1 alone reports them but is gated on M15 ≥ 0.60 for
  coverage; a split mixing two-stage and stage-1-only readings is gated as
  strictly as two-stage. No gate value changed. The grounding block's recall
  gate is 0.50 and its precision gate 1.0 (zero wrong matches).
- **Grounding and seed gates.** The `grounding` and `seed` blocks of
  `thresholds.json` are applied by `scripts/eval/release-gates.ts`
  (`eval:live --qloo`, `measure-taste-seed.ts`). Gates that need a person
  (precision, recall, useful share) read a judgement file and fail without one.

## Label format

```jsonc
{
  "id": "p13", "split": "tune", "file": "13-sport-basketball-hoop.jpg",
  "subject_domains": ["sport"],
  "quality": { "usable": true, "issue": null },
  "expected":   [{ "name": "Streetball", "aliases": ["Street basketball"], "type": "tradition" }],
  "acceptable": [{ "name": "NBA", "pattern": "^nba$", "type": "brand", "requires_text": "NBA" },
                 { "pattern": "basketball", "generic": true }],
  "forbidden":  [{ "pattern": "spalding|wilson|molten", "class": "brand_without_text", "why": "maker patch not legible" }],
  "forbidden_classes": ["brand_without_text", "medium", "person_identity", "person_descriptor",
                        "role_inference", "cuisine_without_food"],
  "allowed_categories": [],
  "must_read_text": ["NBA"],
  "must_not_read_text": [],
  "people": { "present": false },
  "qloo": { "forbidden_entity_types": ["urn:entity:album"], "forbidden_tag_families": ["occupation"] }
}
```

- An entry matches a published candidate when its case-insensitive `pattern`
  matches, its canonical name equals the name or an alias, or (only when no
  entry matches exactly) `nameSimilarity >= 0.75`. `forbidden` is checked first.
- `requires_text`: the entry counts as good only when the final visible text
  contains it; otherwise the claim is unsupported and counts as forbidden (a
  brand named before any text was read).
- `generic: true` marks a generic object; demoting it is intended, so it never
  counts as a clean drop (M4).
- `forbidden[].field` is `candidate` (default), `text` (title and
  interpretation: a hard error), `visible_text` (M8) or `observations` (M11).
  `class` also counts the claim under that forbidden class (M1).
- `forbidden_classes` are checked by the scorer itself, independently of the
  guardrails: brands without legible text, medium words, identity claims,
  person descriptors, role inference, cuisines without food, and candidates on
  an unusable photo.

## Metrics and gates

`scripts/eval/scorer.ts` (`score-v5`; v5 counts plural role nouns and players, athletes or spectators in the reading as people) computes M1–M16 per split; M17 ("scorer
teeth") requires that the same recordings without guardrails fail M1. The
replay gates apply to the tune split of `replay-v1` in CI; the live gates apply
to every split of a live run, with stricter M3/M5 on the tune split
(`live_tune`), minus `two_stage_only` on a stage-1-only split (`runKind`,
`scopedOut` in the scorecard). A gated metric without data (for example M9 on
stage-1-only runs) is reported as not applicable. M12 above its gate fails
with "labels stale": too many published candidates match no label entry, so
the labels need review before the numbers mean anything.

score-v4 and later also report, without gates: `text_only` (references published only
as text-only, decision 2) and the verifier measures `verifier_checked`,
`forbidden_published`, `forbidden_uncontested` and `M5_uncontested` (the
verifier can only contest a claim, never remove it; how Tune uses them is in
docs/requalification-plan.md). `eval:live --roles ...,vision_verify` stores
the verifier's reply with each recording, and `eval:replay --verifier both`
scores the same readings with and without it.
