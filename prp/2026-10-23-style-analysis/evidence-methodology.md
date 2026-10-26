# Evidence-first observation and discovery

Methodology decision, 2026-10-26. Supplements `design.md`; it does not relax
its safety, coverage, qualification, or merge gates.

## Why a different method

Iteration 7's descriptive scores were 8.28/10 style and 5.27/10 relevance.
Accurate descriptions and real catalogue IDs did not establish useful discovery.
Two independent code investigations found information loss and route-dependent
admission, not simply an underperforming vision prompt:

- Small measured colours were discarded by a whole-subject presence threshold,
  even when the model described the accent correctly.
- Aesthetic labels organized observation before concrete supporting features.
- A broad subject category could become a retrieval command: equipment filed
  under fashion fell through to apparel.
- Identified brands, recommended brands, and topic fills passed different
  admission rules. A word's presence substituted for the relationship's meaning.
- Broad product families hid form differences, and partial matches produced
  stronger explanations than the evidence justified.

Further stop words or a higher similarity threshold would conceal symptoms.
A second model adjudicating every card would add cost and another unsupported
claim surface. The chosen method is one bounded vision call followed by
deterministic evidence validation and domain-aware discovery.

## The evidence chain

**Concrete observation → guarded interpretation → discovery relation →
catalogue candidate → candidate-side proof → faithful explanation.**

Each boundary has a different job:

| Stage | Records | Must not imply |
| --- | --- | --- |
| Observe | Object/form, surface, pattern, construction, composition, text, region | Identity, provenance, hidden materials, purchase intent |
| Interpret | Supported aesthetic/material/lineage, linked observations, uncertainty | That a cultural resemblance establishes origin |
| Plan | Subject, active claim, target domain, allowed relationship | That every category needs a filled rail |
| Retrieve | Real provider entities/tags and their recorded provenance | That catalogue existence proves relevance |
| Verify | Candidate's own compatible attributes or explicit relationship | That shared spelling or audience is shared style |
| Explain | Only the relationship actually established | That a broad category match proves historical/design equivalence |

Missing evidence stays missing. Held, retracted, invalid or uncorroborated claims
must not become query inputs, scoring support, or explanation sources.

## Observation contract

Keep the style reader independent from stage-1 candidate names. Observe concrete
features before naming aesthetics. Bounded observations carry IDs, kinds, text,
regions and certainty; interpretations reference those observations.

Use a style-only, explicitly versioned wire format. Existing stored readings
remain readable without invented links. Public v1 response fields remain
compatible. Changing the style prompt is not permission to change the photo-role
prompts, golden labels, qualification thresholds or evaluation binding.

All new text surfaces receive the existing people/identity and untrusted-input
guards. Repeated wording is not independent evidence. An unsupported text claim
cannot be promoted to visual evidence.

### Colours

Hex values come from server measurement, not model guesses. Distinguish dominant,
secondary and accent colours. Dominant colours need meaningful subject presence.
An accent needs a valid localized observation and measured support inside that
feature region, rather than a large share of the complete subject box.

Do not fill a rejected colour automatically or infer a feature-colour link from
prose. Record rejection causes separately so missing measurement, insufficient
presence, background contamination and invalid references can be diagnosed.
Display-region preferences must not erase internal validation evidence.

## Discovery contract

Preserve concepts and their domain sense. Interior minimalism does not itself
prove a connection to musical minimalism; a region modifier does not authorize
artists from that region. An anchor's brand audience is not visual evidence.
Admission must be consistent whether a candidate arrived from an anchor,
recommended-brand bridge, topic fill, or thin-rail fallback.

Distinguish these relationships:

- **Same form/design:** supported product form or design attributes.
- **About the subject:** a candidate genuinely about the subject or tradition.
- **Shared named work:** an exact catalogue title relationship, explained only
  as such; not counted as style evidence.
- **Audience affinity:** a provider relationship, not a claim of visual
  similarity. It must not silently fill a style-discovery rail.

Broad product family remains useful for provider filters. Candidate verification
also considers product form. A backpack-only label does not prove crossbody-bag
suitability; a diversified brand can qualify with compatible evidence.
An unknown object must not default to apparel.
An entity's `brand` type must not default its card to Wear either: fashion
brands retain Wear, coffee/food brands use Eat, and home brands keep a null
category on their subject's More like this rail. This uses the existing
nullable category contract rather than adding a new public enum.

Material/category adjacency can be useful without historical equivalence:
ceramics brands may be presented as ceramics, not as proof of Persian lineage.
Second category rails must add supported discovery, not generic audience filler.
Short or empty results are preferable to invented evidence, but emptiness is
not an improvement metric.

## Implementation ownership

Three independent tracks implement this decision:

1. Style-only observation representation, guarded interpretation and localized
   palette validation.
2. Subject-aware discovery planning/admission, compound topics, provenance and
   faithful category composition.
3. Product-form verification, active-only profiles and appropriately scoped
   same-domain explanations.

Integration must verify that evidence survives each boundary. New optional
metadata alone is not evidence that every retrieval path uses it.

## Evaluation protocol

Freeze inputs and criteria before reading candidate outputs. Existing iter6/7
images are tuning data. An additional disjoint set of existing golden images
tests transfer, but is not a new qualification holdout.

Report separately:

- Observation precision, distinctive-feature recall and retained palette support.
- More-like-this and cross-domain relevance, by subject/category.
- Useful coverage, number of empty rails, repeated generic labels and echoes.
- Faithfulness of explanations to active source and candidate evidence.
- Latency, provider failures, request counts and model reservations versus
  reconciled billing.

Judges open the images and assess relevance without product reasons or Qloo
tags. Assess reasons separately; otherwise the evaluation rewards its own
retrieval vocabulary. Include failures and all selected photos in denominators.

Use one candidate pass with a preflight budget estimate and hard ledger ceiling.
The owner authorized up to $15 for local evaluation, not shipped production
configuration. Outstanding unknown-cost reservations remain counted.
No automatic prompt-tuning loop follows a failed candidate run.

Existing legacy scores are descriptive comparisons, not causal estimates:
observations, live provider responses and judge variability can all change.
Do not describe a score difference as statistically insignificant without a
measurement supporting that claim. The original qualification and merge gates,
including a genuinely fresh holdout, remain unmet until explicitly demonstrated.
