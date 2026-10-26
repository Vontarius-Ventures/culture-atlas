package com.cultureatlas.capture.core

import com.cultureatlas.capture.core.contract.AnalysisResultResponse
import com.cultureatlas.capture.core.contract.AtlasContract
import com.cultureatlas.capture.core.contract.Availability
import com.cultureatlas.capture.core.contract.Capabilities
import com.cultureatlas.capture.core.contract.CaptureResultResponse
import com.cultureatlas.capture.core.contract.CityRequest
import com.cultureatlas.capture.core.contract.ItemDetailResponse
import com.cultureatlas.capture.core.contract.StyleRegion
import com.cultureatlas.capture.core.net.AtlasApi
import com.cultureatlas.capture.core.net.AtlasClientException
import com.cultureatlas.capture.core.net.AtlasHttp
import com.cultureatlas.capture.core.net.retryStyle
import com.cultureatlas.capture.core.net.setCity
import com.cultureatlas.capture.core.identity.SessionManager
import com.cultureatlas.capture.core.identity.StoredSession
import com.cultureatlas.capture.core.identity.TokenVault
import com.cultureatlas.capture.core.contract.NativeSessionTokens
import com.cultureatlas.capture.core.policy.CapabilityGate
import com.cultureatlas.capture.core.result.AnalysisResultReader
import com.cultureatlas.capture.core.result.RailState
import com.cultureatlas.capture.core.result.StyleCopy
import com.cultureatlas.capture.core.result.StyleReader
import com.cultureatlas.capture.core.result.StyleState
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.io.File

/** Style reading, rails and the experimental label (prp/2026-10-23-style-analysis/design.md E.2–E.4, F.1, F.4). */
class StyleReaderTest {
    private val json = AtlasContract.json
    private val root = File(System.getProperty("atlas.style.fixtures") ?: error("atlas.style.fixtures is not set"))

    private fun text(name: String) = File(root, name).readText()
    private fun capture(name: String) = json.decodeFromString(CaptureResultResponse.serializer(), text(name))

    // ---- Decoding ---------------------------------------------------------------------------

    @Test
    fun fullStylePayloadDecodesWithUnknownFields() {
        val c = capture("capture_style_ready.json")
        assertEquals("ready", c.analysis!!.sections["style"])
        assertEquals("Experimental", c.analysis!!.experimental!!.label)
        val reading = c.styleReading!!
        assertEquals("atlas_style_reading_v1", reading.version)
        assertEquals(2, reading.subjects.size)
        assertEquals(listOf("subjects[0].mood[2]"), reading.retracted)
        assertEquals(5, c.rails!!.size)
        val card = c.rails!!.first().cards.first()
        assertEquals("Because of the workwear cut and duck canvas", card.reason)
        assertEquals(listOf("Workwear", "duck canvas"), card.styleMatch!!.attributes)
        assertTrue(card.styleMatch!!.experimental)
    }

    @Test
    fun olderAnalysesDecodeWithNullableDefaults() {
        val c = capture("capture_legacy.json")
        assertNull(c.styleReading)
        assertNull(c.rails)
        assertTrue(c.analysis!!.sections.isEmpty())
        assertNull(c.analysis!!.experimental)
        assertNull(c.recommendations.first().reason)
        assertNull(c.recommendations.first().styleMatch)
        assertEquals(StyleState.ABSENT, StyleReader.state(c))
        assertNull(AnalysisResultReader.readStyle(c))
        assertNull(StyleReader.isSettled(c), "old captures keep the old stop rule")
        // The old recommendations row is kept as the only rail, untouched.
        val rails = StyleReader.rails(c, experimental = false)
        assertEquals(1, rails.size)
        assertEquals("Suggestions from this", rails.single().title)
        assertEquals(listOf("c1", "c2"), rails.single().cards.map { it.id })
        assertNull(rails.single().caption)
    }

    @Test
    fun itemDetailCarriesStyleMatchAndExperimentalLine() {
        val body = """{"item":{"id":"m1","kind":"qloo_entity","title":"Filson","is_example":false,"saved":false,"evidence_available":true},
            "related_state":"ready","style_match":{"subject_id":"s1","attributes":["Workwear"],"experimental":true},
            "experimental_line":"Suggested from an experimental reading of your photo."}"""
        val d = json.decodeFromString(ItemDetailResponse.serializer(), body)
        assertEquals(listOf("Workwear"), d.styleMatch!!.attributes)
        assertEquals(StyleCopy.WHY_LINE, d.experimentalLine)
        val old = json.decodeFromString(ItemDetailResponse.serializer(), """{"item":{"id":"m1","kind":"qloo_entity","title":"Filson","is_example":false,"saved":false,"evidence_available":true},"related_state":"ready"}""")
        assertNull(old.styleMatch)
        assertNull(old.experimentalLine)
    }

