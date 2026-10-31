package com.cultureatlas.capture.core.contract

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * Wire models for Discover (`GET /v1/discoveries`) and boards
 * (`/v1/collections*`). An enrolled phone may call these as its account owner
 * (native owner bridge, fixtures/native-contract/onboarding.json).
 */

@Serializable
data class LibraryImage(
    val url: String,
    val width: Int? = null,
    val height: Int? = null,
    val alt: String,
) {
    /** Public asset path ("/samples/…") resolved against the API base URL, or an absolute URL. */
    fun resolved(baseUrl: String): String? = when {
        url.startsWith("https://") -> url
        url.startsWith("/") -> baseUrl.trimEnd('/') + url
        else -> null
    }
}

@Serializable
data class DiscoveryCard(
    val id: String,
    val kind: String,
    val category: TasteCategory? = null,
    val title: String,
    val subtitle: String? = null,
    val image: LibraryImage? = null,
    @SerialName("is_example") val isExample: Boolean,
    val saved: Boolean,
    @SerialName("saved_item_id") val savedItemId: String? = null,
    @SerialName("recommendation_id") val recommendationId: String? = null,
    @SerialName("evidence_available") val evidenceAvailable: Boolean,
    /** Why this card: server text built from real overlap (≤ 90 chars); null if none. */
    val reason: String? = null,
    /** Which style attributes connected a capture card; null outside capture rails. */
    @SerialName("style_match") val styleMatch: StyleMatch? = null,
)

@Serializable
data class DiscoveriesResponse(
    val items: List<DiscoveryCard>,
    @SerialName("next_cursor") val nextCursor: String? = null,
    @SerialName("feed_id") val feedId: String,
    @SerialName("feed_revision") val feedRevision: Int,
    @SerialName("is_example_feed") val isExampleFeed: Boolean,
    @SerialName("available_categories") val availableCategories: List<TasteCategory>,
    /**
     * The server is still adding cards (the taste seed publishing categories
     * right after onboarding, an expand wave, Music Mode suggestions).
     */
    val expansion: FeedExpansion? = null,
) {
    /** When to look again: sooner while the server says cards are on their way. */
    val nextPollMillis: Long
        get() = if (expansion?.state == "running") {
            (expansion.pollAfterMs ?: 4_000L).coerceIn(2_000L, FEED_POLL_MILLIS)
        } else {
            FEED_POLL_MILLIS
        }

    /**
     * Which cards still on screen stay in the pool after this page. Once real
     * cards land, examples the server no longer lists leave the pool (the
     * conveyor lets them drift off; they never come back), so the real ones
     * float in without a reload. Real cards on screen always stay.
     */
    fun keptOnScreen(onScreen: List<DiscoveryCard>): List<DiscoveryCard> {
        val incoming = items.map { it.id }.toSet()
        val landedReal = items.any { !it.isExample }
        return onScreen.filter { it.id !in incoming && !(landedReal && it.isExample) }
    }

    companion object {
        /** Usual feed poll (spec: every 8 s while the example feed shows). */
        const val FEED_POLL_MILLIS = 8_000L
    }
}

@Serializable
data class FeedExpansion(
    val state: String,
    @SerialName("poll_after_ms") val pollAfterMs: Long? = null,
)

@Serializable
data class CollectionSummary(
    val id: String,
    val name: String,
    val description: String? = null,
    @SerialName("item_count") val itemCount: Int,
    val cover: List<LibraryImage>,
    val revision: Int,
    @SerialName("created_at") val createdAt: String,
    @SerialName("updated_at") val updatedAt: String,
)

@Serializable
data class CollectionsUnfiled(
    @SerialName("item_count") val itemCount: Int,
    val cover: List<LibraryImage>,
)

@Serializable
data class CollectionsListResponse(
    val collections: List<CollectionSummary>,
    val unfiled: CollectionsUnfiled? = null,
)

@Serializable
data class CreateCollectionRequest(val name: String, val description: String? = null)

@Serializable
data class CollectionMember(
    @SerialName("membership_id") val membershipId: String,
    @SerialName("saved_item_id") val savedItemId: String,
    val position: Int,
    @SerialName("added_at") val addedAt: String,
    val item: DiscoveryCard,
)

@Serializable
data class CollectionDetailResponse(
    val collection: CollectionSummary,
    val items: List<CollectionMember>,
    @SerialName("next_cursor") val nextCursor: String? = null,
    @SerialName("available_filters") val availableFilters: List<String>,
)

@Serializable
data class AddCollectionItemResponse(
    @SerialName("collection_id") val collectionId: String,
    @SerialName("membership_id") val membershipId: String,
    @SerialName("saved_item_id") val savedItemId: String,
    @SerialName("collection_revision") val collectionRevision: Int,
    val created: Boolean,
    val saved: Boolean,
)

@Serializable
data class ItemSource(
    val id: String,
    val url: String,
    val title: String? = null,
    val publisher: String? = null,
    @SerialName("retrieved_at") val retrievedAt: String,
)

@Serializable
data class ItemWhyThis(
    val text: String,
    val sources: List<ItemSource> = emptyList(),
)

@Serializable
data class ItemReference(
    val id: String,
    val name: String,
    val type: String,
    val relation: String? = null,
    val qualified: Boolean,
    @SerialName("has_page") val hasPage: Boolean,
    @SerialName("read_text") val readText: String? = null,
)

/** GET /v1/items/{id} — sourced detail plus cached related (at most 6). */
@Serializable
data class ItemDetailResponse(
    val item: DiscoveryCard,
    val description: String? = null,
    val detail: String? = null,
    val reason: String? = null,
    @SerialName("why_this") val whyThis: ItemWhyThis? = null,
    @SerialName("destination_url") val destinationUrl: String? = null,
    val references: List<ItemReference> = emptyList(),
    val related: List<DiscoveryCard> = emptyList(),
    @SerialName("related_state") val relatedState: String,
    @SerialName("related_job_id") val relatedJobId: String? = null,
    @SerialName("collection_ids") val collectionIds: List<String> = emptyList(),
    @SerialName("capture_id") val captureId: String? = null,
    @SerialName("style_match") val styleMatch: StyleMatch? = null,
    /** "From your photo." when the card came from one. */
    @SerialName("experimental_line") val experimentalLine: String? = null,
)

/** POST /v1/items/{id}/discoveries — 202, explicit and bounded. */
@Serializable
data class RelatedDiscoveryResponse(
    @SerialName("job_id") val jobId: String,
    @SerialName("discovery_job_id") val discoveryJobId: String,
    val reused: Boolean,
)
