package com.cultureatlas.capture.core.contract

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

/**
 * Wire models for the in-app result and the server library (domain
 * `schemas/capture-v2.ts` and `schemas/captures.ts`). Shared by the native
 * AnalysisResult screen and the Library grid so neither leaves the app.
 *
 * Kinds and sources stay strings: the server library may grow kinds (audio)
 * before this client knows them, and an unknown value must not break the grid.
 */

@Serializable
data class MediaLinks(
    val original: String? = null,
    val playback: String? = null,
    val poster: String? = null,
    val analysis: String? = null,
)

@Serializable
data class LibraryMedia(
    val id: String,
    val kind: String,
    val source: String? = null,
    val status: String,
    @SerialName("analysis_status") val analysisStatus: String = "not_requested",
    @SerialName("created_at") val createdAt: String? = null,
    val title: String? = null,
    @SerialName("duration_ms") val durationMs: Int? = null,
    val width: Int? = null,
    val height: Int? = null,
)

/** One item of `GET /v2/library` (a MediaDetailResponse). */
@Serializable
data class LibraryEntry(
    val media: LibraryMedia,
    val generation: Int,
    val revision: Int? = null,
    val links: MediaLinks = MediaLinks(),
    @SerialName("error_code") val errorCode: String? = null,
)

/** `GET /v2/library?cursor=&limit=` — newest first, cursor-paged. */
@Serializable
data class MediaLibraryResponse(
    val items: List<LibraryEntry>,
    @SerialName("next_cursor") val nextCursor: String? = null,
)

/**
 * `GET /v2/media/{id}/analysis/{analysisId}` with its `result` body. The body
 * differs by kind (photo/video: frame-cited candidates; audio: music match),
 * so it is kept as JSON and read by [com.cultureatlas.capture.core.result.AnalysisResultReader].
 */
@Serializable
data class AnalysisResultResponse(
    @SerialName("analysis_id") val analysisId: String,
    @SerialName("job_id") val jobId: String? = null,
    val state: AnalysisState,
    val reused: Boolean = false,
    @SerialName("result_url") val resultUrl: String? = null,
    @SerialName("capture_id") val captureId: String? = null,
    @SerialName("waiting_reason") val waitingReason: String? = null,
    @SerialName("error_code") val errorCode: String? = null,
    val result: JsonObject? = null,
    /** Set when the reading ran on an experimental (unqualified) role; null when qualified. */
    val experimental: ExperimentalLabel? = null,
)

@Serializable
data class CaptureAnalysisSummary(
    val title: String? = null,
    val interpretation: String? = null,
    /** Per-section status (`observations`, `style`, `wear`, …): pending | running | ready | empty | failed | held. */
    val sections: Map<String, String> = emptyMap(),
    /** Experimental label; null when the reading ran on qualified roles. */
    val experimental: ExperimentalLabel? = null,
)

/**
 * `GET /v1/captures/{id}` — the compiled result: sourced references and the
 * Qloo-backed recommendations made from them. Only the fields the native
 * result screen shows are decoded.
 */
@Serializable
data class CaptureResultResponse(
    val id: String,
    val status: String? = null,
    val analysis: CaptureAnalysisSummary? = null,
    val references: List<ItemReference> = emptyList(),
    val recommendations: List<DiscoveryCard> = emptyList(),
    /** Style reading (design E.2); null on older analyses and until `sections.style == "ready"`. */
    @SerialName("style_reading") val styleReading: StyleReading? = null,
    /** Display-ordered rails; null on older analyses (then [recommendations] is the only row). */
    val rails: List<StyleRail>? = null,
    @SerialName("discovery_item_id") val discoveryItemId: String? = null,
    @SerialName("job_id") val jobId: String? = null,
)
