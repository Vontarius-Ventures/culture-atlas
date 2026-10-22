# Audio and multimodal discovery amendment 2.3

October 21, 2026 · Required product scope · Design specification, not implemented behavior.

Audio is a first-class medium alongside photos and videos. **Music Mode is audio-only capture, with the camera off.** Users can record with a verified glasses microphone route, their phone or browser microphone, or upload audio. Videos can contribute separately selected sound, spoken references, visible details and moments. Images contribute visible details and text; an image of an album can identify a release through evidence, but cannot prove which song was playing.

This amendment changes v2.1's image/video-only assets and incidental-audio assumption. It preserves v2.2 onboarding, quick/enrichment analysis, explicit taste updates, grounding rules and account isolation. The reviewed integration baseline and gaps are in [the code review](../../research/audio-recent-code-review.md). External capability evidence is in [audio platform findings](../../research/audio-platform-findings.md). Untouched discovery, identity, uploads, agents and sharing retain their existing contracts.

## Product outcomes

1. Tap Music → select microphone → Record → Stop → Keep → Explore music. Never require camera permission for Music Mode.
2. Import an audio file into the same private library, play it, select a range and choose Music, Spoken references or Soundscape exploration.
3. Open a video and choose **Sound**, **Visuals**, or **Both**. Select a time range; findings show exactly where they came from.
4. Open a photo and select visible regions or extracted text to explore an artist, album, place, object or aesthetic. Sound is unavailable for photos, not invented.
5. Save an identified entity, a discovery, or a source moment to a collection. Saving a source recording does not automatically endorse every person, song or brand found in it.

Example: a42-second café video contains a song at12–24s, a book on a table at18s, and a spoken venue reference at30–34s. These become separate evidence-backed candidates. A music match resolves to an artist/album; the book needs a readable title/author; the spoken venue needs a trustworthy transcript plus disambiguation. Qloo returns related culture from selected resolved seeds. The interface must never imply that the song identifies the café or that a visible book was mentioned aloud.

## Capability matrix

| Source | Capture | Analysis | Required qualification |
|---|---|---|---|
| Phone microphone | Audio-only, camera off | Music, optional speech, soundscape | OS permission, route, codecs, interruptions |
| Browser microphone | Audio-only over secure context | Same server pipeline | getUserMedia/audio recorder support and MIME negotiation; file upload fallback |
| Glasses via OS microphone route | Audio-only, camera off | Same server pipeline | Actual input route verified; Bluetooth output connection alone is insufficient |
| Glasses camera SDK | Video plus audio where SDK/platform/channel supports it | Sound/visuals/both | Separate experimental SDK audio qualification and release eligibility |
| Uploaded audio | Bounded supported files | Music/speech/soundscape | Actual container/codec decode, size/duration/channel validation |
| Uploaded/native video | Existing video with optional audio track | Selected channels | No-audio, silent-audio and undecodable-audio distinguished |
| Photo | Existing capture/upload | Visible objects, text, references | No audio inference; current vision grounding rules apply |

Meta hardware records audio, but the reviewed apps currently do not integrate the newer camera-audio path. Implement two independent adapters: AudioCapture for true microphone-only sessions and CameraStreamAudio for qualified DAT video audio. Never run a camera stream and discard frames while calling it audio-only. If a glasses microphone-only route cannot be verified, show “Glasses microphone unavailable” and offer the phone microphone explicitly. Never silently switch to the phone or label phone sound as glasses sound. Record actual input route and route changes. HFP/other Bluetooth profile quality must be measured; a speech-oriented route may be poor for music matching even when recording works.

## Defaults and limits

Proposed release defaults, to be qualified before enabling:

| Setting | Default |
|---|---|
| Native/browser audio capture | Up to120seconds; user stops explicitly or at limit |
| Music recognition selection | Default15seconds, selectable5–30seconds; up to3 recognition windows per run |
| Uploaded audio | Up to10minutes and100MiB, whichever is reached first |
| Channels/sample rates | Decode mono/stereo at8–96kHz; reject unsupported multichannel; retain actual source properties |
| Input formats | MP3, M4A/AAC, WAV/PCM, FLAC, WebM/Opus and Ogg/Opus only after decoder qualification |
| Video limits | Existing120second uploads/60second capture unchanged |
| Speech analysis | Off in Music Mode; explicit action for transcription or spoken references |
| Automatic cloud analysis | Off; Keep saves, Explore authorizes selected analysis |
| Model work per run | Max120seconds selected audio for ASR/soundscape,3 fingerprint windows and8 video frames; longer selections require a new explicit run |
| Storage/account allowance | Existing5GiB and50 analysis requests/day shared across media; derived bytes also count |
| Audio retention | Original and playback follow owner deletion; inference-only PCM/temp chunks expire within24h, failed jobs included |

Keep source-quality audio for playback and music matching when allowed; do not globally downsample it to a speech-only representation. Derive a separate mono speech rendition only when the chosen ASR provider needs it. Do not imply resampling improves an8kHz source. Prepare waveform peaks locally/server-side as bounded numeric data, not a public raw-audio URL. Final production format list is reported by capabilities; unsupported browsers use file upload.

## User journey and recording state

Capture offers Photo, Video and Music. Music opens a waveform/level-meter screen with input name, elapsed time,120second limit, recording indicator and “Camera off”. Its record action requests microphone permission only. No camera preview, camera initialization or frame upload is allowed. Route picker shows actual available inputs, not guessed devices. Prior glasses registration may help discovery but is not proof that audio routing succeeded.

States: idle → permission_requested → route_check → recording → finalizing → local_draft → queued_upload → ready. Interruption, route loss, storage full or account switch stops recording and preserves the valid portion. Resume starts a new capture segment; it never fabricates continuous time. Use explicit Keep/Delete local draft; encrypted account-bound drafts and upload recovery follow existing native policy. An OS interruption that cannot save a valid recording shows “Recording could not be saved”, never “Uploaded”. Remote music capture uses separate local microphone arming and a visible Stop access action; existing camera arming does not cover it.

Music result states: matching, identified, possible matches, no reliable match, provider unavailable. Distinguish exact recording match from artist/album suggestion, cover/live performance and sound/style description. Show recognition coverage and quality warnings, not invented confidence percentages. The owner can correct/reject a match; corrections are attributable user assertions and do not rewrite vendor evidence.

## Analysis architecture

Asset → validate/probe → private playback and bounded derivatives → selected components → evidence records → candidate resolution → grounded cultural compiler → Qloo discovery → user saves.

Each component has its own state: not_requested, queued, running, succeeded, no_result, unavailable, failed, cancelled. The run can be partial: a successful music match survives failed speech extraction, and visual results survive an absent audio track. Explicitly selected audio is never silently omitted. Capture/playback remain available during provider outages.

### Music recognition

Use a dedicated fingerprint/catalog recognition adapter, separately procured and qualified. Concentrate is the initial model gateway, not an assumed music-identification service. For native recognition, ShazamKit is a documented candidate on Apple and Android platforms; qualify it without assuming a generic server REST interface. For upload/browser parity, evaluate a licensed server recognition adapter such as ACRCloud separately. These are candidates, not selected paid services. The mandatory production dependency is a licensed provider that accepts bounded user-authorized snippets and returns stable recording identifiers, artist/title/release, match interval and documented confidence semantics. Evaluate candidates against the published qualification suite; vendor choice, region coverage, retention and price are a procurement gate rather than fabricated API details.

Normalize responses to matched, ambiguous, no_match or unavailable. Preserve raw provider confidence only in its own documented scale; do not compare scores between vendors. Require calibrated precision thresholds on held-out clips before auto-labeling a recording. An LLM may organize metadata or describe sound; it cannot upgrade a guess to a verified song. If identification is unavailable, still offer qualified sound description and manual artist/title search, clearly labeled.

### Spoken references

