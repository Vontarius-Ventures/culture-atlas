# v4 full validation

2026-10-26. Local, uncommitted validation of compiler-2026-10-26-qloo-native-v4.
This is a test record, not a claim that every deployment or hardware path passes.
The iter12 manifest preserves its frozen runtime source. Subsequent improvement
work is separate from that run. No deployment or publication.

## Post-run correction and renewed allowance (2026-10-27)

The Qloo daily request gate reached its separate 1,500-request quota during
iter12. Several empty rails, including transfer photos, have
`error_code=budget_exhausted`, no HTTP response, and no retrieved candidate array.
These are blocked retrievals, not evidence that the stricter filters rejected
valid candidates. The 14/24 empty-photo observation remains accurate, but the
whole coverage regression cannot be attributed to filtering. At least one
modern-room pool did retrieve candidates that all failed the evidence gates,
so a genuine retrieval/precision issue also remains.

At 2026-10-27T12:56:02Z the stored Qloo day was still 2026-10-26 with count
1,500; the next admitted request naturally rolls the UTC day forward. No
counter was reset and no Qloo limit was raised. Future evaluations must check
daily headroom and report quota failures separately from genuine abstention.

The user raised the cumulative paid-model cap to **$25 total**, not $25 extra.
The ledger remained **$18.652927**, leaving **$6.347073** at that check. The
historical $20 figures below describe iter12's original allowance, not the
current approval. No paid calls were made by the status check.

## Matrix (validation stopped with release blockers)

| Scope | Result | Evidence / limits |
| --- | --- | --- |
| Backend, implementation phase | 2088 tests / 204 files passed | `/tmp/culture-atlas-relevance-v4-test-final.log` |
| Backend, concurrent full-validation run | 2087 passed, 1 failed; 2 files failed | `/tmp/culture-atlas-v4-all-backend.log`. Migration reconciliation p5 test exceeded 20 s; restore-drill teardown lacked permission to terminate a database process. Preserve these failures; rerun without competing test workloads. |
| Backend, serial rerun | All 2088 assertions passed; command failed in teardown | `/tmp/culture-atlas-v4-backend-serial.log`, `pnpm test --maxWorkers=1`. 203 files passed, 1 failed: restore-drill cleanup at `isolated-db.ts:75`, permission denied to terminate process. The migration timeout did not recur. The permission failure persists without the earlier test concurrency; it is not explained away as load. No privileges were changed. |
| Workspace typecheck and lint | Passed | `/tmp/culture-atlas-v4-all-typecheck.log`, `/tmp/culture-atlas-v4-all-lint.log`. Existing MusicView effect-dependency warning. |
| Workspace build, same v4 runtime source | Passed | `/tmp/culture-atlas-relevance-v4-build.log`. Existing dynamic-filesystem tracing warnings. Do not rebuild over the live production server. |
| Mocked-API browser matrix | 478 passed, 23 skipped, 2 failed | 503 collected tests, 3 workers, `/tmp/culture-atlas-v4-browser-final.log`. Desktop/mobile microphone tests stayed in “Asking for microphone…” past 10 s. A focused, one-worker recheck against the production build passed all 20 camera tests (`/tmp/culture-atlas-v4-camera-recheck.log`), not a green rerun of the full matrix. An earlier incorrect forwarding command collected no tests; `/tmp/culture-atlas-v4-all-browser.log` preserves it. |
| Android core + store-debug unit tests | 118 passed, no failures/skips | 102 core, 16 app. Store-debug APK assembled; `/tmp/culture-atlas-v4-all-android.log`. Homebrew JDK 17; SDK XML warning. No physical-device or experimental Meta SDK qualification. |
| iOS iPhone 17 / iOS 27 simulator | 116 passed, 2 skipped, 0 failed | Xcode RunAllTests, CultureAtlas scheme in this worktree. CameraKeepTests and FeedFloatTests both skipped because no signed-in account with completed onboarding existed. Neither skipped behavior was exercised; no physical camera proof. |
| Real-stack browser v1/v2 journeys | 6 passed | Isolated keyless database, production Next build, job/media workers, loopback S3/SES stand-ins. No live-provider calls. `/tmp/culture-atlas-v4-keyless-journeys.log`. |
| Real-stack amendment 2.2 journeys | 6 passed, 3 failed | Separate database, fake upstream Qloo and in-process model transport, real gateway/worker/ledger. `/tmp/culture-atlas-v4-fixtures-journeys.log`. Desktop/mobile could not find the legacy “Discoveries from your photo” list after analysis; 320 px anonymous example overflowed by 31 px. Both outage/recovery and existing-account tests passed at all three widths. Fictional fixture results, not live relevance evidence. |
| Fidelity browser captures | Blocked; stopped after 2 failures, remaining tests unfinished | `/tmp/culture-atlas-v4-fidelity.log`. Seeded sample-origin discovery-job rows no longer enter the feed's owner-related Qloo/replay branch. Discover displays the default examples instead of the eight expected fixture titles; the Save sheet then times out. Do not weaken production provenance policy or relabel fixture origins to make this pass. Screenshot generation alone is not a fresh visual review or pixel-match proof. |
| Live same-photo evaluation iter12 | 24/24 terminal artifacts; coverage regressed, acceptance not established | All 24 style sections ready, but 11 captures partial and 14 photos have no cards. Cumulative spend/reservation ledger $16.803375 → $18.652927, an increase of $1.849552; $1.347073 remains under the cumulative $20 cap. `/tmp/culture-atlas-v4-live-run.log`. Runtime/source-photo integrity checks pass; new non-Markdown files are generated test screenshots, not runtime source changes. |

