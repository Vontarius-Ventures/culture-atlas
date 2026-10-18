import Foundation

/// Taste onboarding, Settings → Taste, push registration and analysis calls.
///
/// The onboarding paths are the server's `/v1` owner routes; the enrolled
/// phone's own session is accepted there only for these operations (native
/// owner bridge, fixtures/native-contract/onboarding.json). The same rules as
/// every `/v2` call apply: mutations carry `Idempotency-Key` and
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

  public func analysis(mediaID: UUID, analysisID: UUID) async throws -> AnalysisStatus {
    try await get("/v2/media/\(mediaID.uuidString.lowercased())/analysis/\(analysisID.uuidString.lowercased())")
  }
}
