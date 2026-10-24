import Foundation

/// Wire models for the culture atlas `/v2` contract (contract version
/// `AtlasContract.version`). Field names are spelled out with explicit
/// `CodingKeys`: a snake-case key strategy would also rewrite dictionary keys
/// such as capability names. Every type here is checked against
/// `fixtures/native-contract/messages.json` by `ContractTests`.
public enum AtlasContract {
  public static let version = "2026-10-15.1"
  public static let clipMaxSeconds = 60
  /// Music Mode capture cap (amendment 2.3). Independent of the 60 s video clip.
  public static let audioMaxSeconds = 120
  public static let musicRecognitionDefaultSeconds = 15
  public static let musicRecognitionMinSeconds = 5
  public static let musicRecognitionMaxSeconds = 30
  public static let countdownFromSeconds = 10
  public static let remoteArmMaxSeconds = 600
  public static let heartbeatIntervalSeconds: TimeInterval = 15
  public static let serverStaleAfterSeconds: TimeInterval = 30
  public static let commandPollWaitSeconds = 25
  public static let maxPartNumbersPerRequest = 100
  public static let partInstructionRefreshMargin: TimeInterval = 60
  public static let refreshRetryWindow: TimeInterval = 60
  public static let callbackURL = URL(string: "cultureatlas://identity/callback")!
}

public enum MediaKind: String, Codable, Sendable, CaseIterable {
  case photo, video, audio
}

/// Reported capture source. The server records it separately from the
/// verified installation; it is never proof of identity.
public enum MediaSource: String, Codable, Sendable {
  case phoneCamera = "phone_camera"
  case metaGlasses = "meta_glasses"
  case upload
  /// Music Mode: the phone microphone, camera off.
  case phoneMicrophone = "phone_microphone"
  /// Music Mode: a verified glasses microphone input (not DAT camera audio).
  case glassesMicrophone = "glasses_microphone"
}

public enum UploadState: String, Codable, Sendable {
  case created, uploading, verifying, committed, aborted, expired, rejected, paused
}

// MARK: - Identity

public struct EmailStartRequest: Codable, Sendable, Equatable {
  public enum Purpose: String, Codable, Sendable { case signIn = "sign_in", verify, recover }
  public var email: String
  public var purpose: Purpose
  public var destination: String
  public var state: String
  public var nonce: String
  public var codeChallenge: String

  enum CodingKeys: String, CodingKey {
    case email, purpose, destination, state, nonce
    case codeChallenge = "code_challenge"
  }
}

public struct EmailCompleteRequest: Codable, Sendable, Equatable {
  public var challengeID: String
  public var token: String
  public var state: String
  public var nonce: String
  public var codeVerifier: String

  enum CodingKeys: String, CodingKey {
    case token, state, nonce
    case challengeID = "challenge_id"
    case codeVerifier = "code_verifier"
  }
}

/// Native completion: the verified internal account UUID (not a credential)
/// and a five-minute, single-use enrollment grant.
public struct NativeEmailCompletion: Codable, Sendable, Equatable {
  public var accountID: UUID
  public var enrollmentGrant: String
  public var platform: String

  enum CodingKeys: String, CodingKey {
    case platform
    case accountID = "account_id"
    case enrollmentGrant = "enrollment_grant"
  }
}

public struct RefreshRequest: Codable, Sendable, Equatable {
  public var refreshToken: String
  public var installationID: UUID
  public var refreshRequestID: String

  enum CodingKeys: String, CodingKey {
    case refreshToken = "refresh_token"
    case installationID = "installation_id"
    case refreshRequestID = "refresh_request_id"
  }
}

public struct NativeSessionTokens: Codable, Sendable, Equatable {
  public var sessionID: UUID
  public var installationID: UUID
  public var accountID: UUID
  public var accessToken: String
  public var refreshToken: String
  public var accessExpiresAt: Date
  public var refreshExpiresAt: Date

  enum CodingKeys: String, CodingKey {
    case sessionID = "session_id"
    case installationID = "installation_id"
    case accountID = "account_id"
    case accessToken = "access_token"
    case refreshToken = "refresh_token"
    case accessExpiresAt = "access_expires_at"
    case refreshExpiresAt = "refresh_expires_at"
  }
}

// MARK: - Enrollment

public struct PublicKeyJWK: Codable, Sendable, Equatable {
  public var kty = "EC"
  public var crv = "P-256"
  public var x: String
  public var y: String

  public init(x: String, y: String) {
    self.x = x
    self.y = y
  }
}

public struct EnrollmentChallengeRequest: Codable, Sendable, Equatable {
  public var enrollmentGrant: String?
  public var installationPublicID: UUID
  public var platform = "ios"
  public var publicKey: PublicKeyJWK

