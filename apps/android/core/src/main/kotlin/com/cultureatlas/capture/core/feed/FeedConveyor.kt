package com.cultureatlas.capture.core.feed

import kotlin.random.Random

/**
 * Pure layout model for the floating feed (and the Similar rail on card detail).
 *
 * The feed is a conveyor: [lanes] columns (or one row for the rail) that each
 * drift steadily along the drift axis at their own speed. A card enters past
 * the far edge of the viewport, travels across, and leaves off the near edge;
 * when it leaves, the next waiting card is appended to the tail of that lane.
 *
 * Positions are along the drift axis in "content" units (pixels in the app).
 * Within a lane every card sits at a fixed start that never changes, spaced
 * exactly one [pitch] apart or more, so two cards can never overlap — not while
 * drifting, not while a card is appended or removed. Only the lane offset moves.
 *
 * Card identity is the id from [idOf]. The same id is never placed twice at
 * once. Refill prefers fresh (never placed) pictured cards, then pictured cards
 * that already scrolled off (least recently placed first), and only then
 * typographic posters — a poster never takes a slot while a photo is waiting.
 *
 * Reduce Motion: the host never calls [tick]; it calls [rotate] on a timer,
 * which swaps one visible card in place (the host crossfades it by id).
 *
 * Not thread-safe; drive it from one thread (the UI frame clock).
 */
