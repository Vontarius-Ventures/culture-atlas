# Audio expansion code review

October 21, 2026. Remote refs fetched before review. This is a source review, not a runtime validation.

Culture Atlas main remains `02ec318`; the design branch is `fe37efb`. The active integration branch `claude/wizardly-cannon-yu8trw` is now `a5dd54e`, with native apps, capture intake/preparation, Concentrate, agents, sharing, onboarding and iterative grounding evaluation work. New package branches include `capture-v2/identity`, `capture-v2/p1-domain-infra`, `capture-v2/p4-concentrate`, and `capture-v2/p5-agents`. These are development changes, not evidence of a production deployment. World Observer main remains `bbecdd5`.

## Relevant implementation evidence

All Atlas paths below refer to integration commit a5dd54e, not the older local documentation branch. Read with `git show a5dd54e:<path>`.

- `packages/domain/src/schemas/capture-v2.ts`: MediaKind is photo/video; MIME allowlist excludes standalone audio.
- `packages/domain/src/capture-v2/types.ts`: verification and preparation require width/height, derivatives are normalized/playback/poster/frame; no audio asset or audio evidence type.
- `packages/domain/src/capture-v2/analysis.ts`: validates photo versus video modes and selects frame derivatives.
- `apps/worker/src/media-analysis.ts`: bounded JPEG/frame checkpoints feed the cultural compiler; audio is not an analysis input. It also now accepts an explicitly configured FallbackVlm. Audio must not inherit that image fallback accidentally.
- `packages/providers/src/concentrate/{transport,profiles,providers}.ts` and `docs/concentrate.md`: real transport, role profiles, durable spend ledger and qualification workflow now exist. The documentation still records unresolved photo qualification and privacy confirmation. Do not call every role production-qualified merely because adapters exist.
- `packages/providers/src/qloo/types.ts`: entity search, tags and insights; artists, albums and podcasts are available adapter entity kinds, but no track entity kind or raw-audio recognition contract is present. Affinity is relationship strength, not recognition probability.
- `apps/ios/AtlasGlasses/MetaWearablesAdapter.swift:296`: existing camera link explicitly has no audio track. Observer `WorldObserver/Wearables/MetaWearablesService.swift:398` and observation manifests likewise do not establish current captured audio. Hardware audio capability is distinct from these app implementations.
- `apps/android/app/src/experimental/kotlin/com/cultureatlas/app/capture/MetaDatBinding.kt`: explicitly marked unverified SDK binding, frame/photo only. `docs/native.md` says iOS and Android app builds/device qualification remain incomplete; pure JVM core tests are a narrower achievement.
- `docs/sharing.md`: positive viewer projection excludes transcripts/analysis output; safe media inclusion and original-download grants are separate. Preserve that boundary and require new consent for audio.
- `specs/onboarding-and-fast-analysis.md`: version2.2 establishes explicit taste picks and quick/enrichment stages. Audio amendment2.3 retains them. New screens therefore start at19, not14.

## Design consequence

Extend the new capture services and model gateway; do not recreate the original image-only intake or import Observer's relay. Add audio as a real asset kind, independent audio analysis components, timestamped evidence, actual input-route provenance and explicit new permissions. Preserve the current grounding and qualification discipline. This documentation branch does not merge or overwrite integration code.