  enum CodingKeys: String, CodingKey {
    case platform
    case enrollmentGrant = "enrollment_grant"
    case installationPublicID = "installation_public_id"
    case publicKey = "public_key"
  }
}

public struct EnrollmentChallenge: Codable, Sendable, Equatable {
  public var nonce: String
  public var expiresAt: Date

  enum CodingKeys: String, CodingKey {
    case nonce
    case expiresAt = "expires_at"
  }
}

public struct EnrollRequest: Codable, Sendable, Equatable {
  public struct Proof: Codable, Sendable, Equatable {
    public var nonce: String
    public var signature: String
    public var publicKey: PublicKeyJWK

    enum CodingKeys: String, CodingKey {
      case nonce, signature
      case publicKey = "public_key"
    }
  }

  public var platform = "ios"
  public var appVersion: String
  public var installationPublicID: UUID
  public var enrollmentGrant: String?
  public var proof: Proof
  public var capabilities: [String: Bool]

  enum CodingKeys: String, CodingKey {
    case platform, proof, capabilities
    case appVersion = "app_version"
    case installationPublicID = "installation_public_id"
    case enrollmentGrant = "enrollment_grant"
  }
}

public enum DeviceReadiness: String, Codable, Sendable {
  case unavailable
  case userActionRequired = "user_action_required"
  case ready
}

public enum AppState: String, Codable, Sendable {
  case foreground, background, terminated
}

public struct InstallationDTO: Codable, Sendable, Equatable {
  public var id: UUID
  public var platform: String
  public var appVersion: String
  public var revision: Int
  public var lastSeenAt: Date
  public var revokedAt: Date?
  public var capabilities: [String: Bool]
  public var readiness: DeviceReadiness
  public var appState: AppState

  enum CodingKeys: String, CodingKey {
    case id, platform, revision, capabilities, readiness
    case appVersion = "app_version"
    case lastSeenAt = "last_seen_at"
    case revokedAt = "revoked_at"
    case appState = "app_state"
  }
}

public struct EnrollResponse: Codable, Sendable, Equatable {
  public var installation: InstallationDTO
  public var nativeSession: NativeSessionTokens

  enum CodingKeys: String, CodingKey {
    case installation
    case nativeSession = "native_session"
  }
}

public struct DeviceStatusRequest: Codable, Sendable, Equatable {
  public var sequence: Int
  public var capabilities: [String: Bool]
  public var readiness: DeviceReadiness
  public var appState: AppState

  enum CodingKeys: String, CodingKey {
    case sequence, capabilities, readiness
    case appState = "app_state"
  }
}

public struct CreateWearableRequest: Codable, Sendable, Equatable {
  public enum Permission: String, Codable, Sendable { case unknown, denied, granted }
  /// Hash of the SDK's opaque device reference; the raw value never leaves the phone.
  public var sdkReference: String
  public var displayName: String
  public var capabilities: [String: Bool]
  public var permissionState: Permission

  enum CodingKeys: String, CodingKey {
    case capabilities
    case sdkReference = "sdk_reference"
    case displayName = "display_name"
    case permissionState = "permission_state"
  }
}

// MARK: - Capture sessions

public struct CreateCaptureSessionRequest: Codable, Sendable, Equatable {
  public var source: MediaSource
  public var mode: MediaKind
  public var connectionID: UUID?
  public var localSessionID: UUID?

  enum CodingKeys: String, CodingKey {
    case source, mode
    case connectionID = "connection_id"
    case localSessionID = "local_session_id"
  }
}

public struct CaptureSessionResponse: Codable, Sendable, Equatable {
  public var sessionID: UUID
  public var generation: Int
  public var state: String
  public var remoteArmExpiresAt: Date?

  enum CodingKeys: String, CodingKey {
    case generation, state
    case sessionID = "session_id"
    case remoteArmExpiresAt = "remote_arm_expires_at"
  }
}

public struct ArmRequest: Codable, Sendable, Equatable {
  public var enabled: Bool
  public var durationSeconds: Int
  public var allowedAgentConnectionIDs: [UUID]

  enum CodingKeys: String, CodingKey {
    case enabled
    case durationSeconds = "duration_seconds"
    case allowedAgentConnectionIDs = "allowed_agent_connection_ids"
  }
}

public struct EndSessionRequest: Codable, Sendable, Equatable {
  public var reason: String
}

// MARK: - Uploads

