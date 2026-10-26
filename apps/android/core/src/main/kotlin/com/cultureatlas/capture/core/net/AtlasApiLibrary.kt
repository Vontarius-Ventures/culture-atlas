package com.cultureatlas.capture.core.net

import com.cultureatlas.capture.core.contract.AnalysisResultResponse
import com.cultureatlas.capture.core.contract.CaptureResultResponse
import com.cultureatlas.capture.core.contract.CityRequest
import com.cultureatlas.capture.core.contract.LibraryEntry
import com.cultureatlas.capture.core.contract.MediaLibraryResponse
import kotlinx.serialization.json.JsonObject
import java.util.UUID

/*
 * Library grid and the in-app result screen. `/v2` routes accept the enrolled
 * phone directly. `GET /v1/captures/{id}` (references, recommendations, style
 * reading, rails), the style retry and `PUT /v1/me/city` go through the native
 * owner bridge (packages/domain/src/authz/native-owner.ts), limited to the
 * signed-in account's own captures. An older server answers `scope_denied`;
 * the result screen then shows what `/v2` already returned.
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

/**
 * `POST /v1/captures/{id}/style/retry` — re-queues only the style stage (202). Allowed once per
 * analysis; a second try fails with 409 `retry_used`. Idempotent per [key].
 */
suspend fun AtlasApi.retryStyle(captureId: String, key: UUID = UUID.randomUUID()): JsonObject =
    call<Unit, JsonObject>(
        "POST", "/v1/captures/${captureId.lowercase()}/style/retry", null, null,
        JsonObject.serializer(), idempotencyKey = key,
    )

/** Longest city the server accepts (design C.6). */
const val CITY_MAX_LENGTH = 80

/**
 * `PUT /v1/me/city` (204) — the one explicit city source for place rails. The value travels in
 * the body only, never in a URL. Blank or `null` clears it.
 */
suspend fun AtlasApi.setCity(city: String?, key: UUID = UUID.randomUUID()) {
    val value = city?.trim()?.take(CITY_MAX_LENGTH)?.takeIf { it.isNotEmpty() }
    call("PUT", "/v1/me/city", CityRequest(value), CityRequest.serializer(), JsonObject.serializer(), idempotencyKey = key)
}

/** Path of a media rendition on the API host (needs the bearer token). */
fun mediaContentPath(mediaId: String, variant: String = "poster"): String =
    "/v2/media/${mediaId.lowercase()}/content/$variant"
