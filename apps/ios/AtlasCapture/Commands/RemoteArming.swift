import Foundation

/// Device status heartbeat and explicit, local remote-capture arming
/// (BACKEND-CONTRACTS "Remote command state", PRODUCT defaults "Remote arm").
///
/// - Arming is off by default, lasts at most 10 minutes, and is only ever
///   started by a person tapping Allow on this phone. It is never restored
///   after relaunch, reconnect or sign-in.
/// - The server only arms a phone that has just reported a ready, foreground
///   camera, so a heartbeat is sent first.
/// - Backgrounding reports `background`, which the server treats as an
///   immediate disarm.
public actor RemoteArming {
  public struct Armed: Equatable, Sendable {
    public var sessionID: UUID
    public var generation: Int
    public var mode: MediaKind
    public var source: MediaSource
    public var expiresAt: Date
    public var allowedAgents: [UUID]
  }

  private let api: AtlasAPI
  private let identities: InstallationIdentityStore
  private let capabilities: @Sendable () async -> (caps: [String: Bool], readiness: DeviceReadiness)
  private var heartbeat: Task<Void, Never>?
  private var appState: AppState = .foreground
  public private(set) var armed: Armed?
  public private(set) var lastStatusAt: Date?

  public init(
    api: AtlasAPI, identities: InstallationIdentityStore,
    capabilities: @escaping @Sendable () async -> (caps: [String: Bool], readiness: DeviceReadiness)
  ) {
    self.api = api
    self.identities = identities
    self.capabilities = capabilities
  }

  public func reportNow() async throws {
    guard let account = await api.sessions.currentAccountID else { throw AtlasClientError.notSignedIn }
    let (caps, readiness) = await capabilities()
    let sequence = try identities.nextStatusSequence(for: account)
    try await api.reportStatus(DeviceStatusRequest(sequence: sequence, capabilities: caps, readiness: readiness, appState: appState))
    lastStatusAt = Date()
  }

  /// Heartbeat every 15 s while foreground (server freshness window is 30 s).
  public func setAppState(_ state: AppState) async {
    appState = state
    if state == .foreground {
      startHeartbeat()
    } else {
      heartbeat?.cancel()
      heartbeat = nil
      try? await reportNow()
      // The server disarms on background; mirror it locally.
      armed = nil
    }
  }

  private func startHeartbeat() {
    guard heartbeat == nil else { return }
    heartbeat = Task { [weak self] in
      while !Task.isCancelled {
        try? await self?.reportNow()
        try? await Task.sleep(nanoseconds: UInt64(AtlasContract.heartbeatIntervalSeconds * 1_000_000_000))
      }
    }
  }

  /// Local Allow: open a capture session for the chosen source/mode, report
  /// ready, then arm for `durationSeconds` (<= 600) for the selected agents.
  public func arm(source: MediaSource, mode: MediaKind, wearableConnectionID: UUID?, durationSeconds: Int, allowedAgents: [UUID]) async throws -> Armed {
    let session = try await api.createSession(
      CreateCaptureSessionRequest(source: source, mode: mode, connectionID: wearableConnectionID, localSessionID: UUID()))
    try await reportNow()
    let duration = min(max(durationSeconds, 1), AtlasContract.remoteArmMaxSeconds)
    let response = try await api.arm(
      sessionID: session.sessionID, ArmRequest(enabled: true, durationSeconds: duration, allowedAgentConnectionIDs: allowedAgents))
    let state = Armed(
      sessionID: response.sessionID, generation: response.generation, mode: mode, source: source,
      expiresAt: response.remoteArmExpiresAt ?? Date().addingTimeInterval(TimeInterval(duration)),
      allowedAgents: allowedAgents)
    armed = state
    return state
  }

  /// Stop: always available locally. Local state clears first; the server
  /// call is best effort (expiry ends it anyway).
  public func disarm(endSession: Bool = true) async {
    guard let current = armed else { return }
    armed = nil
    _ = try? await api.arm(sessionID: current.sessionID, ArmRequest(enabled: false, durationSeconds: 1, allowedAgentConnectionIDs: []))
    if endSession { try? await api.endSession(sessionID: current.sessionID, reason: "user_stopped") }
  }

  /// Sign-out: end arming and the session, stop heartbeats.
  public func shutdown() async {
    await disarm(endSession: true)
    heartbeat?.cancel()
    heartbeat = nil
    lastStatusAt = nil
  }

  public func expireIfNeeded(now: Date = Date()) async {
    if let armed, armed.expiresAt <= now { await disarm(endSession: false) }
  }
}
