package com.cultureatlas.capture.core

import com.cultureatlas.capture.core.contract.AtlasContract
import com.cultureatlas.capture.core.contract.DiscoveriesResponse
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test

/**
 * Right after onboarding the first page is a few seed cards topped up with
 * examples. The poll speeds up while the seed lands and real cards push the
 * replaced examples out, so nobody has to reload.
 */
class FeedLandingTest {
    private fun card(id: String, example: Boolean) =
        """{"id":"$id","kind":"film","category":"watch","title":"T","subtitle":null,"image":null,"is_example":$example,
           "saved":false,"saved_item_id":null,"recommendation_id":null,"evidence_available":false}"""

    private fun page(cards: List<String>, expansion: String = ""): DiscoveriesResponse =
        AtlasContract.json.decodeFromString(
            DiscoveriesResponse.serializer(),
            """{"items":[${cards.joinToString(",")}],"next_cursor":null,"feed_id":"f","feed_revision":1,
               "is_example_feed":false,"available_categories":["watch"]$expansion}""",
        )

    @Test
    fun seedLandingPollsSoonerAndRetiresReplacedExamples() {
        val first = page(
            listOf(card("q1", false), card("s1", true), card("s2", true)),
            ""","expansion":{"state":"running","poll_after_ms":4000}""",
        )
        assertEquals(4_000L, first.nextPollMillis)
        val later = page(
            listOf(card("q2", false), card("q1", false), card("s2", true)),
            ""","expansion":{"state":"idle","poll_after_ms":null}""",
        )
        assertEquals(DiscoveriesResponse.FEED_POLL_MILLIS, later.nextPollMillis)
        // On screen: q1, s1, s2. q1 and s2 come back in the page; s1 was replaced, so it leaves.
        assertEquals(emptyList<String>(), later.keptOnScreen(first.items).map { it.id })
        // An examples-only page (an older server without `expansion`) keeps everything on screen.
        val examplesOnly = page(listOf(card("s2", true)))
        assertNull(examplesOnly.expansion)
        assertEquals(DiscoveriesResponse.FEED_POLL_MILLIS, examplesOnly.nextPollMillis)
        assertEquals(listOf("q1", "s1"), examplesOnly.keptOnScreen(first.items).map { it.id })
    }
}
