package com.cultureatlas.capture.core.contract

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * Wire models for Music Mode keep and explore (domain `schemas/audio.ts`,
 * amendment 2.3). Keep never requests analysis. Explore sends
 * `contract_version: 2` and `music_match` only — no speech, no ElevenLabs.
 */

@Serializable
data class KeepAudioRecordingRequest(
    @SerialName("client_capture_id") val clientCaptureId: String,
    val source: MediaSource,
    val filename: String = "music-mode.wav",
    @SerialName("content_type") val contentType: String = "audio/wav",
    @SerialName("captured_at") val capturedAt: String? = null,
    @SerialName("capture_session_id") val captureSessionId: String? = null,
    @SerialName("source_route") val sourceRoute: String = "phone_microphone",
    val title: String? = null,
)

@Serializable
data class AudioSelection(
    @SerialName("track_id") val trackId: String? = null,
    @SerialName("start_ms") val startMs: Int,
    @SerialName("end_ms") val endMs: Int,
)

@Serializable
data class AnalyzeAudioRequest(
    @SerialName("contract_version") val contractVersion: Int = 2,
    @SerialName("expected_generation") val expectedGeneration: Int,
    @SerialName("requested_components") val requestedComponents: List<String> = listOf("music_match"),
    val selection: AudioSelection,
)

@Serializable
data class AudioAssetDto(
    @SerialName("schema_version") val schemaVersion: Int? = null,
    val id: String,
    val kind: MediaKind = MediaKind.AUDIO,
    val source: MediaSource? = null,
    @SerialName("capture_mode") val captureMode: String? = null,
    @SerialName("duration_ms") val durationMs: Int? = null,
    @SerialName("sample_rate_hz") val sampleRateHz: Int? = null,
    val channels: Int? = null,
    val codec: String? = null,
    @SerialName("source_route") val sourceRoute: String? = null,
    val status: String? = null,
    @SerialName("analysis_status") val analysisStatus: String? = null,
    @SerialName("camera_active") val cameraActive: Boolean = false,
    @SerialName("speech_analysis") val speechAnalysis: String? = null,
)

@Serializable
data class KeptAudioResponse(
    val media: AudioAssetDto? = null,
    val generation: Int = 1,
    val revision: Int? = null,
    @SerialName("track_id") val trackId: String? = null,
    @SerialName("asset_id") val assetId: String? = null,
    @SerialName("analysis_status") val analysisStatus: String? = null,
) {
    fun resolvedAssetId(): String? = assetId ?: media?.id
}

@Serializable
data class CreateAudioUploadRequest(
    @SerialName("client_capture_id") val clientCaptureId: String,
    val kind: MediaKind = MediaKind.AUDIO,
    val source: MediaSource,
    val filename: String,
    @SerialName("content_type") val contentType: String,
    @SerialName("byte_size") val byteSize: Long,
    val sha256: String,
    @SerialName("captured_at") val capturedAt: String? = null,
    @SerialName("capture_session_id") val captureSessionId: String? = null,
    @SerialName("capture_mode") val captureMode: String = "music",
    @SerialName("source_route") val sourceRoute: String? = null,
)