Concentrate currently documents image/text inputs; raw-audio support is unverified. Use its existing text roles for validated transcripts and recognition metadata. Do not invent an audio endpoint from OpenAI compatibility. A separately qualified audio transcription role produces language, timestamped words/segments and uncertain spans. Ask permission before sending speech to any provider. Extract cultural references from transcript spans with citations, then resolve catalog IDs. A spoken artist name is “Mentioned”, not “Music heard”. No voice identity, speaker biometrics, emotional diagnosis or sensitive-person profiling. Diarization, if later needed, uses anonymous speaker labels and a separate qualification decision; it is not core release scope. Transcript text is untrusted data, never tool instructions.

### Soundscape and visual detail

Qualified audio understanding can describe broad sound events or musical qualities with time ranges. Separate observed sounds from inferred style. “Crowd noise” cannot establish a venue or the user's preferences. Video vision retains bounded frames and existing quick/enrich grounding. Add user-selected crop regions and OCR spans as addressable evidence, normalized coordinates after orientation transforms. Captions visible in frames remain visual text; only audio evidence supports spoken transcript claims. Sync uses actual presentation timestamps and a recorded media-time offset, not wall-clock guesses. Audio/video drift or gaps make cross-modal links uncertain.

### Fusion and Qloo

Every claim cites one or more evidence IDs and a relationship: heard, spoken, seen, written, user_confirmed or related. Use explicit merge rules: same resolved catalog entity may combine support; contradictory identities remain separate candidates; unverified co-occurrence never becomes identity. Partial results retain their channel labels.

Qloo consumes resolved entity IDs and supported taxonomy tags through the existing adapter. Resolve credited artists to Qloo artist IDs with provider IDs where supported, otherwise text search and disambiguation. Albums may be stored as recognized/search metadata, but Qloo documents album search as legacy and unsupported by Insights; do not use album entities as Insights targets or assume their seed eligibility. Use qualified artist IDs for discovery. A track has its own recognition identity; do not invent a Qloo track URN or replace it with an arbitrary album. Record unresolved/ambiguous mappings. Only real returned IDs enter Insights. Qloo affinity is relationship strength within its query, not certainty that a song/object was recognized; do not average scores across unrelated queries. Keep evidence confidence, entity-resolution status and recommendation affinity as separate fields.

Default discovery uses user-selected resolved seeds, at most5 per request; display which seeds contributed. Music and visual discoveries can appear together but must remain labeled. Automatically hearing music does not alter permanent taste. Explicit Save artist/album/discovery uses existing taste rules; Save recording/moment stores media only. Onboarding picks and exclusions remain in force.

## Storage and wire model

Extend current `MediaKind` to audio in an opt-in schema_version2 representation. Do not merely change the old design JSON: integration Zod contracts, SQL constraints, serializers, native sealed types, OpenAPI, MCP and fixtures must change together. Existing schema_version1 photo/video clients continue receiving compatible kinds; audio is filtered from legacy library pages unless client advertises media_audio_v1. Capabilities declare supported_media_kinds and analysis_components. Never serialize audio as video with a blank frame.

Audio metadata: duration_ms, sample_rate_hz, channels, codec, bitrate when known, source_route, audio_quality and optional discontinuity ranges; width/height are absent for audio. Differentiate has_audio_track, audio_decodable, signal_detected and analysis_requested. A video audio_present flag alone is not sufficient. Client route claims are provenance, not cryptographic proof of a hardware microphone.

Extend derivative kinds with audio_playback, waveform and analysis_audio; retain qualified share_safe markers. Add owner/generation-scoped media_tracks, media_evidence, recognized_recordings, entity_resolutions, analysis_components and optional saved_moments. Reuse existing media_segments only if its frame-specific constraints are generalized; never overload frame IDs as audio IDs. Every child references account_id, asset_id, generation and analysis_run_id with composite foreign keys. Evidence includes modality, track_id, start/end ms or frame timestamp/crop, method/profile version and extraction provenance. Private transcript spans and snippets stay out of public projections and logs.

