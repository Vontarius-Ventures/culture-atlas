import Foundation

/// Background `URLSession` part transfers, adapted from World Observer's
/// `BackgroundUploadManager`: stable session identifiers so the system
/// reconnects in-flight tasks after relaunch, and `taskDescription` carrying
/// the draft/part identity so completions re-associate across process death.
///
/// Differences from Observer: PUTs go to the server-signed part URL (no
/// bearer token, no relay headers); the part's ETag is the receipt; two
/// sessions separate Wi-Fi-only from cellular-allowed transfers.
public final class BackgroundTransfer: NSObject, URLSessionDataDelegate, @unchecked Sendable {
  public struct TaskInfo: Codable, Equatable, Sendable {
    public var draftID: UUID
    public var ownerAccountID: UUID
    public var uploadID: UUID
    public var partNumber: Int
    public var partFile: URL
  }

  public enum Outcome: Equatable, Sendable {
    case uploaded(etag: String)
    case expiredInstruction
    case failed(String)
  }

  public static let wifiIdentifier = "com.cultureatlas.app.uploads.wifi"
  public static let anyNetworkIdentifier = "com.cultureatlas.app.uploads.any"

  /// Called on the delegate queue for every finished part, including ones
  /// that finish while the app was not running.
  public var onPartFinished: (@Sendable (TaskInfo, Outcome) -> Void)?
  /// Set by the app delegate from `handleEventsForBackgroundURLSession`.
  public var backgroundCompletionHandlers: [String: () -> Void] = [:]

  private let queue = OperationQueue()
  private let lock = NSLock()
  private var wifiSession: URLSession!
  private var anySession: URLSession!

  public override init() {
    super.init()
    queue.maxConcurrentOperationCount = 1
    queue.name = "com.cultureatlas.app.uploads"
    wifiSession = makeSession(identifier: Self.wifiIdentifier, cellular: false)
    anySession = makeSession(identifier: Self.anyNetworkIdentifier, cellular: true)
  }

  private func makeSession(identifier: String, cellular: Bool) -> URLSession {
    let config = URLSessionConfiguration.background(withIdentifier: identifier)
    config.waitsForConnectivity = true
    config.timeoutIntervalForRequest = 60
    // Signed part URLs expire after at most 15 minutes.
    config.timeoutIntervalForResource = 14 * 60
    config.isDiscretionary = false
    config.sessionSendsLaunchEvents = true
    config.allowsCellularAccess = cellular
    config.allowsExpensiveNetworkAccess = cellular
    config.allowsConstrainedNetworkAccess = cellular
    return URLSession(configuration: config, delegate: self, delegateQueue: queue)
  }

  /// Starts one part PUT from a plaintext part file.
  public func upload(_ info: TaskInfo, instruction: PartInstruction, allowCellular: Bool) throws {
    var request = URLRequest(url: instruction.url)
    request.httpMethod = instruction.method
    for (name, value) in instruction.headers { request.setValue(value, forHTTPHeaderField: name) }
    let session = allowCellular ? anySession! : wifiSession!
    let task = session.uploadTask(with: request, fromFile: info.partFile)
    task.taskDescription = String(data: try JSONEncoder().encode(info), encoding: .utf8)
    task.resume()
  }

  /// Parts currently owned by the system for a draft (to avoid duplicates on resume).
  public func activeParts(draftID: UUID) async -> Set<Int> {
    var parts = Set<Int>()
    for session in [wifiSession!, anySession!] {
      for task in await session.allTasks where task.state == .running || task.state == .suspended {
        if let info = Self.info(task), info.draftID == draftID { parts.insert(info.partNumber) }
      }
    }
    return parts
  }

  /// Sign-out/account switch: stop every transfer that belongs to `owner`.
  public func cancelAll(owner: UUID) async {
    for session in [wifiSession!, anySession!] {
      for task in await session.allTasks {
        if let info = Self.info(task), info.ownerAccountID == owner { task.cancel() }
      }
    }
  }

  public func cancel(draftID: UUID) async {
    for session in [wifiSession!, anySession!] {
      for task in await session.allTasks {
        if let info = Self.info(task), info.draftID == draftID { task.cancel() }
      }
    }
  }

  static func info(_ task: URLSessionTask) -> TaskInfo? {
    guard let description = task.taskDescription, let data = description.data(using: .utf8) else { return nil }
    return try? JSONDecoder().decode(TaskInfo.self, from: data)
  }

  // MARK: URLSessionDataDelegate

  public func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    guard let info = Self.info(task) else { return }
    try? FileManager.default.removeItem(at: info.partFile)
    let http = task.response as? HTTPURLResponse
    let outcome: Outcome
    if let error {
      outcome = .failed((error as NSError).domain + ":\((error as NSError).code)")
    } else if let http, (200..<300).contains(http.statusCode),
      let etag = http.value(forHTTPHeaderField: "ETag"), !etag.isEmpty
    {
      outcome = .uploaded(etag: etag)
    } else if let http, http.statusCode == 403 {
      // Expired or invalid signature: request fresh instructions.
      outcome = .expiredInstruction
    } else {
      outcome = .failed("http_\(http?.statusCode ?? 0)")
    }
    onPartFinished?(info, outcome)
  }

  public func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
    guard let identifier = session.configuration.identifier else { return }
    let handler = lock.withLock { backgroundCompletionHandlers.removeValue(forKey: identifier) }
    DispatchQueue.main.async { handler?() }
  }
}
