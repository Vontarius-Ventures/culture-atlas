package com.cultureatlas.app.ui

import android.app.Application
import androidx.activity.ComponentActivity
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isHeading
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.test.core.app.ApplicationProvider
import com.cultureatlas.app.notify.ReadyNoticeCenter
import com.cultureatlas.capture.core.contract.DiscoveryCard
import com.cultureatlas.capture.core.result.StyleCopy
import com.github.takahirom.roborazzi.captureRoboImage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File
import java.nio.file.Files
import java.util.concurrent.CopyOnWriteArrayList

/**
 * The style reading, the More-like-this and cross-domain rails and the experimental label on the
 * native result screen (prp/2026-10-23-style-analysis/design.md F.1 / F.4), rendered on the JVM
 * from the wire fixtures in apps/android/fixtures/style. Screenshots go to
 * build/outputs/roborazzi for review (evidence, not golden files).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = Application::class, qualifiers = "w411dp-h891dp-xxhdpi")
class StyleScreensTest {
    @get:Rule
    val rule = createAndroidComposeRule<ComponentActivity>()

    private val backend = TestBackend()
    private val app: Application get() = ApplicationProvider.getApplicationContext()
    private val notices by lazy {
        ReadyNoticeCenter(app, backend.api, backend.sessions, CoroutineScope(SupervisorJob() + Dispatchers.Default), Files.createTempDirectory("ready").toFile())
    }
    private val fixtures = File(System.getProperty("atlas.style.fixtures") ?: error("atlas.style.fixtures is not set"))
    private fun fixture(name: String) = File(fixtures, name).readText()

    @After
    fun tearDown() = backend.close()

    private fun shot(name: String) = rule.onRoot().captureRoboImage("build/outputs/roborazzi/$name.png")

    private fun settle(ms: Long = 1_500) {
        rule.mainClock.advanceTimeBy(ms)
        rule.waitForIdle()
    }

    /**
     * The verticalScroll's semantic scroll is animated and needs frames: with a paused clock it never
     * finishes, so frames run only for the scroll itself.
     */
    private fun scrollTo(text: String): androidx.compose.ui.test.SemanticsNodeInteraction {
        val node = rule.onNodeWithText(text)
        rule.mainClock.autoAdvance = true
        try {
            node.performScrollTo()
        } finally {
            rule.mainClock.autoAdvance = false
        }
        return node
    }

    private fun scriptResult(capture: String, captureStatus: Int = 200) {
        backend.on("GET /v2/media/${TestBackend.MEDIA}") {
            """{"media":{"schema_version":1,"id":"${TestBackend.MEDIA}","kind":"photo","source":"phone_camera","status":"ready",
                "analysis_status":"complete","created_at":"2026-10-23T10:00:00Z","width":1024,"height":1280},"generation":1,"revision":1,
                "links":{"original":null,"playback":null,"poster":null,"analysis":null},"error_code":null,"frames":[]}"""
        }
        backend.on("GET /v2/media/${TestBackend.MEDIA}/analysis/${TestBackend.ANALYSIS}") { fixture("analysis_with_style_preview.json") }
        backend.on("GET /v1/captures/${TestBackend.CAPTURE}", status = captureStatus) { capture }
    }

    private fun showResult(onOpenCard: (DiscoveryCard) -> Unit = {}) {
        rule.mainClock.autoAdvance = false
        rule.setContent {
            AnalysisResultScreen(
                api = backend.api, notices = notices, mediaId = TestBackend.MEDIA, analysisId = TestBackend.ANALYSIS,
                entry = null, library = LibraryModel(backend.api), onBack = {}, onOpenCard = onOpenCard, onFeed = {},
            )
        }
        rule.waitUntil(5_000) { backend.requests.any { it.startsWith("GET /v1/captures/") } }
        settle(2_000)
    }

    @Test
    fun styleReadingAndRailsRenderTheServerWordsOnly() {
        scriptResult(fixture("capture_style_ready.json"))
        showResult()
        shot("style_reading_top")

        rule.onNodeWithText(StyleCopy.TITLE).assertExists()
        rule.onNodeWithText("A heavyweight canvas work jacket with a rugged, utilitarian look.").assertExists()
        // Two subjects: pill tabs.
        // (The label also appears in "What we saw".)
        assertEquals(2, rule.onAllNodesWithText("Canvas work jacket").fetchSemanticsNodes().size)
        rule.onNodeWithText("Wooden chair").assertExists()
        // Asserted and resembles chips; the undisplayed resemblance and the held claim never show.
        rule.onNodeWithText("Workwear").assertExists()
        rule.onNodeWithText("Resembles Americana").assertExists()
        assertTrue(rule.onAllNodesWithText("Streetwear").fetchSemanticsNodes().isEmpty())
        assertTrue(rule.onAllNodesWithText("Resembles skate").fetchSemanticsNodes().isEmpty())
        // Strength is not drawn; it is only the accessibility state.
        rule.onNode(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "clear")).assertExists()
        // Palette names, details preview, mood line, Qloo links.
        rule.onNodeWithText("Tobacco brown").assertExists()
        assertTrue(rule.onAllNodesWithText("Mystery").fetchSemanticsNodes().isEmpty())
        rule.onNodeWithText("Suggests the 1950s–1970s").assertExists()
        rule.onNodeWithText("Duck canvas").assertExists()
        assertTrue("4th detail row waits for Show all details", rule.onAllNodesWithText("Boxy, hip-length cut").fetchSemanticsNodes().isEmpty())
        scrollTo(StyleCopy.SHOW_DETAILS).performClick()
        settle(600)
        rule.onNodeWithText("Boxy, hip-length cut").assertExists()
        rule.onNodeWithText("Looks like triple-stitched seams").assertExists()
        rule.onNodeWithText("Feels rugged, utilitarian").assertExists()
        assertTrue("retracted claim is gone", rule.onAllNodesWithText("austere", substring = true).fetchSemanticsNodes().isEmpty())
        scrollTo("Related: Filson, Patagonia, Pendleton")
        settle(400)
        shot("style_reading_details")

        // Rails in server order, reasons under cards, honest empty with Add city, running skeleton.
        assertEquals(2, rule.onAllNodesWithText("More like this").fetchSemanticsNodes().size)
        rule.onNodeWithText("Workwear · duck canvas").assertExists()
        rule.onNodeWithText("Because of the workwear cut and duck canvas").assertExists()
        rule.onNodeWithText("For the Americana look your photo resembles", useUnmergedTree = true).assertExists()
        assertEquals(
            "caption on the first More-like-this rail and once above the cross-domain group",
            2,
            rule.onAllNodesWithText(StyleCopy.RAIL_CAPTION).fetchSemanticsNodes().size,
        )
        scrollTo(StyleCopy.NO_CITY)
        rule.onNodeWithText(StyleCopy.ADD_CITY).assertExists()
        settle(400)
        shot("style_rails_more_like_this")
        rule.onNode(hasText("Wear") and isHeading()).assertExists()
        // Wear and Watch both carry a bridge reason.
        assertEquals(2, rule.onAllNodesWithText("Shares a taste with Filson, from your workwear rail", useUnmergedTree = true).fetchSemanticsNodes().size)
        scrollTo(StyleCopy.RAIL_RUNNING)
        settle(400)
        shot("style_rails_cross_domain")
        // The old flat "Suggestions from this" row is replaced by rails; the feed hand-off is not shown.
        assertTrue(rule.onAllNodesWithText("See your Feed").fetchSemanticsNodes().isEmpty())
    }

    @Test
    fun experimentalBadgeOpensTheNoteAndTappingAClaimHighlightsItsRegion() {
        scriptResult(fixture("capture_style_ready.json"))
        showResult()
        assertTrue(rule.onAllNodesWithText(StyleCopy.NOTE).fetchSemanticsNodes().isEmpty())
        rule.onNodeWithText(StyleCopy.BADGE).performClick()
        settle(400)
        rule.onNodeWithText(StyleCopy.NOTE).assertExists()
        shot("style_experimental_note")

        rule.onNodeWithText("Workwear").performClick()
        settle(400)
        rule.onNode(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "highlighted area: upper center of the photo")).assertExists()
        rule.onRoot().captureRoboImage("build/outputs/roborazzi/style_region_highlight.png")
        // Tapping the same claim again clears it.
        rule.onNodeWithText("Workwear").performClick()
        settle(400)
        rule.onNode(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "highlighted area: upper center of the photo")).assertDoesNotExist()
    }

    @Test
    fun whileReadingTheCardShowsTheServerPreviewAndRailSkeletons() {
        scriptResult(fixture("capture_style_running.json"))
        showResult()
        rule.onNodeWithText(StyleCopy.TITLE).assertExists()
        rule.onNodeWithText(StyleCopy.BADGE).assertExists()
        rule.onNodeWithText(StyleCopy.READING, useUnmergedTree = true).assertExists()
        // Both rails (More like this and Wear) are still running.
        assertEquals(2, rule.onAllNodesWithText(StyleCopy.RAIL_RUNNING).fetchSemanticsNodes().size)
        shot("style_reading_running")
        // Still polling at 1.5 s while sections run.
        val before = backend.requests.count { it.startsWith("GET /v1/captures/") }
        settle(1_600)
        rule.waitUntil(3_000) { backend.requests.count { it.startsWith("GET /v1/captures/") } > before }
    }

    @Test
    fun aFailedReadingOffersTryAgainOnce() {
        scriptResult(fixture("capture_style_failed.json"))
        val retries = CopyOnWriteArrayList<String>()
        backend.on("POST /v1/captures/${TestBackend.CAPTURE}/style/retry", status = 409) {
            retries += it.getHeader("Idempotency-Key").orEmpty()
            """{"code":"conflict","message":"This style reading was already retried.","retryable":false,"request_id":"r","details":{"reason":"retry_used"}}"""
        }
        showResult()
        rule.onNodeWithText(StyleCopy.FAILED).assertExists()
        shot("style_reading_failed")
        rule.onNodeWithText(StyleCopy.TRY_AGAIN).performClick()
        rule.waitUntil(5_000) { retries.isNotEmpty() }
        settle(600)
        assertTrue("an Idempotency-Key is sent", retries.single().isNotBlank())
        rule.onNodeWithText(StyleCopy.RETRY_USED).assertExists()
        rule.onNodeWithText(StyleCopy.TRY_AGAIN).assertIsNotEnabled()
        // Cross-domain rails still render; no More-like-this rail is invented.
        assertTrue(rule.onAllNodesWithText("Heath Ceramics").fetchSemanticsNodes().isNotEmpty())
        assertTrue(rule.onAllNodesWithText("More like this").fetchSemanticsNodes().isEmpty())
    }

    @Test
    fun anOlderAnalysisStillShowsItsSuggestionsRow() {
        scriptResult(fixture("capture_legacy.json"))
        showResult()
        // The compiled capture is authoritative: no style section there means no style card.
        assertTrue(rule.onAllNodesWithText(StyleCopy.TITLE).fetchSemanticsNodes().isEmpty())
        rule.onNodeWithText("Suggestions from this").assertExists()
        assertTrue(rule.onAllNodesWithText("Herman Miller").fetchSemanticsNodes().isNotEmpty())
        assertTrue(rule.onAllNodesWithText(StyleCopy.RAIL_CAPTION).fetchSemanticsNodes().isEmpty())
        shot("style_legacy_capture")
    }

    @Test
    fun addCitySendsTheCityInTheBodyOnly() {
        scriptResult(fixture("capture_style_ready.json"))
        val bodies = CopyOnWriteArrayList<String>()
        backend.on("PUT /v1/me/city", status = 204) {
            bodies += "${it.path}|${it.body.readUtf8()}"
            ""
        }
        showResult()
        scrollTo(StyleCopy.ADD_CITY).performClick()
        settle(400)
        rule.onNodeWithText("City").performTextInput("Los Angeles, CA")
        scrollTo("Save")
        settle(300)
        shot("style_add_city")
        rule.onNodeWithText("Save").performClick()
        rule.waitUntil(5_000) { bodies.isNotEmpty() }
        settle(400)
        val (path, body) = bodies.single().split("|", limit = 2)
        assertEquals("/v1/me/city", path)
        assertTrue(body.contains("\"city\":\"Los Angeles, CA\""))
        assertFalse(path.contains("?"))
    }

    @Test
    fun cardDetailWhyThisShowsStyleAttributesAndTheExperimentalLine() {
        backend.on("GET /v1/items/m1") {
            """{"item":${TestBackend.card("m1", "Filson", "wear", "Outdoor outfitter")},
               "description":"An outfitter known for heavy canvas and wool.","reason":"Because of the workwear cut and duck canvas",
               "references":[],"related":[],"related_state":"ready","collection_ids":[],
               "style_match":{"subject_id":"s1","attributes":["Workwear","duck canvas"],"palette":["tobacco brown"],"via":null,"experimental":true},
               "experimental_line":"From your photo."}"""
        }
        val feed = FeedModel(backend.api)
        val card = DiscoveryCard("m1", "qloo_entity", null, "Filson", "Outdoor outfitter", null, false, false, null, null, true)
        rule.mainClock.autoAdvance = false
        rule.setContent {
            FeedCardDetail(api = backend.api, card = card, notices = notices, feed = feed, onBack = {}, onOpenRelated = {})
        }
        rule.waitUntil(5_000) { feed.cachedDetail("m1") != null }
        settle()
        rule.onNodeWithText("Because of the workwear cut and duck canvas").assertExists()
        rule.onNodeWithText("Workwear").assertExists()
        rule.onNodeWithText("duck canvas").assertExists()
        rule.onNodeWithText(StyleCopy.WHY_LINE).assertExists()
        rule.onNodeWithText(StyleCopy.BADGE).assertExists()
        shot("style_card_detail_why_this")
    }
}
