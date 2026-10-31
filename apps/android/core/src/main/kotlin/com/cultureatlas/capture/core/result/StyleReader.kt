package com.cultureatlas.capture.core.result

import com.cultureatlas.capture.core.contract.AtlasContract
import com.cultureatlas.capture.core.contract.CaptureResultResponse
import com.cultureatlas.capture.core.contract.DiscoveryCard
import com.cultureatlas.capture.core.contract.ExperimentalLabel
import com.cultureatlas.capture.core.contract.StyleClaim
import com.cultureatlas.capture.core.contract.StylePreview
import com.cultureatlas.capture.core.contract.StyleReading
import com.cultureatlas.capture.core.contract.StyleRegion
import com.cultureatlas.capture.core.contract.StyleSubject
import kotlinx.serialization.json.JsonObject

/**
 * Reads the style reading and rails of `GET /v1/captures/{id}` (design E.2) into what the
 * result screen draws. Pure and testable on the JVM.
 *
 * Rules that keep it honest:
 * - Wording is the server's. Every row is a server `display` string; an `asserted` claim with no
 *   display may show its bare name, but a `resembles` claim (or one with unknown wording) with no
 *   display is dropped rather than worded here, so an uncertain claim is never shown as fact.
 * - Held and retracted claims are never shown.
 * - Palette colours come only from server hex values (measured pixels); an invalid hex is dropped.
 * - Rails are shown exactly as returned; an empty rail is an honest empty, never filled.
 */
object StyleReader {
    const val MAX_DETAIL_PREVIEW = 3
    const val SWATCH_MIN_DP = 28
    const val SWATCH_MAX_DP = 56
    const val MORE_LIKE_THIS = "more_like_this"
    const val CROSS_DOMAIN = "cross_domain"

    private val TERMINAL = setOf("ready", "empty", "failed", "held")
    private val WORKING = setOf("pending", "running")
    private val HEX_RE = Regex("^#[0-9a-fA-F]{6}$")

    // ---- Section state -------------------------------------------------------------------

    fun state(capture: CaptureResultResponse): StyleState {
        val section = capture.analysis?.sections?.get("style")
        return when (section) {
            null -> if (capture.styleReading != null) StyleState.READY else StyleState.ABSENT
            "pending", "running" -> StyleState.READING
            // Ready but the reading has not been written yet: still reading.
            "ready" -> if (capture.styleReading == null) StyleState.READING else StyleState.READY
            "empty" -> StyleState.EMPTY
            "failed" -> StyleState.FAILED
            "held" -> StyleState.HELD
            // Unknown statuses are terminal; show the reading if there is one, otherwise nothing.
            else -> if (capture.styleReading != null) StyleState.READY else StyleState.ABSENT
        }
    }

    /** A status the client may stop polling on. New clients treat unknown statuses as terminal. */
    fun isTerminal(status: String?): Boolean = status == null || status !in WORKING

    /**
     * True when every section and every rail of this capture is terminal (design R-16c).
     * Returns null for an older capture that carries neither `sections` nor `rails`, so the
     * caller can keep its old stop rule.
     */
    fun isSettled(capture: CaptureResultResponse): Boolean? {
        val sections = capture.analysis?.sections.orEmpty()
        val rails = capture.rails
        if (sections.isEmpty() && rails == null) return null
        val sectionsDone = sections.values.all(::isTerminal)
        val railsDone = rails.orEmpty().all { isTerminal(it.status) }
        // "ready" with no reading yet means the write is still landing.
        val readingLanded = sections["style"] != "ready" || capture.styleReading != null
        return sectionsDone && railsDone && readingLanded
    }

    // ---- Experimental label ---------------------------------------------------------------

    fun experimental(capture: CaptureResultResponse?, fallback: ExperimentalLabel? = null): ExperimentalBadge? {
        val label = capture?.analysis?.experimental ?: fallback ?: return null
        return ExperimentalBadge(
            label = label.label?.trim()?.takeIf { it.isNotEmpty() } ?: StyleCopy.BADGE,
            note = label.note?.trim()?.takeIf { it.isNotEmpty() } ?: StyleCopy.NOTE,
        )
    }

