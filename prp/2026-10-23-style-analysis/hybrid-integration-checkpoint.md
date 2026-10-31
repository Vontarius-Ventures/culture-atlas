# Hybrid integration checkpoint

2026-10-27. Implementation passes the automated checks below. Visual comparison
is disabled and not production-qualified; recommendation-quality improvement
has not been established.

## Combined checks

- Final `TEST_DATABASE_URL=postgres://culture_atlas:culture_atlas@localhost:5432/culture_atlas_test pnpm test --maxWorkers=4`:
  **2337 passed, 219 files**,101.19s, exit0 including isolated-database teardown.
  `/tmp/culture-atlas-hybrid-final-tests.log`
  Includes the additional30 negative/schema diagnostic cases and four final
  legacy-refresh/lifecycle cases. The earlier run below is retained history.
- `pnpm test --maxWorkers=4`: **2303 passed, 218 files**, including teardown.
  `/tmp/culture-atlas-hybrid-backend-bounded.log`
- Full typecheck passed: `/tmp/culture-atlas-hybrid-typecheck.log`
- Full lint passed with existing MusicView finishRecording warning:
  `/tmp/culture-atlas-hybrid-lint.log`
- Build passed, existing dynamic-filesystem tracing warnings:
  `/tmp/culture-atlas-hybrid-build.log`
- First default-concurrency run: four failures (Compose settings, source binding,
  cleanup timeout). Fixed the two missing Compose/environment fields, regenerated
  the actual source binding (old photo qualifications become stale, no scores or
  thresholds changed), gave the intentional connected-DROP refusal test a45s
  bound. Focused22 passed. A second full run concurrent with Next build had a
  fresh-migration20s timeout; all cases subsequently passed with four workers.
  Original failed logs retained.

## Retained browser failures and follow-up

Full mocked run: **538 passed, 23 skipped, 6 failed**.
`/tmp/culture-atlas-hybrid-browser-full.log`
Artifacts: private `hybrid/mock-browser-results-v1/`.

1. `e2e/style.spec.ts:207` stage-2 veto/retraction does not disappear within10s,
   desktop/mobile/minimum. This is a guard freshness regression to fix, not
   permission to weaken assertions.