    // ---- Wording: server display strings only ---------------------------------------------

    @Test
    fun readingUsesServerDisplayStringsAndNeverAssertsAResemblance() {
        val p = AnalysisResultReader.readStyle(capture("capture_style_ready.json"))!!
        assertEquals("A heavyweight canvas work jacket with a rugged, utilitarian look.", p.summary)
        val jacket = p.subjects.first()
        assertEquals("Canvas work jacket", jacket.label)
        // Streetwear is `resembles` with no display: dropped, never shown as "Streetwear".
        // Skate is held: never shown.
        assertEquals(listOf("Workwear", "Resembles Americana"), jacket.chips.map { it.text })
        assertEquals(listOf(true, false), jacket.chips.map { it.asserted })
        // Strength is derived after wording: a "clear" resemblance is clamped to "likely".
        assertEquals(listOf("clear", "likely"), jacket.chips.map { it.strength })
        assertTrue(p.subjects.flatMap { it.chips }.none { it.text == "Streetwear" || it.text.contains("skate", true) })
    }

    @Test
    fun detailGroupsKeepOrderAndPreviewThreeRows() {
        val jacket = AnalysisResultReader.readStyle(capture("capture_style_ready.json"))!!.subjects.first()
        assertEquals(listOf("Era & lineage", "Materials", "Construction", "Details"), jacket.detailGroups.map { it.title })
        assertEquals(
            listOf("Suggests the 1950s–1970s", "Resembles American heritage workwear"),
            jacket.detailGroups.first().rows.map { it.text },
        )
        assertEquals(listOf("Boxy, hip-length cut", "Looks like triple-stitched seams"), jacket.detailGroups[2].rows.map { it.text })
        assertEquals(6, jacket.detailCount)
        val preview = jacket.detailPreview()
        assertEquals(3, preview.sumOf { it.rows.size })
        assertEquals(listOf("Era & lineage", "Materials"), preview.map { it.title })
        // Resemblance rows are marked in words ("Resembles", "Looks like", "Suggests"), never colour alone.
        jacket.detailGroups.flatMap { it.rows }.filter { !it.asserted }.forEach {
            assertTrue(it.text.startsWith("Resembles") || it.text.startsWith("Looks like") || it.text.startsWith("Suggests"), it.text)
        }
    }

    @Test
    fun retractedMoodIsRemovedAndMoodIsOneLine() {
        val jacket = AnalysisResultReader.readStyle(capture("capture_style_ready.json"))!!.subjects.first()
        assertEquals("Feels rugged, utilitarian", jacket.moodLine)
        assertEquals("Qloo also links: Filson, Patagonia, Pendleton", jacket.qlooLinks)
        assertNull(StyleReader.moodLine(emptyList()))
    }

    @Test
    fun paletteComesFromMeasuredHexAndScalesByShare() {
        val p = AnalysisResultReader.readStyle(capture("capture_style_ready.json"))!!
        val jacket = p.subjects.first()
        // Swatch 4 has an invalid hex: dropped, never guessed.
        assertEquals(listOf("Tobacco brown", "Faded black"), jacket.palette.map { it.name })
        assertEquals(0xFF7B5A3AL, jacket.palette.first().argb)
        assertEquals(56, jacket.palette[0].sizeDp)
        assertTrue(jacket.palette[1].sizeDp in 28 until 56)
        // A palette entry with no hex of its own reads it from the reading's swatches.
        val chair = p.subjects[1]
        assertEquals("#C9B99A", chair.palette.single().hex)
    }

    @Test
    fun regionsAreDrawableOnlyInsideThePhoto() {
        val jacket = AnalysisResultReader.readStyle(capture("capture_style_ready.json"))!!.subjects.first()
        assertNotNull(jacket.region)
        assertNotNull(jacket.chips.first().region)
        assertNull(jacket.chips[1].region)
        assertFalse(StyleRegion(0.8, 0.8, 0.5, 0.5).drawable)
        assertFalse(StyleRegion(0.1, 0.1, 0.0, 0.2).drawable)
        assertEquals("highlighted area: upper left of the photo", StyleReader.regionDescription(StyleRegion(0.0, 0.0, 0.2, 0.2)))
        assertEquals("highlighted area: center of the photo", StyleReader.regionDescription(StyleRegion(0.4, 0.4, 0.2, 0.2)))
        assertEquals("highlighted area: lower right of the photo", StyleReader.regionDescription(StyleRegion(0.8, 0.8, 0.15, 0.15)))
        assertEquals("highlighted area: middle left of the photo", StyleReader.regionDescription(StyleRegion(0.0, 0.4, 0.2, 0.2)))
    }

