package com.cultureatlas.app.ui

import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.cultureatlas.capture.core.contract.DiscoveryCard
import com.cultureatlas.capture.core.contract.ItemDetailResponse
import com.cultureatlas.capture.core.contract.LibraryEntry
import com.cultureatlas.capture.core.feed.FeedConveyor
import com.cultureatlas.capture.core.net.AtlasApi
import com.cultureatlas.capture.core.net.AtlasClientException
import com.cultureatlas.capture.core.net.discoveries
import com.cultureatlas.capture.core.net.library
import com.cultureatlas.capture.core.result.LibraryPages

/**
 * Feed state that outlives the Feed tab: the pool, the conveyor (with every
 * card's position) and the last message. Held by the signed-in shell, so
 * switching tabs or opening a card and coming back resumes the drift exactly
 * where it was instead of "Loading…" and an empty conveyor.
 */
@Stable
class FeedModel(private val api: AtlasApi) {
    val conveyor = FeedConveyor<DiscoveryCard>(idOf = { it.id }, picturedOf = { it.image != null })
    var pool by mutableStateOf<List<DiscoveryCard>>(emptyList())
        private set
    var exampleFeed by mutableStateOf(false)
        private set
    var message by mutableStateOf<String?>(null)
        private set
    var loading by mutableStateOf(true)
        private set
    var refreshing by mutableStateOf(false)
    val loadedOnce: Boolean get() = !loading

    /** Opened item details, so Back to a card (or a Similar card) is instant. */
    private val details = object : LinkedHashMap<String, ItemDetailResponse>(32, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, ItemDetailResponse>?) = size > 48
    }

    fun cachedDetail(id: String): ItemDetailResponse? = synchronized(details) { details[id.lowercase()] }

    fun rememberDetail(detail: ItemDetailResponse) {
        synchronized(details) { details[detail.item.id.lowercase()] = detail }
    }

    suspend fun load(refresh: Boolean = false) {
        runCatching { api.discoveries(refresh) }
            .onSuccess { feed ->
                exampleFeed = feed.isExampleFeed
                if (feed.items.isEmpty()) {
                    message = if (pool.isEmpty()) {
                        "Still looking for things that match your interests. Pull to try again."
                    } else {
                        "Nothing new yet. Still showing what you had."
                    }
                } else {
                    val incomingIds = feed.items.map { it.id }.toSet()
                    val keepOnScreen = conveyor.onScreenIds()
                    // Posters stay in the pool (as on iOS): the conveyor takes pictured cards first and
                    // never passes a waiting photo for a poster. New cards join; nothing on screen resets.
                    pool = feed.items + pool.filter { it.id in keepOnScreen && it.id !in incomingIds }
                    message = null
                }
            }
            .onFailure {
                if (it is AtlasClientException.Server && it.code == "onboarding_required") {
                    pool = emptyList()
                    conveyor.clear()
                    message = "Finish picking your interests to see suggestions."
                } else if (pool.isEmpty()) {
                    message = "Suggestions aren't available right now. Pull to try again."
                } else {
                    message = "Couldn't refresh. Still showing what you had."
                }
            }
        loading = false
        refreshing = false
    }
}

/**
 * The Library grid's server pages (`GET /v2/library`), kept across tabs so the
 * grid keeps its place. A failed refresh keeps what is on screen.
 */
@Stable
class LibraryModel(private val api: AtlasApi) {
    var pages by mutableStateOf(LibraryPages())
        private set
    var loadingMore by mutableStateOf(false)
        private set
    var refreshing by mutableStateOf(false)
    var message by mutableStateOf<String?>(null)
        private set

    suspend fun refresh() {
        runCatching { api.library() }
            .onSuccess {
                pages = pages.refreshed(it)
                message = null
            }
            .onFailure {
                message = if (pages.entries.isEmpty()) {
                    "Your library isn't available right now. Pull to try again."
                } else {
                    "Couldn't refresh. Still showing what you had."
                }
            }
        refreshing = false
    }

    suspend fun loadMore() {
        val cursor = pages.nextCursor ?: return
        if (loadingMore) return
        loadingMore = true
        runCatching { api.library(cursor) }.onSuccess { pages = pages.appended(it) }
        loadingMore = false
    }

    fun update(entry: LibraryEntry) {
        pages = pages.updated(entry)
    }
}
