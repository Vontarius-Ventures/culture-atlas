# v5 subject-specific documentary discovery

2026-10-27. Local implementation, not a release qualification.

## Change

- Resolve a bounded topic from the active depicted subject, not a generic
  interior/craft category. Resolve both that topic and Documentary through
  actual returned, movie-compatible Qloo tags.
- Use the documented tag intersection for documentary retrieval. Skip a broad
  primary query only when both tags resolve. Preserve the existing topic
  route when they do not.
- A candidate must carry the actual requested topic and a documentary
  genre/subgenre. Its returned description or short description must contain
  a subject-specific focus and content/process relation in one bounded
  sentence. Missing descriptions, incidental background/plot mentions,
  crime references, wrong types and excluded anchors do not earn this proof.
- Persist the exact excerpt, field, documentary tag, subject claim and
  provider query ID. Reasons say “A documentary exploring sculpture” rather
  than claiming a keyword is a genre or a visual match.
- Existing commercial evidence and ranking thresholds remain unchanged.
  No model/provider change, paid metadata ranker, synthetic taxonomy or
  inference about a person's identity.
- Cache version: `compiler-2026-10-27-qloo-native-v5`.

This is a deterministic, English-language evidence heuristic, not a general
parser or a guarantee that every admitted film is useful. Pottery/ceramics
lookups were empty in recorded probes. Do not invent replacement tag IDs.

## Validation and evaluation contract

Unit and real-compiler tests cover a supported sculpture documentary,
coffee-production support versus a crime documentary, missing requested
tags, wrong types, excluded anchors, hidden claims, exact excerpts and
legacy-topic fallback. Broader validation results are recorded separately.

Preserve iter12 and its 24-photo denominator. Its daily Qloo quota exhaustion
confounds coverage comparisons; restored quota alone is not a v5 logic win.
The new runner must check daily Qloo headroom without resetting counters,
freeze source/photos, retain failed/unrun photos, and use separate aliases.

The approved cap is **$25 cumulative**. Preflight found $18.652927 in historical
unknown-cost reservations (1,334 attempts), all still carried into gateway
daily and unknown-spend checks. A $25 runtime limit therefore leaves
**$6.347073**, not a fresh $25. Do not clear reservations, circuits or pauses.
The independent runner checks the same cumulative ledger and stops on
allowance, quota, source drift or a UTC-day change. Operational completion
does not establish the unchanged relevance or style-quality targets.
