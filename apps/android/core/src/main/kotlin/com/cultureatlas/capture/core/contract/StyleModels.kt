package com.cultureatlas.capture.core.contract

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/*
 * Style reading and style rails (prp/2026-10-23-style-analysis/design.md, E.2 / E.3).
 *
 * Every field is optional with a default so that an older capture (no
 * `style_reading`, no `rails`) and a newer server (fields this client does not
 * know yet) both decode. The client never composes wording: `display` strings
 * are the server's, already decided by `style/wording.ts` and the guardrails.
 * Internal certainty numbers are never sent; `strength` is a coarse band used
 * only for accessibility labels.
 */

/** A normalized rectangle (0–1) on the displayed capture image. */
@Serializable
data class StyleRegion(
    val x: Double = 0.0,
    val y: Double = 0.0,
    val w: Double = 0.0,
    val h: Double = 0.0,
) {
    /** A region the client can draw: inside the image and not degenerate. */
    val drawable: Boolean
        get() = w > 0.0 && h > 0.0 && x >= -0.001 && y >= -0.001 && x + w <= 1.001 && y + h <= 1.001
}

/** A measured swatch of the whole image (the hex comes from real pixels). */
@Serializable
data class StyleSwatch(
    val index: Int = 0,
    val hex: String? = null,
    val share: Double? = null,
)

/**
 * One claim of a style reading. The same shape serves aesthetics, era,
 * lineage, materials, construction, details and mood; slot-specific fields
 * are simply absent where they do not apply.
 */
@Serializable
data class StyleClaim(
    val name: String? = null,
    /** Details carry `text` instead of `name`. */
    val text: String? = null,
    /** The server's words for this claim ("Resembles workwear", "Feels rugged"). Rendered verbatim. */
    val display: String? = null,
    /** `asserted` or `resembles`; anything else is treated as `resembles`. */
    val wording: String? = null,
    /** `clear` | `likely` | `possible` | null — accessibility label only, never drawn. */
    val strength: String? = null,
    val region: StyleRegion? = null,
    val features: List<String> = emptyList(),
    val texture: String? = null,
    val kind: String? = null,
    @SerialName("corroborated_by") val corroboratedBy: List<String> = emptyList(),
    val held: Boolean = false,
    val retracted: Boolean = false,
)

@Serializable
data class StylePaletteEntry(
    val swatch: Int? = null,
    val name: String? = null,
    val hex: String? = null,
    val display: String? = null,
)

@Serializable
data class StyleBrand(
    val name: String? = null,
    @SerialName("read_text") val readText: String? = null,
)

@Serializable
data class StyleSubject(
    val id: String = "",
    val category: String? = null,
    val label: String? = null,
    val region: StyleRegion? = null,
    val aesthetics: List<StyleClaim> = emptyList(),
    val era: StyleClaim? = null,
    val lineage: List<StyleClaim> = emptyList(),
    val materials: List<StyleClaim> = emptyList(),
    val construction: List<StyleClaim> = emptyList(),
    val palette: List<StylePaletteEntry> = emptyList(),
    val mood: List<StyleClaim> = emptyList(),
    val details: List<StyleClaim> = emptyList(),
    val brand: StyleBrand? = null,
    /** Qloo `similar_brand` tag names, shown as text only (never cards). */
    @SerialName("qloo_links") val qlooLinks: List<String> = emptyList(),
    /** Key of this subject's More-like-this rail, e.g. `more_like_this:s1`. */
    val rail: String? = null,
)

/** `GET /v1/captures/{id}` → `style_reading` (null until `sections.style == "ready"`). */
@Serializable
data class StyleReading(
    val version: String? = null,
    val summary: String? = null,
    val swatches: List<StyleSwatch> = emptyList(),
    val subjects: List<StyleSubject> = emptyList(),
    /** Claim paths removed after a stage-2 veto, e.g. `subjects[0].mood[1]`. */
    val retracted: List<String> = emptyList(),
    /** Present on video readings: which frame was read. */
    @SerialName("frame_index") val frameIndex: Int? = null,
)

/** Structured match on a capture card: which attributes of the reading connected it. */
@Serializable
data class StyleMatch(
    @SerialName("subject_id") val subjectId: String? = null,
    val attributes: List<String> = emptyList(),
    val palette: List<String> = emptyList(),
    val via: String? = null,
    val experimental: Boolean = false,
)

/** One rail of `GET /v1/captures/{id}` → `rails[]`, already in display order. */
@Serializable
data class StyleRail(
    val key: String = "",
    /** `more_like_this` | `cross_domain` (unknown kinds render as cross-domain). */
    val kind: String? = null,
    val title: String? = null,
    val subtitle: String? = null,
    @SerialName("subject_id") val subjectId: String? = null,
    /** `pending` | `running` | `ready` | `empty` | `failed` (unknown counts as terminal). */
    val status: String? = null,
    @SerialName("empty_message") val emptyMessage: String? = null,
    val cards: List<DiscoveryCard> = emptyList(),
)

/** The experimental label the server attaches when the reading ran on an unqualified role. */
@Serializable
data class ExperimentalLabel(
    val label: String? = null,
    val note: String? = null,
)

/** `GET /v2/media/{id}/analysis/{analysisId}` → `result.style`: compact preview for the analysis screen. */
@Serializable
data class StylePreviewAesthetic(
    @SerialName("subject_id") val subjectId: String? = null,
    val display: String? = null,
    val wording: String? = null,
)

@Serializable
data class StylePreview(
    val status: String? = null,
    val summary: String? = null,
    val aesthetics: List<StylePreviewAesthetic> = emptyList(),
    val swatches: List<String> = emptyList(),
    @SerialName("frame_index") val frameIndex: Int? = null,
)

/** `PUT /v1/me/city` body. `null` clears the city. */
@Serializable
data class CityRequest(val city: String?)
