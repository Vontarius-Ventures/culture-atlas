# Reviewed evidence corpus (PR 8 discovery)

The shared versioned evidence layer behind the interest graph: durable source
revisions, append-only evidence with review provenance, canonical identities
with provider mappings, and a durable provider rights policy. The pilot corpus
covers the four reviewed domains — art, sculpture, ceramics, interiors — and
lives in `fixtures/graph-corpus/pilot-manifest.json`.

Everything here is **shared, public-source cultural data**. No account-private
state, no photos, and no paid provider calls are involved in corpus admission.

## Storage model

| Table | Role |
| --- | --- |
| `graph_nodes` / `graph_node_aliases` / `graph_external_ids` | Canonical identities distinguished by name + kind + domain + sense (a name alone never dedupes); a provider id maps to exactly one identity, ambiguous matches stay proposals. |
| `sources` + `graph_source_revisions` | Immutable per-crawl document revisions (migration 220): URL, locator, revision number, document hash, permitted display metadata, retention policy, rights and applicable expiry. The same reviewed content reuses the latest revision; a changed document is a NEW revision. |
| `graph_evidence` | Append-only evidence rows: permitted excerpt and/or structured value, validation method/version, evidence kind, expiry, and (migration 300) review provenance (`reviewed_by`/`reviewed_at`). Identical content within a revision reuses the row; a correction is a new row. |
| `graph_assertions` + `graph_assertion_support` | Natural-keyed typed relations (one row per subject/predicate/object/subtype; new evidence bumps the revision instead of duplicating) and support rows that record `derivation` (`primary`, `mirror`, `refresh`, `reextraction`) and `source_family_key`. |
| `provider_rights_policies` | Migration 300: the durable operational record of each provider's approved privacy settings and storage/display rights — no secrets. |

### Evidence versions and pinned proofs

The **evidence version** of a `graph_evidence` row is the revision number of
the source revision it was read from. `recommendation_graph_proofs` pin exact
`(evidence_id, revision)` pairs, and because evidence is append-only, a pinned
pair can never drift:

- Replacing evidence (a re-crawl + re-extraction) creates a **new** source
  revision and a **new** evidence row. The old pair a proof recorded stays
  exactly what it was; a newer proof pins the newer pair.
- Migration 300 content guards make in-place rewrites of
  `graph_evidence`/`graph_source_revisions` content fail loudly. Status or
  validity columns (for the later retraction work) stay updatable.
- The disposable research `claims` rows are unaffected evidence-wise: a
  `storeResearch` refresh (which deletes and replaces claims) leaves evidence,
  source revisions, identity links and pinned proofs untouched.
- `loadEvidenceVersions` (`packages/domain/src/interest-graph/evidence.ts`)
  resolves pinned ids to their exact versions for revalidation at read AND
  publication time.

### Source families never inflate support (VAL-EVID-003)

Mirrors, repeated extraction and refreshes of the same source family count as
ONE cultural support. `distinctAssertionSupport` returns the deduplicated
support set — one entry per `(source_family_key, role)` with the family's
derivations and evidence ids — plus `independentFamilies` / `refutingFamilies`
counts. Downstream admission compares against this set, never raw support-row
counts. Independently sourced families stay separately represented (for
example, *The Bedroom*'s creator is corroborated by both the AIC record and
the Wikipedia *Bedroom in Arles* summary).

## Admission and expansion (VAL-DISC-001/002/004)

`expandAccountInterestGraph`
(`packages/domain/src/interest-graph/expansion.ts`) is the shared consumer of
the corpus: one admission pipeline serves BOTH root kinds — explicit-interest
roots (a projected explicit edge whose canonical key is still explicit and not
hidden) and active-photo-reference roots (the current authorized
resolved/user-confirmed, depicted/user-selected references of the current
active analysis of a saved capture).

