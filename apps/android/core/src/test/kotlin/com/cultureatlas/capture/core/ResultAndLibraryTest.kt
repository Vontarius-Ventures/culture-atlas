package com.cultureatlas.capture.core

import com.cultureatlas.capture.core.contract.AnalysisResultResponse
import com.cultureatlas.capture.core.contract.AnalysisState
import com.cultureatlas.capture.core.contract.AtlasContract
import com.cultureatlas.capture.core.contract.CaptureResultResponse
import com.cultureatlas.capture.core.contract.ItemReference
import com.cultureatlas.capture.core.contract.LibraryEntry
import com.cultureatlas.capture.core.contract.LibraryMedia
import com.cultureatlas.capture.core.contract.MediaLibraryResponse
import com.cultureatlas.capture.core.contract.MediaLinks
import com.cultureatlas.capture.core.net.AtlasHttp
import com.cultureatlas.capture.core.net.PrivateMediaPolicy
import com.cultureatlas.capture.core.result.AnalysisReading
import com.cultureatlas.capture.core.result.AnalysisResultCopy
import com.cultureatlas.capture.core.result.AnalysisResultReader
import com.cultureatlas.capture.core.result.LibraryPages
import com.cultureatlas.capture.core.result.LibraryTileCopy
import com.cultureatlas.capture.core.result.MusicOutcome
import com.cultureatlas.capture.core.result.ReferenceCopy
import com.cultureatlas.capture.core.result.ResultRoute
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/** The native result screen and the server Library grid (no browser hand-off). */
class AnalysisResultReaderTest {
    private val json = AtlasContract.json

    private fun decode(body: String) = json.decodeFromString(AnalysisResultResponse.serializer(), body)

    /** Shape written by apps/worker media-analysis.ts publishVision (photo). */
    private val photoBody = """
        {"analysis_id":"6f1a2b3c-4d5e-4f60-8a7b-9c0d1e2f3a4b","job_id":"7f1a2b3c-4d5e-4f60-8a7b-9c0d1e2f3a4b",
         "state":"complete","reused":true,"result_url":"/captures/8f1a2b3c-4d5e-4f60-8a7b-9c0d1e2f3a4b",
         "capture_id":"8f1a2b3c-4d5e-4f60-8a7b-9c0d1e2f3a4b","waiting_reason":null,"error_code":null,
         "result":{"mode":"photo","note":null,
           "frames":[{"frame_id":null,"timestamp_ms":null,"state":"complete"}],
           "candidates":[
             {"name":"Eames Lounge Chair","type":"work","relation":"depicted","cited_frames":[]},
             {"name":"Mid-century modern","type":"style","relation":"resembles","cited_frames":[]},
             {"name":"eames lounge chair","type":"work","relation":"depicted","cited_frames":[]},
             {"name":"  ","type":"object","relation":"depicted","cited_frames":[]}
           ],
           "reading":"quick"}}
    """.trimIndent()

    @Test
    fun photoResultReadsOnlyWhatTheServerPublished() {
        val response = decode(photoBody)
        val reading = AnalysisResultReader.read(response) as AnalysisReading.Vision
        assertEquals(listOf("Eames Lounge Chair", "Resembles Mid-century modern"), reading.seen.map { it.phrase })
        assertEquals(listOf("Work", "Style"), reading.seen.map { it.typeLabel })
        assertEquals(1, reading.framesLooked)
        assertFalse(reading.video)
        assertEquals("Here's what we found", AnalysisResultCopy.headline(response.state, reading))
        assertNull(AnalysisResultCopy.detail(response))
    }

    @Test
    fun noCandidatesSaysSoAndNeverGuesses() {
        val response = decode(
            """{"analysis_id":"a","state":"complete","result":{"mode":"sampled_video","note":"We looked at a few moments.","frames":[],"candidates":[]}}""",
        )
        val reading = AnalysisResultReader.read(response) as AnalysisReading.Vision
        assertTrue(reading.seen.isEmpty())
        assertTrue(reading.video)
        assertEquals("We looked at a few moments.", reading.note)
        assertEquals("Nothing we could name", AnalysisResultCopy.headline(response.state, reading))
    }

