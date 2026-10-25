import Foundation

/// Taste onboarding, Settings → Taste, Discover, boards, push registration
/// and analysis calls.
///
/// The `/v1` paths are the server's owner routes; the enrolled phone's own
/// session is accepted there only for these operations (native owner bridge,
/// fixtures/native-contract/onboarding.json). The same rules as every `/v2`
/// call apply: mutations carry `Idempotency-Key` and
/// `X-Atlas-Expected-Account`, and an expired token is refreshed once.
extension AtlasAPI {
  // MARK: Onboarding (screens 14 and 15)

  public func onboardingState() async throws -> OnboardingStateResponse { try await get("/v1/onboarding/state") }

  public func onboardingCatalog() async throws -> OnboardingCatalog { try await get("/v1/onboarding/catalog") }

  /// Live search. `query` must already satisfy `OnboardingPolicy.searchQuery`.
  public func searchOnboarding(_ query: String, category: TasteCategory? = nil) async throws -> OnboardingSearchResponse {
    var items = [URLQueryItem(name: "q", value: query)]
    if let category { items.append(URLQueryItem(name: "category", value: category.rawValue)) }
    return try await get("/v1/onboarding/search", query: items)
  }

  public func createOnboardingPick(_ request: CreatePickRequest, key: UUID = UUID()) async throws -> CreatePickResponse {
    try await call("POST", "/v1/onboarding/picks", body: request, idempotencyKey: key)
  }

  public func deleteOnboardingPick(_ id: UUID) async throws -> DeletePickResponse {
    try await call("DELETE", "/v1/onboarding/picks/\(id.uuidString.lowercased())", body: EmptyBody?.none)
  }

  public func putFoodExclusions(_ exclusions: [String]) async throws -> FoodExclusionsBody {
    try await call("PUT", "/v1/onboarding/exclusions", body: FoodExclusionsBody(foodExclusions: exclusions))
  }

  /// 409 `conflict` when the server counts fewer than 3 picks.
  public func completeOnboarding(key: UUID = UUID()) async throws -> CompleteOnboardingResponse {
    try await call("POST", "/v1/onboarding/complete", body: EmptyBody(), idempotencyKey: key)
  }

  public func seedStatus() async throws -> TasteSeedStatus { try await get("/v1/onboarding/seed") }

  // MARK: Settings → Taste (screen 18)

  public func tastePicks() async throws -> TastePicksResponse { try await get("/v1/taste/picks") }

  public func createTastePick(_ request: CreatePickRequest, key: UUID = UUID()) async throws -> CreatePickResponse {
    try await call("POST", "/v1/taste/picks", body: request, idempotencyKey: key)
  }

  public func deleteTastePick(_ id: UUID) async throws -> DeletePickResponse {
    try await call("DELETE", "/v1/taste/picks/\(id.uuidString.lowercased())", body: EmptyBody?.none)
  }

  // MARK: Push registration (ready notices)

  public func registerPushToken(_ request: PushTokenRequest) async throws -> PushTokenResponse {
    try await call("PUT", "/v2/device/push-token", body: request)
  }

  public func clearPushToken() async throws {
    let _: PushTokenResponse = try await call("DELETE", "/v2/device/push-token", body: EmptyBody?.none)
  }

  // MARK: Exploring a photo (screen 17 watches these)

  public func media(_ id: UUID) async throws -> MediaDetail {
    try await get("/v2/media/\(id.uuidString.lowercased())")
  }

  public func startAnalysis(mediaID: UUID, generation: Int, key: UUID = UUID()) async throws -> AnalysisStatus {
    try await call(
      "POST", "/v2/media/\(mediaID.uuidString.lowercased())/analysis",
      body: AnalyzeMediaRequest(expectedGeneration: generation), idempotencyKey: key)
  }

  /// Music Mode keep: WAV multipart to `/v2/media/audio`. Never starts analysis.
  public func keepAudioRecording(
    _ request: KeepAudioRecordingRequest, wav: Data, key: UUID = UUID(), expectedAccount: UUID? = nil
  ) async throws -> KeptAudioResponse {
    guard let signedIn = await sessions.currentAccountID else { throw AtlasClientError.notSignedIn }
    let owner = expectedAccount ?? signedIn
    guard owner == signedIn else { throw AtlasClientError.draftLocked }
    var attempt = 0
    while true {
      attempt += 1
      let token = try await sessions.accessToken(transport: transport, baseURL: baseURL)
      do {
        return try await transport.multipart(
          baseURL: baseURL, path: "/v2/media/audio", fields: request.formFields(),
          file: (name: request.filename, type: request.contentType, data: wav),
          bearer: token, idempotencyKey: key, expectedAccount: owner)
      } catch AtlasClientError.server(_, "token_expired", _, _, _) where attempt == 1 {
        _ = try await sessions.refresh(transport: transport, baseURL: baseURL)
      }
    }
  }

  /// Music Mode explore: music_match only. Never sends speech/transcripts.
  /// `recognized` is the song the phone identified on-device (ShazamKit), if
  /// any: an optional hint the server still grounds through its own catalog.
  public func startMusicAnalysis(
    mediaID: UUID, generation: Int, startMS: Int, endMS: Int, key: UUID = UUID(),
    recognized: ClientRecognizedSong? = nil
  ) async throws -> AnalysisStatus {
    try await call(
      "POST", "/v2/media/\(mediaID.uuidString.lowercased())/analysis",
      body: AnalyzeAudioRequest.musicMatch(
        expectedGeneration: generation, startMS: startMS, endMS: endMS, clientRecognition: recognized),
      idempotencyKey: key)
  }

  public func analysis(mediaID: UUID, analysisID: UUID) async throws -> AnalysisStatus {
    try await get("/v2/media/\(mediaID.uuidString.lowercased())/analysis/\(analysisID.uuidString.lowercased())")
  }

  // MARK: Discover and boards

  public func discoveries(refresh: Bool = false) async throws -> DiscoveriesResponse {
    var query = [URLQueryItem(name: "limit", value: "24")]
    if refresh { query.append(URLQueryItem(name: "refresh", value: "true")) }
    return try await get("/v1/discoveries", query: query)
  }

  public func item(_ id: UUID) async throws -> ItemDetailResponse {
    try await get("/v1/items/\(id.uuidString.lowercased())")
  }

  public func discoverRelated(_ id: UUID, key: UUID = UUID()) async throws -> RelatedDiscoveryResponse {
    try await call(
      "POST", "/v1/items/\(id.uuidString.lowercased())/discoveries",
      body: EmptyBody(), idempotencyKey: key)
  }

  public func collections() async throws -> CollectionsListResponse { try await get("/v1/collections") }

  public func createCollection(_ request: CreateCollectionRequest, key: UUID = UUID()) async throws -> CollectionSummary {
    try await call("POST", "/v1/collections", body: request, idempotencyKey: key)
  }

  public func collection(_ id: UUID) async throws -> CollectionDetailResponse {
    try await get("/v1/collections/\(id.uuidString.lowercased())")
  }

  public func addCollectionItem(collectionID: UUID, itemID: UUID, key: UUID = UUID()) async throws -> AddCollectionItemResponse {
    try await call(
      "PUT",
      "/v1/collections/\(collectionID.uuidString.lowercased())/items/\(itemID.uuidString.lowercased())",
      body: EmptyBody(),
      idempotencyKey: key)
  }
}