public struct CreateUploadRequest: Codable, Sendable, Equatable {
  public var clientCaptureID: UUID
  public var kind: MediaKind
  public var source: MediaSource
  public var filename: String
  public var contentType: String
  public var byteSize: Int64
  public var sha256: String
  public var capturedAt: Date?
  public var captureSessionID: UUID?
  /// Provenance of the actual input used for audio (phone_microphone or a
  /// verified glasses mic). Omitted for photo/video so existing bodies match.
  public var sourceRoute: String? = nil

  enum CodingKeys: String, CodingKey {
    case kind, source, filename, sha256
    case clientCaptureID = "client_capture_id"
    case contentType = "content_type"
    case byteSize = "byte_size"
    case capturedAt = "captured_at"
    case captureSessionID = "capture_session_id"
    case sourceRoute = "source_route"
  }

  /// Omit `source_route` when unset so photo/video bodies stay byte-equal to
  /// the native-contract fixtures.
  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(clientCaptureID, forKey: .clientCaptureID)
    try container.encode(kind, forKey: .kind)
    try container.encode(source, forKey: .source)
    try container.encode(filename, forKey: .filename)
    try container.encode(contentType, forKey: .contentType)
    try container.encode(byteSize, forKey: .byteSize)
    try container.encode(sha256, forKey: .sha256)
    try container.encodeIfPresent(capturedAt, forKey: .capturedAt)
    try container.encodeIfPresent(captureSessionID, forKey: .captureSessionID)
    try container.encodeIfPresent(sourceRoute, forKey: .sourceRoute)
  }
}

public struct PartReceipt: Codable, Sendable, Equatable, Hashable {
  public var partNumber: Int
  public var etag: String

  public init(partNumber: Int, etag: String) {
    self.partNumber = partNumber
    self.etag = etag
  }

  enum CodingKeys: String, CodingKey {
    case etag
    case partNumber = "part_number"
  }
}

public struct PartInstruction: Codable, Sendable, Equatable {
  public var partNumber: Int
  public var method: String
  public var url: URL
  public var headers: [String: String]
  public var expiresAt: Date

  enum CodingKeys: String, CodingKey {
    case method, url, headers
    case partNumber = "part_number"
    case expiresAt = "expires_at"
  }
}

public struct UploadResponse: Codable, Sendable, Equatable {
  public var assetID: UUID
  public var uploadID: UUID
  public var state: UploadState
  public var expiresAt: Date
  public var partSize: Int64
  public var partCount: Int
  public var parts: [PartInstruction]
  public var verifiedParts: [PartReceipt]
  public var errorCode: String?
  public var pauseReason: String?

  enum CodingKeys: String, CodingKey {
    case state, parts
    case assetID = "asset_id"
    case uploadID = "upload_id"
    case expiresAt = "expires_at"
    case partSize = "part_size"
    case partCount = "part_count"
    case verifiedParts = "verified_parts"
    case errorCode = "error_code"
    case pauseReason = "pause_reason"
  }
}

public struct UploadPartsRequest: Codable, Sendable, Equatable {
  public var partNumbers: [Int]

  enum CodingKeys: String, CodingKey {
    case partNumbers = "part_numbers"
  }
}

public struct UploadPartsResponse: Codable, Sendable, Equatable {
  public var parts: [PartInstruction]
}

public struct CompleteUploadRequest: Codable, Sendable, Equatable {
  public var parts: [PartReceipt]
}

// MARK: - Commands

public enum CommandAction: String, Codable, Sendable {
  case capturePhoto = "capture_photo"
  case startVideo = "start_video"
  case stopVideo = "stop_video"
}

public struct DeviceCommand: Codable, Sendable, Equatable {
  public var commandID: UUID
  public var sessionID: UUID
  public var generation: Int
  public var action: CommandAction
  public var deliverySequence: Int
  public var durationSeconds: Int?
  public var captureClientID: UUID
  public var authorizationVersion: Int
  public var state: String
  public var expiresAt: Date
  public var resultAssetID: UUID?
  public var errorCode: String?

  enum CodingKeys: String, CodingKey {
    case generation, action, state
    case commandID = "command_id"
    case sessionID = "session_id"
    case deliverySequence = "delivery_sequence"
    case durationSeconds = "duration_seconds"
    case captureClientID = "capture_client_id"
    case authorizationVersion = "authorization_version"
    case expiresAt = "expires_at"
    case resultAssetID = "result_asset_id"
    case errorCode = "error_code"
  }
}

public struct CommandBatch: Codable, Sendable, Equatable {
  public var schemaVersion: String?
  public var requestID: String?
  public var items: [DeviceCommand]
  public var nextSequence: Int

  enum CodingKeys: String, CodingKey {
    case items
    case schemaVersion = "schema_version"
    case requestID = "request_id"
    case nextSequence = "next_sequence"
  }
}

