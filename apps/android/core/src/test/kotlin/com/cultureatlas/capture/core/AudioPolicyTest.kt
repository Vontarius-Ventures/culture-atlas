package com.cultureatlas.capture.core

import com.cultureatlas.capture.core.contract.AnalyzeAudioRequest
import com.cultureatlas.capture.core.contract.AnalyzeMediaRequest
import com.cultureatlas.capture.core.contract.AtlasContract
import com.cultureatlas.capture.core.contract.AudioSelection
import com.cultureatlas.capture.core.contract.CreateUploadRequest
import com.cultureatlas.capture.core.contract.KeepAudioRecordingRequest
import com.cultureatlas.capture.core.contract.MediaKind
import com.cultureatlas.capture.core.contract.MediaSource
import com.cultureatlas.capture.core.policy.AudioPolicy
import com.cultureatlas.capture.core.policy.ClipClock
import com.cultureatlas.capture.core.store.DraftRecord
import com.cultureatlas.capture.core.store.PcmWav
import kotlinx.serialization.json.Json
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class AudioPolicyTest {
    private val json = AtlasContract.json

    @Test
    fun musicModeNeverTouchesTheCamera() {
        assertFalse(AudioPolicy.requestsCameraPermission())
        assertFalse(AudioPolicy.initializesCamera())
        assertTrue(AudioPolicy.emptyCameraTrace().cameraOff)
        assertEquals(120, AtlasContract.AUDIO_MAX_SECONDS)
        assertEquals(120, AudioPolicy.MAX_SECONDS)
        assertTrue(AudioPolicy.MICROPHONE_RATIONALE.contains("camera stays off", ignoreCase = true))
        assertFalse(AudioPolicy.MICROPHONE_RATIONALE.contains("camera access is required", ignoreCase = true))
        assertFalse(AudioPolicy.elevenLabsEnabled())
        assertEquals("pcm_s16le", AudioPolicy.CODEC)
        assertEquals("audio/wav", AudioPolicy.CONTENT_TYPE)
    }

    @Test
    fun unverifiedBluetoothIsNeverLabeledGlasses() {
        assertEquals("This phone", AudioPolicy.labelForInput("builtin_mic", verifiedGlasses = false))
        assertEquals("Bluetooth headset", AudioPolicy.labelForInput("bluetooth_headset_input", verifiedGlasses = false))
        assertEquals(
            "Glasses microphone · Verified input",
            AudioPolicy.labelForInput("bluetooth_headset_input", verifiedGlasses = true),
        )
        assertFalse(AudioPolicy.glassesMicrophoneAvailable(false))
        assertEquals(MediaSource.PHONE_MICROPHONE, AudioPolicy.wireSource(verifiedGlasses = false))
        val phone = AudioPolicy.Route("builtin_mic", "This phone", verifiedGlasses = false)
        val claimedGlasses = AudioPolicy.Route("bluetooth_headset_input", "Glasses", verifiedGlasses = true)
        assertTrue(AudioPolicy.silentPhoneFallbackForbidden(claimedGlasses, phone))
        assertFalse(AudioPolicy.routeStillMatches("bluetooth_headset_input", "builtin_mic"))
    }

    @Test
    fun keepIsLocalAndExploreAuthorizesUpload() {
        assertTrue(AudioPolicy.keepSavesLocal(MediaKind.AUDIO))
        assertFalse(AudioPolicy.keepSavesLocal(MediaKind.PHOTO))
        assertTrue(AudioPolicy.exploreAuthorizesUpload(MediaKind.AUDIO))
        assertEquals(listOf("music_match"), AudioPolicy.musicMatchComponents)
        assertTrue(AudioPolicy.KEEP_COPY.contains("does not start analysis", ignoreCase = true))
        val draft = DraftRecord.new(
            "11111111-1111-4111-8111-111111111111",
            MediaKind.AUDIO,
            MediaSource.PHONE_MICROPHONE,
            "audio/wav",
            "2026-10-21T00:00:00Z",
        )
        assertTrue(draft.filename.startsWith("AUD-"))
        assertTrue(draft.filename.endsWith(".wav"))
        assertFalse(draft.cameraActive)
        assertEquals(DraftRecord.Status.AWAITING_REVIEW, draft.status)
        assertEquals(0 to 15_000, AudioPolicy.musicSelection(40_000))
        assertEquals(0 to 12_000, AudioPolicy.musicSelection(12_000))
        assertNull(AudioPolicy.musicSelection(4_000))
    }

    @Test
    fun audioKindAndMicrophoneSourceSerializeOnTheWire() {
        assertEquals("\"audio\"", json.encodeToString(MediaKind.serializer(), MediaKind.AUDIO))
        assertEquals(MediaKind.AUDIO, json.decodeFromString(MediaKind.serializer(), "\"audio\""))
        assertEquals("\"phone_microphone\"", json.encodeToString(MediaSource.serializer(), MediaSource.PHONE_MICROPHONE))
        assertEquals(MediaKind.PHOTO, json.decodeFromString(MediaKind.serializer(), "\"photo\""))
        assertEquals(MediaKind.VIDEO, json.decodeFromString(MediaKind.serializer(), "\"video\""))
    }

    @Test
    fun photoAnalysisRequestStaysByteCompatible() {
        val encoded = Json.parseToJsonElement(
            json.encodeToString(AnalyzeMediaRequest.serializer(), AnalyzeMediaRequest(expectedGeneration = 1)),
        )
        assertEquals(Fixtures.message("analyze_photo_request"), encoded)
    }

    @Test
    fun exploreMusicRequestMatchesContract2MusicMatchOnly() {
        val encoded = Json.parseToJsonElement(
            json.encodeToString(
                AnalyzeAudioRequest.serializer(),
                AnalyzeAudioRequest(
                    expectedGeneration = 1,
                    requestedComponents = AudioPolicy.musicMatchComponents,
                    selection = AudioSelection(trackId = "11111111-1111-4111-8111-111111111111", startMs = 0, endMs = 15_000),
                ),
            ),
        ).obj
        assertEquals(2, encoded["contract_version"].int)
        assertEquals(listOf("music_match"), encoded["requested_components"]!!.arr.map { it.str })
        assertNull(encoded["mode"]?.str)
        assertNull(encoded["focus"]?.str)
        assertEquals(0, encoded["selection"]!!.obj["start_ms"].int)
        assertEquals(15_000, encoded["selection"]!!.obj["end_ms"].int)
        assertFalse(encoded.toString().contains("speech"))
        assertFalse(encoded.toString().contains("eleven", ignoreCase = true))
    }

    @Test
    fun keepAudioRequestIsWavWithoutAnalysis() {
        val encoded = Json.parseToJsonElement(
            json.encodeToString(
                KeepAudioRecordingRequest.serializer(),
                KeepAudioRecordingRequest(
                    clientCaptureId = "11111111-1111-4111-8111-111111111111",
                    source = MediaSource.PHONE_MICROPHONE,
                    sourceRoute = "builtin_mic",
                ),
            ),
        ).obj
        assertEquals("audio/wav", encoded["content_type"].str)
        assertEquals("music-mode.wav", encoded["filename"].str)
        assertEquals("phone_microphone", encoded["source"].str)
        assertNull(encoded["requested_components"]?.arr)
        assertTrue(AudioPolicy.qualifiedKeepContentType("audio/wav"))
        assertFalse(AudioPolicy.qualifiedKeepContentType("audio/mpeg"))
    }

    @Test
    fun photoUploadRequestOmitsAudioRoute() {
        val example = Fixtures.message("create_upload_photo_request")
        val model = json.decodeFromString(CreateUploadRequest.serializer(), example.toString())
        assertNull(model.sourceRoute)
        assertNull(model.captureMode)
        assertEquals(example, Json.parseToJsonElement(json.encodeToString(CreateUploadRequest.serializer(), model)))
    }

    @Test
    fun audioReservationUploadSendsKindAudio() {
        val encoded = Json.parseToJsonElement(
            json.encodeToString(
                CreateUploadRequest.serializer(),
                CreateUploadRequest(
                    clientCaptureId = "11111111-1111-4111-8111-111111111111",
                    kind = MediaKind.AUDIO,
                    source = MediaSource.UPLOAD,
                    filename = "clip.wav",
                    contentType = "audio/wav",
                    byteSize = 100,
                    sha256 = "a".repeat(64),
                    captureMode = "music",
                ),
            ),
        ).obj
        assertEquals("audio", encoded["kind"].str)
        assertEquals("music", encoded["capture_mode"].str)
        assertEquals("audio/wav", encoded["content_type"].str)
    }

    @Test
    fun pcmWavRoundTrip() {
        val pcm = ByteArray(16_000 * 2) // 1s mono 16kHz
        val wav = PcmWav.wrapPcm(pcm, 16_000, 1)
        val info = PcmWav.parse(wav)
        assertEquals(1_000, info.durationMs)
        assertEquals(16_000, info.sampleRateHz)
        assertEquals(1, info.channels)
        assertEquals("pcm_s16le", info.codec)
        assertEquals("RIFF", String(wav, 0, 4, Charsets.US_ASCII))
        assertEquals("WAVE", String(wav, 8, 4, Charsets.US_ASCII))
    }

    @Test
    fun audioClockUsesTwoMinuteLimit() {
        val clock = ClipClock(limitSeconds = AudioPolicy.MAX_SECONDS)
        assertEquals("0:12 / 2:00", clock.display(12.0).elapsedText)
        assertTrue(clock.display(120.0).shouldStop)
    }

    @Test
    fun captureStatesAreSpokenWithoutColor() {
        assertTrue(AudioPolicy.CaptureState.RECORDING.spoken.contains("Recording audio"))
        assertTrue(AudioPolicy.CaptureState.IDLE.spoken.contains("Not recording"))
        assertTrue(AudioPolicy.CaptureState.entries.all { it.spoken.contains("Camera", ignoreCase = true) })
    }
}
