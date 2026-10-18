package com.cultureatlas.capture.core.contract

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

// Wire models for taste onboarding (spec amendment 2.2, screens 14, 15 and
// 18), Settings → Taste, push registration and ready notices. The onboarding
// routes are the server's /v1/onboarding/... and /v1/taste/picks, which an
// enrolled phone may call as its account owner (native owner bridge,
// fixtures/native-contract/onboarding.json). Written independently of the iOS
// client and checked against messages.json by OnboardingTest.

@Serializable
enum class TasteCategory(val wire: String) {
    @SerialName("wear") WEAR("wear"),
    @SerialName("play") PLAY("play"),
    @SerialName("watch") WATCH("watch"),
    @SerialName("eat") EAT("eat"),
}

@Serializable
data class OnboardingImage(
    /** Public asset path ("/samples/…") resolved against the API base URL, or an absolute https URL. */
    val url: String,
    val width: Int,
    val height: Int,
    val alt: String,
    val credit: String? = null,
    val license: String? = null,
) {
    fun resolved(baseUrl: String): String? = when {
        url.startsWith("https://") -> url
        url.startsWith("/") -> baseUrl.trimEnd('/') + url
        else -> null
    }
}

@Serializable
data class OnboardingCatalogEntry(
    val id: String,
    val kind: String,
    val category: TasteCategory,
    val label: String,
    val image: OnboardingImage? = null,
    val picked: Boolean,
    @SerialName("pick_id") val pickId: String? = null,
)

@Serializable
data class OnboardingChips(
    val wear: List<OnboardingCatalogEntry>,
    val play: List<OnboardingCatalogEntry>,
    val watch: List<OnboardingCatalogEntry>,
    val eat: List<OnboardingCatalogEntry>,
) {
    operator fun get(category: TasteCategory): List<OnboardingCatalogEntry> = when (category) {
        TasteCategory.WEAR -> wear
        TasteCategory.PLAY -> play
        TasteCategory.WATCH -> watch
        TasteCategory.EAT -> eat
    }
}

@Serializable
data class OnboardingCatalog(
    @SerialName("catalog_version") val catalogVersion: String,
    val images: List<OnboardingCatalogEntry>,
    val chips: OnboardingChips,
    @SerialName("exclusion_suggestions") val exclusionSuggestions: List<String>,
    @SerialName("min_picks") val minPicks: Int,
) {
    val allEntries: List<OnboardingCatalogEntry> get() = images + TasteCategory.entries.flatMap { chips[it] }
}

@Serializable
data class OnboardingSearchResult(
    /** Opaque, server-signed token: the only way to save a search result. */
    @SerialName("result_id") val resultId: String,
    val name: String,
    @SerialName("type_label") val typeLabel: String,
    val category: TasteCategory? = null,
    val picked: Boolean,
)

@Serializable
data class OnboardingSearchResponse(val status: String, val results: List<OnboardingSearchResult>) {
    val unavailable: Boolean get() = status == "unavailable"
}

/**
 * POST /v1/onboarding/picks and /v1/taste/picks. A client can only name a
 * catalog item or a signed search result, never a provider id of its own.
 */
@Serializable
data class CreatePickRequest(
    val source: String,
    @SerialName("catalog_item_id") val catalogItemId: String? = null,
    @SerialName("result_id") val resultId: String? = null,
) {
    companion object {
        fun catalog(itemId: String) = CreatePickRequest(source = "catalog", catalogItemId = itemId)
        fun search(resultId: String) = CreatePickRequest(source = "search", resultId = resultId)
    }
}

/** One counted choice, backed by one or more explicit saves (a multi-tag image counts once). */
@Serializable
data class OnboardingPick(
    val id: String,
    val source: String,
    @SerialName("catalog_item_id") val catalogItemId: String? = null,
    val label: String,
    val category: TasteCategory? = null,
    @SerialName("item_kind") val itemKind: String,
    @SerialName("saved_item_ids") val savedItemIds: List<String>,
    @SerialName("discovery_item_ids") val discoveryItemIds: List<String>,
    val image: OnboardingImage? = null,
    @SerialName("created_at") val createdAt: String,
)

@Serializable
data class OnboardingState(
    val required: Boolean,
    @SerialName("picks_count") val picksCount: Int,
    @SerialName("min_picks") val minPicks: Int,
    @SerialName("started_at") val startedAt: String? = null,
    @SerialName("completed_at") val completedAt: String? = null,
    @SerialName("catalog_version") val catalogVersion: String? = null,
)

@Serializable
data class CreatePickResponse(
    val pick: OnboardingPick,
    val state: OnboardingState,
    @SerialName("taste_revision") val tasteRevision: Int,
    @SerialName("already_picked") val alreadyPicked: Boolean,
)