    // ---- Reading --------------------------------------------------------------------------

    fun read(capture: CaptureResultResponse): StylePresentation? {
        val reading = capture.styleReading ?: return null
        return read(reading)
    }

    fun read(reading: StyleReading): StylePresentation? {
        val retracted = reading.retracted.toSet()
        val hexByIndex = reading.swatches.associate { it.index to it.hex }
        val shareByIndex = reading.swatches.associate { it.index to (it.share ?: 0.0) }
        val subjects = reading.subjects.mapIndexedNotNull { i, s -> subject(i, s, retracted, hexByIndex, shareByIndex) }
        val summary = reading.summary?.trim()?.takeIf { it.isNotEmpty() }
        if (subjects.isEmpty() && summary == null) return null
        return StylePresentation(summary = summary, subjects = subjects, frameIndex = reading.frameIndex)
    }

    private fun subject(
        index: Int,
        s: StyleSubject,
        retracted: Set<String>,
        hexByIndex: Map<Int, String?>,
        shareByIndex: Map<Int, Double>,
    ): PresentedSubject? {
        val base = "subjects[$index]"
        fun claims(slot: String, list: List<StyleClaim>) =
            list.mapIndexedNotNull { j, c -> claim(c, "$base.$slot[$j]", retracted) }

        val chips = claims("aesthetics", list = s.aesthetics).map { c ->
            AestheticChip(
                text = c.text,
                asserted = c.asserted,
                strength = c.strength,
                region = c.region,
                path = c.path,
            )
        }
        val eraRow = s.era?.let { claim(it, "$base.era", retracted) }
        val groups = listOf(
            DetailGroup(StyleCopy.GROUP_ERA, listOfNotNull(eraRow) + claims("lineage", s.lineage)),
            DetailGroup(StyleCopy.GROUP_MATERIALS, claims("materials", s.materials)),
            DetailGroup(StyleCopy.GROUP_CONSTRUCTION, claims("construction", s.construction)),
            DetailGroup(StyleCopy.GROUP_DETAILS, claims("details", s.details)),
        ).filter { it.rows.isNotEmpty() }

        val palettePaths = s.palette.indices.map { "$base.palette[$it]" }
        val rawPalette = s.palette.mapIndexedNotNull { j, p ->
            if (palettePaths[j] in retracted) return@mapIndexedNotNull null
            val hex = (p.hex ?: p.swatch?.let { hexByIndex[it] })?.trim()
            if (hex == null || !HEX_RE.matches(hex)) return@mapIndexedNotNull null
            val name = (p.display ?: p.name)?.trim()?.takeIf { it.isNotEmpty() } ?: return@mapIndexedNotNull null
            Triple(name, hex, p.swatch?.let { shareByIndex[it] } ?: 0.0)
        }
        val maxShare = rawPalette.maxOfOrNull { it.third }?.takeIf { it > 0.0 }
        val palette = rawPalette.map { (name, hex, share) ->
            val size = if (maxShare == null) SWATCH_MIN_DP
            else (SWATCH_MAX_DP * share / maxShare).toInt().coerceIn(SWATCH_MIN_DP, SWATCH_MAX_DP)
            PresentedSwatch(name = name, hex = hex, argb = argb(hex), sizeDp = size)
        }

        val moods = claims("mood", s.mood).map { it.text }
        val label = s.label?.trim()?.takeIf { it.isNotEmpty() }
        if (label == null && chips.isEmpty() && groups.isEmpty() && palette.isEmpty() && moods.isEmpty()) return null
        return PresentedSubject(
            id = s.id,
            label = label,
            category = s.category,
            region = s.region?.takeIf { it.drawable },
            chips = chips,
            palette = palette,
            detailGroups = groups,
            moodLine = moodLine(moods),
            brand = s.brand?.name?.trim()?.takeIf { it.isNotEmpty() }?.let { name ->
                BrandLine(name, s.brand.readText?.trim()?.takeIf { it.isNotEmpty() }?.let { "Read in the photo: “$it”" })
            },
            qlooLinks = s.qlooLinks.map { it.trim() }.filter { it.isNotEmpty() }.distinct()
                .takeIf { it.isNotEmpty() }?.let { StyleCopy.qlooLinks(it) },
            railKey = s.rail,
        )
    }

