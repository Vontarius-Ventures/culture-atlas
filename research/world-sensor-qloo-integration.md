# World Sensor → Qloo style and virality app

Reviewed October 11, 2026. Source review only: no device run, build, endpoint exercise, or deployment verification. Sensor repository: private `Vontarius-Ventures/WorldCompilerSensor`, main snapshot `8639b3b52cc163074c7e4ebaf6e948ae2c4890df`. Existing implementation and proposed additions are distinguished below.

## Existing capture and delivery

- `MetaWearablesService.capturePhoto() async throws -> Data` checks readiness, rejects concurrent captures, asks the active Meta camera stream for JPEG, and times out after five seconds. The photo listener returns bytes or converts a non-JPEG image to JPEG. It requires registration, an active device/session, and a streaming camera. [Source, lines 714–748](https://github.com/Vontarius-Ventures/WorldCompilerSensor/blob/8639b3b52cc163074c7e4ebaf6e948ae2c4890df/WorldCompilerSensor/Wearables/MetaWearablesService.swift#L714).
- The photo UI captures bytes and immediately calls `model.library.savePhoto(jpeg:sessionID:)`. [Source, lines 994–1007](https://github.com/Vontarius-Ventures/WorldCompilerSensor/blob/8639b3b52cc163074c7e4ebaf6e948ae2c4890df/WorldCompilerSensor/Views/HomeView.swift#L994).
- `LibraryStore.savePhoto` returns a local UUID, writes JPEG plus metadata, and queues upload when configured and paired. `upload(photo:)` creates an `image/jpeg` request and records the returned relay asset ID after upload. Auto-upload is governed by the existing upload policy, so capture does not imply immediate network availability. [Save source, lines 927–951](https://github.com/Vontarius-Ventures/WorldCompilerSensor/blob/8639b3b52cc163074c7e4ebaf6e948ae2c4890df/WorldCompilerSensor/Library/LibraryStore.swift#L927), [upload source, lines 624–693](https://github.com/Vontarius-Ventures/WorldCompilerSensor/blob/8639b3b52cc163074c7e4ebaf6e948ae2c4890df/WorldCompilerSensor/Library/LibraryStore.swift#L624).
- `LibraryUploader` declares an asset, uploads its content, checks that it is committed, and optionally uploads a thumbnail. The shared API exposes authenticated photo listing, thumbnail retrieval, and original content download. Photos have capture timestamps and optional session linkage. [Uploader](https://github.com/Vontarius-Ventures/WorldCompilerSensor/blob/8639b3b52cc163074c7e4ebaf6e948ae2c4890df/WorldCompilerSensor/Library/LibraryUploader.swift), [asset API](https://github.com/Vontarius-Ventures/WorldCompilerSensor/blob/8639b3b52cc163074c7e4ebaf6e948ae2c4890df/Shared/Assets.swift).
- Live preview has a decoded `onLiveImage` callback, and the relay exposes `GET /wc/v2/live/frame.jpg`; frames older than five seconds produce `404 not_live`. This is a live stream frame, distinct from a captured still. [Live API spec](https://github.com/Vontarius-Ventures/WorldCompilerSensor/blob/8639b3b52cc163074c7e4ebaf6e948ae2c4890df/Specs/live-and-control-api.md).
- The reviewed server README explicitly describes the relay as a loopback transport qualification rig, not a production relay or semantic compiler. Its asset routes nevertheless provide a useful integration contract. [README](https://github.com/Vontarius-Ventures/WorldCompilerSensor/blob/8639b3b52cc163074c7e4ebaf6e948ae2c4890df/TestServer/README.md).

## Proposed MVP

Target creators evaluating an outfit, product arrangement, or visual concept before publishing. Start with one niche and one social platform; a still image can support visual analysis but cannot establish video pacing, audio quality, or retention.

1. Capture a photo with World Sensor or upload an image in the hosted demo.
2. Select intended platform, audience, geography, post format, proposed publishing time/timezone, and optionally caption and creator baseline.
3. A VLM extracts observable colors, garments/objects, composition, legible text, and candidate aesthetics. Preserve uncertainty; visible cues do not prove a brand or cultural identity.
4. Resolve candidates to Qloo entities/tags using actual returned IDs. Permit correction of ambiguous matches. Do not pass arbitrary VLM labels as if they were Qloo entities.
5. Query Qloo for cultural affinity and available entity trends; keep query context and returned scores alongside the interpretation.
6. Combine cultural signals with account/post outcomes and timing data where available. Missing data should remain missing rather than becoming invented estimates.
7. Return audience fit, cultural momentum, recommendations, source evidence, and model/data confidence. Give numeric probability ranges only when supported by a fitted and validated outcome model; otherwise label the output an experimental potential score.
8. Make the workflow agentic through ambiguity resolution, tool selection, evidence checks, and comparison of alternate captions/music/visual treatments. Show how Qloo changes the audience or recommendation compared with a VLM-only result.

Recommended sensor seam: use committed `kind=photo` assets and fetch their originals through the authenticated viewer API. A server adapter can poll committed assets for a hackathon MVP; a production commit event would be a new addition. Key jobs by asset ID/image hash plus model and analysis version. Store reports separately from sensor evidence and preserve capture responsiveness when analysis is slow or unavailable. Keep Qloo/VLM keys and sensor viewer credentials server-side.

Direct iPhone analysis is also possible after `savePhoto` returns the local UUID, but introduces client/UI work. Live sampling should be an optional later mode; it needs throttling, duplicate suppression, and careful stale-frame handling.

## Probability semantics

Define a concrete outcome, for example exceeding an account-relative reach threshold within seven days. The threshold and window are product decisions, not Qloo outputs. Train on observed posts with the same outcome window and platform; use chronological validation, prevent future trend/outcome leakage, assess calibration against a creator-baseline model, and express uncertainty around the estimated probability. A wide numerical range does not by itself make an unsupported estimate valid. Capture time and intended publish time are separate fields.

## Hackathon requirements and packaging

The competition asks for meaningful Qloo use in an agentic application, a working externally hosted demo, a public source repository with run instructions/assets, and an open-source license. The deadline is October 30, 2026 at 11:45 p.m. EDT. [Official Devpost page](https://qloo.devpost.com/).

Recommendation: create a separate public hackathon application and documented sensor adapter rather than changing the visibility of the existing private Sensor repo. Provide image upload and sample images as first-class demo inputs. Public/private packaging and licensing still need to be implemented; the reviewed Sensor tree has no LICENSE file. No repository publication or source changes were performed during this review.

See the companion Qloo feasibility note for verified API parameters and trend/affinity interpretation.
