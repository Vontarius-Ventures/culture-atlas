# culture atlas for iOS

Native capture client for the culture atlas `/v2` API. Build, test and release
steps, and what still has to be qualified on physical devices, are in
[docs/native.md](../../docs/native.md).

**Status: source only.** This repository's CI has no Xcode, so none of this
code has been compiled or run yet. The protocol it implements is verified on
the server side by `apps/web/lib/server/native-contract.test.ts` against
`fixtures/native-contract`, which `AtlasCaptureTests` also reads.

| Path | Contents |
| --- | --- |
| `AtlasCapture/` | Reusable capture module (no Meta SDK import): wire models (incl. `Contract/OnboardingModels.swift`), onboarding and ready-notice rules (`Onboarding/`, `Notifications/`), email sign-in + PKCE, Secure Enclave installation key and enrollment proof, Keychain session store with refresh rotation, encrypted account-scoped draft store, multipart background uploader, remote command processing with persisted receipts, arming/heartbeat, phone camera, glasses clip recorder |
| `AtlasGlasses/` | Experimental Meta Wearables DAT adapter, ported from World Observer's `MetaWearablesService` |
| `CultureAtlas/` | SwiftUI app: sign-in, Library, Capture source chooser, camera with Retake/Keep, glasses screens 04/05/09, remote-capture sheet and banner, sign-out with Keep/Delete; amendment 2.2 taste questionnaire (screen 14, three steps), Building your feed (15), Settings → Taste (18), "Explore this photo" with the ready notice (17: silent APNs wake, local notification, in-app toast) |
| `AtlasCaptureTests/` | XCTest suites driven by `fixtures/native-contract` |
| `project.yml` | XcodeGen spec: `CultureAtlas` (public, no SDK) and `CultureAtlasExperimental` (SDK) targets |
