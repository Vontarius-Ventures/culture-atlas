package com.cultureatlas.capture.core

import com.cultureatlas.capture.core.contract.AnalysisState
import com.cultureatlas.capture.core.contract.AnalysisStatus
import com.cultureatlas.capture.core.contract.AnalyzeMediaRequest
import com.cultureatlas.capture.core.contract.AtlasContract
import com.cultureatlas.capture.core.contract.CompleteOnboardingResponse
import com.cultureatlas.capture.core.contract.CreatePickRequest
import com.cultureatlas.capture.core.contract.CreatePickResponse
import com.cultureatlas.capture.core.contract.DeletePickResponse
import com.cultureatlas.capture.core.contract.EmptyBody
import com.cultureatlas.capture.core.contract.FlatServerError
import com.cultureatlas.capture.core.contract.FoodExclusionsBody
import com.cultureatlas.capture.core.contract.MediaDetail
import com.cultureatlas.capture.core.contract.OnboardingCatalog
import com.cultureatlas.capture.core.contract.OnboardingSearchResponse
import com.cultureatlas.capture.core.contract.OnboardingStateResponse
import com.cultureatlas.capture.core.contract.PushTokenRequest
import com.cultureatlas.capture.core.contract.PushTokenResponse
import com.cultureatlas.capture.core.contract.SeedCategoryState
import com.cultureatlas.capture.core.contract.SeedState
import com.cultureatlas.capture.core.contract.TasteCategory
import com.cultureatlas.capture.core.contract.TastePicksResponse
import com.cultureatlas.capture.core.contract.TasteSeedStatus
import com.cultureatlas.capture.core.net.AtlasApi
import com.cultureatlas.capture.core.net.AtlasClientException
import com.cultureatlas.capture.core.net.AtlasHttp
import com.cultureatlas.capture.core.notify.ReadyNoticeCopy
import com.cultureatlas.capture.core.notify.ReadyNoticePolicy
import com.cultureatlas.capture.core.notify.ReadyNoticeStore
import com.cultureatlas.capture.core.notify.WatchedAnalysis
import com.cultureatlas.capture.core.onboarding.OnboardingCopy
import com.cultureatlas.capture.core.onboarding.OnboardingPolicy
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.nio.file.Files
import java.time.Instant
import java.util.UUID

/** Taste onboarding (amendment 2.2) against fixtures/native-contract/onboarding.json and messages.json. */
class OnboardingTest {
    private val json = AtlasContract.json
    private val fixture get() = Fixtures.json("onboarding.json")

    private fun <T> decode(serializer: KSerializer<T>, key: String): T = json.decodeFromString(serializer, Fixtures.messageText(key))

    @Test
    fun decodesEveryOnboardingResponseExample() {
        val catalog = decode(OnboardingCatalog.serializer(), "onboarding_catalog_response")
        assertEquals(OnboardingPolicy.MIN_PICKS, catalog.minPicks)
        assertEquals(
            "https://app.cultureatlas.com/samples/feed/tea-rituals.jpg",
            catalog.images.first().image?.resolved("https://app.cultureatlas.com/"),
        )
        assertTrue(catalog.allEntries.any { it.picked && it.pickId != null })
        val search = decode(OnboardingSearchResponse.serializer(), "onboarding_search_response")
        assertFalse(search.unavailable)
        assertEquals("Artist", search.results.first().typeLabel)
        assertTrue(decode(OnboardingSearchResponse.serializer(), "onboarding_search_unavailable_response").unavailable)
        val pick = decode(CreatePickResponse.serializer(), "onboarding_pick_response")
        assertEquals(2, pick.pick.savedItemIds.size, "a multi-tag image is one pick with several saves")
        assertEquals(1, pick.state.picksCount)
        decode(DeletePickResponse.serializer(), "onboarding_delete_pick_response")
        decode(FoodExclusionsBody.serializer(), "onboarding_exclusions_response")
        assertFalse(decode(CompleteOnboardingResponse.serializer(), "onboarding_complete_response").state.required)
        val state = decode(OnboardingStateResponse.serializer(), "onboarding_state_response")
        assertEquals(state.state.picksCount, state.picks.size)
        val partial = decode(TasteSeedStatus.serializer(), "onboarding_seed_partial_response")
        assertEquals(OnboardingPolicy.SeedAction.ADVANCE, OnboardingPolicy.seed(partial, 0))
        assertEquals(1000L, OnboardingPolicy.seedPollMs(partial))
        val retrying = decode(TasteSeedStatus.serializer(), "onboarding_seed_retrying_response")
        assertEquals(OnboardingPolicy.SeedAction.BACKGROUND, OnboardingPolicy.seed(retrying, 0))
        val taste = decode(TastePicksResponse.serializer(), "taste_picks_response")
        assertEquals(taste.picksCount, taste.picks.all.size)
    }

