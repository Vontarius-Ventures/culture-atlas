package com.cultureatlas.capture.core.net

import com.cultureatlas.capture.core.contract.AnalysisResultResponse
import com.cultureatlas.capture.core.contract.CaptureResultResponse
import com.cultureatlas.capture.core.contract.LibraryEntry
import com.cultureatlas.capture.core.contract.MediaLibraryResponse

/*
 * Library grid and the in-app result screen. `/v2` routes accept the enrolled
 * phone directly. `GET /v1/captures/{id}` (references + recommendations) goes
 * through the native owner bridge (packages/domain/src/authz/native-owner.ts),
 * read-only and limited to the signed-in account's own captures. An older
 * server answers `scope_denied`; the result screen then shows what `/v2`
 * already returned.
 */

/** Newest first. [cursor] is the previous page's `next_cursor`. */
suspend fun AtlasApi.library(cursor: String? = null, limit: Int = 30): MediaLibraryResponse {
    val query = buildMap {
        put("limit", limit.coerceIn(1, 100).toString())
        cursor?.takeIf { it.isNotBlank() }?.let { put("cursor", it) }
    }
    return get("/v2/library", MediaLibraryResponse.serializer(), query)
}

/** `GET /v2/media/{id}` read as a library entry (photo, video or a kept recording). */
suspend fun AtlasApi.mediaEntry(mediaId: String): LibraryEntry =
    get("/v2/media/${mediaId.lowercase()}", LibraryEntry.serializer())

suspend fun AtlasApi.analysisResult(mediaId: String, analysisId: String): AnalysisResultResponse =
    get("/v2/media/${mediaId.lowercase()}/analysis/${analysisId.lowercase()}", AnalysisResultResponse.serializer())

suspend fun AtlasApi.captureResult(captureId: String): CaptureResultResponse =
    get("/v1/captures/${captureId.lowercase()}", CaptureResultResponse.serializer())

/** Path of a media rendition on the API host (needs the bearer token). */
fun mediaContentPath(mediaId: String, variant: String = "poster"): String =
    "/v2/media/${mediaId.lowercase()}/content/$variant"
