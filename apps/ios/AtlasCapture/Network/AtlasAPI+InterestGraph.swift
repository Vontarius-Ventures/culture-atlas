import Foundation

/// The four typed owner/native graph operations (VAL-API-001). A protocol so
/// the phone's owner-scoped store (and its tests) can run against any
/// implementation; `AtlasAPI` conforms through the live transport. Account
/// identity is always the current installation session's account — none of
/// these calls takes or trusts a caller-supplied account id.
public protocol InterestGraphService: Sendable {
  func interestGraph(interestsCursor: String?, tentativeCursor: String?, limit: Int) async throws -> InterestGraphSummary
  func updateInterestGraphSettings(expectedRevision: Int, discoveryPaused: Bool) async throws -> InterestGraphSettings
  func updateInterestGraphInterest(edgeID: UUID, expectedRevision: Int, state: TentativeInterestItem.State) async throws -> UpdateInterestGraphInterestResponse
  func recommendationConnection(recommendationID: UUID) async throws -> RecommendationConnection
}

extension AtlasAPI: InterestGraphService {
  /// GET /v2/me/interest-graph — the owner's graph summary. Pure read: the
  /// server makes no provider or model calls to fill it in.
  public func interestGraph(interestsCursor: String? = nil, tentativeCursor: String? = nil, limit: Int = 25) async throws -> InterestGraphSummary {
    var query = [URLQueryItem(name: "limit", value: String(limit))]
    if let interestsCursor { query.append(URLQueryItem(name: "interests_cursor", value: interestsCursor)) }
    if let tentativeCursor { query.append(URLQueryItem(name: "tentative_cursor", value: tentativeCursor)) }
    let response: InterestGraphSummary = try await get("/v2/me/interest-graph", query: query)
    return response
  }

  /// PATCH /v2/me/interest-graph/settings — desired-state pause control.
  /// Returns the echoed settings with their shared optimistic revision.
  public func updateInterestGraphSettings(expectedRevision: Int, discoveryPaused: Bool) async throws -> InterestGraphSettings {
    let response: UpdateInterestGraphSettingsResponse = try await call(
      "PATCH", "/v2/me/interest-graph/settings",
      body: UpdateInterestGraphSettingsBody(expectedRevision: expectedRevision, discoveryPaused: discoveryPaused))
    return response.settings
  }

  /// PATCH /v2/me/interest-graph/interests/{id} — suppress/restore a
  /// tentative affinity. An explicit edge answers `action_required`.
  public func updateInterestGraphInterest(edgeID: UUID, expectedRevision: Int, state: TentativeInterestItem.State) async throws -> UpdateInterestGraphInterestResponse {
    try await call(
      "PATCH", "/v2/me/interest-graph/interests/\(edgeID.uuidString.lowercased())",
      body: UpdateInterestGraphInterestBody(expectedRevision: expectedRevision, state: state))
  }

  /// GET /v2/me/recommendations/{id}/connection — the pinned proof behind a
  /// recommendation the owner already saw, or its honest unavailable state.
  public func recommendationConnection(recommendationID: UUID) async throws -> RecommendationConnection {
    try await get("/v2/me/recommendations/\(recommendationID.uuidString.lowercased())/connection")
  }
}
