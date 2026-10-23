package com.cultureatlas.capture.core.net

import com.cultureatlas.capture.core.contract.AddCollectionItemResponse
import com.cultureatlas.capture.core.contract.AnalysisStatus
import com.cultureatlas.capture.core.contract.AnalyzeAudioRequest
import com.cultureatlas.capture.core.contract.AnalyzeMediaRequest
import com.cultureatlas.capture.core.contract.CollectionDetailResponse
import com.cultureatlas.capture.core.contract.CollectionSummary
import com.cultureatlas.capture.core.contract.CollectionsListResponse
import com.cultureatlas.capture.core.contract.CompleteOnboardingResponse
import com.cultureatlas.capture.core.contract.CreateCollectionRequest
import com.cultureatlas.capture.core.contract.CreatePickRequest
import com.cultureatlas.capture.core.contract.CreatePickResponse
import com.cultureatlas.capture.core.contract.DeletePickResponse
import com.cultureatlas.capture.core.contract.DiscoveriesResponse
import com.cultureatlas.capture.core.contract.EmptyBody
import com.cultureatlas.capture.core.contract.FoodExclusionsBody
import com.cultureatlas.capture.core.contract.ItemDetailResponse
import com.cultureatlas.capture.core.contract.KeepAudioRecordingRequest
import com.cultureatlas.capture.core.contract.KeptAudioResponse
import com.cultureatlas.capture.core.contract.MediaDetail
import com.cultureatlas.capture.core.contract.OnboardingCatalog
import com.cultureatlas.capture.core.contract.OnboardingSearchResponse
import com.cultureatlas.capture.core.contract.OnboardingStateResponse
import com.cultureatlas.capture.core.contract.PushTokenRequest
import com.cultureatlas.capture.core.contract.PushTokenResponse
import com.cultureatlas.capture.core.contract.RelatedDiscoveryResponse
import com.cultureatlas.capture.core.contract.TasteCategory
import com.cultureatlas.capture.core.contract.TastePicksResponse
import com.cultureatlas.capture.core.contract.TasteSeedStatus
import java.util.UUID

/*
 * Taste onboarding, Settings → Taste, push registration and analysis calls.
 * The onboarding paths are the server's /v1 owner routes; the enrolled
 * phone's own session is accepted there only for AtlasApi.ONBOARDING_OPERATIONS
 * (native owner bridge). The usual rules apply: mutations carry
 * Idempotency-Key and X-Atlas-Expected-Account, and an expired token is
 * refreshed once.
 */

// Onboarding (screens 14 and 15)

suspend fun AtlasApi.onboardingState(): OnboardingStateResponse =
    get("/v1/onboarding/state", OnboardingStateResponse.serializer())

suspend fun AtlasApi.onboardingCatalog(): OnboardingCatalog = get("/v1/onboarding/catalog", OnboardingCatalog.serializer())

/** Live search; [query] must already satisfy OnboardingPolicy.searchQuery. */
suspend fun AtlasApi.searchOnboarding(query: String, category: TasteCategory? = null): OnboardingSearchResponse =
    get(
        "/v1/onboarding/search", OnboardingSearchResponse.serializer(),
        buildMap {
            put("q", query)
            category?.let { put("category", it.wire) }
        },
    )

suspend fun AtlasApi.createOnboardingPick(request: CreatePickRequest, key: UUID = UUID.randomUUID()): CreatePickResponse =
    call("POST", "/v1/onboarding/picks", request, CreatePickRequest.serializer(), CreatePickResponse.serializer(), idempotencyKey = key)

suspend fun AtlasApi.deleteOnboardingPick(id: String): DeletePickResponse =
    call<Unit, DeletePickResponse>("DELETE", "/v1/onboarding/picks/${id.lowercase()}", null, null, DeletePickResponse.serializer())

suspend fun AtlasApi.putFoodExclusions(exclusions: List<String>): FoodExclusionsBody =
    call("PUT", "/v1/onboarding/exclusions", FoodExclusionsBody(exclusions), FoodExclusionsBody.serializer(), FoodExclusionsBody.serializer())

/** 409 conflict when the server counts fewer than 3 picks. */
suspend fun AtlasApi.completeOnboarding(key: UUID = UUID.randomUUID()): CompleteOnboardingResponse =
    call("POST", "/v1/onboarding/complete", EmptyBody(), EmptyBody.serializer(), CompleteOnboardingResponse.serializer(), idempotencyKey = key)

suspend fun AtlasApi.seedStatus(): TasteSeedStatus = get("/v1/onboarding/seed", TasteSeedStatus.serializer())

// Settings → Taste (screen 18)

suspend fun AtlasApi.tastePicks(): TastePicksResponse = get("/v1/taste/picks", TastePicksResponse.serializer())

