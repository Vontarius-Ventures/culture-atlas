# Qloo-native discovery implementation plan

2026-10-26. Implements the owner's request to define delivery by Qloo's
actual capabilities. Supplements the evidence-method evaluation; does not
convert its failed relevance results into a passing gate.

## Product contract

Photo observation and catalogue exploration are separate.
Qloo provides entity-level taste recommendations and catalogue metadata,
not demonstrated uploaded-image search, product-SKU matching or an artwork
inventory. The supported capture experience is:

| Connection | Required support | Honest delivery |
| --- | --- | --- |
| Brand exploration | Compatible commercial domain/form and candidate-owned design/product metadata | A brand to explore, not a matching product |
| Topic connection | Candidate-owned, type-appropriate topic evidence | Media connected to a topic, not visual resemblance or historical influence |
| Named work | Disambiguated real catalogue title relationship | Shared title only, not an inferred adaptation |
| Taste affinity | Actual Qloo result and attributable supplied seed/influence provenance | Qloo taste connection, not shared appearance or subject matter |
| Place exploration | Actual place/destination and supported request constraints | Places to explore; use only user-provided city, never inferred photo location |

Every card remains a real provider entity. Every path uses the same
relation-specific admission contract. Candidate images illustrate entities;
their availability does not establish product correspondence or image rights.
An absent evidence field is unknown, not a fabricated negative fact.

No new public item/category enums. Defer books, generic/visual artists and
other new surfaces until their card semantics and available evidence are
verified. An artist type alone does not establish a musician. No person
identification, sensitive-trait inference or unverified provenance claims.
Preserve existing stored readings, public response compatibility, guards,
photo/style prompts, budgets, call count and deadlines.

## Evidence informing the plan

Official docs verified by a specialist:

- https://docs.qloo.com/reference/available-parameters-by-entity-type
- https://docs.qloo.com/reference/parameters
- https://docs.qloo.com/reference/search-tags
- https://docs.qloo.com/reference/insights-api-deep-dive
- https://docs.qloo.com/docs/interpreting-affinity-scores

Filter tags default to union; signal tags have different documented defaults.
Explicit operators must retain their actual meaning. GET does not document
per-tag weights; do not silently pretend to send them. Preserve documented
metadata and explainability warnings without turning them into content proof.
Do not change endpoints/base URL or assume account entitlement from docs.

Private recorded-data audit: 24 candidate captures contain 1,681 entity
occurrences / 800 distinct IDs. Twenty-three query records marked empty
retain nonempty result arrays. Reduced recordings lack candidate
descriptions/images; published image URLs have unverified roles. No book or
demonstrated visual-artist discovery requests were made. These are findings
about recorded pools, not the whole catalogue or judged candidate relevance.

## Implementation workstreams

1. **Provider contract:** explicit filter/signal tag operators; deliberate
   unweighted GET requests; preserve documented optional metadata and
   explainability diagnostics; synthetic request/parse/replay regressions.
   Migrate affected capture callers alongside local weight rejection.
2. **Discovery contract:** one typed, provenance-bearing admission result
   across early, fashion/home/media MLT and cross-domain paths. Early calls
   may prefetch, never publish before the subject is known. Separate
   commercial objects, artworks and actual film/music subjects; do not infer
   movie interest from a sculpture's visual-style tag. Keep useful,
   attributable affinity as explicitly labeled taste, without a lexical
   topic requirement masquerading as provider capability.
3. **Presentation:** accurate entity/connection-level rail titles and empty
   copy; preserve wire keys/kinds and server-composed reasons on all clients.
   Never say that Qloo has no suitable entity merely because one route
   admitted no candidate. Images are not verified visual matches.
4. **Private audit tooling:** versioned bounded candidate projections,
   query/provenance/operator and admission accounting, metadata availability,
   and offline reports. No raw third-party response fixtures in the public
   repository, no secrets or signed URLs in reports, no network calls.
   Missing historical fields remain unknown. Unjudged rows are not oracle
   positives or relevance negatives.

## Validation and boundaries

Focused synthetic tests must retain legitimate brand/topic/music/place and
attributable affinity cases, not just reject everything. Cover sculpture
film leakage, stale/held claims, early publication, wrong-form brand
evidence, nonmusical artist routing, ambiguous seed attribution, absent
metadata, operator semantics, GET weights, legacy responses and honest copy.
Then run typecheck, lint, relevant DOM/contract tests and production build,
followed by the full test suite where practical. Report existing PostgreSQL
teardown/timing failures separately, without raising database privileges.

Use recorded data for audit validation only. No paid live/model run, new
provider/content source, image corpus or dependency is included. Useful
yield, coverage and novelty still need candidate-evidence inspection and a
fresh qualification protocol before claiming relevance improvement.
Review validated changes locally. Publishing requires authorization;
PR #7 stays open and unmerged.

The default compiler cache version advances to
`compiler-2026-10-26-qloo-native`, so intentional future submissions do not
silently reuse the old discovery contract. Explicit deployment overrides
must be advanced by the operator. This does not rewrite existing analyses,
trigger jobs, or change the VLM qualification binding.
