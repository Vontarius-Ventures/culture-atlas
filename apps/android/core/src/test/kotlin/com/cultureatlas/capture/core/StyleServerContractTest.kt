package com.cultureatlas.capture.core

import com.cultureatlas.capture.core.contract.AnalysisResultResponse
import com.cultureatlas.capture.core.contract.AtlasContract
import com.cultureatlas.capture.core.contract.CaptureResultResponse
import com.cultureatlas.capture.core.result.AnalysisResultReader
import com.cultureatlas.capture.core.result.RailState
import com.cultureatlas.capture.core.result.StyleCopy
import com.cultureatlas.capture.core.result.StyleReader
import com.cultureatlas.capture.core.result.StyleState
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
}
