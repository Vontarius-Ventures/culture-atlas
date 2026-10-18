# culture atlas for Android

Native capture client for the culture atlas `/v2` API, written independently
of the iOS app against the same contract fixtures. Build, test and release
steps are in [docs/native.md](../../docs/native.md).

**Status:** `app/` is source only: this environment has no Android SDK and no
access to Google's Maven repository, so it has never been compiled or run.
`core/` compiles and its JUnit tests pass on a plain JVM (Kotlin 2.1.0 from
Maven Central, see docs/native.md "Build and test").

| Module | Contents |
| --- | --- |
| `core/` | Pure Kotlin/JVM: wire models (incl. onboarding, push and analysis DTOs), onboarding and ready-notice rules, multipart planner, command decision table, draft-lock, capability gate, error/backoff/refresh policies, enrollment proof (payload, DER to P1363), chunked AES-GCM draft encryption, OkHttp client, session manager with refresh-request-id rotation, upload engine, command runner. `./gradlew :core:test` needs no Android SDK and reads `fixtures/native-contract`. |
| `app/` | Android app: Keystore vault (tokens, installation EC keys with StrongBox when present, per-account draft keys), file-backed draft and receipt stores, WorkManager uploads (Wi-Fi only by default), CameraX phone camera, segmented glasses clip encoder, Compose UI; amendment 2.2 taste questionnaire (screen 14, three steps), Building your feed (15), Settings → Taste (18), "Explore this photo" with the ready notice (17: data-only FCM wake, local notification, in-app toast). |
| `app/src/store` | Public store flavor: no Meta SDK; glasses entry explains it is unavailable. |
| `app/src/experimental` | Meta Wearables DAT binding (`MetaDatBinding.kt`, unverified against the SDK) and adapter. |
