import CryptoKit
import Foundation

/// Recoverable email sign-in, installation enrollment and sign-out for the
/// native app (IDENTITY-CONTRACT). Replaces Observer's relay pairing: there is
/// no relay URL, QR pairing code or operator approval anywhere in this flow.
public actor AccountService {
  /// Persisted between "send link" and the callback; the verifier never leaves the phone.
  public struct PendingSignIn: Codable, Equatable, Sendable {
    public var email: String
    public var state: String
    public var nonce: String
    public var codeVerifier: String
    public var startedAt: Date
  }

  public enum CallbackError: Error, Equatable {
    case noPendingSignIn
    case malformedCallback
    case stateMismatch
  }

  private let baseURL: URL
  private let transport: HTTPTransport
  private let sessions: SessionStore
  private let identities: InstallationIdentityStore
  private let keychain: KeychainStore
  private let appVersion: String
  private let capabilities: @Sendable () -> [String: Bool]
  private let pendingKey = "signin.pending"

  public init(
    baseURL: URL, transport: HTTPTransport, sessions: SessionStore, identities: InstallationIdentityStore,
    keychain: KeychainStore = KeychainStore(), appVersion: String,
    capabilities: @escaping @Sendable () -> [String: Bool]
  ) {
    self.baseURL = baseURL
    self.transport = transport
    self.sessions = sessions
    self.identities = identities
    self.keychain = keychain
    self.appVersion = appVersion
    self.capabilities = capabilities
  }

  // MARK: Email sign-in

  /// Sends the sign-in (or recovery) link. The response is the same whether
  /// or not the address has an account.
  public func startSignIn(email: String, purpose: EmailStartRequest.Purpose = .signIn) async throws {
    let verifier = Self.randomURLSafe(bytes: 32)
    let pending = PendingSignIn(
      email: email, state: Self.randomURLSafe(bytes: 32), nonce: Self.randomURLSafe(bytes: 32),
      codeVerifier: verifier, startedAt: Date())
    try keychain.setCodable(pending, for: pendingKey)
    let body = EmailStartRequest(
      email: email, purpose: purpose, destination: "ios", state: pending.state, nonce: pending.nonce,
      codeChallenge: Self.pkceChallenge(verifier))
    let _: StartAccepted = try await transport.json(
      baseURL: baseURL, method: "POST", path: "/v2/identity/email/start", body: body, bearer: nil,
      idempotencyKey: nil, expectedAccount: nil)
  }

  public struct StartAccepted: Codable, Sendable {
    public var accepted: Bool
  }

  /// Parses `cultureatlas://identity/callback#challenge_id=…&token=…&state=…&nonce=…`.
  public static func parseCallback(_ url: URL) -> [String: String]? {
    guard url.scheme == AtlasContract.callbackURL.scheme, url.host == "identity", url.path == "/callback",
      let fragment = url.fragment, !fragment.isEmpty
    else { return nil }
    var components = URLComponents()
    components.percentEncodedQuery = fragment
    var values: [String: String] = [:]
    for item in components.queryItems ?? [] { values[item.name] = item.value }
    for key in ["challenge_id", "token", "state", "nonce"] where values[key]?.isEmpty ?? true { return nil }
    return values
  }

  /// Completes the email proof, then enrolls this installation for the
  /// verified account. Returns the signed-in account UUID.
  public func completeSignIn(callback url: URL) async throws -> UUID {
    guard let pending = keychain.codable(PendingSignIn.self, for: pendingKey) else { throw CallbackError.noPendingSignIn }
    guard let values = Self.parseCallback(url), let challengeID = values["challenge_id"], let token = values["token"]
    else { throw CallbackError.malformedCallback }
    guard values["state"] == pending.state, values["nonce"] == pending.nonce else { throw CallbackError.stateMismatch }
    let completion: NativeEmailCompletion = try await transport.json(
      baseURL: baseURL, method: "POST", path: "/v2/identity/email/complete",
      body: EmailCompleteRequest(
        challengeID: challengeID, token: token, state: pending.state, nonce: pending.nonce,
        codeVerifier: pending.codeVerifier),
      bearer: nil, idempotencyKey: nil, expectedAccount: nil)
    keychain.delete(pendingKey)
    try await enroll(completion)
    return completion.accountID
  }

  // MARK: Enrollment

  /// Challenge → signature → enroll. Reuses this account's installation key
  /// (which lets the server unpause that account's uploads); a revoked phone
  /// gets a new installation identity once.
  func enroll(_ completion: NativeEmailCompletion) async throws {
    var identity = try identities.identityOrCreate(for: completion.accountID)
    do {
      try await enroll(completion, identity: &identity)
    } catch AtlasClientError.server(_, "token_revoked", _, _, _) {
      // "This phone was removed": a fresh installation, never the old authority.
      // The grant was not consumed (enrollment failed before issuance), but a
      // new challenge is needed for the new key.
      identity = try identities.rotate(for: completion.accountID)
      try await enroll(completion, identity: &identity)
    }
  }

  private func enroll(_ completion: NativeEmailCompletion, identity: inout InstallationIdentity) async throws {
    let signer = try identities.signer(for: identity)
    guard let jwk = EnrollmentProof.jwk(x963: signer.publicKeyX963) else { throw AtlasClientError.decoding("public key") }
    let challenge: EnrollmentChallenge = try await transport.json(
      baseURL: baseURL, method: "POST", path: "/v2/devices/enrollment/challenge",
      body: EnrollmentChallengeRequest(
        enrollmentGrant: completion.enrollmentGrant, installationPublicID: identity.installationPublicID,
        publicKey: jwk),
      bearer: nil, idempotencyKey: nil, expectedAccount: completion.accountID)
    let payload = EnrollmentProof.payload(
      nonce: challenge.nonce, installationPublicID: identity.installationPublicID, platform: "ios",
      enrollmentGrant: completion.enrollmentGrant)
    let signature = try signer.sign(Data(payload.utf8)).base64URLEncodedString()
    let response: EnrollResponse = try await transport.json(
      baseURL: baseURL, method: "POST", path: "/v2/devices/enroll",
      body: EnrollRequest(
        appVersion: appVersion, installationPublicID: identity.installationPublicID,
        enrollmentGrant: completion.enrollmentGrant,
        proof: .init(nonce: challenge.nonce, signature: signature, publicKey: jwk),
        capabilities: capabilities()),
      bearer: nil, idempotencyKey: nil, expectedAccount: completion.accountID)
    guard response.nativeSession.accountID == completion.accountID else {
      throw AtlasClientError.server(status: 409, code: "account_mismatch", message: "", retryable: false, retryAfter: nil)
    }
    identity.installationID = response.installation.id
    try identities.save(identity)
    try await sessions.store(response.nativeSession)
  }

  // MARK: Sign-out / switch

  /// Ends server authority for this installation. `token_revoked` and
  /// `token_expired` on this call mean "already signed out" (terminal).
  /// Credentials are cleared either way; local drafts stay locked to the
  /// account that captured them.
  public func signOut() async {
    if let token = await sessions.currentTokens?.accessToken {
      do {
        let _: SwitchResponse = try await transport.json(
          baseURL: baseURL, method: "POST", path: "/v2/identity/switch", body: EmptyBody(), bearer: token,
          idempotencyKey: nil, expectedAccount: nil)
      } catch AtlasClientError.server(_, let code, _, _, _) where ErrorPolicy.isTerminalSignOut(code: code) {
        // Terminal sign-out result; do not refresh merely to retry.
      } catch {
        // Offline: local authority still ends now; the server ends it on next
        // use because the credentials are gone from this phone.
      }
    }
    await sessions.clear()
  }

  public struct SwitchResponse: Codable, Sendable {
    public var signedOut: Bool

    enum CodingKeys: String, CodingKey {
      case signedOut = "signed_out"
    }
  }

  // MARK: Helpers

  static func randomURLSafe(bytes count: Int) -> String {
    var bytes = [UInt8](repeating: 0, count: count)
    precondition(SecRandomCopyBytes(kSecRandomDefault, count, &bytes) == errSecSuccess)
    return Data(bytes).base64URLEncodedString()
  }

  /// S256: base64url(SHA-256(verifier)).
  public static func pkceChallenge(_ verifier: String) -> String {
    Data(SHA256.hash(data: Data(verifier.utf8))).base64URLEncodedString()
  }
}