    /** Shape written by packages/domain/src/audio/analyze-job.ts. */
    @Test
    fun musicResultShowsOnlyQlooResolvedArtists() {
        val identified = decode(
            """{"analysis_id":"a","job_id":"j","state":"complete","reused":true,"result_url":"/v2/media/m/analysis/a","error_code":null,
               "result":{"music":"identified","components":{"music_match":{"state":"succeeded"}},"evidence_id":"e","recognition_id":"r",
               "qloo_seeds":[{"entity_id":"Q-1","entity_type":"urn:entity:artist","name":"Nina Simone","insights_eligible":true}]}}""",
        )
        val music = AnalysisResultReader.read(identified) as AnalysisReading.Music
        assertEquals(MusicOutcome.IDENTIFIED, music.outcome)
        assertEquals("We heard Nina Simone", AnalysisResultCopy.headline(identified.state, music))

        // "identified" without a resolved Qloo artist is not presented as a match.
        val unresolved = AnalysisResultReader.read(
            decode("""{"analysis_id":"a","state":"partial","result":{"music":"identified","qloo_seeds":[]}}"""),
        ) as AnalysisReading.Music
        assertEquals(MusicOutcome.POSSIBLE, unresolved.outcome)

        // No match drops any seeds rather than showing them.
        val none = AnalysisResultReader.read(
            decode("""{"analysis_id":"a","state":"complete","result":{"music":"no_reliable_match","qloo_seeds":[{"entity_id":"x","name":"Y"}]}}"""),
        ) as AnalysisReading.Music
        assertEquals(MusicOutcome.NO_MATCH, none.outcome)
        assertTrue(none.artists.isEmpty())
    }

    @Test
    fun workingAndFailedStatesAreWords() {
        val queued = decode("""{"analysis_id":"a","state":"queued","waiting_reason":"ai_paused"}""")
        assertEquals(AnalysisResultCopy.LOOKING, AnalysisResultCopy.headline(queued.state, AnalysisReading.Nothing))
        assertTrue(AnalysisResultCopy.detail(queued)!!.contains("paused"))
        assertTrue(AnalysisResultCopy.isWorking(AnalysisState.RUNNING))
        val failed = decode("""{"analysis_id":"a","state":"failed","error_code":"analysis_unavailable","result":{"mode":"photo","frames":[],"candidates":[]}}""")
        assertFalse(AnalysisResultCopy.isWorking(failed.state))
        assertTrue(AnalysisResultCopy.detail(failed)!!.contains("safe in your library"))
        assertEquals(AnalysisReading.Nothing, AnalysisResultReader.read(decode("""{"analysis_id":"a","state":"queued"}""")))
        assertEquals(AnalysisReading.Nothing, AnalysisResultReader.read(decode("""{"analysis_id":"a","state":"complete","result":{"other":1}}""")))
    }

    @Test
    fun captureResultDecodesReferencesAndRecommendations() {
        val capture = json.decodeFromString(
            CaptureResultResponse.serializer(),
            """{"id":"c","source":"camera","status":"complete","received_at":"2026-10-22T10:00:00Z","captured_at":null,"image":null,
                "focus":{"kind":"whole"},"is_example":false,"discovery_item_id":null,"saved":false,
                "analysis":{"id":"x","version":1,"title":"A lounge chair","interpretation":"Moulded plywood and leather.","sections":{},"question":null,"warnings":[],"created_at":"2026-10-22T10:00:00Z"},
                "references":[{"id":"r","name":"Eames Lounge Chair","type":"work","relation":"depicted","qualified":true,"has_page":true}],
                "recommendations":[{"id":"d","kind":"qloo_entity","category":"wear","title":"Herman Miller","is_example":false,"saved":false,"evidence_available":true}],
                "available_categories":["wear"],"job_id":null}""",
        )
        assertEquals("A lounge chair", capture.analysis?.title)
        assertEquals("Eames Lounge Chair", capture.references.single().name)
        assertEquals("Herman Miller", capture.recommendations.single().title)
    }