Saved moments reference an immutable source generation and range, with optional note. They are logical views, not duplicated originals. Source deletion makes them unavailable and triggers derivative/transcript/match cleanup; shared copies cannot retain access. Exporting a clip is a separate owner action, creates bounded derived bytes and retains provenance. All timestamps use milliseconds relative to the canonical playback timeline; enforce0≤start<end≤duration. Photo regions use[0,1] bounds and an orientation-version reference.

## API and agent extensions

Existing `/v2/uploads` accepts kind audio only with capability/version negotiation and the qualified MIME list. Existing multipart reservations, hashes, leases, cancellation and idempotency remain authoritative. Add analysis request contract2 with requested_components, selection and expected_generation. Existing v1 analysis modes remain valid and unchanged.

| Component | Allowed input | Additional authorization |
|---|---|---|
| music_match | Audio or video audio range | media:analyze plus audio:analyze |
| speech_references | Audio/video audio range | audio:analyze plus transcripts:write |
| soundscape | Audio/video audio range | audio:analyze |
| visual | Photo region or video frames/range | Existing media:analyze |
| fused_discovery | Selected existing successful component outputs | Read authority for every referenced evidence record |

Proposed routes: GET `/v2/media/{id}/tracks`, GET `/v2/media/{id}/evidence?analysis_id=…` (paginated), GET `/v2/media/{id}/transcript` (transcripts:read), POST `/v2/media/{id}/moments`, DELETE `/v2/media/{id}/moments/{momentId}`, POST `/v2/media/{id}/analysis` with contract2, and GET existing operations for progress. All require current account/resource grants. Read-only evidence projection redacts transcript text unless transcripts:read. Playback includes sound and therefore requires audio:read for agents; old media:read grants do not automatically expose newly stored audio or unmuted video. Existing downloadable video grants must be audited when adding audio; never offer an original containing hidden sound to an agent without audio:read plus media:download.

Add devices:microphone_record to agent scopes and local microphone arming, independent of devices:command/camera arming. Remote commands record_audio/stop_audio include allowed input, max_duration_ms≤120000, selected agent and arming session. Existing TTL/idempotency/unknown-outcome protections apply. Owner must approve the new permission; no token migration grants it. Setup response reports microphone capability and observed route availability without exposing hardware IDs. MCP tools expose the same component selection and evidence endpoints with identical fences; transcripts or lyrics cannot trigger tools.

## Sharing and privacy

Existing share policy must not silently broaden when videos gain sound. Add include_audio=false and include_transcripts=false to every old share; migrate existing shared-video playback to a muted rendition unless owner explicitly grants sound. New share UI independently selects captured media, sound, transcripts and original downloads. Original downloads containing audio require include_audio=true; otherwise provide a sanitized silent export or deny original download. Transcript permission never grants raw audio. A bare audio asset is omitted unless captured media and sound are both allowed. Waveforms and time-coded findings are also private by default.

Broadening previews exact newly exposed items and requires owner confirmation and a policy-version change. New evidence and transcript endpoints recheck current share membership and policy; no owner-signed URL bypass. Keep range/segment revocation behavior. Music matches may be shared as public catalog cards without the private clip or transcript. Do not promise recipients can freely redistribute copyrighted recordings or full lyrics; do not generate full lyric transcripts in Music Mode. Analysis quality and content rights are separate concerns. Owner deletion cancels workers and removes derived speech/text/evidence from serving indexes; retention/purge policies cover all new artifacts.

## Performance and costs

Capture must not wait on AI. Show upload/preparation and per-component progress, not a fake overall percentage. Proposed Music Mode target: a first trustworthy match or explicit no-match within10s p50/25s p95 after a15s clip is ready, to be measured per route. Sound/visual enrichment can finish later. Existing photo latency targets are unchanged. A partial result notice says which component remains pending.

