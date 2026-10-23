# Audio platform research — verified 2026-10-21

No paid requests, account inspection, credentials or hardware tests were used. These are public documentation findings, not production qualification.

## Meta: audio exists; distinguish two capture paths

**Verified:** Meta's iOS DAT 1.0.0 changelog (September 24) adds experimental camera audio streaming through `StreamConfiguration.audioCodec` and `Stream.audioFramePublisher`; 1.0.1 (October 9) lists no developer-facing changes. The same changelog says experimental features may be tested but apps using them cannot yet be published. [Official changelog](https://github.com/facebook/meta-wearables-dat-ios/blob/main/CHANGELOG.md)

Official integration guidance requires camera AND microphone permission for in-stream PCM, subscribing before starting the stream and honoring frame timestamps. Android uses `audioStream` and `presentationTimeUs`; iOS uses `audioFramePublisher`. These are Camera Stream extensions, not a documented independent microphone-only DAT recorder. [iOS guidance](https://github.com/facebook/meta-wearables-dat-ios/blob/main/AGENTS.md), [Android guidance](https://github.com/facebook/meta-wearables-dat-android/blob/main/AGENTS.md)

**Fresh production constraint:** On October 16, Meta staff confirmed in-stream audio remains limited to development/beta channels and cannot publish yet. Some glasses firmware ends camera sessions when HFP is opened; their interim advice is to keep HFP closed during DAT sessions and use experimental in-stream audio for concurrent video/audio. Firmware fix timing is unannounced. [Official staff response](https://github.com/facebook/meta-wearables-dat-android/issues/206)

A separate October 16 staff response says Wi-Fi streaming is iOS-only (still true in 1.0.1); Android shares Bluetooth bandwidth. It recommends `setCommunicationDevice()` and `MODE_IN_COMMUNICATION` on compatible firmware instead of cycling SCO, and testing each supported handset. [Official discussion](https://github.com/facebook/meta-wearables-dat-android/discussions/130)

**Audio-only design implication:** For Music mode, prefer the OS Bluetooth-headset input path with camera closed, verified active route, and explicit phone-microphone fallback choice. Do not start the camera merely to obtain DAT PCM and describe it as audio-only. A new October 13 community request for DAT microphone-only streaming has no official answer; it reports camera/LED staying on with camera stream audio. This is an unresolved capability, not a promise. [Open request](https://github.com/facebook/meta-wearables-dat-ios/discussions/337)

The official microphone recipe page is login-gated in this research environment. Older community discussion quotes the OS `AVAudioSession`/`AVAudioEngine` HFP recipe; treat its fixed sample-rate claims as unqualified. Persist observed codec, sample rate, channels, source route and interruptions rather than assuming studio-quality glasses music audio. [Official guide entry](https://wearables.developer.meta.com/docs/develop/dat/microphones-and-speakers/)

**Qualification requirements:** independently test audio-only HFP, video+DAT PCM, phone audio/video, silence detection, route loss, interruptions, sample format, A/V alignment and firmware matrix. Do not globally assume DAT audio is beamformed or synchronized perfectly. User reports are useful test hypotheses; they are not guarantees.

## Qloo: resolution and cultural affinity, not raw-media recognition

The official Search API accepts text names/properties (`GET /search`), with type/category filters. Albums are explicitly legacy search types not supported in `/v2/insights`. Do not design a universal Qloo song/album recommendation API or send waveforms to Search. [Search contract](https://docs.qloo.com/reference/get-search)

The Insights API provides cultural preference rankings from entities, tags and other supported signals. `feature.explainability=true` adds input-contribution metadata and may return a warning when it cannot be computed. This is recommendation explanation, not acoustic-match confidence. [Insights contract](https://docs.qloo.com/reference/insights-api-deep-dive)

**Architecture inference:** identify a recording with a music recognition adapter; keep its track/recording IDs separately; resolve credited artists into Qloo artist IDs; request related artists, places, films and other supported categories. Describe independent results: “heard in this clip,” “recognized artist,” and “recommended from this artist.” Cross-domain affinity does not establish something was present in an image/video/audio recording, and an incidental recording does not establish the user likes it.

Qloo's own capabilities page supports record enrichment and cross-category recommendations. No raw audio fingerprinting/transcription endpoint was found in the inspected official API. [Qloo capabilities](https://www.qloo.com/capabilities)

## Concentrate: keep it for vision/text; audio contract remains unverified

The current official multimodal page documents images plus text, including `input_image`, data URIs/URLs and model image capability discovery. It does not establish a supported audio upload/transcription request or native video inference contract. [Multimodal inputs](https://concentrate.ai/docs/api-reference/endpoint/multi-modal)

The public documentation index includes Responses, Chat Completions, Messages, model discovery, structured output and multimodal images; it does not list an audio transcription endpoint. Absence from this index is not proof the gateway cannot support audio privately; it is insufficient evidence to promise production support. [Documentation index](https://concentrate.ai/docs/llms.txt)

**Design implication:** preserve a provider-neutral `transcribeAudio` / `analyzeAudio` seam. Use Concentrate for structured interpretation of verified transcript, extracted visual observations and metadata. Route raw audio through Concentrate only after obtaining a documented supported model/provider/API contract and passing privacy, duration, language, timestamp and error-behavior tests. Do not invent `/audio/transcriptions` support from OpenAI compatibility marketing. Credits available at Concentrate do not establish coverage of a separate recognizer or transcription service.

## Recognition option with primary-source grounding

ShazamKit recognizes music using signatures, supports Apple platforms and Android, and requires enabling the service; Android uses signed developer tokens. Apple says audio itself is not sent and signatures are not reversible. This is a credible native music-recognition adapter candidate, not a generic backend HTTP recognizer for all uploaded media. [Apple ShazamKit](https://developer.apple.com/shazamkit/)

For parity on browser uploads/server processing, evaluate a licensed server-side recognizer. ACRCloud's official index documents identification and music metadata alongside custom-file and music/speech-detection APIs. Exact commercial terms, format limits, regional endpoints and credentials still require qualification; do not claim it is selected or free. [ACRCloud identification index](https://docs.acrcloud.com/reference/identification-api)

## Recommended spec decisions (product proposals, not vendor claims)

- Audio is a first-class asset type and Music a strictly audio-only capture mode.
- Split pipelines: audio extraction, speech transcription (opt-in), music recognition, environmental sound observations, visual frame/region/OCR observations, then entity resolution and Qloo discovery.
- Store time spans for audio/video and normalized boxes for images/frames, confidence provenance, processor/version, user confirmation and source references. Preserve unknown/no-match/unsupported independently.
- Default Music mode to no transcript; enable speech transcription separately. Recognized music metadata can be shared without sharing the underlying audio.
- An “extract audio” result is a derivative of a video; a saved audio item must retain parent provenance and deletion/sharing inheritance. Original mixed soundtrack is not isolated vocals/instruments.
- Separate agent scopes for audio bytes, transcripts, recognition results, derived observations and starting audio capture. Existing media-read authority must not silently expand into transcript access or remote microphones.
- A camera-free audio mode must remain camera-free on both successful and fallback paths. If a glasses-only route is unavailable, explain and let the user choose the phone microphone.