- **Cultural evidence and private relevance are separate decisions.** A
  candidate is admitted only when an approved path-grammar composition
  (`validateGraphPath`, exactly the six reviewed templates — never "some
  bounded graph walk") is currently justified AND the root's private relevance
  is current right now (stale roots are never rescued by still-valid
  evidence). Photo-root candidates additionally require a supported path to
  the photo reference itself; personal appeal only ranks admitted candidates,
  it never admits one.
- **Reason truth stays distinct.** The rendered reason is the template's own
  bounded meaning; the private support edge and the photo-reference metadata
  (with its uncertainty) are recorded separately on the frontier candidate and
  the pinned proof (`intent: 'personal' | 'photo'`).
- **Unqualified vision is fail-closed.** `visionQualified` is a constant
  `false`: active `VISUALLY_RESEMBLES` private links are counted as denied and
  never become roots, candidates or reasons, and a reference with relation
  `resembles` is a visual claim that never yields a photo root. Enabling the
  graph flags does not qualify vision.
- **Bounds.** At most two approved relation hops, 200 distinct assertions
  traversed, 40 candidates evaluated and 500 active frontier entries per
  account (due entries expire first, then lowest-priority entries are pruned —
  pruning candidate state never removes confirmed interests). Frontier
  candidates deduplicate per account and expire within seven days, shortened
  by evidence/rights expiry. Only admitted candidates enter the versioned
  ranking policy (`RANKING_POLICY_VERSION`), whose deterministic scores and
  tie handling make fixed-input replay reproduce the selection; rejected
  evidence can never be overridden and no unsupported filler completes a rail.

The expansion runs entirely on the shared corpus and the account's own
projected state: it makes no provider or model calls and records none.

## Review and rights

- **Reviewed only:** corpus admission requires a review record
  (`review.reviewed_by`/`reviewed_at`/`basis` in the manifest, stamped onto
  every evidence row). Machine-extracted proposals stay unreviewed
  (`reviewed_by IS NULL`) until a review admits them; a manifest without a
  review record does not even parse (`CorpusManifestSchema`, strict).
- **Permitted content only:** sources record the fields we may store and
  display (title, publisher, attribution, license, permitted use, expiry).
  Excerpts are bounded and rights-limited; no unrestricted third-party
  content is stored.
- **Fail-closed rights:** a provider whose recorded policy keeps responses
  transient is rejected before anything is written, and the whole manifest
  commits in one transaction — a rejected entry rolls back the accepted
  prefix instead of half-copying restricted material.
- **Not a holdout:** the 40-entry candidate photo inventory in the mission
  research directory is evaluation-planning material, not a qualified blind or
  holdout set, and never becomes corpus content or graph evidence. The strict
  manifest schema rejects photo-candidate entries (image URLs, HEAD checks,
  license-evidence blobs) outright.

### Pilot corpus sources (all verified 2026-10-28)

- **Art Institute of Chicago** (11 object records, `artic_open_access`): the
  museum's open-access policy releases object-page caption metadata under CC0
  and its API responses state that all non-description data is CC0 1.0. Every
  `structured_value` holds the exact non-description fields the API returned
  (title, artist, date, medium, style, classification, gallery, type, origin,
  public-domain flag); excerpts quote those fields verbatim. One entry also
  cites the API endpoint itself as a mirror of the same record family
  (`artic:<id>`).
- **Wikipedia** (`Bedroom in Arles`, CC BY-SA 4.0): the REST summary extract
  is quoted verbatim with attribution to Wikipedia contributors and the
  license link (page revision 1374251357).
- **Wikidata** identity mappings (CC0) for the four pilot creators: Vincent
  van Gogh (Q5582), Georges Seurat (Q34013), Paul Cézanne (Q35548), Auguste
  Rodin (Q30755), each confirmed by a label+description lookup recorded in the
  mapping provenance.

The pilot asserts only what the cited metadata supports: `CREATED_BY` for
named artists/designers (unattributed works carry no creator claim),
`USES_TECHNIQUE` from `medium_display`, `HAS_ATTRIBUTE` from `style_title`,
and `DOCUMENTED_ASSOCIATION (on_display_at)` from the museum's gallery record.
It deliberately contains no `ABOUT` or `AUDIENCE_AFFINITY` assertion (no
reviewed public-source evidence for those predicates in this pilot) and no
visual-resemblance claim of any kind.

## Qloo remains transient (VAL-EVID-005)

Qloo's response-retention and public-display rights are **not documented yet**
(see the TODOs in `docs/privacy.md` and `docs/capability-matrix.md`; operator
assurance does not establish storage/display rights). Until the terms are
recorded:

- Qloo responses stay transient under the existing adapter semantics: only
  ids, names and ranks needed for traceability are stored in
  `provider_queries` (`summarizeEntities` — no raw payloads, no imagery).
- The `provider_rights_policies` row for `qloo` records
  `response_retention = transient_only`, `public_display =
  owned_or_cleared_only`, `rights_documented = false` and the honest
  unresolved-rights note; `graphCorpusSummary().unresolvedRightsPolicies`
  surfaces it.
- Corpus admission rejects Qloo-derived material outright
  (`requireDurableStoragePolicy`), and displayed assets remain owned/cleared.

## Operating

```sh
DATABASE_URL=... pnpm db:migrate    # applies migration 300 among others
DATABASE_URL=... pnpm graph:corpus  # idempotent corpus admission + summary
```

`pnpm graph:corpus` prints the admission counts (all zero on idempotent
replay) and the corpus summary. Edited manifest content versions the affected
sources (new revision + new evidence rows) without ever rewriting a pinned
pair. Typed contracts live in
`packages/domain/src/interest-graph/{evidence,corpus-manifest,corpus}.ts`;
tests in `interest-graph/{evidence,corpus}.test.ts`.
