package com.cultureatlas.capture.core

import com.cultureatlas.capture.core.nav.BackStack
import com.cultureatlas.capture.core.nav.BackStack.Direction
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class BackStackTest {
    private enum class Tab { FEED, CAPTURE, LIBRARY, SETTINGS }
    private sealed interface R {
        data class Card(val id: String) : R
        data object Camera : R
        data object Glasses : R
        data class Board(val id: String) : R
    }

    private fun root() = BackStack<Tab, R>(tab = Tab.FEED, home = Tab.FEED)

    @Test
    fun backWalksSimilarHistoryThenTheFeed() {
        var s = root()
        s = s.push(R.Card("a")).stack
        s = s.push(R.Card("b")).stack // Similar
        s = s.push(R.Card("c")).stack // Similar of Similar
        assertEquals(R.Card("c"), s.top)
        val back1 = s.back()
        assertEquals(Direction.BACK, back1.direction)
        assertEquals(R.Card("b"), back1.stack.top)
        val back2 = back1.stack.back()
        assertEquals(R.Card("a"), back2.stack.top)
        val back3 = back2.stack.back()
        assertTrue(back3.stack.atRoot)
        assertFalse(back3.stack.handlesBack, "on the Feed root, Back leaves the app")
        assertEquals(Direction.NONE, back3.stack.back().direction)
    }

    @Test
    fun backFromAnotherTabRootGoesHomeFirst() {
        val s = root().selectTab(Tab.LIBRARY).stack
        assertTrue(s.handlesBack)
        val home = s.back()
        assertEquals(Tab.FEED, home.stack.tab)
        assertEquals(Direction.BACK, home.direction)
    }

    @Test
    fun doubleTapDoesNotStackTheSameScreen() {
        val once = root().push(R.Camera).stack
        val twice = once.push(R.Camera)
        assertEquals(Direction.NONE, twice.direction)
        assertEquals(1, twice.stack.depth)
    }

    @Test
    fun tabsResetTheStackAndReselectPopsToRoot() {
        val deep = root().push(R.Card("a")).stack.push(R.Card("b")).stack
        val reselect = deep.selectTab(Tab.FEED)
        assertTrue(reselect.stack.atRoot)
        assertEquals(Direction.BACK, reselect.direction)
        val other = deep.selectTab(Tab.CAPTURE)
        assertEquals(Tab.CAPTURE, other.stack.tab)
        assertTrue(other.stack.atRoot)
        assertEquals(Direction.NONE, root().selectTab(Tab.FEED).direction)
    }

    @Test
    fun replaceTopAndRemoveAll() {
        val glasses = root().selectTab(Tab.CAPTURE).stack.push(R.Glasses).stack
        val camera = glasses.replaceTop(R.Camera).stack
        assertEquals(listOf<R>(R.Camera), camera.routes)
        val boards = root().push(R.Board("x")).stack.push(R.Card("a")).stack.push(R.Board("y")).stack
        val pruned = boards.removeAll { it == R.Board("x") }.stack
        assertEquals(listOf(R.Card("a"), R.Board("y")), pruned.routes)
        assertNull(root().top)
    }

    @Test
    fun depthIsCapped() {
        var s = BackStack<Tab, R>(Tab.FEED, Tab.FEED, maxDepth = 3)
        listOf("a", "b", "c", "d", "e").forEach { s = s.push(R.Card(it)).stack }
        assertEquals(listOf("c", "d", "e"), s.routes.map { (it as R.Card).id })
    }
}
