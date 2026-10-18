import Foundation

/// Screen 17 on iOS: "Your photo is ready" for analyses this phone's user
/// started (fixtures/native-contract/ready-notice.json).
///
/// Pushes are silent wake-ups that carry only an opaque reference. Nothing in
/// the payload is trusted or shown: on a valid wake the app asks the server
/// about the analyses it is watching and decides locally what to show.
public enum ReadyNoticeCopy {
  public static let title = "Your photo is ready"
  public static let open = "Open"
  public static let dismiss = "Dismiss"

  public static let byKey: [String: String] = [
    "ready.toast": title,
    "ready.open": open,
    "ready.dismiss": dismiss,
  ]
}

public enum ReadyNoticePolicy {
  public static let maxWatched = 20
  public static let expireAfterHours: Double = 24
  public static let foregroundPollSeconds: TimeInterval = 5
  public static let notificationCategory = "ready_notice"
  public static let openAction = "open"

  public enum AppPresence: String, Sendable {
    case background, foreground
    /// The user is looking at this photo's result already.
    case viewing
  }

  public enum Notice: String, Equatable, Sendable {
    case none, toast, notification
  }

  public struct Decision: Equatable, Sendable {
    public var notice: Notice
    public var keepWatching: Bool
  }

  public static func decide(
    state: AnalysisState, app: AppPresence, watched: Bool, notified: Bool, ageHours: Double
  ) -> Decision {
    let stop = Decision(notice: .none, keepWatching: false)
    // Only analyses the user started on this phone; never twice; never stale.
    guard watched, !notified, ageHours < expireAfterHours else { return stop }
    switch state {
    case .queued, .running, .partial: return Decision(notice: .none, keepWatching: true)
    case .failed, .cancelled: return stop
    case .complete:
      switch app {
      case .background: return Decision(notice: .notification, keepWatching: false)
      case .foreground: return Decision(notice: .toast, keepWatching: false)
      case .viewing: return stop
      }
    }
  }

  private static let referencePattern = try! NSRegularExpression(pattern: "^[A-Za-z0-9_-]{16,64}$")

  /// A wake is valid only when it carries an opaque base64url reference.
  public static func isValidWake(_ payload: [AnyHashable: Any]) -> Bool {
    guard let ref = payload["ref"] as? String else { return false }
    let range = NSRange(ref.startIndex..., in: ref)
    return referencePattern.firstMatch(in: ref, range: range) != nil
  }

  /// APNs device token as the lowercase hex string the server stores.
  public static func apnsTokenHex(_ token: Data) -> String {
    token.map { String(format: "%02x", $0) }.joined()
  }
}

/// An analysis the user started from this phone, watched until it ends.
public struct WatchedAnalysis: Codable, Sendable, Equatable, Identifiable {
  public var mediaID: UUID
  public var analysisID: UUID
  public var startedAt: Date
  public var notified: Bool
  public var id: UUID { analysisID }

  public init(mediaID: UUID, analysisID: UUID, startedAt: Date, notified: Bool = false) {
    self.mediaID = mediaID
    self.analysisID = analysisID
    self.startedAt = startedAt
    self.notified = notified
  }

  public func ageHours(now: Date) -> Double { now.timeIntervalSince(startedAt) / 3600 }
}

/// Watched analyses per account, in a small file protected until first unlock
/// (it holds only ids, never media or results).
public actor ReadyNoticeStore {
  private let directory: URL

  public init(directory: URL) {
    self.directory = directory
  }

  private func url(_ account: UUID) -> URL {
    directory.appendingPathComponent("ready-\(account.uuidString.lowercased()).json")
  }

  public func watched(account: UUID) -> [WatchedAnalysis] {
    guard let data = try? Data(contentsOf: url(account)) else { return [] }
    return (try? AtlasJSON.decoder().decode([WatchedAnalysis].self, from: data)) ?? []
  }

  private func save(_ list: [WatchedAnalysis], account: UUID) {
    try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    guard let data = try? AtlasJSON.encoder().encode(list) else { return }
    try? data.write(to: url(account), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
  }

  /// Starts watching; the oldest entries drop beyond `ReadyNoticePolicy.maxWatched`.
  public func watch(_ analysis: WatchedAnalysis, account: UUID) {
    var list = watched(account: account).filter { $0.analysisID != analysis.analysisID }
    list.append(analysis)
    list.sort { $0.startedAt < $1.startedAt }
    save(Array(list.suffix(ReadyNoticePolicy.maxWatched)), account: account)
  }

  public func stop(_ analysisID: UUID, account: UUID) {
    save(watched(account: account).filter { $0.analysisID != analysisID }, account: account)
  }

  public func clear(account: UUID) {
    try? FileManager.default.removeItem(at: url(account))
  }
}