    @Test
    fun requestsEncodeToTheExampleBodies() {
        roundTrip(CreatePickRequest.serializer(), "onboarding_pick_catalog_request")
        roundTrip(CreatePickRequest.serializer(), "onboarding_pick_search_request")
        roundTrip(FoodExclusionsBody.serializer(), "onboarding_exclusions_request")
        roundTrip(EmptyBody.serializer(), "onboarding_complete_request")
        assertEquals(Fixtures.message("onboarding_pick_catalog_request"), Json.parseToJsonElement(json.encodeToString(CreatePickRequest.serializer(), CreatePickRequest.catalog("img-tea"))))
    }

    private fun <T> roundTrip(serializer: KSerializer<T>, key: String) {
        val example = Fixtures.message(key)
        val model = json.decodeFromString(serializer, example.toString())
        assertEquals(example, Json.parseToJsonElement(json.encodeToString(serializer, model)), key)
    }

    @Test
    fun copyMatchesTheDesignCopy() {
        val copy = fixture["copy"]!!.obj
        OnboardingCopy.byKey.forEach { (key, value) -> assertEquals(value, copy[key].str, key) }
        assertEquals(OnboardingCopy.step(2), copy["onboarding.step"].str!!.replace("{n}", "2"))
        assertEquals(OnboardingCopy.tasteRemove("Japandi"), copy["settings_taste.remove"].str!!.replace("{label}", "Japandi"))
        val groups = fixture["category_copy_keys"]!!.obj
        TasteCategory.entries.forEach { assertEquals(OnboardingCopy.group(it), copy[groups[it.wire].str!!].str) }
    }

    @Test
    fun limitsMatchTheFixture() {
        val limits = fixture["limits"]!!.obj
        assertEquals(OnboardingPolicy.MIN_PICKS, limits["min_picks"].int)
        assertEquals(OnboardingPolicy.MAX_PICKS, limits["max_picks"].int)
        assertEquals(OnboardingPolicy.SEARCH_MIN_CHARS, limits["search_query_min_chars"].int)
        assertEquals(OnboardingPolicy.SEARCH_MAX_CHARS, limits["search_query_max_chars"].int)
        assertEquals(OnboardingPolicy.EXCLUSIONS_MAX, limits["exclusions_max"].int)
        assertEquals(OnboardingPolicy.EXCLUSION_MAX_CHARS, limits["exclusion_max_chars"].int)
        assertEquals(TasteCategory.entries.map { it.wire }, fixture["categories"]!!.arr.map { it.str })
        assertEquals(OnboardingPolicy.SEARCH_DEBOUNCE_MS, fixture["search"]!!.obj["debounce_ms"].long)
        assertEquals(OnboardingPolicy.DEFAULT_SEED_POLL_MS, fixture["seed"]!!.obj["default_poll_ms"].long)
        assertEquals(OnboardingPolicy.SEED_MAX_WAIT_MS, fixture["seed"]!!.obj["max_wait_ms"].long)
    }

    @Test
    fun counterTable() {
        for (row in fixture["counter"]!!.arr.map { it.obj }) {
            val counter = OnboardingPolicy.counter(row["picks"].int!!)
            assertEquals(row["text"].str, counter.text)
            assertEquals(row["progress"].int, counter.progress)
            assertEquals(row["can_complete"].bool, counter.canComplete)
        }
    }

    @Test
    fun searchAndExclusionTables() {
        for (c in fixture["search"]!!.obj["cases"]!!.arr.map { it.obj }) {
            assertEquals(c["expect"].str, OnboardingPolicy.searchQuery(c["input"].str!!), c["name"].str)
        }
        val exclusions = fixture["exclusions"]!!.obj
        for (c in exclusions["cases"]!!.arr.map { it.obj }) {
            val out = OnboardingPolicy.addExclusion(c["current"]!!.arr.map { it.str!! }, c["input"].str!!)
            val expect = c["expect"]!!.obj
            assertEquals(expect["list"]!!.arr.map { it.str }, out.list, c["name"].str)
            assertEquals(expect["rejected"].str, out.rejected?.wire, c["name"].str)
        }
        for (c in exclusions["toggle_cases"]!!.arr.map { it.obj }) {
            assertEquals(
                c["expect"]!!.arr.map { it.str },
                OnboardingPolicy.toggleExclusion(c["current"]!!.arr.map { it.str!! }, c["term"].str!!),
                c["name"].str,
            )
        }
        for (c in exclusions["display_examples"]!!.arr.map { it.obj }) {
            assertEquals(c["label"].str, OnboardingPolicy.label(c["term"].str!!))
        }
    }