    // ---- States and polling ---------------------------------------------------------------

    @Test
    fun sectionStatesAndPollingTermination() {
        val ready = capture("capture_style_ready.json")
        assertEquals(StyleState.READY, StyleReader.state(ready))
        // "play" is still running: keep polling.
        assertEquals(false, StyleReader.isSettled(ready))

        val running = capture("capture_style_running.json")
        assertEquals(StyleState.READING, StyleReader.state(running))
        assertEquals(false, StyleReader.isSettled(running))

        val failed = capture("capture_style_failed.json")
        assertEquals(StyleState.FAILED, StyleReader.state(failed))
        // An unknown section status is terminal (R-16c).
        assertEquals(true, StyleReader.isSettled(failed))

        // "ready" before the reading is written is still reading.
        val landing = ready.copy(styleReading = null)
        assertEquals(StyleState.READING, StyleReader.state(landing))
        val held = ready.copy(analysis = ready.analysis!!.copy(sections = mapOf("style" to "held")), styleReading = null, rails = emptyList())
        assertEquals(StyleState.HELD, StyleReader.state(held))
        assertEquals(true, StyleReader.isSettled(held))
        val empty = held.copy(analysis = held.analysis!!.copy(sections = mapOf("style" to "empty")))
        assertEquals(StyleState.EMPTY, StyleReader.state(empty))
        assertTrue(StyleReader.isTerminal("whatever"))
        assertFalse(StyleReader.isTerminal("pending"))
    }

    // ---- Rails -------------------------------------------------------------------------------

    @Test
    fun railsKeepServerOrderWithHonestEmptiesAndOneCaptionPerGroup() {
        val rails = StyleReader.rails(capture("capture_style_ready.json"), experimental = true)
        assertEquals(listOf("more_like_this:s1", "more_like_this:s2", "wear", "play", "watch"), rails.map { it.key })
        assertEquals(listOf(RailState.READY, RailState.EMPTY, RailState.READY, RailState.RUNNING, RailState.READY), rails.map { it.state })
        // Caption on the first More-like-this rail and once above the cross-domain group (R-17).
        assertEquals(listOf(StyleCopy.RAIL_CAPTION, null, StyleCopy.RAIL_CAPTION, null, null), rails.map { it.caption })
        val noCity = rails[1]
        assertEquals(StyleCopy.NO_CITY, noCity.message)
        assertTrue(noCity.offerCity)
        assertTrue(noCity.cards.isEmpty(), "an empty rail is never filled")
        assertEquals(StyleCopy.RAIL_RUNNING, rails[3].message)
        assertEquals("Workwear · duck canvas", rails[0].subtitle)
        // Without the experimental label there is no caption anywhere.
        assertTrue(StyleReader.rails(capture("capture_style_ready.json"), experimental = false).all { it.caption == null })
        // An empty rail with no server message uses the D.4 copy.
        val failed = StyleReader.rails(capture("capture_style_failed.json"), experimental = true)
        assertEquals(StyleCopy.RAIL_EMPTY, failed[1].message)
        assertFalse(failed[1].offerCity)
    }

    // ---- Experimental label ---------------------------------------------------------------

    @Test
    fun experimentalLabelOnCaptureAndAnalysis() {
        val badge = StyleReader.experimental(capture("capture_style_ready.json"))!!
        assertEquals("Experimental", badge.label)
        assertEquals(StyleCopy.NOTE, badge.note)
        assertNull(StyleReader.experimental(capture("capture_legacy.json")))
        val analysis = json.decodeFromString(AnalysisResultResponse.serializer(), text("analysis_with_style_preview.json"))
        assertEquals("Experimental", StyleReader.experimental(null, analysis.experimental)!!.label)
    }