class FeedConveyor<T>(
    private val idOf: (T) -> String,
    private val picturedOf: (T) -> Boolean,
    private val random: Random = Random.Default,
) {
    /** One placed card. [start] is the content position; it never changes for an entry. */
    class Entry<T> internal constructor(val key: Long, card: T, val lane: Int, internal val start: Double) {
        var card: T = card
            internal set
    }

    /** A card as it appears now: [position] is relative to the viewport's near edge. */
    data class Placed<T>(val key: Long, val id: String, val card: T, val lane: Int, val position: Float)

    private class Lane<T>(var speed: Float) {
        // Double: offsets grow for as long as the feed is open; Float would lose sub-pixel spacing.
        var offset = 0.0
        var tail = 0.0
        var primed = false
        val entries = ArrayDeque<Entry<T>>()
    }

    var extent = 0f
        private set
    var spacing = 0f
        private set
    var viewport = 0f
        private set
    val pitch: Float get() = extent + spacing

    /** Bumped whenever an entry is added, removed or swapped (not on plain drift). */
    var version = 0
        private set

    /** Seconds of model time; advances in [tick] even while paused. */
    var clock = 0.0
        private set

    private var lanes: List<Lane<T>> = emptyList()
    private var pool: List<T> = emptyList()
    private val lastPlaced = HashMap<String, Long>()
    private var placeSerial = 0L
    private var keySerial = 0L
    private var holding = false
    private var resumeAt = 0.0

    val isConfigured: Boolean get() = lanes.isNotEmpty() && extent > 0f && viewport > 0f

    /** Drift is paused while the user is touching it and for [RESUME_AFTER_SECONDS] after release. */
    val isPaused: Boolean get() = holding || clock < resumeAt

    /**
     * Sets the geometry. [speeds] are content units per second per lane (one
     * value per lane; the list is cycled if shorter). Re-configuring with a
     * different geometry re-flows the cards already on screen, in order.
     */
    fun configure(lanes: Int, extent: Float, spacing: Float, viewport: Float, speeds: List<Float>, stagger: Float = 0f) {
        require(lanes > 0) { "lanes must be positive" }
        require(extent > 0f && viewport > 0f && spacing >= 0f) { "invalid geometry" }
        require(speeds.isNotEmpty()) { "speeds required" }
        val sameGeometry = lanes == this.lanes.size && extent == this.extent && spacing == this.spacing && viewport == this.viewport
        if (sameGeometry) {
            this.lanes.forEachIndexed { i, lane -> lane.speed = speeds[i % speeds.size] }
            return
        }
        val carried = this.lanes.flatMap { it.entries }.sortedBy { it.key }.map { it.card }
        this.extent = extent
        this.spacing = spacing
        this.viewport = viewport
        this.lanes = List(lanes) { i ->
            Lane<T>(speeds[i % speeds.size]).also { lane ->
                // Stagger lanes so columns read as a mosaic, not a table.
                lane.offset = if (i % 2 == 1) stagger.toDouble() else 0.0
                lane.tail = 0.0
            }
        }
        version++
        // Re-place the cards that were on screen first, in their old order.
        val carriedIds = HashSet<String>()
        for (card in carried) {
            val id = idOf(card)
            if (!carriedIds.add(id)) continue
            val lane = this.lanes.minBy { it.tail - it.offset }
            if (lane.tail >= lane.offset + viewport + pitch) break
            place(lane, card, appendAt = lane.tail)
        }
        fill()
    }

    /**
     * Replaces the pool (in priority order: newest first). Cards already on screen
     * stay where they are even if the new pool omits them — refresh never empties
     * the feed. New cards join the conveyor at the tail.
     */
    fun setPool(cards: List<T>) {
        val byId = LinkedHashMap<String, T>()
        cards.forEach { byId.putIfAbsent(idOf(it), it) }
        pool = byId.values.toList()
        // Keep on-screen entries showing the freshest data for their id.
        lanes.forEach { lane -> lane.entries.forEach { e -> byId[idOf(e.card)]?.let { e.card = it } } }
        if (isConfigured) fill()
        version++
    }

    /** Wipes everything (only for onboarding_required: the account has no feed). */
    fun clear() {
        pool = emptyList()
        lanes.forEach { lane ->
            lane.entries.clear()
            lane.tail = lane.offset
            lane.primed = false
        }
        holding = false
        resumeAt = 0.0
        version++
    }

    /** Advances the drift by [dtSeconds]. Returns true when entries were added or removed. */
    fun tick(dtSeconds: Double): Boolean {
        val dt = dtSeconds.coerceIn(0.0, MAX_FRAME_SECONDS)
        clock += dt
        if (!isConfigured || isPaused) return false
        val before = version
        lanes.forEach { it.offset += it.speed * dt }
        maintain()
        return version != before
    }

    /** The user started touching/scrolling: hold the drift. */
    fun hold() {
        holding = true
    }

    /** The user let go: resume drifting [RESUME_AFTER_SECONDS] later. */
    fun release() {
        if (!holding) return
        holding = false
        resumeAt = clock + RESUME_AFTER_SECONDS
    }

    /**
     * User scroll along the drift axis. Positive [delta] moves toward newer cards
     * (the same direction as the drift). Returns how much was consumed; the rest
     * belongs to the parent (pull-to-refresh) when the user drags back past the
     * oldest card still kept.
     */
    fun scrollBy(delta: Float): Float {
        if (!isConfigured || delta == 0f) return 0f
        val consumed = if (delta > 0f) {
            delta
        } else {
            val room = lanes.minOf { lane -> (lane.offset - minOffset(lane)).coerceAtLeast(0.0) }.toFloat()
            -minOf(-delta, room)
        }
        if (consumed == 0f) return 0f
        lanes.forEach { it.offset += consumed }
        maintain()
        return consumed
    }

    /**
     * Reduce Motion: swap one visible card in place for the next waiting card.
     * Posters are swapped out first; a photo is never swapped out for a poster.
     * Returns the key of the entry that changed, or null.
     */
    fun rotate(): Long? {
        if (!isConfigured) return null
        val incoming = nextCard() ?: return null
        val visible = visibleEntries()
        if (visible.isEmpty()) return null
        val posters = visible.filter { !picturedOf(it.card) }
        val target = when {
            posters.isNotEmpty() -> posters.random(random)
            !picturedOf(incoming) -> return null
            else -> visible.random(random)
        }
        target.card = incoming
        lastPlaced[idOf(incoming)] = ++placeSerial
        version++
        return target.key
    }

    /** Every entry the model holds (visible or buffered just off-screen). */
    fun entries(): List<Entry<T>> = lanes.flatMap { it.entries }

    /** Current position of an entry relative to the viewport's near edge. */
    fun positionOf(entry: Entry<T>): Float = (entry.start - lanes[entry.lane].offset).toFloat()

    fun placed(): List<Placed<T>> = lanes.flatMap { lane ->
        lane.entries.map { Placed(it.key, idOf(it.card), it.card, it.lane, (it.start - lane.offset).toFloat()) }
    }

    fun visible(): List<Placed<T>> = placed().filter { it.position < viewport && it.position + extent > 0f }

    fun onScreenIds(): Set<String> = lanes.flatMapTo(HashSet()) { lane -> lane.entries.map { idOf(it.card) } }

    /** True once [id] has been placed at least once (used to prefer fresh cards). */
    fun hasShown(id: String): Boolean = id in lastPlaced

    private fun visibleEntries(): List<Entry<T>> = lanes.flatMap { lane ->
        lane.entries.filter { it.start - lane.offset < viewport && it.start - lane.offset + extent > 0f }
    }

    private fun minOffset(lane: Lane<T>): Double = lane.entries.firstOrNull()?.start ?: lane.offset

    private fun maintain() {
        // Remove cards that are a full pitch past the near edge (one is kept so a drag back has something to show).
        lanes.forEach { lane ->
            while (true) {
                val first = lane.entries.firstOrNull() ?: break
                if (first.start + extent >= lane.offset - pitch) break
                lane.entries.removeFirst()
                version++
            }
        }
        fill()
    }

    /** Appends waiting cards to the lane whose tail is nearest the viewport, until every lane has one buffered card. */
    private fun fill() {
        if (!isConfigured) return
        while (true) {
            val lane = lanes
                .filter { it.tail < it.offset + viewport + pitch }
                .minByOrNull { it.tail - it.offset } ?: break
            val card = nextCard() ?: break
            // The first fill lays cards out from the top. After that, cards always
            // enter from beyond the far edge of the viewport — never pop in mid-screen.
            val at = if (lane.primed) maxOf(lane.tail, lane.offset + viewport) else lane.tail
            place(lane, card, at)
        }
        lanes.forEach { if (it.entries.isNotEmpty()) it.primed = true }
    }

    private fun place(lane: Lane<T>, card: T, appendAt: Double) {
        val laneIndex = lanes.indexOf(lane)
        lane.entries.addLast(Entry(++keySerial, card, laneIndex, appendAt))
        lane.tail = appendAt + pitch
        lastPlaced[idOf(card)] = ++placeSerial
        version++
    }

    /** Fresh pictured → recycled pictured (least recent) → fresh poster → recycled poster. Never an id already placed. */
    internal fun nextCard(): T? {
        val onScreen = onScreenIds()
        val waiting = pool.filter { idOf(it) !in onScreen }
        if (waiting.isEmpty()) return null
        val group = waiting.filter(picturedOf).ifEmpty { waiting }
        return group.firstOrNull { idOf(it) !in lastPlaced }
            ?: group.minBy { lastPlaced[idOf(it)] ?: Long.MIN_VALUE }
    }

    companion object {
        const val RESUME_AFTER_SECONDS = 2.0
        /** A long frame (app resumed, jank) never teleports the conveyor. */
        const val MAX_FRAME_SECONDS = 0.1
    }
}
