package com.cultureatlas.capture.core.result

import com.cultureatlas.capture.core.contract.AnalysisResultResponse
import com.cultureatlas.capture.core.contract.AnalysisState
import com.cultureatlas.capture.core.contract.CaptureResultResponse
import com.cultureatlas.capture.core.contract.ItemReference
import com.cultureatlas.capture.core.contract.LibraryEntry
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Reads the `result` body of `GET /v2/media/{id}/analysis/{analysisId}` into
 * what the native result screen shows. Nothing is invented: every line comes
 * from the server's published (guardrailed) result, and a malformed or empty
 * body reads as [AnalysisReading.Nothing], never as a guess.
 *
 * - photo / video: `{ mode, note, frames: [...], candidates: [{ name, type, relation, cited_frames }] }`
 * - audio (Music Mode): `{ music, components, qloo_seeds: [{ entity_id, entity_type, name }] }`
 */
object AnalysisResultReader {
    const val MAX_SEEN = 12

    fun read(response: AnalysisResultResponse): AnalysisReading = read(response.result)

    /**
     * The style reading of a compiled capture, built only from the server's `display` strings
     * (see [StyleReader]); null for an older analysis or before the reading lands.
     */
    fun readStyle(capture: CaptureResultResponse): StylePresentation? = StyleReader.read(capture)

    /** The compact `result.style` preview of the analysis screen (design E.3). */
    fun readStylePreview(response: AnalysisResultResponse): StylePreviewPresentation? = StyleReader.preview(response.result)

    fun read(result: JsonObject?): AnalysisReading {
        if (result == null) return AnalysisReading.Nothing
        if ("music" in result || "qloo_seeds" in result) return readMusic(result)
        if ("candidates" in result || "frames" in result) return readVision(result)
        return AnalysisReading.Nothing
    }

    private fun readVision(result: JsonObject): AnalysisReading.Vision {
        val seen = (result["candidates"] as? JsonArray).orEmpty().mapNotNull { element ->
            val o = element as? JsonObject ?: return@mapNotNull null
            val name = o.string("name")?.trim()?.takeIf { it.isNotEmpty() } ?: return@mapNotNull null
            val relation = o.string("relation")
            Seen(
                name = name,
                type = o.string("type"),
                resembles = relation == "resembles",
                frames = (o["cited_frames"] as? JsonArray)?.size ?: 0,
            )
        }.distinctBy { it.name.lowercase() to it.type }.take(MAX_SEEN)
        val frames = (result["frames"] as? JsonArray).orEmpty()
        val looked = frames.count { (it as? JsonObject)?.string("state") == "complete" }
        return AnalysisReading.Vision(
            seen = seen,
            framesLooked = looked,
            framesTotal = frames.size,
            note = result.string("note")?.trim()?.takeIf { it.isNotEmpty() },
            video = result.string("mode").let { it == "sampled_video" || it == "selected_frame" },
        )
    }

    private fun readMusic(result: JsonObject): AnalysisReading.Music {
        val outcome = when (result.string("music")) {
            "identified" -> MusicOutcome.IDENTIFIED
            "possible_matches" -> MusicOutcome.POSSIBLE
            "no_reliable_match" -> MusicOutcome.NO_MATCH
            "provider_unavailable" -> MusicOutcome.UNAVAILABLE
            else -> MusicOutcome.UNKNOWN
        }
        val artists = (result["qloo_seeds"] as? JsonArray).orEmpty().mapNotNull { element ->
            val o = element as? JsonObject ?: return@mapNotNull null
            val id = o.string("entity_id")?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
            val name = o.string("name")?.trim()?.takeIf { it.isNotEmpty() } ?: return@mapNotNull null
            Artist(id, name)
        }.distinctBy { it.entityId }
        // An identified song with no resolved Qloo artist is shown as "possible", never as a match.
        val shown = if (outcome == MusicOutcome.IDENTIFIED && artists.isEmpty()) MusicOutcome.POSSIBLE else outcome
        return AnalysisReading.Music(shown, if (shown == MusicOutcome.NO_MATCH || shown == MusicOutcome.UNAVAILABLE) emptyList() else artists)
    }

    private fun JsonObject.string(key: String): String? = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
    private fun JsonArray?.orEmpty(): List<JsonElement> = this ?: emptyList()
}

sealed interface AnalysisReading {
    data object Nothing : AnalysisReading

    data class Vision(
        val seen: List<Seen>,
        val framesLooked: Int,
        val framesTotal: Int,
        val note: String?,
        val video: Boolean,
    ) : AnalysisReading

    data class Music(val outcome: MusicOutcome, val artists: List<Artist>) : AnalysisReading
}

data class Seen(val name: String, val type: String?, val resembles: Boolean, val frames: Int) {
    /** A resemblance is never phrased as a match (same rule as ItemReference.qualified). */
    val phrase: String get() = if (resembles) "Resembles $name" else name
    val typeLabel: String? get() = AnalysisResultCopy.typeLabel(type)
}

data class Artist(val entityId: String, val name: String)

enum class MusicOutcome { IDENTIFIED, POSSIBLE, NO_MATCH, UNAVAILABLE, UNKNOWN }