    /** Mirrors apps/web referencePhrase: qualified means a resemblance, never a confirmed match. */
    @Test
    fun referencesArePhrasedLikeTheWeb() {
        fun ref(qualified: Boolean, relation: String?, readText: String? = null) =
            ItemReference(id = "r", name = "Bauhaus", type = "style", relation = relation, qualified = qualified, hasPage = false, readText = readText)
        assertEquals("Resembles Bauhaus", ReferenceCopy.phrase(ref(qualified = true, relation = "resembles")))
        assertEquals("Resembles Bauhaus", ReferenceCopy.phrase(ref(qualified = true, relation = "depicted")))
        assertEquals("Resembles Bauhaus", ReferenceCopy.phrase(ref(qualified = false, relation = "resembles")))
        assertEquals("Bauhaus", ReferenceCopy.phrase(ref(qualified = false, relation = "depicted")))
        assertEquals("Bauhaus", ReferenceCopy.phrase(ref(qualified = true, relation = "depicted", readText = "BAUHAUS")))
        assertEquals("Read in the photo: “BAUHAUS”", ReferenceCopy.attribution(ref(true, "depicted", "BAUHAUS")))
        assertNull(ReferenceCopy.attribution(ref(false, "depicted")))
    }

    @Test
    fun resultRoutesAcceptOnlyUuids() {
        val route = ResultRoute.parse("6F1A2B3C-4D5E-4F60-8A7B-9C0D1E2F3A4B", "7f1a2b3c-4d5e-4f60-8a7b-9c0d1e2f3a4b")
        assertEquals("6f1a2b3c-4d5e-4f60-8a7b-9c0d1e2f3a4b", route?.mediaId)
        assertNull(ResultRoute.parse("../../v1/accounts", "7f1a2b3c-4d5e-4f60-8a7b-9c0d1e2f3a4b"))
        assertNull(ResultRoute.parse(null, "7f1a2b3c-4d5e-4f60-8a7b-9c0d1e2f3a4b"))
        assertNull(ResultRoute.parse("6f1a2b3c-4d5e-4f60-8a7b-9c0d1e2f3a4b", "x"))
    }
}

class LibraryPagesTest {
    private fun entry(id: String, kind: String = "photo", status: String = "ready", analysis: String = "not_requested", gen: Int = 1) =
        LibraryEntry(
            media = LibraryMedia(id = id, kind = kind, status = status, analysisStatus = analysis),
            generation = gen,
            links = MediaLinks(playback = "/v2/media/$id/content/n-$id", poster = if (kind == "video") "/v2/media/$id/content/p-$id" else null),
        )

    private fun page(vararg ids: String, next: String? = null) = MediaLibraryResponse(ids.map { entry(it) }, next)

    @Test
    fun pagesAppendWithoutDuplicates() {
        val first = LibraryPages().refreshed(page("a", "b", "c", next = "k1"))
        assertEquals(listOf("a", "b", "c"), first.entries.map { it.media.id })
        assertTrue(first.hasMore)
        val second = first.appended(page("c", "d", next = null))
        assertEquals(listOf("a", "b", "c", "d"), second.entries.map { it.media.id })
        assertFalse(second.hasMore)
    }

    @Test
    fun refreshPutsNewFirstAndKeepsWhatWasShown() {
        val shown = LibraryPages().refreshed(page("a", "b", next = "k1")).appended(page("c", next = null))
        val refreshed = shown.refreshed(page("z", "a", next = "k2"))
        assertEquals(listOf("z", "a", "b", "c"), refreshed.entries.map { it.media.id })
        // A failed or empty refresh never empties what is on screen.
        val empty = refreshed.refreshed(MediaLibraryResponse(emptyList(), null))
        assertEquals(listOf("z", "a", "b", "c"), empty.entries.map { it.media.id })
    }

    @Test
    fun updateReplacesInPlace() {
        val pages = LibraryPages().refreshed(page("a", "b"))
        val updated = pages.updated(entry("B", analysis = "running"))
        assertEquals("running", updated.entries[1].media.analysisStatus)
        assertEquals(pages.entries.size, updated.entries.size)
    }