    @Test
    fun entryCompleteAndSeedTables() {
        for (c in fixture["entry"]!!.obj["cases"]!!.arr.map { it.obj }) {
            val state = c["state"] as? JsonObject
            val entry = OnboardingPolicy.entry(c["onboarding_flag"].bool!!, state?.get("required").bool, c["error"].str)
            assertEquals(c["expect"].str, entry.wire, c["name"].str)
        }
        for (c in fixture["complete"]!!.obj["cases"]!!.arr.map { it.obj }) {
            assertEquals(c["expect"].str, OnboardingPolicy.complete(c["picks"].int!!, c["error"].str).wire, c["name"].str)
        }
        for (c in fixture["seed"]!!.obj["cases"]!!.arr.map { it.obj }) {
            val action = OnboardingPolicy.seed(
                json.decodeFromString(SeedState.serializer(), c["state"].toString()),
                c["categories"]!!.arr.map { json.decodeFromString(SeedCategoryState.serializer(), it.toString()) },
                c["elapsed_ms"].long!!,
            )
            assertEquals(c["expect"].str, action.wire, c["name"].str)
        }
    }

    /** /v1 flat error bodies become the same typed server error as /v2 ones. */
    @Test
    fun flatV1ErrorsAndTheOwnerBridgeHeaders() = runBlocking<Unit> {
        val server = MockWebServer()
        server.enqueue(MockResponse().setResponseCode(409).setBody(Fixtures.messageText("v1_error_body")))
        server.start()
        try {
            val flat = decode(FlatServerError.serializer(), "v1_error_body")
            val http = AtlasHttp(server.url("/"))
            val error = try {
                http.call(
                    "POST", "/v1/onboarding/complete", EmptyBody(), EmptyBody.serializer(),
                    CompleteOnboardingResponse.serializer(), bearer = "cna_x", idempotencyKey = UUID.randomUUID(),
                    expectedAccount = "A1B2C3D4-E5F6-4A7B-8C9D-0E1F2A3B4C5D",
                )
                null
            } catch (e: AtlasClientException.Server) {
                e
            }
            assertNotNull(error)
            assertEquals(flat.code, error!!.code)
            assertEquals(409, error.status)
            assertEquals(OnboardingPolicy.CompleteAction.RELOAD_STATE, OnboardingPolicy.complete(3, OnboardingPolicy.errorCode(error)))
            val request = server.takeRequest()
            assertEquals("Bearer cna_x", request.getHeader("Authorization"))
            assertNotNull(request.getHeader("Idempotency-Key"))
            assertEquals("a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d", request.getHeader("X-Atlas-Expected-Account"))
            assertEquals("{}", request.body.readUtf8())
        } finally {
            server.shutdown()
        }
    }

    @Test
    fun onboardingAuthMatchesTheContract() {
        val auth = fixture["auth"]!!.obj
        assertEquals(listOf("Idempotency-Key", "X-Atlas-Expected-Account"), auth["mutation_headers"]!!.arr.map { it.str })
        assertEquals("flat", auth["error_body"].str)
        // Every route the client calls is one of the bridged operations.
        val operations = auth["operations"]!!.arr.map { it.str!! }.toSet()
        val called = listOf(
            "GET /v1/onboarding/state", "GET /v1/onboarding/catalog", "GET /v1/onboarding/search", "POST /v1/onboarding/picks",
            "DELETE /v1/onboarding/picks/{id}", "PUT /v1/onboarding/exclusions", "POST /v1/onboarding/complete",
            "GET /v1/onboarding/seed", "GET /v1/taste/picks", "POST /v1/taste/picks", "DELETE /v1/taste/picks/{id}",
        )
        assertEquals(operations, called.toSet())
        assertEquals(called.toSet(), AtlasApi.ONBOARDING_OPERATIONS)
    }
}

/** Ready notices (screen 17) against fixtures/native-contract/ready-notice.json. */
class ReadyNoticeTest {
    private val json = AtlasContract.json
    private val fixture get() = Fixtures.json("ready-notice.json")

