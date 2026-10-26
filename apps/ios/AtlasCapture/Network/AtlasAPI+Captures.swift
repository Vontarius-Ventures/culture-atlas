import Foundation

/// Capture detail with the style reading and rails (design E.2 and E.4). These
/// `/v1` owner routes are on the native allow-list
/// (fixtures/native-contract/onboarding.json → auth.operations):
///   GET  /v1/captures/{id}
///   POST /v1/captures/{id}/style/retry
///   PUT  /v1/me/city
extension AtlasAPI {
  public func capture(_ id: UUID) async throws -> CaptureDetailResponse {
    try await get("/v1/captures/\(id.uuidString.lowercased())")
  }

  /// Re-queues only the style stage. 202 with `sections.style = "running"`;
  /// a second use answers 409 `retry_used` (one retry per analysis).
  public func retryStyle(captureID: UUID, key: UUID = UUID()) async throws {
    let _: EmptyBody = try await call(
      "POST", "/v1/captures/\(captureID.uuidString.lowercased())/style/retry",
      body: EmptyBody(), idempotencyKey: key)
  }

  /// The user's own city for place suggestions (never inferred). 204.
  public func setCity(_ city: String?, key: UUID = UUID()) async throws {
    let _: EmptyBody = try await call("PUT", "/v1/me/city", body: CityRequest(city: city), idempotencyKey: key)
  }
}