    private fun claim(c: StyleClaim, path: String, retracted: Set<String>): DetailRow? {
        if (c.held || c.retracted || path in retracted) return null
        val asserted = c.wording == "asserted"
        val text = c.display?.trim()?.takeIf { it.isNotEmpty() }
            ?: if (asserted) (c.name ?: c.text)?.trim()?.takeIf { it.isNotEmpty() } else null
        text ?: return null
        return DetailRow(
            text = text,
            asserted = asserted,
            strength = strength(c),
            region = c.region?.takeIf { it.drawable },
            path = path,
        )
    }

    /**
     * Strength is an accessibility label only, derived after wording (R-16a): an asserted claim
     * is `clear`/`likely`, a resemblance is `likely`/`possible`. A contradictory band is clamped.
     */
    private fun strength(c: StyleClaim): String? {
        val s = c.strength ?: return null
        return when {
            c.wording == "asserted" -> if (s == "possible") "likely" else s.takeIf { it == "clear" || it == "likely" }
            else -> if (s == "clear") "likely" else s.takeIf { it == "likely" || it == "possible" }
        }
    }

    /** "Feels rugged" + "Feels utilitarian" → "Feels rugged, utilitarian" (server words only). */
    fun moodLine(displays: List<String>): String? {
        if (displays.isEmpty()) return null
        val prefix = "Feels "
        return if (displays.all { it.startsWith(prefix) }) {
            prefix + displays.joinToString(", ") { it.removePrefix(prefix) }
        } else {
            displays.joinToString(", ")
        }
    }

    private fun argb(hex: String): Long = 0xFF000000L or hex.removePrefix("#").toLong(16)

    // ---- Rails ----------------------------------------------------------------------------

    /**
     * Rails in display order. An older capture has no `rails`: its recommendations become one
     * cross-domain row under the existing title, exactly as before.
     */
    fun rails(capture: CaptureResultResponse, experimental: Boolean): List<PresentedRail> {
        val wire = capture.rails
        if (wire == null) {
            if (capture.recommendations.isEmpty()) return emptyList()
            return listOf(
                PresentedRail(
                    key = "recommendations",
                    moreLikeThis = false,
                    title = AnalysisResultCopy.SUGGESTIONS_TITLE,
                    subtitle = null,
                    subjectId = null,
                    state = RailState.READY,
                    message = null,
                    offerCity = false,
                    cards = capture.recommendations,
                    caption = null,
                ),
            )
        }
        var mltCaptioned = false
        var crossCaptioned = false
        return wire.map { r ->
            val more = r.kind == MORE_LIKE_THIS
            val state = when (r.status) {
                "pending", "running" -> if (r.cards.isEmpty()) RailState.RUNNING else RailState.READY
                "empty" -> RailState.EMPTY
                "failed" -> if (r.cards.isEmpty()) RailState.FAILED else RailState.READY
                else -> if (r.cards.isEmpty()) RailState.EMPTY else RailState.READY
            }
            val message = when (state) {
                RailState.RUNNING -> StyleCopy.RAIL_RUNNING
                RailState.EMPTY -> r.emptyMessage?.trim()?.takeIf { it.isNotEmpty() } ?: StyleCopy.RAIL_EMPTY
                RailState.FAILED -> r.emptyMessage?.trim()?.takeIf { it.isNotEmpty() } ?: StyleCopy.RAIL_FAILED
                RailState.READY -> null
            }
            // The caption sits on the first More-like-this rail and once above the cross-domain group (R-17).
            val caption = if (!experimental) null else if (more && !mltCaptioned) {
                mltCaptioned = true
                StyleCopy.RAIL_CAPTION
            } else if (!more && !crossCaptioned) {
                crossCaptioned = true
                StyleCopy.RAIL_CAPTION
            } else {
                null
            }
            PresentedRail(
                key = r.key,
                moreLikeThis = more,
                title = r.title?.trim()?.takeIf { it.isNotEmpty() } ?: if (more) StyleCopy.MORE_LIKE_THIS else AnalysisResultCopy.SUGGESTIONS_TITLE,
                subtitle = r.subtitle?.trim()?.takeIf { it.isNotEmpty() },
                subjectId = r.subjectId,
                state = state,
                message = message,
                offerCity = message == StyleCopy.NO_CITY || message == "Add a city to see places with this style.",
                cards = r.cards,
                caption = caption,
            )
        }
    }