## Live evaluation outcome

Artifacts in the evaluation scratch directory: `eval-qloo-native-v4.json`,
`iter12-run-result.json`, `iter12-operational-metrics.json`, and
`iter12-final-freeze-check.json`. The original 16+8 photo denominator is intact.
The runner counted 123 non-replay Qloo query records, including setup; the
per-photo traces contain 114. These are not a separately observed HTTP count.

| Metric | Prior iter11 tuning | v4 tuning | Prior iter11 transfer | v4 transfer |
| --- | ---: | ---: | ---: | ---: |
| Photos | 16 | 16 | 8 | 8 |
| Published cards | 155 | 89 | 40 | 2 |
| Photos with no cards | 0 | 7 | 2 | 7 |
| Photos with More like this | 12 | 7 | 6 | 0 |
| Photos with cross-domain cards | 13 | 8 | 1 | 1 |
| Partial captures | 1 | 5 | 0 | 6 |
| First readable within 5 seconds | 14 | 11 | 8 | 8 |
| Complete within 30 seconds | 15 | 15 | 6 | 8 |
| Median completion (seconds) | 21.425 | 22.084 | 19.919 | 17.584 |

No new calibrated relevance or style-quality score was produced. “Style ready”
is an operational state, not the 7.5/10 quality gate. The relevance ≥7 target
remains unqualified. Nineteen of 24 photos meet the 5-second first-readable
target; 23/24 meet 30-second completion. Concurrent workloads, stochastic
readings, and changing from a development to a production server confound
latency and causal comparisons. Qloo quota exhaustion additionally confounds
coverage comparisons, as corrected above.

The observed coverage is substantially worse than iter11: 91 cards versus 195,
and 14 empty photos versus 2, with retrieval blocked by quota for several photos.
Removing unsupported suggestions is not an
end-to-end usefulness improvement. Subject-specific retrieval and real positive
evidence remain necessary; do not restore a provenance waiver, invent evidence,
or lower admission thresholds merely to fill the rails. The current v4 is not
qualified for release.

All ten owned live/fixture service roots and their descendants were stopped.
Their loopback ports are closed. Isolated databases and test artifacts were
retained; no cleanup of unrelated databases or connections was attempted.
The serial backend rerun finished with a failing cleanup hook, as recorded above.
No managed background commands remain.

## Remaining release blockers and next work

1. Recover useful non-fashion retrieval coverage using genuine subject/form/
   material/style evidence. Keep the compound and provenance fixes. Validate
   positive controls as well as rejection cases before another paid run.
2. Diagnose the 320 px overflow and the amendment-2.2 result-list failure.
   Do not assume the latter is only a stale selector without establishing
   whether useful cards exist under the fixture's unqualified style role.
3. Repair the fidelity seed's representation of example data without forging
   Qloo/replay origins or weakening the production evidence gate, then rerun
   its full 30-test matrix. Capture-platform v2 fidelity phases and opt-in v22
   live-Qloo fidelity were not run in this pass.
4. Resolve the isolated restore database cleanup permission problem without
   elevating privileges or terminating unrelated sessions. Preserve the original
   failing full-suite runs.
5. Recheck the full mocked browser matrix after diagnosing microphone startup
   under concurrency. A focused serial pass does not supersede its two failures.
6. Exercise signed-in native feed/camera flows and required physical-device/
   provider qualifications. No claim of “everything passes” is warranted.

At the close of this validation, no further paid inference or AI judging was
dispatched after iter12. The then-
remaining $1.347073 is below the observed $1.849552 for this full 24-photo run,
so another equivalent full paid run cannot be promised within the existing cap.

## Setup incident

One setup command accidentally omitted `ENV_FILES` when invoking the launcher
and ran `pnpm db:migrate` against the default local `culture_atlas` database.
It applied `180_music_mode_discovery.sql`, `190_style_reading.sql`, and
`200_client_recognition.sql` (30 prior migrations already applied).
The mistake was reported immediately. No automatic rollback, data cleanup,
privilege escalation, or termination of unrelated connections was attempted.
The paid evaluation uses `ca_r3_new` and was not the target of this command.
All subsequent real-stack setup commands explicitly select their newly created
isolated databases (`ca_v4_keyless_1793058709862` and
`ca_v4_fixtures_1793058709862`).

## Coverage limits

- Loopback AWS stand-ins do not verify signatures or real AWS delivery.
- Fake-provider browser results do not qualify real models or Qloo relevance.
- Simulator/unit tests do not qualify physical cameras, glasses, push delivery,
  store-release signing, real-device background behavior, or native video playback.
- New runtime success cannot retroactively turn historical subjective AI ratings
  into calibrated human judgments. Human-anchored relevance remains unqualified.
- Existing and failed runs remain part of the record; no denominator changes.
