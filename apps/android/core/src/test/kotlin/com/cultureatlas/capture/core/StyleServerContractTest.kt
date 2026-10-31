package com.cultureatlas.capture.core

import com.cultureatlas.capture.core.contract.AnalysisResultResponse
import com.cultureatlas.capture.core.contract.AtlasContract
import com.cultureatlas.capture.core.contract.CaptureResultResponse
import com.cultureatlas.capture.core.result.AnalysisResultReader
import com.cultureatlas.capture.core.result.RailState
import com.cultureatlas.capture.core.result.StyleCopy
import com.cultureatlas.capture.core.result.StyleReader
import com.cultureatlas.capture.core.result.StyleState
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * The server's own wire examples (fixtures/native-contract/messages.json, validated against
 * the zod contract by apps/web/lib/server/native-contract.test.ts) decode and present the
 * way the hand-written style fixtures do. This is the integration check that the phone
 * reads what the server actually sends.
 */
class StyleServerContractTest {
    private val json = AtlasContract.json
    private fun capture(key: String) = json.decodeFromString(CaptureResultResponse.serializer(), Fixtures.messageText(key))

    @Test
    fun additiveDiscoveryIntentsPreserveLegacyPresentation() {
        val baseline = capture("capture_style_response")
        val original = json.parseToJsonElement(Fixtures.messageText("capture_style_response")).jsonObject
        for (status in listOf("unavailable", "pending", "failed")) {
            val intents = buildJsonObject {
                put("version", "atlas_discovery_intents_v1")
                put("default_intent", "connections")
                put("visual", buildJsonObject {
                    put("status", status)
                    put("reason", "catalog_not_configured")
                    put("cards", JsonArray(emptyList()))
                })
                put("connections", buildJsonObject {
                    put("rails", original["rails"] ?: JsonArray(emptyList()))
                })
            }
            val decoded = json.decodeFromJsonElement(
                CaptureResultResponse.serializer(),
                JsonObject(original + ("discovery_intents" to intents)),
            )
            assertEquals(baseline.id, decoded.id)
            assertEquals(baseline.rails, decoded.rails)
            assertEquals(baseline.recommendations, decoded.recommendations)
            assertEquals(StyleState.READY, StyleReader.state(decoded))
            assertEquals(
                StyleReader.rails(baseline, experimental = true),
                StyleReader.rails(decoded, experimental = true),
            )
        }
    }

    @Test
    fun readyCaptureFromTheServerDecodesAndPresents() {
        val c = capture("capture_style_response")
        assertEquals(StyleState.READY, StyleReader.state(c))
        assertEquals(true, StyleReader.isSettled(c))
        val reading = AnalysisResultReader.readStyle(c)
        assertNotNull(reading)
        reading!!
        assertEquals(1, reading.subjects.size)
        val rails = StyleReader.rails(c, experimental = true)
        val mlt = rails.first()
        assertTrue(mlt.moreLikeThis)
        assertEquals(RailState.READY, mlt.state)
        assertEquals(2, mlt.cards.size)
        assertEquals("Brands to explore", mlt.title)
        assertEquals(c.rails!!.first().subtitle, mlt.subtitle)
        assertEquals(c.rails!!.first().cards.map { it.reason }, mlt.cards.map { it.reason })
        assertTrue(mlt.cards.all { !it.reason.isNullOrBlank() }, "every style card carries the server reason")
        assertEquals(StyleCopy.RAIL_CAPTION, mlt.caption)
        assertEquals(1, rails.count { it.caption != null && !it.moreLikeThis }, "one caption above the cross-domain group")
    }

    @Test
    fun runningAndFailedCapturesFromTheServer() {
        val running = capture("capture_style_running_response")
        assertEquals(StyleState.READING, StyleReader.state(running))
        assertEquals(false, StyleReader.isSettled(running))
        val failed = capture("capture_style_failed_response")
        assertEquals(StyleState.FAILED, StyleReader.state(failed))
    }

    @Test
    fun noCityRailOffersAddCity() {
        val c = capture("capture_style_no_city_response")
        val mlt = StyleReader.rails(c, experimental = true).first { it.moreLikeThis }
        assertEquals(RailState.EMPTY, mlt.state)
        assertTrue(mlt.offerCity)
        assertEquals(StyleCopy.NO_CITY, mlt.message)
    }

    @Test
    fun mediaAnalysisPreviewFromTheServer() {
        val r = json.decodeFromString(AnalysisResultResponse.serializer(), Fixtures.messageText("analysis_style_response"))
        val preview = AnalysisResultReader.readStylePreview(r)
        assertNotNull(preview)
        preview!!
        assertFalse(preview.toString().isBlank())
        assertEquals("Experimental", r.experimental?.label)
    }

    @Test
    fun legacyLocationAndUnsupportedCopyRemainServerOwned() {
        val c = capture("capture_style_no_city_response")
        val legacy = c.rails!!.first().copy(emptyMessage = "Add a city to see places with this style.")
        assertTrue(StyleReader.rails(c.copy(rails = listOf(legacy)), experimental = false).first().offerCity)
        val unsupported = legacy.copy(title = "Qloo connections", emptyMessage = "No supported connection on this route.")
        val presented = StyleReader.rails(c.copy(rails = listOf(unsupported)), experimental = false).first()
        assertEquals(unsupported.title, presented.title)
        assertEquals(unsupported.emptyMessage, presented.message)
        assertFalse(presented.offerCity)
    }
}
