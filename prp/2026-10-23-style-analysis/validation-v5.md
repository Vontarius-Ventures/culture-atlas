# v5 validation

2026-10-27. Local and uncommitted. No deployment or publication.

## Before the paid evaluation

- Focused evidence tests: 61 passed across four files.
- A broader first run caught a legacy-topic routing regression. Fixed by
  preferring documentary retrieval only when actual topic and Documentary
  tags resolve. A routing recheck passed 29 tests across three files.
- Final full run: **2,101 assertions passed**, 204 files passed, one suite
  failed in teardown. The command exited 1 because migration reconciliation
  cleanup at `migration-reconcile.test.ts:81` lacked permission to terminate
  a database process during DROP DATABASE. No privileges changed or unrelated
  connections terminated. `/tmp/culture-atlas-v5-backend-final.log`.
- Final workspace typecheck, lint and production build passed.
  `/tmp/culture-atlas-v5-{typecheck,lint,build}-final.log`.
  Existing MusicView effect-dependency and dynamic-filesystem build warnings.
- Style browser regression: **42 passed** across 1440/390/360 px, one worker,
  mocked API. `/tmp/culture-atlas-v5-style-browser.log`. This does not
  supersede the unresolved full browser/native/real-stack blockers in v4.
- Offline replay of recorded Qloo documentary responses, without provider
  calls: 7/20 sculpture candidates and 3/13 coffee candidates earned bounded
  content evidence. Rivers and Tides and A Film About Coffee survived;
  Ice Cold: Murder, Coffee and Jessica Wongso did not. These are admission
  controls, not usefulness ratings or a new relevance score.

## Live evaluation contract

Separate iter13 aliases and `eval-qloo-native-v5.json`; preserve iter12.
Same 16 tuning + 8 reused transfer photos, not a new holdout.
The cumulative $25 cap includes $18.652927 of historical unknown-cost
reservations, leaving $6.347073. All old reservations remain counted.
The Qloo daily limit remains 1,500. Per-job allowance remains the prior
configured 18, not the default 12; preflight headroom uses the actual setting.
No paid judging is implied by operational completion.

## Completed iter13 live evaluation

All 24 photos produced terminal, ready captures, with no partial captures,
recorded Qloo errors or quota failures. Source and source-image drift checks
were empty at the end of the frozen run, before subsequent test-cleanup edits.
No favorable retries or paid judging were performed.

| Metric | Tuning | Reused transfer |
| --- | ---: | ---: |
| Photos | 16 | 8 |
| Cards | 109 | 11 |
| Empty photos | 3 | 6 |
| More like this coverage | 9 | 2 |
| Cross-domain coverage | 11 | 2 |
| Cards carrying documentary content proof | 12 | 1 |
| First readable within 5 seconds | 16 | 8 |
| Complete within 30 seconds | 15 | 8 |
| Median completion, seconds | 19.774 | 13.735 |

The cumulative reservation ledger increased **$1.803852**, from $18.652927 to
**$20.456779**, leaving **$4.543221** under the approved $25 cap. These are
unknown-cost reservations, not reconciled billing. Qloo admitted 135 requests
including setup, leaving 1,365 of the unchanged 1,500 daily limit.
Per-photo query records total 127; setup accounts for the other eight.

The 120 cards and nine empty photos compare with iter12's 91 cards and 14
empty photos, but iter12 quota exhaustion prevents attributing that recovery
to v5 logic. Coverage still trails iter11's 195 cards and two empty photos.
Ceramic-head and marble-statue transfer photos remain empty despite the
offline sculpture positive control. No new relevance score establishes the
unchanged acceptance threshold. Operational completion is not a quality pass.

Artifacts: `eval-qloo-native-v5.json`, `iter13-run-result.json`,
`iter13-operational-metrics.json`; source hash
`cc0ee3c2be33c302be914819e7a25353e93e13c8db8059133f405680afc2c3ba`.
Live log: `/tmp/culture-atlas-v5-live-run.log`.
The owned web and worker process trees were stopped; port 4030 is closed.
Evaluation databases, manifests and traces were retained.

## Subsequent test-cleanup repair

After the frozen run and integrity check, replaced forced database drops
in the isolated test helper, migration reconciliation and Vitest global
teardown with normal drops. Administrative connections close in `finally`;
isolated-pool closure is awaited once and can be reused on a cleanup retry.
Migration cleanup attempts all tracked databases/directories and reports
errors rather than hiding them. No privileges were raised and no unrelated
sessions were terminated.

Focused cleanup/migration/restore tests: **9 passed**. The new regression
proves cleanup refuses to kill a connected client and succeeds after the
client closes. `/tmp/culture-atlas-cleanup-focused.log`.
Final post-repair validation: **2,103 tests across 206 files passed**, including
teardown; command exited 0. Workspace typecheck passed. Lint passed with zero
errors and the existing MusicView dependency warning.
Logs: `/tmp/culture-atlas-cleanup-backend-final.log`,
`/tmp/culture-atlas-cleanup-typecheck.log`,
`/tmp/culture-atlas-cleanup-lint.log`.
Other v4 browser/native/real-stack and recommendation-quality blockers remain
open; this repair does not qualify them.