    @Test
    fun decisionTable() {
        for (c in fixture["decisions"]!!.arr.map { it.obj }) {
            val decision = ReadyNoticePolicy.decide(
                json.decodeFromString(AnalysisState.serializer(), c["state"].toString()),
                ReadyNoticePolicy.Presence.entries.first { it.wire == c["app"].str },
                c["watched"].bool!!, c["notified"].bool!!, c["age_hours"]!!.jsonPrimitive.content.toDouble(),
            )
            val expect = c["expect"]!!.obj
            assertEquals(expect["notice"].str, decision.notice.wire, c["name"].str)
            assertEquals(expect["keep_watching"].bool, decision.keepWatching, c["name"].str)
        }
        val watch = fixture["watch"]!!.obj
        assertEquals(ReadyNoticePolicy.MAX_WATCHED, watch["max_watched"].int)
        assertEquals(ReadyNoticePolicy.EXPIRE_AFTER_HOURS, watch["expire_after_hours"]!!.jsonPrimitive.content.toDouble())
        assertEquals(ReadyNoticePolicy.FOREGROUND_POLL_SECONDS, watch["foreground_poll_seconds"].long)
        val copy = fixture["copy"]!!.obj
        ReadyNoticeCopy.byKey.forEach { (key, value) -> assertEquals(value, copy[key].str, key) }
    }

    @Test
    fun onlyOpaqueWakesAreAccepted() {
        val push = fixture["push"]!!.obj
        val data = push["fcm"]!!.obj["data"]!!.obj.mapValues { it.value.str!! }
        assertTrue(ReadyNoticePolicy.isValidWake(data))
        for (wake in push["invalid_wakes"]!!.arr.map { it.obj }) {
            assertFalse(ReadyNoticePolicy.isValidWake(wake["fcm_data"]!!.obj.mapValues { it.value.str ?: "" }), wake["name"].str)
        }
        assertEquals("fcm", push["register"]!!.obj["providers"]!!.obj["android"].str)
    }

    @Test
    fun pushRegistrationAndAnalysisMessages() {
        val example = Fixtures.message("push_token_android_request")
        val model = json.decodeFromString(PushTokenRequest.serializer(), example.toString())
        assertEquals("fcm", model.provider)
        assertEquals(example, Json.parseToJsonElement(json.encodeToString(PushTokenRequest.serializer(), model)))
        json.decodeFromString(PushTokenResponse.serializer(), Fixtures.messageText("push_token_response"))
        val media = json.decodeFromString(MediaDetail.serializer(), Fixtures.messageText("media_detail_response"))
        assertEquals(
            Fixtures.message("analyze_photo_request"),
            Json.parseToJsonElement(json.encodeToString(AnalyzeMediaRequest.serializer(), AnalyzeMediaRequest(expectedGeneration = media.generation))),
        )
        assertEquals(AnalysisState.QUEUED, json.decodeFromString(AnalysisStatus.serializer(), Fixtures.messageText("analysis_queued_response")).state)
        val done = json.decodeFromString(AnalysisStatus.serializer(), Fixtures.messageText("analysis_complete_response"))
        assertEquals(AnalysisState.COMPLETE, done.state)
        assertNotNull(done.resultUrl)
    }

    @Test
    fun storeKeepsAtMostTheNewestWatchesPerAccount() {
        val dir = Files.createTempDirectory("ready").toFile()
        try {
            val store = ReadyNoticeStore(dir)
            val start = Instant.parse("2026-10-18T20:00:00Z")
            repeat(ReadyNoticePolicy.MAX_WATCHED + 3) { i ->
                store.watch(WatchedAnalysis("m$i", "a$i", start.plusSeconds(i.toLong()).toString()), "acct")
            }
            val list = store.watched("acct")
            assertEquals(ReadyNoticePolicy.MAX_WATCHED, list.size)
            assertEquals("a3", list.first().analysisId)
            assertTrue(store.watched("other").isEmpty())
            store.stop("a3", "acct")
            assertEquals(ReadyNoticePolicy.MAX_WATCHED - 1, store.watched("acct").size)
            assertEquals(1.0, WatchedAnalysis("m", "a", start.toString()).ageHours(start.plusSeconds(3600)), 1e-9)
            store.clear("acct")
            assertTrue(store.watched("acct").isEmpty())
            assertNull(store.watched("acct").firstOrNull())
        } finally {
            dir.deleteRecursively()
        }
    }
}