2. `e2e/v22/hybrid-recommendations.spec.ts:26`, mobile project320px: new small
   text contrast is3.57 (#808379 on #f8f6f1) instead of4.5; fix component color.
3. `e2e/item-settings.spec.ts:123`, desktop collections and capture: waits for
   networkidle timeout despite rendered UI. Diagnose and wait for actual
   settled page content rather than disabling axe or dropping cases.

The first real-stack follow-up passed30 fidelity and9 interests journeys with
the loopback transport guard. Three keyless v1 journeys passed; three keyless
v2 journeys failed because the main HTTP server generated HTTP callbacks for
an HTTPS browser session. An initial unguarded fixture run made15 logical
Wikipedia lookups; those are retained, not described as offline evidence.
The guarded repeats blocked external research normally. See `hybrid-web.md`.

Coordinator fixes:
- Palette labels now use the ink token, including touch-hover contrast.
- Legacy style work receives one final owner-bound read after it settles, to
 observe a late guard veto, without continuous polling of terminal visual data.
 Added regression tests for bounded reads, unmount, account and capture changes.
- Accessibility waits for visible page/data, no busy content, fonts and finite
 entrance animations rather than Next prefetch network-idle.
- The existing stop-polling browser assertion also requires exactly one final
 guard refresh; the veto/removal and axe assertions are not weakened.

Isolated web suite now139 passed/12 files; affected types/lint and rebuilt
production web passed. A first affected run retained130 passes/9 failures:
six scans captured entrance-animation contrast; three old stop-polling checks
did not account for the deliberate final read. These are retained in
`/tmp/culture-atlas-hybrid-browser-fixes-v2.log`. Corrected affected run is now
complete: **139 passed, zero skipped**,2.0m, exit0,
`/tmp/culture-atlas-hybrid-browser-fixes-v3.log`. This includes all original
retraction, palette contrast and accessibility cases across their projects.

The full rebuilt mocked matrix passed with three workers:
**544 passed,23 existing project-specific skips,0 failures**,4.6m, exit0.
`/tmp/culture-atlas-hybrid-browser-full-v2.log`, private
`hybrid/mock-browser-full-v2/`. The first full run's failures remain retained.
The existing23 project skips are explicit scope choices:15 screenshot duplicates
(the desktop project sets each shot's widths itself), four non-desktop keyboard
duplicates, three non-desktop signed-phone-handoff cases and one desktop run of
the mobile-only onboarding steps. No cases were removed to obtain a pass.

Old main root73927 was stopped before rebuild. New guarded main root93611 serves
4071 with `APP_BASE_URL=https://127.0.0.1:4471` supplied after the launcher.
The web worker completed all6 keyless/9 interests/30 fidelity cases against
that frozen build: **45 passed, zero failures or skips**. HTTPS callback origin
correction fixed the three prior v2 sign-in failures without weakening cookie
or browser binding. All11 worker-owned roots stopped; main93611 was untouched.
Commands and root cleanup records: private
`hybrid/frozen45-v3/services-and-results.json`; exact artifact list (including
141 regenerated screenshots): `hybrid/frozen45-v3/artifact-manifest.json`.
No source edits, builds, reseeds, migrations or paid calls in that repeat.
Paid runtime4030 is not running.

## Actual catalog acquisitions

Both retained, private outside Git:
- `hybrid/met-20261027-v1`: requested24, considered24, requests34, images7;
 17 non-public-domain rejects. Most admitted objects were molds/fragments and
 a print titled Sculpture, not useful complete physical objects.
- Changed retrieval before any model evaluation: concrete static queries
 statuette/vase/chair + documented isHighlight=true, bounded per-class quotas.
 Not a favorable model rerun or overwritten acquisition.
- `hybrid/met-20261027-object-query-v2`: requested24, considered24, requests43,
 images16, eight non-public-domain rejects. Still partial, catalog recallunknown.
 All16 passed domain schema/asset hash/dimension/format checks. Includes seven
 sculptural records, five vases, four chair/part records, not shopping inventory.
- Catalog hash `003f6811c5da86d750299ccfef2bc484aae14f82f7ce32a3e76a90afe5a34e1a`.
- Original query shortcomings, rejects and partiality retained in acquisition.json.
 No retries through429/throttling and no private user queries/photos sent.
- Live owned read-only image route returned exact cached JPEG hash200 and
 unknown hash404 on4071 with featuremax0.

## Cached24 diagnostic

Private input `hybrid/frozen-intent-input-v1.json`, mapping and review packet
`hybrid/intent-review-v1/`, public-safe audit `hybrid/intent-packet-audit-v1.json`.

All24 original v6 captures retained. Surrogate guard states passed23/unknown1
derive from persisted guard provenance plus retained server subjects, never
parent readiness.1567 recorded candidate/relation occurrences,143 known admitted
and shown,1424 admissionunknown/hidden. All recorded-pool completeness and
strengthunknown. No candidate image bytes cached, so image evaluability0.
Twenty explicit review pairs have all human dimensions `not_evaluated`.
No invented labels, catalog recall, ranking regret or retrospective visual-mode
success. New Met objects were not attached to old v6 results.

## Experimental profile diagnostic

Private `run/profiles-hybrid-visual-v1.json`, hash
`6cfae45a536b3ac721172518e54d257c804b6120428acafbcd1655e338706096`.
vision_similarity, Haiku5.5/anthropic, reasoningnone, schema/prompt independent,
8s, 600output tokens, single1024x544 contact sheet. Genuine existing route privacy
date/pricing snapshot retained, not fabricated re-verification. Pending artifact
identifier explicitly means no qualification artifact. Role is catalog-compatible;
gateway dispatch readiness is experimental_production, not quality qualification.

First helper had a SQL alias error before dispatch, then a plain pg.Client lacked
the transaction surface required by the durable ledger. Retained v1 outcome:
one pre-dispatch TypeError, two unrun, zero reservations/paid calls. Fixed only
the coordinator harness to use production PoolDb; no provider/gate changes.

v2 manifest `4014944cbcecfbfa9dc874c5ca55a4755f7559c1e21af28be3778288c2d43296`
froze the same three public museum-image pairs. No user-photo inputs.
- pair01 Vase/Vase: complete, weak,3.199s.
- pair02 Vase/Vase: complete, weak,1.822s.
- pair03 Chair/Vase incompatibility check: invalid_response,2.558s, retained.
  No valid negative judgment, no favorable retry or pass claim.
- Each reserved7000micros; all three remain unknown-cost, no settlement guessed.
- Actual durable outcomes complete/complete/invalid_response, usage disclosed
 2088input each and76/76/78output. Zero active reservations afterward.
- Diagnostic does not pass the predeclared negative/schema mechanism check or
 establish human usefulness/visual quality. Do not spend a full24-photo wave
 merely because budget remains; the failed check must be understood first.
- Content logging remains off. Raw model response was not retained to work
 around privacy policy. Caller error projection omitted kind; ledger retains
 invalid_response. Do not invent the precise semantic cause.
- v1/v2 manifests, failures, started records and outcomes remain private and
 exclusive, no overwritten model attempts.

Offline diagnostic follow-up added30 synthetic tests. Valid incompatible
`false/none/[]` judgments pass the schema, semantic validator and mock adapter;
contradictions still fail. Combined visual72 and offline provider628/38 pass,
with provider TypeScript and focused lint passing. Several distinct errors
map to `invalid_response`;78 output tokens do not identify the live cause.
The caller's `.code` projection is a harness reporting bug because ProviderError
uses `.kind`; it does not explain the durable invalid response. No prompt,
schema, validator, privacy or retry rule was relaxed. No further paid calls or
full24 wave are justified by this evidence. Visual comparisons remain disabled.

## Latest durable accounting

2026-10-27T16:05:50.164Z, private `hybrid/hybrid-final-ledger-v2.json`
(earlier v1 preserved):
- total counted **$22.274631**, increase **$0.021**, remaining **$22.725369** of45.
- unknown model attempts1526; active reservations0; pauseunset; circuits0.
- Unfinished paid-runtime jobs0. Final accounting used a read-only transaction.
- Qloo count262/1500 unchanged. No quota, spend history or controls reset.
- `ca_r3_new` explicitly migrated through210, preserving historical attempts.
- Qualification-stage absolute runtime cap25.253631 includes the entire history.
- Visualmax remains0 in runtime envs; no paid capture worker running.

## Native compatibility checks

No new native intent-mode UI was implemented or claimed. Additive optional
`discovery_intents` unavailable/pending/failed payload tests verify that the
existing native style/recommendation fields still decode unchanged.

- iOS full suite123 total:121 passed,2 existing physical/live skips,0 failures.
  Xcode workspace `workspace-cMnynP4SZ1`.
- Android focused contract6/6 passed. Full core103 freshly passed; app16 cached
  results were UP-TO-DATE, not a fresh app execution. No failures.
- Logs `/tmp/culture-atlas-hybrid-android-contract.log` and
  `/tmp/culture-atlas-hybrid-android-full.log`.
- No physical capture/auth/release/Meta/push qualification.

## Final cleanup and decision

Final full bounded suite, full mocked matrix, affected browser repeat and all45
rebuilt real-stack journeys passed. Main-owned93611 and its four-process tree
were stopped with the validated owned-root helper. Listener inspection found
no listeners on4071–4073,4470–4473,4679 or4680. The worker's11 roots were already
stopped. No owned runtime remains running.

Build and affected TypeScript/ESLint passed; final `git diff --check` passed.
Existing dynamic-filesystem build warnings and the pre-existing MusicView hook
warning remain documented above. No commits, push, deployment, privilege/auth/
cloud changes, discarded user work or counter resets.

No further paid evaluation was run after the three public-pair diagnostic
attempts. The failed negative mechanism check remains unresolved, the20 review
pairs have no human labels, and vision_similarity has no independent bound
qualification artifact. A full24-photo wave would not establish the missing
ground truth or justify enabling visual comparison. Feature maximum stays0.
The hybrid modes and cached museum-reference infrastructure are implemented,
but neither human usefulness nor improved frozen-photo relevance has been
demonstrated. These are explicit remaining quality gates, not passing claims.
