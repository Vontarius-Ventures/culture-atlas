import Foundation

/// Native session credentials for the signed-in account, in the Keychain.
///
/// Refresh rotation follows IDENTITY-CONTRACT: a new `refresh_request_id`
/// (32 random bytes, base64url) is persisted together with the refresh token
/// BEFORE the request is sent. A lost response may be retried with the same
/// token and id within 60 s. The returned pair is committed before the pending
/// attempt is cleared.
public actor SessionStore {
  public struct PendingRefresh: Codable, Equatable, Sendable {
    public var refreshToken: String
    public var requestID: String
    public var startedAt: Date
  }

  struct Stored: Codable, Equatable {
    var tokens: NativeSessionTokens
    var pending: PendingRefresh?
  }

  private let keychain: KeychainStore
  private let currentKey = "session.current"
  private var cached: Stored?
  private var refreshTask: Task<NativeSessionTokens, Error>?

  public init(keychain: KeychainStore = KeychainStore()) {
    self.keychain = keychain
  }

  public var currentAccountID: UUID? { load()?.tokens.accountID }
  public var currentTokens: NativeSessionTokens? { load()?.tokens }

  private func load() -> Stored? {
    if let cached { return cached }
    cached = keychain.codable(Stored.self, for: currentKey)
    return cached
  }

  public func store(_ tokens: NativeSessionTokens) throws {
    let stored = Stored(tokens: tokens, pending: nil)
    try keychain.setCodable(stored, for: currentKey)
    cached = stored
  }

  public func clear() {
    keychain.delete(currentKey)
    cached = nil
    refreshTask?.cancel()
    refreshTask = nil
  }

  /// A usable access token, refreshing first when it is about to expire.
  public func accessToken(transport: HTTPTransport, baseURL: URL, now: Date = Date()) async throws -> String {
    guard let stored = load() else { throw AtlasClientError.notSignedIn }
    if stored.pending == nil, stored.tokens.accessExpiresAt.timeIntervalSince(now) > 30 {
      return stored.tokens.accessToken
    }
    return try await refresh(transport: transport, baseURL: baseURL).accessToken
  }

  /// Single-flight refresh rotation.
  public func refresh(transport: HTTPTransport, baseURL: URL) async throws -> NativeSessionTokens {
    if let refreshTask { return try await refreshTask.value }
    let task = Task { try await self.performRefresh(transport: transport, baseURL: baseURL) }
    refreshTask = task
    defer { refreshTask = nil }
    return try await task.value
  }

  private func performRefresh(transport: HTTPTransport, baseURL: URL) async throws -> NativeSessionTokens {
    guard var stored = load() else { throw AtlasClientError.notSignedIn }
    let now = Date()
    if stored.pending == nil {
      stored.pending = PendingRefresh(
        refreshToken: stored.tokens.refreshToken, requestID: Self.newRequestID(), startedAt: now)
      try keychain.setCodable(stored, for: currentKey)
      cached = stored
    }
    let pending = stored.pending!
    while true {
      let body = RefreshRequest(
        refreshToken: pending.refreshToken, installationID: stored.tokens.installationID,
        refreshRequestID: pending.requestID)
      let outcome: RefreshPolicy.Outcome
      do {
        let tokens: NativeSessionTokens = try await transport.json(
          baseURL: baseURL, method: "POST", path: "/v2/identity/native/refresh", body: body,
          bearer: nil, idempotencyKey: nil, expectedAccount: nil)
        stored = Stored(tokens: tokens, pending: nil)
        try keychain.setCodable(stored, for: currentKey)
        cached = stored
        return tokens
      } catch AtlasClientError.server(let status, _, _, _, _) {
        outcome = .http(status)
      } catch AtlasClientError.transport {
        outcome = .networkError
      }
      switch RefreshPolicy.action(outcome: outcome, elapsed: Date().timeIntervalSince(pending.startedAt)) {
      case .retrySameRequestID:
        try await Task.sleep(nanoseconds: 2_000_000_000)
      case .signInRequired, .commitTokensThenClearPending:
        clear()
        throw AtlasClientError.refreshRequired
      }
    }
  }

  /// 32 cryptographically random bytes, base64url (43 characters).
  static func newRequestID() -> String {
    var bytes = [UInt8](repeating: 0, count: 32)
    precondition(SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess)
    return Data(bytes).base64URLEncodedString()
  }
}