Budget each role separately: recognition windows, ASR audio seconds, sound-model input, frames and synthesis. Reserve worst-case selected work before dispatch; retry under one owner, max1 transport retry per component, uncertain billing reserved until reconciliation. Cache completed work by owner+asset generation+range+component+profile version; never reuse private results across accounts. Changing component selection can reuse authorized completed checkpoints but counts only new dispatch work. Provider402/429 pauses only its affected component; no audio is rerouted to the image fallback. Fused discovery may proceed from selected successful evidence if the UI discloses missing channels.

## Build plan and release gates

1. Add schema2/capabilities and migrations; preserve legacy clients and share semantics.
2. Implement phone/browser audio-only capture, upload/playback/waveform, encrypted drafts and audio preparation. This is core scope even if glasses routing is unavailable.
3. Implement true glasses microphone routing on iOS/Android and experimental DAT video audio separately; compile current SDK bindings and qualify physical devices.
4. Add recognition provider adapter and qualified audio transcription/understanding profiles. Concentrate remains preferred where its actual routes support the role; another audio service requires explicit configuration, retention review and budget approval.
5. Add evidence graph, candidate resolution and Qloo mapping; preserve compiler grounding and quick/enrich behavior.
6. Add timeline/region selection, partial results, collection moments, API/MCP permissions and sharing migration.
7. Run held-out evaluation and two-account physical tests before release. Keep raw capture available when inference is unqualified.

Required release evidence: no camera calls in Music Mode; verified input device; no silent microphone fallback; interruption preservation; A/V synchronization; actual model/recognition route quality; current platform/channel eligibility; explicit audio sharing and scope migration. A provider's support for uploaded audio does not establish its ability to identify music. An SDK's video audio support does not establish a camera-off microphone API.

## Acceptance and evaluation

| ID | Pass condition |
|---|---|
| AUD01 | Music Mode works with camera permission denied; instrumentation records zero camera initialization/frames/network images. |
| AUD02 | Glasses unplug/route switch stops or explicitly asks to switch; metadata always reflects the actual route. |
| AUD03 | Phone, browser, uploaded files and each qualified glasses route pass silence, clipping, noise, interruption, codec and duration tests. |
| AUD04 | Video sound/visual/both selections produce timestamped independent evidence; silent video reports no sound, not provider failure. |
| AUD05 | ASR cannot invent speech in music/silence; uncertain names stay unresolved; visible captions do not become spoken claims. |
| AUD06 | Music suite includes clean recordings, café noise, speech-over-music, live/cover/remix, uncatalogued tracks and multiple songs. Report exact-match precision, false-positive rate, abstention and coverage by route; block automatic Identified labels unless≥99% precision on at least200 held-out matched/negative clips and separately inspect each input-route slice. Report confidence intervals; this sample threshold is an initial gate, not a universal accuracy guarantee. |
| AUD07 | Qloo seed IDs are returned catalog IDs; artist/album mapping ambiguity is preserved. Affinity never appears as recognition confidence. |
| AUD08 | New audio scopes grant nothing to old agents; revoked agents cannot read transcripts, fetch sound, execute queued commands or publish results. |
| AUD09 | Old shares remain silent; transcript/audio/original toggles cannot bypass each other, including range requests and cached playback. |
| AUD10 | Two accounts, separate devices/networks and founder systems off: capture, identify, explore and share only authorized data. |
| AUD11 | Cancellation/deletion/revocation during extraction/inference prevents stale result publication; cleanup includes waveform/transcript/indexes. |
| AUD12 | Credit outage/timeout preserves captures and successful components; retry does not duplicate logical jobs or hide unknown provider charges. |
| AUD13 | Legacy clients never crash on unknown audio enums; v2.2 onboarding/taste behavior and existing photo tests remain intact. |

## Screen extension

New references19–23 are in [the audio mockup gallery](design/audio.html). They extend existing screens01–18 on the integration branch:19 Music recorder,20 Audio detail and selection,21 Video evidence timeline,22 Granular discovery,23 Sound sharing permissions. The recorder must be fully usable without sight: accessible record/stop state and elapsed time, meaningful input labels and non-color status. Waveforms have keyboard/numeric range controls. Media does not autoplay with sound. Reduced-motion and safe-area rules remain in force.