@Serializable
data class DeletePickResponse(
    @SerialName("removed_pick_id") val removedPickId: String,
    val state: OnboardingState,
    @SerialName("taste_revision") val tasteRevision: Int,
)

/** PUT /v1/onboarding/exclusions request and response (preferences, never picks). */
@Serializable
data class FoodExclusionsBody(@SerialName("food_exclusions") val foodExclusions: List<String>)

@Serializable
enum class SeedState {
    @SerialName("not_started") NOT_STARTED,
    @SerialName("queued") QUEUED,
    @SerialName("running") RUNNING,
    @SerialName("retrying") RETRYING,
    @SerialName("partial") PARTIAL,
    @SerialName("complete") COMPLETE,
    @SerialName("failed") FAILED,
}

@Serializable
enum class SeedCategoryState {
    @SerialName("pending") PENDING,
    @SerialName("ready") READY,
    @SerialName("empty") EMPTY,
    @SerialName("unavailable") UNAVAILABLE,
}

@Serializable
data class SeedCategory(
    val category: TasteCategory,
    val state: SeedCategoryState,
    @SerialName("card_count") val cardCount: Int,
    @SerialName("ready_at") val readyAt: String? = null,
)

@Serializable
data class TasteSeedStatus(
    @SerialName("job_id") val jobId: String? = null,
    val state: SeedState,
    val categories: List<SeedCategory>,
    @SerialName("first_ready_at") val firstReadyAt: String? = null,
    @SerialName("poll_after_ms") val pollAfterMs: Long? = null,
)

@Serializable
data class OnboardingStateResponse(
    val state: OnboardingState,
    val picks: List<OnboardingPick>,
    @SerialName("food_exclusions") val foodExclusions: List<String>,
    val seed: TasteSeedStatus,
)

@Serializable
data class CompleteOnboardingResponse(val state: OnboardingState, val seed: TasteSeedStatus)

/** POST /v1/onboarding/complete takes an empty object. */
@Serializable
class EmptyBody

@Serializable
data class GroupedPicks(
    val wear: List<OnboardingPick>,
    val play: List<OnboardingPick>,
    val watch: List<OnboardingPick>,
    val eat: List<OnboardingPick>,
    val other: List<OnboardingPick>,
) {
    val all: List<OnboardingPick> get() = wear + play + watch + eat + other
}

/** GET /v1/taste/picks (Settings → Taste). */
@Serializable
data class TastePicksResponse(
    val picks: GroupedPicks,
    @SerialName("picks_count") val picksCount: Int,
    @SerialName("food_exclusions") val foodExclusions: List<String>? = null,
)

/** /v1 errors are flat ({code,message,retryable,request_id}), unlike /v2. */
@Serializable
data class FlatServerError(
    val code: String,
    val message: String,
    val retryable: Boolean,
    @SerialName("request_id") val requestId: String,
    @SerialName("retry_after_ms") val retryAfterMs: Double? = null,
)

// Push registration and ready notices

/** PUT /v2/device/push-token. The token is a secret of this installation. */
@Serializable
data class PushTokenRequest(val provider: String, val token: String, val environment: String)

@Serializable
data class PushTokenResponse(val registered: Boolean, val provider: String? = null)

/** The fields of GET /v2/media/{id} the ready notice needs. */
@Serializable
data class MediaDetail(val media: Media, val generation: Int) {
    @Serializable
    data class Media(
        val id: String,
        val kind: MediaKind,
        val status: String,
        @SerialName("analysis_status") val analysisStatus: String,
    )
}

/** POST /v2/media/{id}/analysis: the user starts exploring a photo. */
@Serializable
data class AnalyzeMediaRequest(
    val focus: String = "",
    val mode: String = "photo",
    @SerialName("expected_generation") val expectedGeneration: Int,
)

@Serializable
enum class AnalysisState {
    @SerialName("queued") QUEUED,
    @SerialName("running") RUNNING,
    @SerialName("partial") PARTIAL,
    @SerialName("complete") COMPLETE,
    @SerialName("failed") FAILED,
    @SerialName("cancelled") CANCELLED,
}

/** POST /v2/media/{id}/analysis and GET /v2/media/{id}/analysis/{analysisId}. */
@Serializable
data class AnalysisStatus(
    @SerialName("analysis_id") val analysisId: String,
    @SerialName("job_id") val jobId: String,
    val state: AnalysisState,
    val reused: Boolean,
    /** Web path of the result ("/captures/{id}") once published. */
    @SerialName("result_url") val resultUrl: String? = null,
    @SerialName("capture_id") val captureId: String? = null,
    @SerialName("waiting_reason") val waitingReason: String? = null,
    @SerialName("error_code") val errorCode: String? = null,
)
