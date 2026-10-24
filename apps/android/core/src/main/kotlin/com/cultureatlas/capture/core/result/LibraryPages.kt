package com.cultureatlas.capture.core.result

import com.cultureatlas.capture.core.contract.LibraryEntry
import com.cultureatlas.capture.core.contract.MediaLibraryResponse

/**
 * The Library grid's server pages. Pages are merged by media id (a refresh
 * replaces an entry in place, keeping its position), newest first; a failed
 * refresh never empties what is already on screen.
 */
data class LibraryPages(
    val entries: List<LibraryEntry> = emptyList(),
    val nextCursor: String? = null,
    val loadedOnce: Boolean = false,
) {
    val hasMore: Boolean get() = nextCursor != null
    val ids: Set<String> get() = entries.mapTo(HashSet()) { it.media.id.lowercase() }

    /** First page (pull to refresh / app open): fresh items lead, older ones already shown stay below. */
    fun refreshed(page: MediaLibraryResponse): LibraryPages {
        val fresh = page.items.distinctBy { it.media.id.lowercase() }
        val freshIds = fresh.mapTo(HashSet()) { it.media.id.lowercase() }
        val kept = if (loadedOnce) entries.filter { it.media.id.lowercase() !in freshIds } else emptyList()
        return LibraryPages(
            entries = fresh + kept,
            // Keep paging from where we were when older entries are still below.
            nextCursor = if (kept.isNotEmpty() && nextCursor != null) nextCursor else page.nextCursor,
            loadedOnce = true,
        )
    }

    /** Next page (scrolled near the end). Entries already shown are updated in place. */
    fun appended(page: MediaLibraryResponse): LibraryPages {
        val byId = page.items.associateBy { it.media.id.lowercase() }
        val updated = entries.map { byId[it.media.id.lowercase()] ?: it }
        val present = updated.mapTo(HashSet()) { it.media.id.lowercase() }
        val added = page.items.filter { present.add(it.media.id.lowercase()) }
        return LibraryPages(updated + added, page.nextCursor, loadedOnce = true)
    }

    /** One entry changed (e.g. analysis started); unknown ids are ignored. */
    fun updated(entry: LibraryEntry): LibraryPages =
        copy(entries = entries.map { if (it.media.id.equals(entry.media.id, ignoreCase = true)) entry else it })

    companion object {
        /** Start the next page when this many tiles remain below the last visible one. */
        const val PREFETCH_DISTANCE = 6

        fun shouldLoadMore(lastVisibleIndex: Int, total: Int, hasMore: Boolean, loading: Boolean): Boolean =
            hasMore && !loading && total > 0 && lastVisibleIndex >= total - 1 - PREFETCH_DISTANCE

        /**
         * Local drafts still worth a row above the grid: anything not yet in the
         * server library. A committed draft whose asset the grid already shows is hidden.
         */
        fun <D> pendingDrafts(drafts: List<D>, serverIds: Set<String>, assetIdOf: (D) -> String?): List<D> =
            drafts.filter { d -> assetIdOf(d)?.lowercase()?.let { it !in serverIds } ?: true }
    }
}
