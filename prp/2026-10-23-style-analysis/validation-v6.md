# Four-agent integration validation

2026-10-27. Local work only. No commit, push, production deployment,
privilege changes or termination of unrelated database sessions.

## Verified

- Final backend: 2,141 tests / 209 files passed, including teardown and
  the latest seed regression.
- Typecheck passed. Lint has zero errors and the existing MusicView
  `finishRecording` dependency warning.
- Integrated production build passed. The existing dynamic-filesystem
  tracing warnings remain.
- Mocked browser matrix: 492 passed, 23 skipped, zero failures.
  The previously failing microphone checks are included.
- Real keyless v1/v2 journeys: six passed over loopback HTTPS, using
  production session-cookie behavior and isolated PostgreSQL/storage/mail.
- Fidelity: all 30 tests passed over production HTTPS. Six seed
  regressions passed, including production-shaped sign-in behavior.
- Real v22: nine passed, including useful documentary cards, ready-toast
  navigation, interests editing, outage/recovery and 320 px layout.
- iOS: 120 passed, two live-session tests skipped. Four new simulator
  fixture tests exercise feed motion, camera fallback and auth/onboarding
  gates. This does not prove real signed-in upload/commit.
- Android: the prior 118-test result remains valid historical evidence;
  no Android production code changed in this team pass. Not rerun here.

## Integration corrections

The real-stack provider regression now owns an isolated database and runs
Worker against that database. Its former shared-ledger reservations caused
seven budget tests to fail; the combined suite now passes without changing
production budgets or cleanup privileges.

Production sets Secure cookies. Plain-HTTP browser/API harness checks
disagreed about their transport eligibility. Tests now use loopback HTTPS,
an ephemeral private certificate, and an exact certificate public-key pin.
No production cookie/security setting was weakened.

Fidelity sign-in now explicitly declines claiming an empty anonymous
session. Claiming otherwise legitimately advances taste revision and
invalidates the seeded snapshot. Curated cards remain labeled examples;
no sample origin or production admission gate was promoted.

The real v22 harness also needed the current `Edit your interests` label,
an exact accessible card-link locator rather than matching its duplicate
text-art title, and the existing approved Qloo heading/route messages.
Unknown provider copy still fails; intentional attribution was not removed.
Missing actions now fail in 30 seconds instead of consuming the entire
five-minute journey timeout. Old failed/cancelled artifacts are preserved.

## Frozen v6 live run (iter14)

All 24 original photos were retained: 16 tuning and eight reused transfer,
not a new holdout. Runtime source/image drift was zero at measurement,
before this final documentation update. Frozen source hash:
`b343937d33c6fd46bcf7849e6fab5d766c4c73d684ed2638e8e3f1f2caaeb982`.

| Metric | Tuning | Transfer |
| --- | ---: | ---: |
| Photos | 16 | 8 |
| Cards | 117 | 26 |
| Empty photos | 1 | 3 |
| More-like-this coverage | 10 | 2 |
| Cross-domain coverage | 15 | 5 |
| Content-proof cards | 24 | 10 |
| First readable within 5 seconds | 15 | 8 |
| Complete within 30 seconds | 16 | 8 |
| Median complete time | 20.672 s | 18.318 s |

- 23 ready, one partial. 143 cards and four empty photos, versus iter13's
  120 cards and nine empties. These are descriptive, stochastic comparisons,
  not proof of relevance or a causal effect.
- All 24 completed within 30 seconds, but espresso's first-readable time
  was 6.115 seconds, missing the unchanged five-second target.
- The people/cafe capture retained partial status: all four Wikipedia
  source lookups returned HTTP 429; its style and documentary rail worked.
  No Qloo provider, budget or quota error was recorded.
- Wood-panelled bedroom retained an enrichment timeout, with a usable
  style/documentary result and terminal ready status. No favorable retry.
- The ceramic head remains empty: `G-STYLE-PERSON` rejected its new style
  payload, leaving no styled subject. The form-eligibility fix cannot run
  without an admitted style subject. Do not waive that guard or claim this
  transfer case resolved.
- The other empties are the ceramics display, canopy bedroom and mug.
- Counted ledger rose $1.796852, from $20.456779 to **$22.253631**.
  **$2.746369 remains** under the cumulative $25 cap. This is conservative
  reservation accounting, not reconciled provider billing.
- Qloo admitted 127 requests including setup; daily total 262/1,500,
  leaving 1,238. No quota, reservation, circuit or pause was reset.
- Every owned validation/evaluation runtime was stopped after its checks.

## Blinded quality gate: failed

Both independent judges completed 48 unique paired rows and viewed all 24
source images. Exact card counts and score/count bounds validated. Empty,
partial and null-style outputs stayed in the denominators.

| Candidate mean | Tuning | Transfer | Target |
| --- | ---: | ---: | ---: |
| Style | 8.65625 | 7.21875 | 7.5 |
| Relevance | 3.78125 | 1.875 | 7 |

Only tuning style passes. Transfer style and both relevance gates fail.
The paired comparison uses the original frozen `iter8method` /
`iter8transfer` baseline, not iter13. Freshly re-scored baseline relevance
was 3.75 / 1.5625: descriptive gains of 0.03125 / 0.3125 do not establish
the intended improvement. Historical judge-round scores are not a
calibrated scale.

These are two AI reviewers, not calibrated human ground truth. They did
not view candidate images, reasons or proof metadata. Familiar candidate
names were judged from existing knowledge, with uncertainty retained.
Subject-related documentaries and admitted evidence are not verified
visual matches. More cards and fewer empties do not qualify relevance.

Final ledger verification found zero active reservations and zero
unfinished jobs, with 1,523 unknown-cost attempts retained and the counted
total unchanged at $22.253631. No further paid call or favorable retry is
planned.

## Remaining qualification work

Recommendation quality is **not resolved**. The ceramic-head style guard,
sparse ceramic/canopy/mug coverage, generic cross-domain relevance and
candidate-image verification need separate controlled work, not weaker
admission rules or a lower target. Wikipedia's rate limit and the retained
enrichment timeout also prevent claiming a clean provider-health run.

Physical capture/commit, live native auth integration, glasses, release
signing, push, cloud storage and store distribution remain unqualified.
More admitted cards alone are not a relevance or visual-match pass.

## Evidence

- Backend/static: `/tmp/culture-atlas-team-backend-verified.log`,
  `/tmp/culture-atlas-team-typecheck-verified.log`,
  `/tmp/culture-atlas-team-lint-verified.log`.
- Mocked browsers: `/tmp/culture-atlas-team-browser-full.log`.
- Real journeys: `/tmp/culture-atlas-team-real-keyless-tls.log`,
  `/tmp/culture-atlas-team-real-v22-interests.log`.
- Fidelity: `/tmp/culture-atlas-team-fidelity-v2.log`.
- Frozen artifacts are under the retained private `r3run` scratch root:
  `eval-qloo-native-v6.json`, `iter14-run-result.json`,
  `iter14-operational-metrics.json`, both `judge-qloo-native-v6-*.json`,
  `iter14-qloo-native-judged.json`, and `iter14-final-ledger.json`.
