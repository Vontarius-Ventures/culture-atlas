# Qloo-native photo discovery

Qloo recommends catalogue entities using taste signals and metadata. It is
not the photo reader and does not provide verified visual matches for the
photographed products, rooms or artworks in this integration.

The implementation plan and qualification boundaries are in
[`qloo-native-discovery-plan.md`](../prp/2026-10-23-style-analysis/qloo-native-discovery-plan.md).
The prior evidence-method evaluation remains a failed relevance gate, and
the three bounded live improvement checks that followed it
([`qloo-native-live-evaluation.md`](../prp/2026-10-23-style-analysis/qloo-native-live-evaluation.md))
also failed the relevance gate on both splits. The latest check improved
paired relevance but still missed the target and regressed latency.
Passing implementation
tests does not replace those evaluations. The subsequent bounded
[relevance experiments](../prp/2026-10-23-style-analysis/relevance-experiments-v3.md)
separate retrieval coverage from unqualified model-score predictions.

The subsequent local [v4 logic repair](../prp/2026-10-23-style-analysis/relevance-logic-v4.md)
fixes artwork classification, weak home-brand seeds, and the ranking bypass
that treated provenance as relevance. Its offline audit exposes a substantial
coverage trade-off: only 3 of 67 previously published home cards qualify on the
recorded pools. Seed choices also change, so this is not a new end-to-end
result. Historical relevance failures remain failures; v4 has not been live
evaluated.

## What a connection means

- **Brand exploration:** a compatible brand with its own supporting catalogue
  metadata. It is not a matching product or a claim about current inventory.
- **Topic connection:** a candidate's own tags support a connection to an
  active reading. The reason names that evidence rather than claiming visual
  similarity or historical influence.
- **Named work:** a disambiguated catalogue film shares a work's title. This
  alone does not establish an adaptation or a film about that work.
- **Qloo taste connection:** an actual supplied entity seed, attributable
  from the request or returned explainability. With multiple seeds, the
  request alone cannot identify which seed contributed. Explainability is
  computational influence, not visual or historical provenance.
- **Place exploration:** an actual place result with supported constraints.
  A requested city comes from the user, never inferred photo location.

All publication paths need evidence appropriate to the connection. Early
requests may prefetch candidates but cannot establish the subject. Missing
or retracted evidence must not silently become a weaker relationship.
An artist type alone does not prove that the entity is a musician. Books
and visual-artist discovery need a separate verified presentation contract.

When the optional style reader is unavailable or disabled, independently
guarded and resolved references may support catalogue-tag or taste
connections. This fallback must not invent a style subject or bypass
candidate evidence. It does not authorize publication ahead of a pending
style reading.

## Requests and metadata

`filterTagsOperator` and `signalTagsOperator` expose the documented union
and intersection controls. Omitted operators stay omitted: filter and
signal defaults are not interchangeable. A ranking signal is not a
substitute for checking the returned candidate.

This GET integration rejects defined per-tag weights instead of silently
discarding them. It does not switch to an unverified POST endpoint.
Request identity, sanitized diagnostics and replay identity retain the
operators.

Documented optional metadata and top-level explainability warnings survive
normalization. Their presence does not establish entitlement for another
entity type or turn audience affinity into content evidence. Unknown
metadata shapes remain unknown until a consumer validates them.

An entity illustration may be a logo, poster or portrait. Image availability
does not prove visual similarity, product correspondence, or an image-rights
grant. For proof-bearing catalogue connections, public `style_match`
attributes and palette stay empty; the relation-specific reason explains
the connection. Legacy response keys and category enums remain unchanged.

## Audit and validation

`scripts/style/qloo-native-audit.ts` audits recorded captures without network
calls. Its [usage guide](../scripts/style/qloo-native-audit.md) covers private
outputs and optional manual judgments.

Keep these counts separate:

1. Provider retrieval and missing historical results.
2. Candidates admitted under a supported connection.
3. Cards actually published after exclusions and caps.
4. Candidate usefulness, which requires evidence-based judgments.

An empty published rail does not establish an empty retrieval or an absent
catalogue capability. Unpublished candidates are unjudged, not necessarily
irrelevant. Historical recordings that omit descriptions or images do not
prove those fields were absent upstream.

Synthetic tests exercise admission and transport contracts. Recorded-pool
audits establish accounting, not a fresh relevance result. Paid live
evaluation outcomes are recorded in the reports linked above; model-score
diagnostics do not replace those judgments.

The default compiler cache version is `compiler-2026-10-26-qloo-native-v3`.
Operators who pin `COMPILER_VERSION` must advance that override to avoid
reusing the old discovery contract. Existing analyses are not rewritten or
automatically rerun, and VLM qualification bindings are unchanged.
