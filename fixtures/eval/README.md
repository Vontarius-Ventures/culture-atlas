# Evaluation fixtures (docs/quality-plan.md §7)

The validation mechanism for photo readings: a hash-pinned golden set, a scorer
with versioned pass thresholds, a hermetic CI replay and a budgeted live
evaluation. Qualification of the photo roles requires a passing evaluation on
this set (`docs/concentrate.md`, "Qualification").

```
fixtures/eval/
  README.md          this file
  thresholds.json    versioned pass gates (thr-v1); its sha256 is bound into artifacts
  golden-v1/
    manifest.json    { version, photos: [{ id, split, file, sha256, width, height, source }] }
    labels/<id>.json one hand-written label per photo (schema: scripts/eval/labels.ts)
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
- **Version bumps and the binding.** Editing a label, the manifest,
  `thresholds.json`, a scorer, a text fixture or prompt builder, or any guard
  rule changes `EVAL_BINDING` (`pnpm eval:binding`; the test suite fails until
  `pnpm eval:binding --write` is run). `qualificationState()` compares every
  artifact's eval block with that binding, so the regenerated binding
  un-qualifies every role scored on the old inputs. A threshold change needs
  the owner's approval and a new `thr-v*` version; thresholds are never
  relaxed to make a run pass. A new photo or relabelled split is a new
  `golden-v*`.
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

`scripts/eval/scorer.ts` (`score-v2`) computes M1–M16 per split; M17 ("scorer
teeth") requires that the same recordings without guardrails fail M1. The
replay gates apply to the tune split of `replay-v1` in CI; the live gates apply
to every split of a live run, with stricter M3/M5 on the tune split
(`live_tune`). A gated metric without data (for example M9 on stage-1-only
runs) is reported as not applicable. M12 above its gate fails with "labels
stale": too many published candidates match no label entry, so the labels need
review before the numbers mean anything.
