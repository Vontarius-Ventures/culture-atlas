# Private offline Qloo audit

No provider calls, credentials, installs, or import-time writes. From the repository:

```sh
./node_modules/.bin/tsx scripts/style/qloo-native-audit.ts \
  /absolute/private/capture-directory /another/private/capture-directory \
  --out /tmp/private-qloo-audit.json
```

Directories contain capture JSONs with `trace.provider_queries`; scanning is
nonrecursive, sorted, and deduplicated by canonical file path. Unknown roots fail
with safe error codes. Output is compact JSON; `--out` exclusively creates a
mode-0600 file, never overwrites. Omit it for stdout. Keep reports private and
outside Git. `--include-ids` adds validated catalogue UUIDs, tag URNs, and
per-capture entity projections; names, paths, search text, locations, raw request
blobs, descriptions, cookies, emails, URLs, and raw third-party bodies are never
copied. Without IDs, local `c0001`/`q1` references still support query accounting.
Capture references follow canonical path ordering; use the same input set when
creating and applying judgments.

`auditCaptures(iterableOrAsyncIterable, options)` and
`auditDirectories(directories, options)` return reports without writing files.
File reads are capped at 8 MiB, total bytes at 128 MiB, files at 256, queries at
512/capture, result rows at 10,000/query and 20,000/capture, 100,000/run.
Limit excess fails closed, not a misleading truncated denominator.

## Interpretation

- Only top-level `entity_id` UUID rows count as candidates. Tag IDs, tag parent
  types, request seeds, and nested explainability contributions are separate.
- Insight types are request-inferred unless a row explicitly records types.
  Explicit operator keys are retained with their actual values; absent operators
  are `not_recorded`, not assumed union/intersection.
- Missing historical results or unknown envelopes are unknown/null, never zero.
  `observed*` values are only lower bounds when `poolKnowledge` is incomplete.
  Tag-only requests do not demonstrate that their parent entity domains were queried.
- Stored nonhidden recommendation rows are authoritative; catalogue IDs come
  from `external_ids.qloo`/`qloo_id`, not public item IDs. Multirail rows count as
  multiple publications but one unique entity. Public rails and duplicate legacy
  recommendations are not added to stored rows. Public/local row IDs are joined
  for diagnostics. Without stored rows, explicit catalogue-ID public cards are
  deduplicated; unresolvable public cards make publication unknown.
- Missing fields are unknown, not evidence that the upstream provider lacks
  them. Optional `qloo_candidate_audit_v1` rows with `metadataAvailability`
  booleans are accepted; old arrays need no migration. An available image URL
  never verifies logo/product/poster/portrait role or visual similarity. Roles
  remain unknown; contradictory explicit availability observations are reported.
- A nonpublished candidate is **unjudged**, not irrelevant or an oracle positive.
  Publication absence is not absence from Qloo's catalogue. No catalogue recall
  or current implementation relevance claim follows from recorded pools.

## Optional evidence judgments

Pass `--judgments /private/manual-judgments.json`. Example **synthetic** schema:

```json
{
  "schema_version": "qloo_manual_judgments_v1",
  "pool_complete": true,
  "judgments": [
    {
      "capture": "c0001",
      "entity_id": "00000000-0000-4000-8000-000000000001",
      "grade": 2,
      "candidate_evidence_verified": true,
      "relation": "brand_exploration"
    }
  ]
}
```

Grade is 0..3 or `"unverifiable"`. Relations: `brand_exploration`,
`topic_connection`, `named_work`, `taste_affinity`, `place_exploration`,
`unsupported`. Labels are supplied by humans after actual candidate-evidence
inspection; the auditor does not generate or infer them.

Evaluation defaults to **not_evaluated**. Even `pool_complete: true` is insufficient
unless every capture/entity in every complete recorded pool has exactly one
label, with no extras, verified evidence, and no unverifiable grades or missing
publication IDs. Partial labels report `scope: partial` and no metrics.

Useful means grade >=2, verified evidence, and a supported relation. Select the
first four unique published entities per capture ordered by numeric stored
rank, then stored order across rails. This is a deterministic offline selection,
not a claim about UI viewport ordering. Pooled useful coverage@4 =
useful selected capture/entity pairs / useful complete-pool pairs. Yield@4 =
useful selected pairs / (4 × capture count), penalizing unfilled slots. With
zero useful pool candidates coverage is null, not invented recall. These are
conditional manual-label metrics on recorded pools, never a catalogue oracle.
