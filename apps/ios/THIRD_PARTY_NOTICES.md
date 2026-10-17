# Third-party notices (iOS)

## Meta Wearables Device Access Toolkit (iOS)

- Package: `https://github.com/facebook/meta-wearables-dat-ios`, pinned to
  `exactVersion: 1.0.0` in `project.yml` (products `MWDATCore`, `MWDATCamera`).
- Linked only by the `AtlasGlasses` framework and the
  `CultureAtlasExperimental` app target. The public `CultureAtlas` target does
  not contain the SDK.
- The SDK is distributed under Meta's own license and developer terms, which
  are not reproduced here because this repository has no network access to
  the pinned package. `Scripts/copy-sdk-notices.sh` copies the license and
  notice files from the resolved package checkout into every Experimental app
  bundle (`ThirdPartyNotices/`) and fails the build if none is found. Review
  those terms, including any distribution restrictions, before each release
  (docs/native.md, "Store and SDK eligibility gates").

## Code adapted from Meta's CameraAccess sample (via World Observer)

`AtlasCapture/Wearables/ClipRecorder.swift` (HEVC keyframe detection, the
software `H265FrameDecoder`, and the passthrough `AVAssetWriter` path) was
adapted in World Observer from Meta's CameraAccess sample that ships with the
Wearables Device Access Toolkit, then ported here. Those portions remain
subject to the license that accompanies that sample in the SDK repository;
keep this notice and the SDK license files with any distribution of the
Experimental build.

## World Observer

`AtlasGlasses/MetaWearablesAdapter.swift`, `AtlasCapture/Wearables/ClipRecorder.swift`,
`AtlasCapture/Identity/KeychainStore.swift` and
`AtlasCapture/Upload/BackgroundTransfer.swift` are ported from the World
Observer app (WorldCompilerSensor) by the same owner. Each file's header
states what was kept and what was removed.