    // ---- Media-analysis preview (E.3) ----------------------------------------------------

    /**
     * What the analysis screen can say about style before the compiled capture loads: ABSENT when
     * the `/v2` result carries no `style` (older servers), READY when its preview is ready,
     * otherwise READING (and FAILED / EMPTY / HELD when the preview says so).
     */
    fun previewState(result: JsonObject?): StyleState {
        val raw = result?.get("style") as? JsonObject ?: return StyleState.ABSENT
        val status = (raw["status"] as? kotlinx.serialization.json.JsonPrimitive)?.takeIf { it.isString }?.content
        return when (status) {
            "ready" -> if (preview(result) != null) StyleState.READY else StyleState.READING
            "empty" -> StyleState.EMPTY
            "failed" -> StyleState.FAILED
            "held" -> StyleState.HELD
            null, "pending", "running" -> StyleState.READING
            else -> StyleState.ABSENT
        }
    }

    /** `result.style` of `GET /v2/media/{id}/analysis/{analysisId}`; null when absent or not ready. */
    fun preview(result: JsonObject?): StylePreviewPresentation? {
        val raw = result?.get("style") as? JsonObject ?: return null
        val preview = runCatching { AtlasContract.json.decodeFromJsonElement(StylePreview.serializer(), raw) }.getOrNull() ?: return null
        if (preview.status != null && preview.status != "ready") return null
        val chips = preview.aesthetics.mapNotNull { a ->
            val text = a.display?.trim()?.takeIf { it.isNotEmpty() } ?: return@mapNotNull null
            AestheticChip(text = text, asserted = a.wording == "asserted", strength = null, region = null, path = null)
        }.take(4)
        val swatches = preview.swatches.map { it.trim() }.filter { HEX_RE.matches(it) }.map { argb(it) }
        val summary = preview.summary?.trim()?.takeIf { it.isNotEmpty() }
        if (chips.isEmpty() && swatches.isEmpty() && summary == null) return null
        return StylePreviewPresentation(summary, chips, swatches)
    }

    // ---- Accessibility ----------------------------------------------------------------------

    /** "highlighted area: upper left of the photo" from the region's centre. */
    fun regionDescription(region: StyleRegion): String {
        val cx = region.x + region.w / 2
        val cy = region.y + region.h / 2
        val v = when {
            cy < 1.0 / 3 -> "upper"
            cy > 2.0 / 3 -> "lower"
            else -> "middle"
        }
        val h = when {
            cx < 1.0 / 3 -> "left"
            cx > 2.0 / 3 -> "right"
            else -> "center"
        }
        val place = when {
            v == "middle" && h == "center" -> "center"
            v == "middle" -> "middle $h"
            h == "center" -> "$v center"
            else -> "$v $h"
        }
        return "highlighted area: $place of the photo"
    }
}

enum class StyleState { ABSENT, READING, READY, EMPTY, FAILED, HELD }

enum class RailState { RUNNING, READY, EMPTY, FAILED }

data class ExperimentalBadge(val label: String, val note: String)

data class StylePresentation(
    val summary: String?,
    val subjects: List<PresentedSubject>,
    val frameIndex: Int?,
)

