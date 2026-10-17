# culture atlas for Android

Native capture client for the culture atlas `/v2` API, written independently
of the iOS app against the same contract fixtures. Build, test and release
steps are in [docs/native.md](../../docs/native.md).

**Status: source only.** This repository's environment has no Android SDK, no
Kotlin compiler and no network access to Maven repositories, so nothing here
has been compiled or run. Gradle 8.14.3 does parse `settings.gradle.kts` and
the version catalog, then stops at plugin resolution.

| Module | Contents |
| --- | --- |
| `core/` | Pure Kotlin/JVM: wire models, multipart planner, command decision table, draft-lock, capability gate, error/backoff/refresh policies, enrollment proof (payload, DER to P1363), chunked AES-GCM draft encryption, OkHttp client, session manager with refresh-request-id rotation, upload engine, command runner. `./gradlew :core:test` needs no Android SDK and reads `fixtures/native-contract`. |
| `app/` | Android app: Keystore vault (tokens, installation EC keys with StrongBox when present, per-account draft keys), file-backed draft and receipt stores, WorkManager uploads (Wi-Fi only by default), CameraX phone camera, segmented glasses clip encoder, Compose UI. |
| `app/src/store` | Public store flavor: no Meta SDK; glasses entry explains it is unavailable. |
| `app/src/experimental` | Meta Wearables DAT binding (`MetaDatBinding.kt`, unverified against the SDK) and adapter. |
