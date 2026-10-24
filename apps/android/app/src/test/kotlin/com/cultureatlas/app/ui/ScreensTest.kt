package com.cultureatlas.app.ui

import android.app.Application
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.material3.Text
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ApplicationProvider
import com.cultureatlas.app.notify.ReadyNoticeCenter
import com.cultureatlas.capture.core.contract.DiscoveryCard
import com.cultureatlas.capture.core.contract.LibraryEntry
import com.cultureatlas.capture.core.contract.LibraryMedia
import com.cultureatlas.capture.core.contract.MediaLinks
import com.cultureatlas.capture.core.nav.BackStack
import com.cultureatlas.capture.core.result.ResultRoute
import com.github.takahirom.roborazzi.captureRoboImage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.nio.file.Files

/**
 * The finding-level screens rendered on the JVM against scripted wire data. Screenshots go to
 * build/outputs/roborazzi for review (they are evidence, not golden files).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = Application::class, qualifiers = "w411dp-h891dp-xxhdpi")
class ScreensTest {
    @get:Rule
    val rule = createAndroidComposeRule<ComponentActivity>()

    private val backend = TestBackend()
    private val app: Application get() = ApplicationProvider.getApplicationContext()
    private val notices by lazy {
        ReadyNoticeCenter(app, backend.api, backend.sessions, CoroutineScope(SupervisorJob() + Dispatchers.Default), Files.createTempDirectory("ready").toFile())
    }

    @After
    fun tearDown() = backend.close()

    private fun shot(name: String) = rule.onRoot().captureRoboImage("build/outputs/roborazzi/$name.png")

    private fun settle(ms: Long = 1_500) {
        rule.mainClock.advanceTimeBy(ms)
        rule.waitForIdle()
    }

    @Test
    fun cardDetailMatchesTheIosOrderAndPhrasesResemblances() {
        backend.on("GET /v1/items/c1") { TestBackend.item("c1", "Herman Miller") }
        val feed = FeedModel(backend.api)
        val card = DiscoveryCard("c1", "qloo_entity", null, "Herman Miller", "Furniture maker", null, false, false, null, null, true)
        rule.mainClock.autoAdvance = false
        rule.setContent {
            FeedCardDetail(api = backend.api, card = card, notices = notices, feed = feed, onBack = {}, onOpenRelated = {})
        }
        rule.waitUntil(5_000) { feed.cachedDetail("c1") != null }
        settle()
        rule.onNodeWithContentDescription("Back").assertIsDisplayed()
        // Qualified references read as resemblances; an unqualified depiction is the bare name.
        rule.onNodeWithText("Eames Lounge Chair").assertExists()
        rule.onNodeWithText("Resembles Bauhaus").assertExists()
        // iOS order: Similar comes before the focus tool and Add to a board.
        val similar = rule.onNodeWithText("Similar").getUnclippedBoundsInRoot().top
        val focus = rule.onNodeWithText("Focus on an area").getUnclippedBoundsInRoot().top
        val add = rule.onNodeWithText("Add to a board").getUnclippedBoundsInRoot().top
        assertTrue("Similar ($similar) before focus ($focus)", similar < focus)
        assertTrue("focus ($focus) before Add to a board ($add)", focus < add)
        shot("card_detail_top")
        rule.onNodeWithText("Similar").performScrollTo()
        settle(600)
        shot("card_detail_similar")
    }

    @Test
    fun resultScreenShowsThePublishedReadingInTheApp() {
        val media = """{"media":{"schema_version":1,"id":"${TestBackend.MEDIA}","kind":"photo","source":"phone_camera","status":"ready",
            "analysis_status":"complete","created_at":"2026-10-22T10:00:00Z"},"generation":1,"revision":1,
            "links":{"original":null,"playback":null,"poster":null,"analysis":null},"error_code":null,"frames":[]}"""
        backend.on("GET /v2/media/${TestBackend.MEDIA}") { media }
        backend.on("GET /v2/media/${TestBackend.MEDIA}/analysis/${TestBackend.ANALYSIS}") {
            """{"analysis_id":"${TestBackend.ANALYSIS}","job_id":"j","state":"complete","reused":true,
               "result_url":"/captures/${TestBackend.CAPTURE}","capture_id":"${TestBackend.CAPTURE}",
               "result":{"mode":"photo","note":null,"frames":[{"frame_id":null,"timestamp_ms":null,"state":"complete"}],
                 "candidates":[{"name":"Eames Lounge Chair","type":"work","relation":"depicted","cited_frames":[]},
                               {"name":"Mid-century modern","type":"style","relation":"resembles","cited_frames":[]}]}}"""
        }
        // An older server refuses the phone: the screen shows what /v2 returned and points to the Feed.
        backend.on("GET /v1/captures/${TestBackend.CAPTURE}", status = 403) { """{"code":"scope_denied","message":"Not allowed."}""" }
        var openedFeed = false
        rule.mainClock.autoAdvance = false
        rule.setContent {
            AnalysisResultScreen(
                api = backend.api, notices = notices, mediaId = TestBackend.MEDIA, analysisId = TestBackend.ANALYSIS,
                entry = null, library = LibraryModel(backend.api), onBack = {}, onOpenCard = {}, onFeed = { openedFeed = true },
            )
        }
        rule.waitUntil(5_000) { backend.requests.any { it.startsWith("GET /v1/captures/") } }
        settle(2_000)
        rule.onNodeWithText("Here's what we found").assertExists()
        rule.onNodeWithText("Eames Lounge Chair").assertExists()
        rule.onNodeWithText("Resembles Mid-century modern").assertExists()
        rule.onNodeWithText("See your Feed").assertExists()
        shot("analysis_result")
        // Nothing left the app.
        assertNull(shadowOf(app).nextStartedActivity)
        assertTrue(!openedFeed)
    }

    @Test
    fun resultScreenShowsBridgedReferencesAndRecommendations() {
        val media = """{"media":{"schema_version":1,"id":"${TestBackend.MEDIA}","kind":"photo","source":"phone_camera","status":"ready",
            "analysis_status":"complete","created_at":"2026-10-22T10:00:00Z"},"generation":1,"revision":1,
            "links":{"original":null,"playback":null,"poster":null,"analysis":null},"error_code":null,"frames":[]}"""
        backend.on("GET /v2/media/${TestBackend.MEDIA}") { media }
        backend.on("GET /v2/media/${TestBackend.MEDIA}/analysis/${TestBackend.ANALYSIS}") {
            """{"analysis_id":"${TestBackend.ANALYSIS}","job_id":"j","state":"complete","reused":true,
               "result_url":"/captures/${TestBackend.CAPTURE}","capture_id":"${TestBackend.CAPTURE}",
               "result":{"mode":"photo","note":null,"frames":[{"frame_id":null,"timestamp_ms":null,"state":"complete"}],
                 "candidates":[{"name":"Eames Lounge Chair","type":"work","relation":"depicted","cited_frames":[]}]}}"""
        }
        // GET /v1/captures/{id} through the native owner bridge: sourced references and Qloo cards.
        backend.on("GET /v1/captures/${TestBackend.CAPTURE}") {
            """{"id":"${TestBackend.CAPTURE}","status":"ready","job_id":null,"discovery_item_id":null,
               "analysis":{"title":"A lounge chair","interpretation":"A moulded plywood lounge chair."},
               "references":[{"id":"r1","name":"Charles and Ray Eames","type":"creator","relation":"depicted","qualified":false,"has_page":true},
                             {"id":"r2","name":"Scandinavian design","type":"style","relation":"resembles","qualified":true,"has_page":false}],
               "recommendations":[{"id":"q1","kind":"qloo_entity","category":"play","title":"Nina Simone","subtitle":"Artist","image":null,
                 "is_example":false,"saved":false,"saved_item_id":null,"recommendation_id":null,"evidence_available":true}]}"""
        }
        rule.mainClock.autoAdvance = false
        rule.setContent {
            AnalysisResultScreen(
                api = backend.api, notices = notices, mediaId = TestBackend.MEDIA, analysisId = TestBackend.ANALYSIS,
                entry = null, library = LibraryModel(backend.api), onBack = {}, onOpenCard = {}, onFeed = {},
            )
        }
        rule.waitUntil(5_000) { backend.requests.any { it.startsWith("GET /v1/captures/") } }
        settle(2_000)
        rule.onNodeWithText("References").performScrollTo().assertExists()
        rule.onNodeWithText("Charles and Ray Eames").assertExists()
        rule.onNodeWithText("Resembles Scandinavian design").assertExists()
        rule.onNodeWithText("Nina Simone").assertExists()
        assertEquals(1, backend.requests.count { it.startsWith("GET /v1/captures/") })
    }

    @Test
    fun readyToastAndNotificationOpenTheNativeResult() {
        notices.open(ReadyNoticeCenter.Toast(TestBackend.MEDIA, TestBackend.ANALYSIS, "/captures/${TestBackend.CAPTURE}"))
        assertEquals(ResultRoute(TestBackend.MEDIA, TestBackend.ANALYSIS), notices.openRequest.value)
        assertNull("no browser intent", shadowOf(app).nextStartedActivity)
        notices.consumeOpenRequest()
        val bad = android.content.Intent()
            .putExtra(ReadyNoticeCenter.EXTRA_MEDIA, "../v1/accounts")
            .putExtra(ReadyNoticeCenter.EXTRA_ANALYSIS, TestBackend.ANALYSIS)
        notices.openFromIntent(bad)
        assertNull(notices.openRequest.value)
        val good = android.content.Intent()
            .putExtra(ReadyNoticeCenter.EXTRA_MEDIA, TestBackend.MEDIA)
            .putExtra(ReadyNoticeCenter.EXTRA_ANALYSIS, TestBackend.ANALYSIS)
        notices.openFromIntent(good)
        assertEquals(ResultRoute(TestBackend.MEDIA, TestBackend.ANALYSIS), notices.openRequest.value)
    }

    @Test
    fun feedKeepsItsConveyorAcrossTabSwitches() {
        backend.on("GET /v1/discoveries") { TestBackend.discoveries() }
        val feed = FeedModel(backend.api)
        var nav by mutableStateOf(BackStack<Tab, String>(tab = Tab.FEED, home = Tab.FEED))
        rule.mainClock.autoAdvance = false
        rule.setContent {
            AtlasNavHost(nav = nav, direction = BackStack.Direction.NONE, onBack = { nav = nav.back().stack }, stateKey = { r, d -> "$d:$r" }) { frame ->
                if (frame.tab == Tab.FEED) FeedScreen(feed, notices, onOpen = {}) else Text("library")
            }
        }
        rule.waitUntil(5_000) { feed.pool.isNotEmpty() }
        settle(2_000)
        shot("feed_conveyor")
        val before = rule.runOnIdle { feed.conveyor.entries().map { it.key to it.card.id } }
        val loads = backend.requests.count { it.startsWith("GET /v1/discoveries") }
        assertTrue(before.isNotEmpty())

        rule.runOnIdle { nav = nav.selectTab(Tab.LIBRARY).stack }
        settle(600)
        rule.onNodeWithText("library").assertIsDisplayed()
        rule.runOnIdle { nav = nav.selectTab(Tab.FEED).stack }
        repeat(10) { settle(200) }

        // Same cards on the conveyor, no "Loading" skeleton, and no reload from empty.
        val after = rule.runOnIdle { feed.conveyor.entries().map { it.key to it.card.id } }
        assertEquals(before.map { it.first }, after.map { it.first }.take(before.size))
        rule.onNodeWithContentDescription("Loading suggestions").assertDoesNotExist()
        assertEquals(loads, backend.requests.count { it.startsWith("GET /v1/discoveries") })
        shot("feed_after_tab_switch")
        // The cards that were drifting are drawn again straight away.
        val titles = feed.pool.associate { it.id to it.title }
        assertTrue(after.any { (_, id) -> rule.onAllNodesWithText(titles.getValue(id), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() })
    }

    @Test
    fun tabBarAndLibraryGridRender() {
        val entries = (1..9).map { i ->
            LibraryEntry(
                media = LibraryMedia(
                    id = "m$i", kind = if (i % 3 == 0) "video" else "photo", status = "ready",
                    analysisStatus = when (i % 4) { 0 -> "complete"; 1 -> "running"; else -> "not_requested" },
                    durationMs = if (i % 3 == 0) 14_000 else null,
                ),
                generation = 1,
                links = MediaLinks(),
            )
        }
        rule.mainClock.autoAdvance = false
        rule.setContent {
            androidx.compose.foundation.layout.Column(Modifier.fillMaxSize()) {
                LazyVerticalGrid(
                    columns = GridCells.Fixed(3),
                    modifier = Modifier.weight(1f),
                    contentPadding = PaddingValues(16.dp),
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    items(entries, key = { it.media.id }) { LibraryTile(it) {} }
                }
                AtlasTabBar(selected = Tab.LIBRARY) {}
            }
        }
        settle(400)
        rule.onNodeWithText("Feed").assertIsDisplayed()
        rule.onNodeWithText("Capture").assertIsDisplayed()
        rule.onNodeWithText("Library").assertIsDisplayed()
        rule.onNodeWithText("Settings").assertIsDisplayed()
        rule.onNodeWithContentDescription("Video. Explored", substring = true, useUnmergedTree = true)
        shot("library_grid_tab_bar")
    }
}