    @Test
    fun prefetchAndPendingDrafts() {
        assertTrue(LibraryPages.shouldLoadMore(lastVisibleIndex = 24, total = 30, hasMore = true, loading = false))
        assertFalse(LibraryPages.shouldLoadMore(lastVisibleIndex = 10, total = 30, hasMore = true, loading = false))
        assertFalse(LibraryPages.shouldLoadMore(lastVisibleIndex = 29, total = 30, hasMore = true, loading = true))
        assertFalse(LibraryPages.shouldLoadMore(lastVisibleIndex = 29, total = 30, hasMore = false, loading = false))
        data class Draft(val id: String, val assetId: String?)
        val drafts = listOf(Draft("1", null), Draft("2", "A"), Draft("3", "b"))
        assertEquals(listOf("1", "3"), LibraryPages.pendingDrafts(drafts, setOf("a")) { it.assetId }.map { it.id })
    }

    @Test
    fun tileWordsAndPictures() {
        assertEquals("/v2/media/a/content/n-a", LibraryTileCopy.picturePath(entry("a")))
        assertEquals("/v2/media/v/content/p-v", LibraryTileCopy.picturePath(entry("v", kind = "video")))
        assertEquals("Explored", LibraryTileCopy.status(entry("a", analysis = "complete")))
        assertEquals("Preparing", LibraryTileCopy.status(entry("a", status = "processing")))
        assertTrue(LibraryTileCopy.canExplore(entry("a")))
        assertFalse(LibraryTileCopy.canExplore(entry("a", status = "processing")))
        assertEquals("sampled_video", LibraryTileCopy.analysisMode("video"))
    }

    @Test
    fun bearerOnlyForOwnMediaOnTheApiHost() {
        val host = "app.cultureatlas.com"
        assertTrue(PrivateMediaPolicy.needsBearer("https", host, 443, "/v2/media/a/content/p", host))
        assertFalse(PrivateMediaPolicy.needsBearer("https", "images.qloo.com", 443, "/v2/media/a/content/p", host))
        assertFalse(PrivateMediaPolicy.needsBearer("http", host, 443, "/v2/media/a/content/p", host))
        assertFalse(PrivateMediaPolicy.needsBearer("https", host, 443, "/samples/chair.jpg", host))
        assertFalse(PrivateMediaPolicy.needsBearer("https", host, 443, "/v2/media/../v1/accounts", host))
        assertFalse(PrivateMediaPolicy.needsBearer("https", host, 8443, "/v2/media/a/content/p", host))
        assertTrue(PrivateMediaPolicy.needsBearer("https", "dev.test", 8443, "/v2/media/a/content/p", "dev.test:8443"))
        assertTrue(PrivateMediaPolicy.isPrivate("https://$host/v2/media/a/content/p", "https://$host"))
        assertFalse(PrivateMediaPolicy.isPrivate("https://$host/samples/x.jpg", "https://$host/"))
    }

    /** `GET /v2/library` sends limit/cursor and decodes the server page. */
    @Test
    fun libraryCallUsesCursorPaging() = runBlocking<Unit> {
        val server = MockWebServer()
        server.enqueue(
            MockResponse().setBody(
                """{"items":[{"media":{"schema_version":1,"id":"a","kind":"photo","source":"phone_camera","status":"ready",
                   "analysis_status":"complete","created_at":"2026-10-22T10:00:00Z"},"generation":2,"revision":1,
                   "links":{"original":null,"playback":"/v2/media/a/content/n","poster":null,"analysis":null},"error_code":null,"frames":[]}],
                   "next_cursor":"eyJhdCI6IngifQ"}""",
            ),
        )
        server.start()
        try {
            val http = AtlasHttp(server.url("/"))
            val page = http.get(
                "/v2/library", MediaLibraryResponse.serializer(),
                mapOf("limit" to "30", "cursor" to "abc"), bearer = "cna_x",
            )
            assertEquals("a", page.items.single().media.id)
            assertEquals(2, page.items.single().generation)
            assertEquals("eyJhdCI6IngifQ", page.nextCursor)
            val request = server.takeRequest()
            assertEquals("/v2/library?limit=30&cursor=abc", request.path)
        } finally {
            server.shutdown()
        }
    }
}
