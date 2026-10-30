import Foundation

/// The two typed owner account-deletion operations the native owner bridge
/// accepts (VAL-DELETE-001/002), plus the token-gated public status read that
/// keeps answering after the acceptance revoked every authority — this
/// phone's installation included. A protocol so the app's deletion model
/// (and its tests) can run against any implementation; `AtlasAPI` conforms
/// through the live transport. Account identity is always the current
/// installation session's account — no call takes or trusts a caller-supplied
/// account id.
public protocol AccountDeletionService: Sendable {
  /// GET /v2/me/account-deletion — the owner's own deletion state and the
  /// truthful disclosure, before and without a token.
  func accountDeletionOverview() async throws -> AccountDeletionOverview
  /// POST /v2/me/account-deletion — accept the deletion. Idempotent: a retry
  /// with the same status token returns the same durable status.
  func requestAccountDeletion(statusToken: String) async throws -> RequestAccountDeletionResponse
  /// GET /v2/account-deletion/status — the one-time capability token answers
  /// the honest lifecycle snapshot once every credential is gone.
  func accountDeletionStatus(token: String) async throws -> AccountDeletionStatusResponse
}

extension AtlasAPI: AccountDeletionService {
  /// GET /v2/me/account-deletion. The installation session authenticates; a
  /// revoked or expired one fails honestly and nothing is shown as accepted.
  public func accountDeletionOverview() async throws -> AccountDeletionOverview {
    try await get("/v2/me/account-deletion")
  }

  /// POST /v2/me/account-deletion. `call` names the signed-in account in
  /// X-Atlas-Expected-Account (the bridge refuses a mutation without it, so a
  /// phone that switched accounts can never delete the previous one) and
  /// carries the idempotency key the server's one-time-secret replay honors.
  public func requestAccountDeletion(statusToken: String) async throws -> RequestAccountDeletionResponse {
    try await call(
      "POST", "/v2/me/account-deletion",
      body: RequestAccountDeletionBody(confirm: true, statusToken: statusToken))
  }

  /// GET /v2/account-deletion/status. Purely capability-token gated: no
  /// bearer (there is no live credential left to send), the token rides the
  /// documented header, and a wrong or missing token answers not_found.
  public func accountDeletionStatus(token: String) async throws -> AccountDeletionStatusResponse {
    try await transport.json(
      baseURL: baseURL, method: "GET", path: "/v2/account-deletion/status",
      body: EmptyBody?.none, bearer: nil, idempotencyKey: nil, expectedAccount: nil,
      extraHeaders: ["x-atlas-deletion-token": token])
  }
}
