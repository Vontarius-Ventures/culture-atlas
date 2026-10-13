# Qloo contract probes

The build spec requires contract probes with the hackathon key before dependent features are trusted: resolve one brand, look up one relevant tag, request artist/film/brand/place results, inspect explainability, verify rate limits and confirm permitted response storage. Until a key exists, every Qloo capability reports `unavailable / not_configured`, and the app shows partial states ("Related discoveries are taking longer") instead of invented results.

## Run

```sh
# .env (never commit): QLOO_API_KEY=...   optional QLOO_API_URL (default https://hackathon.api.qloo.com)
pnpm qloo:probe                                    # probes + writes docs/capability-matrix.md
pnpm qloo:probe --brand "Carhartt" --tag workwear  # choose the probe inputs
pnpm qloo:probe --dry-run                          # print only
pnpm qloo:probe --json                             # machine-readable results
```

Without `QLOO_API_KEY` the script exits with code 2 and changes nothing. With a key, it exits with code 1 when a required capability (search, tags, insights, explainability) is unavailable. The key is never printed or written.

## What it checks

`scripts/qloo-probe.ts` uses raw HTTP (`scripts/qloo-probe-lib.ts`), so it tests the documented API itself rather than the adapter's interpretation of it. Requests are paced 250 ms apart.

| Probe | Request | Passes when |
| --- | --- | --- |
| `search.brand` | `GET /search?query=<brand>&types=urn:entity:brand` | At least one entity with an `entity_id` |
| `tags.lookup` | `GET /v2/tags?filter.query=<tag>` | At least one tag id |
| `insights.artist` / `movie` / `brand` / `place` | `GET /v2/insights?filter.type=urn:entity:<type>&signal.interests.entities=<brand id>&feature.explainability=true` | Results for that category |
| `insights.explainability` | Derived from the four insight probes | At least one result names its contributing inputs (`query.explainability`) |
| `insights.tag_signal` | `GET /v2/insights?filter.type=urn:entity:brand&signal.interests.tags=<tag id>` | Tag signals return results (style anchors use tags) |
| `trending` | `GET /v2/trending` with `signal.interests.entities`, `filter.type`, `filter.start_date`, `filter.end_date` | Optional; inspector only |
| `trends.entity` | `GET /trends/entity?entity_id=&start_date=&end_date=` | Optional; inspector only |
| `auth.invalid_key` | `GET /search` with a wrong key | 401/403, confirming the `X-Api-Key` scheme |

Rate-limit headers (`x-ratelimit-*`, `retry-after`) are recorded from every response, along with the number of 429s.

Status per probe: **available** (worked), **degraded** (worked but empty, or rate limited), **unavailable** (denied, failed or unreachable), **skipped** (depended on an earlier probe).

## What it writes

`docs/capability-matrix.md` gets:

- the Status and Result columns of each `qloo.*` row, e.g. `available (probed 2026-10-20)`;
- a generated "Qloo probe results" section between `<!-- qloo-probe:begin -->` and `<!-- qloo-probe:end -->`.

Re-running replaces both, so the file always shows the latest run. Review the diff before committing.

## What it cannot answer (fill in by hand)

- **Storage:** may responses be stored (`provider_queries.results`), and for how long? Until confirmed, the app keeps only ids, names and ranks needed for traceability.
- **Display:** may provider images and metadata be shown publicly? Until confirmed, use licensed or own imagery, or the text treatment.
- **Categories:** which categories the hackathon key covers, if the probes show gaps.

Record the answers in the access table of `docs/capability-matrix.md` and in [privacy.md](privacy.md).

## Related

- The adapter-level probe from the providers stream, `pnpm tsx scripts/probe-qloo.ts [--record]`, exercises `packages/providers/src/qloo/client.ts`. With `--record` it saves sanitized real responses for labeled "Example result" replay. Only use `--record` after storage rights are confirmed.
- Contract tests run against shape-only fixtures in `fixtures/qloo/contract/`, which are never shown to users.