## Extracting and keeping source material

“Extract sound” creates a private derivative containing the selected existing soundtrack, not generated audio and not separated vocals/instruments. “Save moment” creates a time-range reference; “Save frame” creates an owner-scoped image derivative from an exact decoded frame. Source separation, stem generation, full lyric extraction, unlimited background listening and live continuous surveillance are outside2.3. Multiple soundtrack tracks require an explicit track selection; default to the primary playable track and disclose it. No inferred sound is generated for silent video.

When users export derived audio/images as standalone library items, store parent_asset_id and parent_generation, preserve ownership, record the transform, and require an explicit Keep action. A saved derived item cannot broaden a parent share/agent grant by itself. Parent deletion revokes derivative serving and schedules purge; if a future product allows independently retained copies, that must be a separate explicit copy/retention contract, not a hidden side effect.

## Concrete contract examples

The schema2 example and analysis request live in [audio-contract.examples.json](audio-contract.examples.json). They are proposed wire examples, not a claim that current endpoints accept them. Empty or unsupported component selections return422 with supported_components; a photo plus music_match returns422 before spend reservation. Missing transcript permission returns403 without revealing transcript existence. An absent audio track yields a no_result component with reason no_audio_track; unavailable provider yields unavailable with a different reason. Requested selection outside duration returns422 rather than silently shifting the evidence range.

## External release constraints as of October21

Meta's official October16 response limits in-stream audio to development/beta channels and notes that HFP may interrupt camera sessions on some firmware. Keep HFP audio-only and DAT video-audio paths distinct; do not combine them as an untested workaround. Native build qualification must verify current SDK methods and firmware, including Android's existing unverified binding. Experimental audio flags are capability-specific; disable only unsupported routes and preserve phone/browser audio core functionality. See linked research for exact primary sources and unresolved account/route eligibility.

## ElevenLabs integration decision

**Preferred transcription candidate: ElevenLabs Scribe v2**, pending account privacy eligibility and held-out audio qualification. Its documented speech API accepts recordings/video, timestamps words and optionally tags non-speech events. [Transcription overview](https://elevenlabs.io/docs/overview/capabilities/speech-to-text). This supports spoken cultural references and coarse audio-event evidence; it does not establish catalog song recognition or detailed acoustic scene understanding. Keep fingerprint matching separate.

Implement an ElevenLabsTranscription adapter behind the audio role interface. Worker sends only the authorized audio selection as a multipart file to POST `https://api.elevenlabs.io/v1/speech-to-text`, with server-held `xi-api-key`, model_id=scribe_v2, timestamps_granularity=word, diarize=false. Disable transcript editing and automatic transcription of Music Mode. Enable event tags only for an explicitly requested compatible task. Use the original transcript as evidence, not polished paraphrases. Convert returned seconds to canonical milliseconds plus the extraction offset, validate bounds and map gaps. [Endpoint contract](https://elevenlabs.io/docs/api-reference/speech-to-text/convert).

Default to worker batch transcription for this release; live captions are a later separately qualified option. Apply the same audio-second reservation, retry ownership, authorization fences and deletion checks as other components. An event such as music is a broad observation, not a recognized recording. A recognition request alone must never invoke Scribe on incidental conversation.

Privacy is an activation gate: the batch endpoint defaults logging on, and its documented zero-retention flag is enterprise-only. Require verified account eligibility and enable_logging=false; otherwise leave this private-audio route unavailable until an explicit alternative retention policy is approved. Do not silently accept standard logging. Realtime documentation includes a warning that requested zero retention can be rejected while logging continues; any later realtime adapter must establish eligibility before sending samples and stop on such a warning. [Realtime contract](https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime).

ElevenLabs usage has its own credentials and spending ceiling; Concentrate credits are not assumed to cover it. Proposed stack: ElevenLabs for opted-in transcription, a qualified recognizer for song identity, Concentrate for visual/text interpretation, Qloo for related culture. Voice generation is outside this capture/analysis amendment.