data class PresentedSubject(
    val id: String,
    val label: String?,
    val category: String?,
    val region: StyleRegion?,
    val chips: List<AestheticChip>,
    val palette: List<PresentedSwatch>,
    val detailGroups: List<DetailGroup>,
    val moodLine: String?,
    val brand: BrandLine?,
    val qlooLinks: String?,
    val railKey: String?,
) {
    val detailCount: Int get() = detailGroups.sumOf { it.rows.size }

    /** The first [limit] rows across groups, keeping group headings (R-17 "Show all details"). */
    fun detailPreview(limit: Int = StyleReader.MAX_DETAIL_PREVIEW): List<DetailGroup> {
        var left = limit
        return detailGroups.mapNotNull { g ->
            if (left <= 0) return@mapNotNull null
            val rows = g.rows.take(left)
            left -= rows.size
            DetailGroup(g.title, rows)
        }
    }
}

data class AestheticChip(
    val text: String,
    val asserted: Boolean,
    val strength: String?,
    val region: StyleRegion?,
    val path: String?,
)

data class DetailRow(
    val text: String,
    val asserted: Boolean,
    val strength: String?,
    val region: StyleRegion?,
    val path: String,
)

data class DetailGroup(val title: String, val rows: List<DetailRow>)

data class PresentedSwatch(val name: String, val hex: String, val argb: Long, val sizeDp: Int)

data class BrandLine(val name: String, val attribution: String?)

data class PresentedRail(
    val key: String,
    val moreLikeThis: Boolean,
    val title: String,
    val subtitle: String?,
    val subjectId: String?,
    val state: RailState,
    /** Running, empty or failed copy; null when the rail has cards. */
    val message: String?,
    /** The empty state is `style.no_city`: offer "Add city". */
    val offerCity: Boolean,
    val cards: List<DiscoveryCard>,
    /** "From your photo" on the first More-like-this rail and once above the cross-domain group. */
    val caption: String?,
)

data class StylePreviewPresentation(
    val summary: String?,
    val chips: List<AestheticChip>,
    val swatches: List<Long>,
)

/** Copy from design D.4 (`design/copy.json` → `experimental`, `style`). Rendered verbatim. */
object StyleCopy {
    const val TITLE = "Style reading"
    const val BADGE = "Experimental"
    const val NOTE = "Readings can miss details."
    const val RAIL_CAPTION = "From your photo"
    const val WHY_LINE = "From your photo."
    const val PAUSED = "Paused for now. Your photo is saved."
    const val LIMIT = "That's all the readings for today. Your photo is saved for tomorrow."
    const val FAILED = "Couldn't read this one."
    const val EMPTY = "No clear style here."
    const val NO_CITY = "Add a city to explore places."
    const val RAIL_EMPTY = "Nothing close enough yet."
    const val READING = "Reading the style…"
    const val RAIL_RUNNING = "Finding more…"
    const val UPDATED = "Style updated"
    const val TRY_AGAIN = "Try again"
    const val ADD_CITY = "Add city"
    const val SHOW_DETAILS = "Show all details"
    const val MORE_LIKE_THIS = "Qloo connections"
    const val SHOW_MORE_LIKE_THIS_STYLE = "More like this"

    /** Not in D.4: a failed rail is not "nothing found", so it says so plainly. */
    const val RAIL_FAILED = "We couldn't load these suggestions."
    /** Not in D.4: the Try-again button was already used (409 `retry_used`). */
    const val RETRY_USED = "This one has already been tried again."

    const val GROUP_ERA = "Era & lineage"
    const val GROUP_MATERIALS = "Materials"
    const val GROUP_CONSTRUCTION = "Construction"
    const val GROUP_DETAILS = "Details"

    fun qlooLinks(names: List<String>): String = "Related: ${names.joinToString(", ")}"

    fun strengthLabel(strength: String?): String? = when (strength) {
        "clear" -> "clear"
        "likely" -> "likely"
        "possible" -> "possible"
        else -> null
    }
}
