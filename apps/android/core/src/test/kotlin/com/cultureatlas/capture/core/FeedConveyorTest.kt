package com.cultureatlas.capture.core

import com.cultureatlas.capture.core.feed.FeedConveyor
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import kotlin.random.Random

class FeedConveyorTest {
    private data class Card(val id: String, val pictured: Boolean)

    private fun cards(n: Int, prefix: String = "c", pictured: Boolean = true) = List(n) { Card("$prefix$it", pictured) }

    // A phone-ish geometry: 2 lanes, 170px wide tiles → 4:5 image + caption ≈ 276px, 12px gap, 640px viewport.
    private fun conveyor(pool: List<Card>, lanes: Int = 2, viewport: Float = 640f): FeedConveyor<Card> =
        FeedConveyor<Card>({ it.id }, { it.pictured }, Random(7)).apply {
            setPool(pool)
            configure(lanes = lanes, extent = 276f, spacing = 12f, viewport = viewport, speeds = listOf(12f, 15.5f), stagger = 110f)
        }

    private fun assertInvariants(c: FeedConveyor<Card>) {
        val placed = c.placed()
        // 1. Never the same card twice at once.
        assertEquals(placed.size, placed.map { it.id }.toSet().size, "duplicate id on screen: ${placed.map { it.id }}")
        // 2. No two cards overlap: lanes are distinct columns, and within a lane cards are ≥ one pitch apart.
        placed.groupBy { it.lane }.values.forEach { lane ->
            lane.sortedBy { it.position }.zipWithNext().forEach { (a, b) ->
                assertTrue(b.position >= a.position + c.extent + c.spacing - 0.001f, "overlap in lane ${a.lane}: ${a.position} / ${b.position}")
            }
        }
        // Same check as rectangles, across the whole grid.
        val laneWidth = 170f
        val gap = 12f
        val rects = placed.map { p ->
            val x = p.lane * (laneWidth + gap)
            floatArrayOf(x, p.position, x + laneWidth, p.position + c.extent)
        }
        for (i in rects.indices) for (j in i + 1 until rects.size) {
            val a = rects[i]
            val b = rects[j]
            val intersects = a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]
            assertFalse(intersects, "rects overlap: ${placed[i]} / ${placed[j]}")
        }
    }

    private fun simulate(c: FeedConveyor<Card>, seconds: Double, fps: Int = 60, each: (Int) -> Unit = {}) {
        val frames = (seconds * fps).toInt()
        repeat(frames) { f ->
            c.tick(1.0 / fps)
            each(f)
        }
    }

    @Test
    fun `fills the viewport on first layout and drifts upward without overlap or duplicates`() {
        val c = conveyor(cards(40))
        assertTrue(c.visible().isNotEmpty())
        assertTrue(c.visible().all { it.position < c.viewport })
        val firstPositions = c.placed().associate { it.key to it.position }
        c.tick(1.0 / 60)
        // Every card moved up (towards the near edge); lanes move at different speeds.
        c.placed().filter { it.key in firstPositions }.forEach { assertTrue(it.position < firstPositions.getValue(it.key)) }
        simulate(c, 600.0) { assertInvariants(c) }
    }

    @Test
    fun `lanes drift at staggered speeds so columns are not in lockstep`() {
        val c = conveyor(cards(40))
        val start = c.placed().associate { it.key to it.position }
        simulate(c, 1.0)
        val moved = c.placed().filter { it.key in start }.groupBy { it.lane }
            .mapValues { (_, list) -> start.getValue(list.first().key) - list.first().position }
        assertEquals(12f, moved.getValue(0), 0.5f)
        assertEquals(15.5f, moved.getValue(1), 0.5f)
    }

    @Test
    fun `cards leave off the top and new ones enter from below the visible area`() {
        val c = conveyor(cards(60))
        val seen = c.placed().map { it.key }.toMutableSet()
        simulate(c, 300.0) {
            c.placed().filter { it.key !in seen }.forEach { p ->
                assertTrue(p.position >= c.viewport - 1f, "card ${p.id} popped in at ${p.position}")
                seen += p.key
            }
        }
        assertTrue(seen.size > 20, "conveyor should have floated through many cards, saw ${seen.size}")
    }

    @Test
    fun `refill prefers fresh pictured cards and never brings in a poster while a photo is waiting`() {
        val pool = cards(30, "p") + cards(10, "x", pictured = false)
        val c = conveyor(pool)
        simulate(c, 600.0) {
            assertTrue(c.placed().all { it.card.pictured }, "a poster was placed while photos were waiting")
        }
        // Fresh first: every pictured card got a turn before any was recycled.
        assertTrue(cards(30, "p").all { c.hasShown(it.id) })
    }

    @Test
    fun `posters fill in only when there are no photos to show`() {
        val c = conveyor(cards(12, "x", pictured = false))
        assertTrue(c.visible().isNotEmpty())
        simulate(c, 120.0) { assertInvariants(c) }
    }

    @Test
    fun `small pools recycle cards that scrolled off but never show one twice at once`() {
        val pool = cards(5)
        val c = conveyor(pool)
        val placements = mutableListOf<Long>()
        simulate(c, 900.0) {
            assertInvariants(c)
            c.placed().forEach { if (it.key !in placements) placements += it.key }
        }
        assertTrue(placements.size > pool.size * 3, "expected recycling, got ${placements.size} placements")
    }

    @Test
    fun `a tiny pool leaves an honest gap instead of duplicating`() {
        val c = conveyor(cards(2))
        assertEquals(2, c.placed().size)
        simulate(c, 600.0) {
            assertInvariants(c)
            assertTrue(c.placed().size <= 2)
        }
    }

    @Test
    fun `refresh never empties the conveyor and new cards join at the tail`() {
        val c = conveyor(cards(20, "old"))
        simulate(c, 30.0)
        val onScreen = c.onScreenIds()
        val positions = c.placed().associate { it.key to it.position }
        c.setPool(cards(20, "new"))
        assertEquals(onScreen, c.onScreenIds(), "refresh must not remove cards already on screen")
        c.placed().forEach { assertEquals(positions.getValue(it.key), it.position, "refresh must not move cards") }
        c.setPool(emptyList())
        assertEquals(onScreen, c.onScreenIds(), "an empty refresh keeps what is shown")
        c.setPool(cards(20, "new"))
        var sawNew = false
        simulate(c, 120.0) {
            assertInvariants(c)
            if (c.placed().any { it.id.startsWith("new") }) sawNew = true
        }
        assertTrue(sawNew)
        // Fresh cards were preferred over recycling the old ones.
        assertTrue(cards(20, "new").take(5).all { c.hasShown(it.id) })
    }

    @Test
    fun `user scrolling pauses the drift until two seconds after release`() {
        val c = conveyor(cards(40))
        c.hold()
        val before = c.placed().associate { it.key to it.position }
        simulate(c, 5.0)
        c.placed().forEach { assertEquals(before.getValue(it.key), it.position) }
        assertEquals(50f, c.scrollBy(50f))
        c.placed().filter { it.key in before }.forEach { assertEquals(before.getValue(it.key) - 50f, it.position, 0.01f) }
        c.release()
        val held = c.placed().associate { it.key to it.position }
        simulate(c, 1.9)
        c.placed().filter { it.key in held }.forEach { assertEquals(held.getValue(it.key), it.position, 0.01f) }
        simulate(c, 0.5)
        assertTrue(c.placed().filter { it.key in held }.all { it.position < held.getValue(it.key) }, "drift should resume after 2s")
    }

    @Test
    fun `dragging back past the oldest kept card is left for pull-to-refresh`() {
        val c = conveyor(cards(40))
        // At the very top there is nothing above, so a downward pull passes straight through.
        assertEquals(0f, c.scrollBy(-40f))
        c.scrollBy(300f)
        val consumed = c.scrollBy(-1_000f)
        assertTrue(consumed < 0f && consumed > -1_000f, "consumed $consumed")
        assertEquals(0f, c.scrollBy(-10f))
        assertInvariants(c)
    }

    @Test
    fun `user flings do not break the invariants`() {
        val c = conveyor(cards(9))
        val r = Random(3)
        repeat(4_000) {
            c.hold()
            c.scrollBy(r.nextFloat() * 400f - 150f)
            c.release()
            c.tick(1.0 / 60)
            assertInvariants(c)
        }
    }

    @Test
    fun `reduce motion rotates in place by id, posters first, never photo to poster`() {
        val pool = cards(4, "p") + cards(4, "x", pictured = false) + cards(6, "q")
        val c = FeedConveyor<Card>({ it.id }, { it.pictured }, Random(1)).apply {
            // Pool order puts posters among the first cards shown.
            setPool(cards(2, "x", pictured = false) + cards(2, "p"))
            configure(lanes = 2, extent = 276f, spacing = 12f, viewport = 640f, speeds = listOf(12f, 15.5f))
            setPool(pool)
        }
        // No tick: positions never change.
        val positions = c.placed().associate { it.key to it.position }
        repeat(30) {
            val beforePictured = c.placed().associate { it.key to it.card.pictured }
            val changed = c.rotate()
            c.placed().forEach { p ->
                assertEquals(positions.getValue(p.key), p.position, "reduce motion must not move cards")
                if (beforePictured.getValue(p.key)) assertTrue(p.card.pictured, "a photo was swapped out for a poster")
            }
            if (changed != null) assertNotNull(positions[changed])
            assertInvariants(c)
        }
        assertTrue(c.placed().all { it.card.pictured }, "posters should rotate out first")
    }

    @Test
    fun `reduce motion with nothing waiting is a no-op`() {
        val c = conveyor(cards(2))
        assertNull(c.rotate())
    }

    @Test
    fun `onboarding reset clears and the next pool lays out from the top again`() {
        val c = conveyor(cards(20))
        simulate(c, 60.0)
        c.clear()
        assertTrue(c.placed().isEmpty())
        c.setPool(cards(20, "z"))
        assertTrue(c.visible().isNotEmpty(), "after a reset the first cards are visible immediately")
        assertInvariants(c)
    }

    @Test
    fun `pool arriving after layout fills the viewport immediately`() {
        val c = FeedConveyor<Card>({ it.id }, { it.pictured }).apply {
            configure(lanes = 2, extent = 276f, spacing = 12f, viewport = 640f, speeds = listOf(12f, 15.5f), stagger = 110f)
        }
        assertTrue(c.placed().isEmpty())
        c.setPool(cards(20))
        assertTrue(c.visible().size >= 4)
        assertInvariants(c)
    }

    @Test
    fun `re-layout keeps the cards that were on screen`() {
        val c = conveyor(cards(30))
        simulate(c, 20.0)
        val shown = c.placed().sortedBy { it.key }.map { it.id }
        c.configure(lanes = 2, extent = 300f, spacing = 12f, viewport = 700f, speeds = listOf(12f, 15.5f))
        val after = c.placed().map { it.id }.toSet()
        assertTrue(shown.take(3).all { it in after })
        assertInvariants(c)
    }

    @Test
    fun `a single horizontal lane (Similar rail) loops through a small related set`() {
        val related = cards(4)
        val c = FeedConveyor<Card>({ it.id }, { it.pictured }).apply {
            setPool(related)
            configure(lanes = 1, extent = 140f, spacing = 12f, viewport = 360f, speeds = listOf(14f))
        }
        val placements = mutableSetOf<Long>()
        simulate(c, 300.0) {
            val p = c.placed()
            assertEquals(p.size, p.map { it.id }.toSet().size)
            p.sortedBy { it.position }.zipWithNext().forEach { (a, b) -> assertTrue(b.position >= a.position + 152f - 0.001f) }
            p.forEach { placements += it.key }
        }
        assertTrue(placements.size > related.size, "rail should loop")
    }
}
