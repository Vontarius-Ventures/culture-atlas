# Frozen intent-specific AI quality gates

2026-10-27. Declared before generating/reviewing the renewed benchmark outputs.
User accepts blinded AI evidence for completion; human usefulness remains unverified.
These gates do not retroactively change the failed historical names-only gates.

## Common protocol

- Retain all 24 original source photos: 16 tuning and 8 reused transfer, not a fresh holdout.
- Use unchanged source bytes and admitted guarded readings. Keep held, empty,
  unsupported, errored and unavailable outcomes in the 24-photo denominator.
- Freeze code, inputs, catalog, profiles, rubric, A/B assignment and cost limits
  before any paid benchmark dispatch or reviewer sees the corresponding outputs.
- Two independent AI sessions score anonymized packets without implementation,
  arm labels, provider scores or outcome summaries. They are not necessarily
  different model families. The conservative score is the lower of their scores.
- Score each card 0–4: 0 unrelated/misleading; 1 generic or marginal;
  2 plausible but weak; 3 useful and clearly supported; 4 unusually useful,
  specific and well-supported. A useful card needs a conservative score of 3.
- Review actual source pixels and actual candidate images when available, plus
  displayed reason and recorded relation evidence. Record missing candidate images;
  never substitute a generated image or pretend a logo is a pictured product.
- Report every card, per-photo best-card score (empty=0), coverage, conditional
  precision, split results, disagreements, missing evidence and latency separately.
- No favorable retries, counter resets or qualification artifacts inferred from
  passing counts. Production activation remains off pending genuine bound evaluation.

## Connections

Purpose: useful, honest cultural/taste discovery prompted by the photograph,
not a product search or claim that a film/brand looks like the pictured object.

Baseline: retained v6 published cards and reasons, with their actual evidence.
Candidate: same cached retrieval pools/guarded readings, re-admitted and selected
using current evidence policy and proof-specific reasons. No complete-pool claim.
Report unchanged selections and code-path limitations rather than inventing an effect.

Pass all:

1. No unsupported identity, visual-product, authorship, influence or provenance claims.
2. At least 16/24 photos have a useful card, including at least 5/8 transfer.
3. At least 80% of shown cards are useful; missing/unreviewable cards are not successes.
4. Mean per-photo best-card score is at least 2.5/4 overall and 2.25/4 transfer.
5. Paired mean best-card improvement over baseline is at least 0.25/4 overall,
   with nonnegative mean transfer improvement.

## Visual references

Purpose: useful visible-form/surface inspiration, not identification, maker
attribution, authentication, shopping inventory or merely sharing an object noun.
Review source subject crop and candidate pixels. Useful scores require a specific,
visible connection beyond generic object type; background/color alone is insufficient.

Baseline: historical v6 had no visual intent, hence zero visual coverage. Do not
claim this is a randomized comparison of selectors. Report the separately frozen
old/new prospective retrieval comparison as diagnostic, not published visual success.

Pass all:

1. The frozen 14-pair mechanism set returns 14 valid responses, zero consensus
   type errors, label-invariance errors or tiny-crop false matches, all within 15s.
   This set alone has no useful-match positives and cannot qualify quality.
2. A separately frozen genuine alternate-view positive set demonstrates useful
   match sensitivity; exact/cropped source echoes and generated positives are excluded.
   Keep all acquired views, including uncertain or insufficient-detail cases.
   Require at least two independently AI-consensus useful positives, at least 80%
   provider acceptance of those positives, and no accepted incompatible controls.
3. At least 10/24 photos have a useful published-reference-equivalent result,
   including at least 3/8 transfer. At most two sequential comparisons per source
   photo, no retries or hidden extra shortlist screening through the paid comparator.
4. At least 80% of accepted/shown references are useful. Weak/none are not shown.
5. Zero incompatible-type, source/image binding, attribution/license or unsupported
   identity/authenticity/product claims. Missing credit is a failed reference.

The benchmark may run the actual provider/admission/projection seams in a bounded
evaluation harness. Such outputs must be labeled prospective, not production-served
or a full runtime publication test. Owner/lease/cancellation/runtime behavior has
separate regression tests. No source photo is reanalyzed merely to reset its allowance.
