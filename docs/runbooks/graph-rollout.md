# Runbook: PR 8 graph rollout, rollback and spend ceilings

Applies to the interest graph (PR 8): projection, graph-assisted discovery,
paid relation research and the framework shadow pass. All four flags default
OFF; nothing below is live until the operator opts in
([graph-real-stack.md](../graph-real-stack.md), [graph-corpus.md](../graph-corpus.md)).

## Invariants

- The four flags (`interest_graph_projection_enabled`,
  `interest_graph_discovery_enabled`, `interest_graph_research_enabled`,
  `interest_graph_framework_shadow_enabled`) default off, evaluate identically
  on the client surface and the server gates, and are all killable at any
  moment — globally or for one account — through `pnpm ops:kill`
  (VAL-OPS-001).
- A rollback is a FILTER, never a deletion: graph runs, cards, proofs and
  frontier rows stay in place, so re-enabling serves them again without
  rebuilding anything. Saves, taste, suppression markers and pause state are
  untouched.
- A kill stops dispatch AND publication, including work already in flight:
  the expansion pass re-checks the flag inside its publication transaction,
  and relation research re-runs its full dispatch gate inside the storage
  fence. A pass that is refused mid-flight rolls back whole; the paid research
  call that already happened stays accounted in the ledger, and nothing is
  published.
- Safety work never stops for a graph rollback: projection and
  reconciliation continue, suppression writes persist, source retraction
  still withdraws proofs (a retracted card is never resurrected by lifting a
  kill), and account deletion is still accepted, fenced and purged.
- Projection alone or the framework shadow alone never changes a live feed,
  ranking or reason, and never buys research.

## Enabling

1. Projection first: `INTEREST_GRAPH_PROJECTION_ENABLED=true` (requires
   nothing paid). Saves start projecting into the private graph.
2. Discovery: `INTEREST_GRAPH_DISCOVERY_ENABLED=true` (requires projection).
   Saved support refreshes through bounded expansion passes; cards publish
   with pinned proofs.
3. Research (paid, default off even with the opt-in): set
   `INTEREST_GRAPH_RESEARCH_ENABLED=true` AND the full durable budget —
   `MODEL_DAILY_SPEND_LIMIT_USD`, `MODEL_ACCOUNT_DAILY_SPEND_LIMIT_USD`,
   `MODEL_MAX_UNKNOWN_SPEND_USD` and `MODEL_TOTAL_SPEND_LIMIT_USD` — plus a
   qualified `research_text` role. Research refuses with
   `limits_not_configured` until the ALL-TIME total ceiling exists
   (VAL-OPS-002).
4. Watch the rollout: `pnpm ops:graph-metrics` (see Signals).

## Rolling back

Stop everything graph (global, applies at once):

```sh
pnpm ops:kill kill interest_graph_projection_enabled --reason "<incident>: rollback"
pnpm ops:kill kill interest_graph_discovery_enabled --reason "<incident>: rollback"
pnpm ops:kill kill interest_graph_research_enabled --reason "<incident>: rollback"
pnpm ops:kill kill interest_graph_framework_shadow_enabled --reason "<incident>: rollback"
```

One account only (add `--account <uuid>`):

```sh
pnpm ops:kill kill interest_graph_discovery_enabled --reason "<incident>: one account" --account <uuid>
pnpm ops:kill kill interest_graph_research_enabled --reason "<incident>: one account" --account <uuid>
```

What to expect within seconds:

- Discovery/expansion: no new dispatch; in-flight passes reject with
  `disabled` (trace `graph_expansion_disabled`) and commit nothing; the feed
  filters the account's graph cards out while every row stays in place.
- Research: no new dispatch; in-flight jobs fail non-retryably with rule
  `disabled` (trace `graph_research_disabled`); the paid call already made
  stays in the ledger.
- Projection/reconciliation, suppression, retraction/invalidation and
  deletion cleanup keep working (only the discovery/research gates closed).

Re-enable by lifting the same kills; serving resumes from the retained rows:

```sh
pnpm ops:kill lift interest_graph_discovery_enabled
```

Verify after lifting: `GraphProjectionLagSeconds` returns to ~0, the account's
feed serves its graph cards again, and a card whose evidence was retracted
during the rollback stays absent (known revocations are never resurrected).

## Spend ceilings (VAL-OPS-002)

- The durable ledger (`inference_attempts`) enforces daily, account-daily and
  unknown-outcome caps PLUS the all-time total ceiling
  (`MODEL_TOTAL_SPEND_LIMIT_USD`). The total counts every settled cost and
  every outstanding reservation from EVERY day: a restart, a midnight
  rollover or a parallel admission can never reopen an exhausted allowance.
  The mission's shared allowance is $100 (the compose default).
- Reconcile before any further paid call:

  ```sh
  pnpm ops:spend
  ```

  The line reports reserved/unknown/billed micros, the charged total, the
  remaining all-time allowance and per-provider request counts, with
  `ceilingStatus` `within` / `exceeded` / `not_configured`. Exit code 1 on
  `exceeded` or `not_configured` — that is the honest signal, not a pass.
  Unknown-outcome attempts stay charged at their reservation until billing
  reconciliation; provider request counts are activity, never billing proof.
- Exhaustion pauses/fails paid admission honestly (`budget_exhausted`); it
  never falls back to an unreserved paid path, and the caps are never raised
  to "make it work" (see `docs/runbooks/credit-exhaustion.md`).

## Signals (`pnpm ops:graph-metrics`)

One EMF line per snapshot (event `graph_ops_snapshot`, namespace from
`OPS_METRICS_NAMESPACE`, default `CultureAtlas`), plus up to three sanitized
run-outcome samples (`graph_run_outcome`). Counts and lags only — no titles,
no interest text, no photos.

| Metric | Meaning | Act when |
| --- | --- | --- |
| `GraphProjectionLagSeconds` | oldest pending projection intent | grows or exceeds the expansion cadence |
| `GraphOutboxPending` | projection backlog | grows without draining |
| `GraphRunsFailedLastHour` | failed graph runs | any sustained value |
| `GraphRunLagSeconds` | oldest queued/running run | worker stalled or dead |
| `GraphExpansionRejectionsLastHour` | fence rejections + rollback-disabled stops | a spike means authority churn or a kill |
| `GraphBudgetWindowsStuck` | active work budgets past their anchored deadline | crashed workers: windows never re-anchor |
| `ModelReservedMicros` / `ModelSettledMicros` / `ModelUnknownAttempts` | durable ledger state | compare against the ceilings; see `pnpm ops:spend` |
| `AccountDeletionsOwed` / `AccountPurgeLagSeconds` | deletions whose durable cleanup is still owed | purge lag grows while cleanup is failing |

## Measured latency (VAL-OPS-003)

The targets are measured, not assumed
(`packages/domain/src/ops/graph-latency.test.ts` runs the real paths over
isolated PostgreSQL with no provider or network calls, prints every p95 with
sample counts plus workload/hardware context, and fails with the measured
numbers when a target is unmet). Last measurement on this machine
(darwin/arm64, 12 cores, 24 GB; 40 samples per metric after 3 warmups;
workload: 17 saved items, 8 same-creator candidates, 3 published graph cards,
24-item feed page):

| Path | Target | Measured p95 | Result |
| --- | --- | --- | --- |
| Projection pass | < 5000 ms | 16.3 ms | met |
| Why-this summary/proof (`getRecommendationConnection`) | < 500 ms ex-network | 2.0 ms | met |
| Graph-local feed overhead (graph-on page minus kill-filtered page) | < 250 ms | 0.2 ms | met |

Re-measure any time with:

```sh
pnpm exec vitest run --maxWorkers=1 --no-file-parallelism packages/domain/src/ops/graph-latency.test.ts
```

The numbers are machine- and load-dependent by nature; the test discloses the
workload and hardware alongside them, so compare like with like.
