# Hybrid coordinator preflight and compatibility

## Current status

Full plan saved in `hybrid-recommendation-plan.md`. Four disjoint implementation
workers launched: domain/API, comparison provider, web, catalog/evaluation.
Integration, live profile readiness and recommendation quality remain pending.
No paid model/Qloo calls or service deployments performed in this planning stage.

## Budget

Read-only durable check 2026-10-27T15:14:20.041Z on `ca_r3_new`:
- total and counted: 22,253,631 micros ($22.253631)
- cumulative user authorization: 45,000,000 micros ($45)
- remaining: 22,746,369 micros ($22.746369)
- active reservations 0; unknown attempts 1,523 preserved; unfinished jobs 0
- no pause value set; circuit map empty, neither changed
- Qloo day 2026-10-27 count262/1500, remaining1238; no rollover/reset.

Private `run/hybrid45.env` carries the new cap and leaves visual comparisons
disabled pending readiness. Private `run/hybrid-qualification-cap.env` limits
the first stage to an absolute $25.253631 (historical $22.253631 + at most $3).
No dispatch occurred merely by writing these files. Recheck state before use.
`hybrid-plan-preflight.json` contains the read-only result, not credentials.

## Public source checks

- Official API paginated search returned HTTP200 with `total` and `objectIDs`:
  https://collectionapi.metmuseum.org/public/collection/v1.1/search?q=sculpture&isPublicDomain=true&hasImages=true&limit=2&offset=0
- This confirms endpoint operation, not that search filters establish licensing
  or pictured-object relevance. Each object still requires its own public-domain
  flag and usable image. No images/catalog imported by this check.
- Terms fetched successfully, redirecting to:
  https://www.metmuseum.org/policies/terms-and-conditions
- Terms identify Open Access materials as CC0, permitting commercial and
  noncommercial use. Non-OA material has different restrictions. Trademark,
  third-party-rights and no-endorsement limitations remain. API availability and
  accuracy are not guaranteed and access can be restricted. No museum logo,
  endorsement, image authenticity or third-party-rights warranty is implied.
- Current API documentation: https://metmuseum.github.io/
  Do not use the retired original search endpoint.

## Native additive-field compatibility

Added a test to each existing StyleServerContract suite that injects
`discovery_intents` into the server's existing capture fixture and checks the
legacy reading, recommendations and rails remain unchanged. This is decoder
compatibility, not native support for the new visual UI or live server proof.

### iOS

Full active scheme: **123 tests, 121 passed, 2 skipped, zero failures**.
The new compatibility test passed. Skips still require live/physical fixtures:
`CameraKeepTests/testTakePhotoAndKeepOnThisPhone()` and
`FeedFloatTests/testFeedCardsFloatByIdentityAndNeverOverlap()`.

Workspace: factory6 `CultureAtlas.xcodeproj`, workspace-cMnynP4SZ1.
Summary:
`/var/folders/tf/xywb0t3n2_39nr0h62r1zqlw0000gn/T/ActionArtifacts/default/RunAllTests/3504D5C6-4B31-4F6F-BD95-2F2F09D9C4AE.txt`

### Android

Focused StyleServerContract: **6/6 passed**, including new compatibility test.
Full `:core:test :app:testStoreDebugUnitTest` command succeeded:
- core: 103 tests, zero failed/skipped; freshly executed
- app: 16 tests, zero failed/skipped in existing results; task was UP-TO-DATE,
  so these app results are cached, not a fresh rerun.
- Existing SDK XML-version and Gradle-deprecation warnings remain.
Logs: `/tmp/culture-atlas-hybrid-android-contract.log`,
`/tmp/culture-atlas-hybrid-android-full.log`.

No physical capture, live auth/onboarding, release/Meta/background/push,
human visual matching or new native visual-mode qualification claimed.