public enum AckState: String, Codable, Sendable {
  case awaitingUser = "awaiting_user"
  case executing, succeeded, failed, unknown
}

public enum SafeCommandError: String, Codable, Sendable {
  case deviceUnavailable = "device_unavailable"
  case permissionDenied = "permission_denied"
  case interrupted
  case storageFull = "storage_full"
  case outcomeUnknown = "outcome_unknown"
}

public struct CommandAck: Codable, Sendable, Equatable {
  public var sequence: Int
  public var state: AckState
  public var resultAssetID: UUID?
  public var safeError: SafeCommandError?

  public init(sequence: Int, state: AckState, resultAssetID: UUID? = nil, safeError: SafeCommandError? = nil) {
    self.sequence = sequence
    self.state = state
    self.resultAssetID = resultAssetID
    self.safeError = safeError
  }

  enum CodingKeys: String, CodingKey {
    case sequence, state
    case resultAssetID = "result_asset_id"
    case safeError = "safe_error"
  }
}

// MARK: - Capabilities and errors

public struct Capabilities: Codable, Sendable, Equatable {
  public struct Availability: Codable, Sendable, Equatable {
    public var available: Bool
    public var reasons: [String]
    /// Production experimental mode (design D.3): the roles run unqualified
    /// and every client shows the label. All optional on the wire.
    public var experimental: Bool? = nil
    public var label: String? = nil
    public var note: String? = nil
    public var reason: String? = nil
    public var message: String? = nil

    enum CodingKeys: String, CodingKey { case available, reasons, experimental, label, note, reason, message }
  }

  public var contractVersion: String
  public var flags: [String: Bool]
  public var limits: [String: Int64]
  public var availability: [String: Availability]

  enum CodingKeys: String, CodingKey {
    case flags, limits, availability
    case contractVersion = "contract_version"
  }

  public func flag(_ name: String) -> Bool { flags[name] == true }
}

extension Capabilities.Availability {
  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    available = try c.decode(Bool.self, forKey: .available)
    reasons = (try? c.decodeIfPresent([String].self, forKey: .reasons)) ?? []
    experimental = (try? c.decodeIfPresent(Bool.self, forKey: .experimental)) ?? nil
    label = (try? c.decodeIfPresent(String.self, forKey: .label)) ?? nil
    note = (try? c.decodeIfPresent(String.self, forKey: .note)) ?? nil
    reason = (try? c.decodeIfPresent(String.self, forKey: .reason)) ?? nil
    message = (try? c.decodeIfPresent(String.self, forKey: .message)) ?? nil
  }
}

public struct ServerErrorBody: Codable, Sendable, Equatable {
  public struct Detail: Codable, Sendable, Equatable {
    public var code: String
    public var message: String
    public var retryable: Bool
    public var requestID: String
    public var retryAfterMS: Double?

    enum CodingKeys: String, CodingKey {
      case code, message, retryable
      case requestID = "request_id"
      case retryAfterMS = "retry_after_ms"
    }
  }

  public var error: Detail
}

// UUIDs go on the wire in lowercase, exactly as the server returns them. This
// matters beyond style: the enrollment proof signs the installation id string
// that the request body carries. These overloads are picked by the synthesized
// `Encodable` conformances in this module.
extension KeyedEncodingContainer {
  mutating func encode(_ value: UUID, forKey key: Key) throws {
    try encode(value.uuidString.lowercased(), forKey: key)
  }

  mutating func encodeIfPresent(_ value: UUID?, forKey key: Key) throws {
    if let value { try encode(value.uuidString.lowercased(), forKey: key) }
  }

  mutating func encode(_ value: [UUID], forKey key: Key) throws {
    try encode(value.map { $0.uuidString.lowercased() }, forKey: key)
  }
}

public enum AtlasJSON {
  /// ISO 8601 with or without fractional seconds, as the server emits.
  public static func decoder() -> JSONDecoder {
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .custom { container in
      let raw = try container.singleValueContainer().decode(String.self)
      if let date = parseDate(raw) { return date }
      throw DecodingError.dataCorrupted(
        .init(codingPath: container.codingPath, debugDescription: "Invalid date \(raw)"))
    }
    return decoder
  }

  public static func encoder() -> JSONEncoder {
    let encoder = JSONEncoder()
    encoder.dateEncodingStrategy = .custom { date, container in
      var single = container.singleValueContainer()
      try single.encode(formatDate(date))
    }
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return encoder
  }

  public static func parseDate(_ raw: String) -> Date? {
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = fractional.date(from: raw) { return date }
    let plain = ISO8601DateFormatter()
    plain.formatOptions = [.withInternetDateTime]
    return plain.date(from: raw)
  }

  public static func formatDate(_ date: Date) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: date)
  }
}