/** Words for the result screen. Status is always in words, never colour alone. */
object AnalysisResultCopy {
    const val LOOKING = "Looking…"
    const val SEEN_TITLE = "What we saw"
    const val SUGGESTIONS_TITLE = "Suggestions from this"
    const val SUGGESTIONS_IN_FEED = "Suggestions from this join your Feed as they're found."
    const val NOTHING_NAMED = "We looked closely but couldn't name anything with confidence. Nothing was guessed."
    const val OPEN_FEED = "See your Feed"

    fun headline(state: AnalysisState, reading: AnalysisReading): String = when (state) {
        AnalysisState.QUEUED, AnalysisState.RUNNING -> LOOKING
        AnalysisState.FAILED -> "We couldn't finish looking"
        AnalysisState.CANCELLED -> "This exploration was stopped"
        AnalysisState.COMPLETE, AnalysisState.PARTIAL -> when (reading) {
            is AnalysisReading.Music -> when (reading.outcome) {
                MusicOutcome.IDENTIFIED -> "We heard ${reading.artists.first().name}"
                MusicOutcome.POSSIBLE -> if (reading.artists.isEmpty()) "We heard music we couldn't place" else "It might be one of these"
                MusicOutcome.NO_MATCH -> "We couldn't name this song"
                MusicOutcome.UNAVAILABLE -> "Music matching isn't available right now"
                MusicOutcome.UNKNOWN -> "Here's what we found"
            }
            is AnalysisReading.Vision -> if (reading.seen.isEmpty()) "Nothing we could name" else "Here's what we found"
            AnalysisReading.Nothing -> "Here's what we found"
        }
    }

    fun detail(response: AnalysisResultResponse): String? = when (response.state) {
        AnalysisState.QUEUED -> when (response.waitingReason) {
            "ai_paused" -> "Exploring is paused for a moment. It picks up again on its own."
            "rate_limited" -> "Lots of people are exploring right now. Yours is next in line."
            else -> "Waiting its turn. This usually takes a few seconds."
        }
        AnalysisState.RUNNING -> "Reading the picture closely. This usually takes a few seconds."
        AnalysisState.FAILED -> when (response.errorCode) {
            "analysis_unavailable" -> "Exploring isn't available right now. Your capture is safe in your library."
            "quota_exceeded" -> "You've reached today's exploring allowance. Try again tomorrow."
            else -> "Something went wrong while looking. Your capture is safe in your library."
        }
        AnalysisState.CANCELLED -> "Nothing more will be looked at for this one."
        AnalysisState.PARTIAL -> "Some of it couldn't be read, so this is what we could see."
        AnalysisState.COMPLETE -> null
    }

    fun isWorking(state: AnalysisState): Boolean = state == AnalysisState.QUEUED || state == AnalysisState.RUNNING

    fun typeLabel(type: String?): String? = when (type) {
        "object" -> "Object"
        "creator" -> "Creator"
        "work" -> "Work"
        "brand" -> "Brand"
        "style" -> "Style"
        "tradition" -> "Tradition"
        "place" -> "Place"
        "cuisine" -> "Cuisine"
        else -> null
    }
}

/**
 * A request to open the in-app result for one analysis (toast, notification
 * or library tile). Both ids must be UUIDs: notification extras are data, and
 * nothing else may reach an API path.
 */
data class ResultRoute(val mediaId: String, val analysisId: String) {
    companion object {
        private val UUID_RE = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")

        fun parse(mediaId: String?, analysisId: String?): ResultRoute? {
            if (mediaId == null || analysisId == null) return null
            if (!UUID_RE.matches(mediaId) || !UUID_RE.matches(analysisId)) return null
            return ResultRoute(mediaId.lowercase(), analysisId.lowercase())
        }
    }
}

/**
 * How a reference is phrased (same rule as the web's `referencePhrase`):
 * a text-only reference is the name it was read as; a qualified reference or a
 * resemblance is "Resembles …"; only an unqualified depiction is the bare name.
 */
object ReferenceCopy {
    fun phrase(ref: ItemReference): String = when {
        !ref.readText.isNullOrBlank() -> ref.name
        ref.qualified || ref.relation == "resembles" -> "Resembles ${ref.name}"
        else -> ref.name
    }

    fun attribution(ref: ItemReference): String? =
        ref.readText?.takeIf { it.isNotBlank() }?.let { "Read in the photo: “$it”" }
}

/** Library tile words and which picture to show, from one `/v2/library` entry. */
object LibraryTileCopy {
    /** Poster for a video, the normalized picture for a photo; null shows a quiet placeholder. */
    fun picturePath(entry: LibraryEntry): String? =
        entry.links.poster ?: if (entry.media.kind == "photo") entry.links.playback else null

    fun status(entry: LibraryEntry): String = when (entry.media.status) {
        "pending_upload" -> "Uploading"
        "verifying" -> "Checking on the server"
        "processing" -> "Preparing"
        "failed" -> "Couldn't prepare"
        else -> when (entry.media.analysisStatus) {
            "queued", "running" -> "Looking…"
            "complete" -> "Explored"
            "failed" -> "Couldn't explore"
            else -> if (entry.media.kind == "video") "Video" else "Photo"
        }
    }

    fun canExplore(entry: LibraryEntry): Boolean =
        entry.media.status == "ready" && entry.media.kind in setOf("photo", "video")

    fun analysisMode(kind: String): String = if (kind == "video") "sampled_video" else "photo"
}