suspend fun AtlasApi.createTastePick(request: CreatePickRequest, key: UUID = UUID.randomUUID()): CreatePickResponse =
    call("POST", "/v1/taste/picks", request, CreatePickRequest.serializer(), CreatePickResponse.serializer(), idempotencyKey = key)

suspend fun AtlasApi.deleteTastePick(id: String): DeletePickResponse =
    call<Unit, DeletePickResponse>("DELETE", "/v1/taste/picks/${id.lowercase()}", null, null, DeletePickResponse.serializer())

// Push registration (ready notices)

suspend fun AtlasApi.registerPushToken(request: PushTokenRequest): PushTokenResponse =
    call("PUT", "/v2/device/push-token", request, PushTokenRequest.serializer(), PushTokenResponse.serializer())

suspend fun AtlasApi.clearPushToken(): PushTokenResponse =
    call<Unit, PushTokenResponse>("DELETE", "/v2/device/push-token", null, null, PushTokenResponse.serializer())

// Exploring a photo (screen 17 watches these)

suspend fun AtlasApi.media(id: String): MediaDetail = get("/v2/media/${id.lowercase()}", MediaDetail.serializer())

suspend fun AtlasApi.startAnalysis(mediaId: String, generation: Int, key: UUID = UUID.randomUUID()): AnalysisStatus =
    call(
        "POST", "/v2/media/${mediaId.lowercase()}/analysis", AnalyzeMediaRequest(expectedGeneration = generation),
        AnalyzeMediaRequest.serializer(), AnalysisStatus.serializer(), idempotencyKey = key,
    )

/** Explore music: `contract_version: 2` and `music_match` only. Keep never calls this. */
suspend fun AtlasApi.startAudioAnalysis(
    mediaId: String,
    request: AnalyzeAudioRequest,
    key: UUID = UUID.randomUUID(),
): AnalysisStatus =
    call(
        "POST", "/v2/media/${mediaId.lowercase()}/analysis", request,
        AnalyzeAudioRequest.serializer(), AnalysisStatus.serializer(), idempotencyKey = key,
    )

suspend fun AtlasApi.analysis(mediaId: String, analysisId: String): AnalysisStatus =
    get("/v2/media/${mediaId.lowercase()}/analysis/${analysisId.lowercase()}", AnalysisStatus.serializer())

/**
 * Keep a Music Mode WAV on the account. Does not start analysis.
 * Multipart: JSON [KeepAudioRecordingRequest] + `audio/wav` file.
 */
suspend fun AtlasApi.discoveries(refresh: Boolean = false): DiscoveriesResponse {
    val query = mutableMapOf("limit" to "24")
    if (refresh) query["refresh"] = "true"
    return get("/v1/discoveries", DiscoveriesResponse.serializer(), query)
}

suspend fun AtlasApi.item(id: String): ItemDetailResponse =
    get("/v1/items/${id.lowercase()}", ItemDetailResponse.serializer())

suspend fun AtlasApi.discoverRelated(id: String, key: UUID = UUID.randomUUID()): RelatedDiscoveryResponse =
    call(
        "POST", "/v1/items/${id.lowercase()}/discoveries",
        EmptyBody(), EmptyBody.serializer(), RelatedDiscoveryResponse.serializer(),
        idempotencyKey = key,
    )

suspend fun AtlasApi.collections(): CollectionsListResponse = get("/v1/collections", CollectionsListResponse.serializer())

suspend fun AtlasApi.createCollection(request: CreateCollectionRequest, key: UUID = UUID.randomUUID()): CollectionSummary =
    call("POST", "/v1/collections", request, CreateCollectionRequest.serializer(), CollectionSummary.serializer(), idempotencyKey = key)

suspend fun AtlasApi.collection(id: String): CollectionDetailResponse =
    get("/v1/collections/${id.lowercase()}", CollectionDetailResponse.serializer())

suspend fun AtlasApi.addCollectionItem(collectionId: String, itemId: String, key: UUID = UUID.randomUUID()): AddCollectionItemResponse =
    call(
        "PUT", "/v1/collections/${collectionId.lowercase()}/items/${itemId.lowercase()}",
        EmptyBody(), EmptyBody.serializer(), AddCollectionItemResponse.serializer(), idempotencyKey = key,
    )

suspend fun AtlasApi.keepAudioRecording(
    request: KeepAudioRecordingRequest,
    wav: java.io.File,
    key: UUID = UUID.randomUUID(),
    owner: String? = null,
): KeptAudioResponse =
    callMultipart(
        "/v2/media/audio",
        request,
        KeepAudioRecordingRequest.serializer(),
        wav,
        KeptAudioResponse.serializer(),
        key,
        owner,
    )