    @Test
    fun capabilitiesExposeExperimentalAndPaused() {
        fun caps(a: Availability) = Capabilities("2", mapOf("concentrate_analysis_enabled" to true), emptyMap(), mapOf("analysis" to a))
        val experimental = CapabilityGate.photoAnalysis(
            json.decodeFromString(
                Capabilities.serializer(),
                """{"contract_version":"2","flags":{},"limits":{},"availability":{"analysis":{"available":true,"experimental":true,
                   "label":"Experimental","note":"Photo and video readings are experimental. They can miss or misread details.",
                   "reason":"experimental_production"}}}""",
            ),
        )
        assertTrue(experimental.available)
        assertTrue(experimental.experimental)
        assertEquals("Experimental", experimental.label)
        assertEquals(StyleCopy.NOTE, experimental.note)
        // Older demo servers sent "Experimental reading" and no note: the badge is still "Experimental".
        val demo = CapabilityGate.photoAnalysis(caps(Availability(true, emptyList(), experimental = true, label = "Experimental reading")))
        assertEquals("Experimental", demo.label)
        assertEquals(StyleCopy.NOTE, demo.note)
        val qualified = CapabilityGate.photoAnalysis(caps(Availability(true, emptyList())))
        assertFalse(qualified.experimental)
        assertNull(qualified.label)
        val paused = CapabilityGate.photoAnalysis(caps(Availability(false, emptyList(), reason = "paused")))
        assertFalse(paused.available)
        assertEquals(StyleCopy.PAUSED, paused.message)
    }

    // ---- Media-analysis preview (E.3) -------------------------------------------------------

    @Test
    fun analysisPreviewShowsServerChipsAndMeasuredSwatches() {
        val analysis = json.decodeFromString(AnalysisResultResponse.serializer(), text("analysis_with_style_preview.json"))
        val preview = AnalysisResultReader.readStylePreview(analysis)!!
        assertEquals(listOf("Workwear", "Resembles Americana"), preview.chips.map { it.text })
        assertEquals(listOf(0xFF7B5A3AL, 0xFF2B2A28L), preview.swatches)
        // The candidates still read as before.
        assertTrue(AnalysisResultReader.read(analysis) is com.cultureatlas.capture.core.result.AnalysisReading.Vision)
        // Not ready → no preview.
        val running = analysis.result!!.toMutableMap().apply {
            put("style", json.parseToJsonElement("""{"status":"running"}"""))
        }
        assertNull(StyleReader.preview(kotlinx.serialization.json.JsonObject(running)))
        assertNull(StyleReader.preview(null))
    }

    // ---- Endpoints (E.4) ------------------------------------------------------------------

    @Test
    fun retryAndCityUseTheBodyAndAnIdempotencyKey() = runBlocking {
        val server = MockWebServer()
        server.enqueue(MockResponse().setResponseCode(202).setBody("""{"sections":{"style":"running"}}"""))
        server.enqueue(MockResponse().setResponseCode(409).setBody("""{"code":"conflict","message":"This style reading was already retried.","retryable":false,"request_id":"req_1","details":{"reason":"retry_used"}}"""))
        server.enqueue(MockResponse().setResponseCode(204))
        server.start()
        try {
            val vault = object : TokenVault {
                var s: StoredSession? = StoredSession(
                    NativeSessionTokens("s", "i", ACCOUNT, "cna_test", "r", "2099-01-01T00:00:00Z", "2099-01-01T00:00:00Z"),
                )
                override fun read() = s
                override fun write(session: StoredSession) { s = session }
                override fun clear() { s = null }
            }
            val http = AtlasHttp(server.url("/"))
            val api = AtlasApi(http, SessionManager(http, vault))
            val accepted = api.retryStyle(CAPTURE.uppercase())
            assertEquals("running", accepted["sections"]!!.jsonObject["style"]!!.jsonPrimitive.content)
            val first = server.takeRequest()
            assertEquals("POST", first.method)
            assertEquals("/v1/captures/$CAPTURE/style/retry", first.path)
            assertNotNull(first.getHeader("Idempotency-Key"))
            val used = assertThrows<AtlasClientException.Server> { runBlocking { api.retryStyle(CAPTURE) } }
            assertEquals(409, used.status)
            assertEquals("conflict", used.code)
            server.takeRequest()

            api.setCity("  Los Angeles, CA  ")
            val city = server.takeRequest()
            assertEquals("PUT", city.method)
            assertEquals("/v1/me/city", city.path, "the city is never in a query string")
            assertEquals(CityRequest("Los Angeles, CA"), json.decodeFromString(CityRequest.serializer(), city.body.readUtf8()))
            assertNotNull(city.getHeader("Idempotency-Key"))
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun styleRoutesAreOnTheNativeAllowList() {
        assertTrue(
            AtlasApi.ONBOARDING_OPERATIONS.containsAll(
                listOf("GET /v1/captures/{id}", "POST /v1/captures/{id}/style/retry", "PUT /v1/me/city"),
            ),
        )
    }

    private companion object {
        const val ACCOUNT = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d"
        const val CAPTURE = "8f1a2b3c-4d5e-4f60-8a7b-9c0d1e2f3a4b"
    }
}
