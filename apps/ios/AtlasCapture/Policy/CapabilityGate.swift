import Foundation

/// Experimental Meta glasses availability on this phone: the intersection of
/// the server's capability policy and local SDK state
/// (fixtures/native-contract/capability-gate.json). Client state never grants
/// access the server withholds; distribution blocks never offer a reconnect.
public enum CapabilityGate {
  public static let distributionReasons: Set<String> = [
    "build_unsupported", "release_channel_ineligible", "rollout_unavailable",
    "device_unsupported", "temporarily_disabled",
  ]

  public enum Registration: String, Sendable {
    case unavailable, unregistered, registering, registered
  }

  public enum Permission: String, Sendable {
    case unknown, denied, granted
  }

  public enum Stream: String, Sendable {
    case stopped, starting, streaming, paused
  }

  public struct Local: Equatable, Sendable {
    public var registration: Registration
    public var permission: Permission
    public var deviceAvailable: Bool
    public var stream: Stream
    public var recording: Bool
    public var wasConnected: Bool
    public var error: String?

    public init(
      registration: Registration, permission: Permission, deviceAvailable: Bool, stream: Stream,
      recording: Bool, wasConnected: Bool = false, error: String? = nil
    ) {
      self.registration = registration
      self.permission = permission
      self.deviceAvailable = deviceAvailable
      self.stream = stream
      self.recording = recording
      self.wasConnected = wasConnected
      self.error = error
    }
  }

  public enum GlassesState: String, Equatable, Sendable {
    case unavailable, notConnected = "not_connected", registering
    case awaitingPermission = "awaiting_permission", connecting, ready, recording, disconnected, error
  }

  public struct Result: Equatable, Sendable {
    public var state: GlassesState
    /// Distribution reasons, in server order; each is explained separately on screen 09.
    public var reasons: [String]
    public var allowCapture: Bool
    /// Camera and uploads always stay available.
    public var showCameraAndUpload = true
  }

  public static func evaluate(buildIncludesSDK: Bool, serverReasons: [String], local: Local) -> Result {
    var blocking = serverReasons.filter { distributionReasons.contains($0) }
    if !buildIncludesSDK, !blocking.contains("build_unsupported") { blocking.insert("build_unsupported", at: 0) }
    if !blocking.isEmpty { return Result(state: .unavailable, reasons: blocking, allowCapture: false) }
    if local.error != nil { return Result(state: .error, reasons: [], allowCapture: false) }
    switch local.registration {
    case .unavailable:
      return Result(state: .unavailable, reasons: ["build_unsupported"], allowCapture: false)
    case .unregistered:
      return Result(state: .notConnected, reasons: [], allowCapture: false)
    case .registering:
      return Result(state: .registering, reasons: [], allowCapture: false)
    case .registered:
      break
    }
    // A connected radio does not prove camera permission.
    if local.permission != .granted, local.deviceAvailable {
      return Result(state: .awaitingPermission, reasons: [], allowCapture: false)
    }
    if !local.deviceAvailable {
      return Result(state: local.wasConnected ? .disconnected : .notConnected, reasons: [], allowCapture: false)
    }
    if local.permission != .granted {
      return Result(state: .awaitingPermission, reasons: [], allowCapture: false)
    }
    if local.recording { return Result(state: .recording, reasons: [], allowCapture: true) }
    switch local.stream {
    case .streaming: return Result(state: .ready, reasons: [], allowCapture: true)
    case .starting, .paused: return Result(state: .connecting, reasons: [], allowCapture: false)
    case .stopped:
      return Result(state: local.wasConnected ? .disconnected : .connecting, reasons: [], allowCapture: false)
    }
  }

  /// Never label stale status Ready.
  public static func mayShowReady(lastStatusAge: TimeInterval) -> Bool {
    lastStatusAge <= AtlasContract.serverStaleAfterSeconds
  }

  public struct PhoneCamera: Equatable, Sendable {
    public var photo: Bool
    public var video: Bool
  }

  public static func phoneCamera(_ capabilities: Capabilities?) -> PhoneCamera {
    guard let capabilities else { return PhoneCamera(photo: false, video: false) }
    return PhoneCamera(photo: capabilities.flag("camera_photo"), video: capabilities.flag("camera_video"))
  }
}
