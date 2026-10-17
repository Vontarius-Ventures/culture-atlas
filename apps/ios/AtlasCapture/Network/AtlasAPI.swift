import Foundation

/// Authenticated `/v2` calls for the enrolled installation. Every mutation
/// carries an `Idempotency-Key` and `X-Atlas-Expected-Account`; an expired
/// access token is refreshed once and the call retried with the same key.
public final class AtlasAPI: Sendable {
  public let baseURL: URL
  public let transport: HTTPTransport
  public let sessions: SessionStore

  public init(baseURL: URL, transport: HTTPTransport = HTTPTransport(), sessions: SessionStore) {
    self.baseURL = baseURL
    self.transport = transport
    self.sessions = sessions
  }

  /// `expectedAccount` is the owner of the data being changed (e.g. a draft's
  /// account). When it differs from the signed-in account nothing is sent.
  public func call<Body: Encodable, Result: Decodable>(
    _ method: String, _ path: String, body: Body?, query: [URLQueryItem] = [],
    idempotencyKey: UUID? = nil, expectedAccount: UUID? = nil, timeout: TimeInterval = 30
  ) async throws -> Result {
    guard let signedIn = await sessions.currentAccountID else { throw AtlasClientError.notSignedIn }
    let owner = expectedAccount ?? signedIn
    guard owner == signedIn else { throw AtlasClientError.draftLocked }
    let mutation = method != "GET"
    let key = mutation ? (idempotencyKey ?? UUID()) : nil
    var attempt = 0
    while true {
      attempt += 1
      let token = try await sessions.accessToken(transport: transport, baseURL: baseURL)
      do {
        return try await transport.json(
          baseURL: baseURL, method: method, path: path, query: query, body: body, bearer: token,
          idempotencyKey: key, expectedAccount: mutation ? owner : nil, timeout: timeout)
      } catch AtlasClientError.server(_, "token_expired", _, _, _) where attempt == 1 {
        _ = try await sessions.refresh(transport: transport, baseURL: baseURL)
      }
    }
  }

  public func get<Result: Decodable>(_ path: String, query: [URLQueryItem] = [], timeout: TimeInterval = 30) async throws -> Result {
    try await call("GET", path, body: EmptyBody?.none, query: query, timeout: timeout)
  }

  // MARK: Typed operations

  public func capabilities() async throws -> Capabilities { try await get("/v2/capabilities") }

  public func reportStatus(_ status: DeviceStatusRequest) async throws {
    let _: StatusAccepted = try await call("PUT", "/v2/device/status", body: status)
  }

  public func createSession(_ request: CreateCaptureSessionRequest) async throws -> CaptureSessionResponse {
    try await call("POST", "/v2/device/capture-sessions", body: request)
  }

  public func arm(sessionID: UUID, _ request: ArmRequest) async throws -> CaptureSessionResponse {
    try await call("POST", "/v2/device/capture-sessions/\(sessionID.uuidString.lowercased())/arm", body: request)
  }

  public func endSession(sessionID: UUID, reason: String) async throws {
    let _: CaptureSessionResponse = try await call(
      "POST", "/v2/device/capture-sessions/\(sessionID.uuidString.lowercased())/end", body: EndSessionRequest(reason: reason))
  }

  public func linkWearable(_ request: CreateWearableRequest) async throws -> WearableLink {
    try await call("POST", "/v2/device/wearables", body: request)
  }

  public func pollCommands(afterSequence: Int) async throws -> CommandBatch {
    try await get(
      "/v2/device/commands",
      query: [
        URLQueryItem(name: "after_sequence", value: String(afterSequence)),
        URLQueryItem(name: "wait", value: String(AtlasContract.commandPollWaitSeconds)),
      ],
      timeout: TimeInterval(AtlasContract.commandPollWaitSeconds + 10))
  }

  public func acknowledge(commandID: UUID, ack: CommandAck, key: UUID) async throws -> DeviceCommand {
    try await call("POST", "/v2/device/commands/\(commandID.uuidString.lowercased())/ack", body: ack, idempotencyKey: key)
  }

  public func agentConnections() async throws -> AgentConnectionList { try await get("/v2/agent-connections") }
}

/// The highest status sequence the server has accepted (older ones are ignored).
public struct StatusAccepted: Codable, Sendable, Equatable {
  public var acceptedSequence: Int

  enum CodingKeys: String, CodingKey {
    case acceptedSequence = "accepted_sequence"
  }
}

public struct WearableLink: Codable, Sendable, Equatable {
  public var connectionID: UUID

  enum CodingKeys: String, CodingKey {
    case connectionID = "connection_id"
  }
}

/// Owner-visible agent connections offered in the local arming sheet.
public struct AgentConnectionList: Codable, Sendable, Equatable {
  public struct Connection: Codable, Sendable, Equatable, Identifiable {
    public var id: UUID
    public var clientName: String
    public var scopes: [String]

    enum CodingKeys: String, CodingKey {
      case id, scopes
      case clientName = "client_name"
    }
  }

  public var connections: [Connection]
}
