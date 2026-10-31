import Combine
import Foundation

/// Loads `GET /v1/captures/{id}` and polls it every 1.5 s while any section
/// or rail is pending or running, then stops (design B.4). Publishes the
/// style card state and the rails, plus two counters the view turns into a
/// haptic (the reading first landed) and a VoiceOver announcement (a claim
/// was retracted: "Style updated").
@MainActor
public final class CaptureStyleViewModel: ObservableObject {
  public typealias Loader = @Sendable () async throws -> CaptureDetailResponse
  public typealias Action = @Sendable () async throws -> Void

  @Published public private(set) var capture: CaptureDetailResponse?
  @Published public private(set) var cardState: StyleCardState = .reading
  @Published public private(set) var rails: [StylePresentation.RailItem] = []
  /// The first load failed (nothing to show yet).
  @Published public private(set) var unreachable = false
  /// One style retry per analysis (409 `retry_used` afterwards).
  @Published public private(set) var retryAvailable = true
  @Published public private(set) var retrying = false
  /// Increments when the reading first lands (haptic `.selection`).
  @Published public private(set) var landedCount = 0
  /// Increments when a shown claim disappears (aria-live equivalent).
  @Published public private(set) var updatedCount = 0

  /// `ai_paused` / `daily_limit` from the media analysis, when known.
  public var waitingReason: String?
  public let pollInterval: TimeInterval
  public let maxPolls: Int

  private let load: Loader
  private let retryCall: Action?
  private var shownClaims: Set<String> = []
  private var polling = false

  public init(
    load: @escaping Loader, retry: Action? = nil, waitingReason: String? = nil,
    pollInterval: TimeInterval = 1.5, maxPolls: Int = 80
  ) {
    self.load = load
    self.retryCall = retry
    self.waitingReason = waitingReason
    self.pollInterval = pollInterval
    self.maxPolls = maxPolls
    retryAvailable = retry != nil
  }

  public var imageAspect: Double? {
    guard let image = capture?.image, let w = image.width, let h = image.height, w > 0, h > 0 else { return nil }
    return Double(w) / Double(h)
  }

  public var experimental: ExperimentalLabel? { capture?.analysis?.experimental }

  /// Poll until nothing is pending or running (or the bound is reached).
  /// Returns when done; cancelling the calling task stops it.
  public func run() async {
    guard !polling else { return }
    polling = true
    defer { polling = false }
    for attempt in 0..<maxPolls {
      if Task.isCancelled { return }
      do {
        let loaded = try await load()
        apply(loaded)
        unreachable = false
        if !StylePresentation.needsPolling(loaded) { return }
      } catch where AtlasClientError.isCancellation(error) {
        return
      } catch {
        if capture == nil { unreachable = true }
        // Keep trying a few times on a flaky network, then stop quietly.
        if attempt >= 3 && capture == nil { return }
      }
      try? await Task.sleep(nanoseconds: UInt64(pollInterval * 1_000_000_000))
    }
  }

  /// "Try again" on a failed style reading: re-queues only the style stage.
  public func retry() async {
    guard let retryCall, retryAvailable, !retrying else { return }
    retrying = true
    defer { retrying = false }
    do {
      try await retryCall()
      retryAvailable = false
      cardState = .reading
      await run()
    } catch AtlasClientError.server(409, _, _, _, _) {
      // retry_used: the one retry for this analysis is spent.
      retryAvailable = false
    } catch {
      // Stay on the failed card; the button remains for another attempt.
    }
  }

  public func apply(_ loaded: CaptureDetailResponse) {
    let previous = cardState
    capture = loaded
    let state = StylePresentation.cardState(loaded, waitingReason: waitingReason)
    cardState = state
    rails = StylePresentation.rails(loaded)
    if case .ready(let reading) = state {
      let keys = StylePresentation.visibleClaimKeys(reading)
      if case .ready = previous {
        if !shownClaims.subtracting(keys).isEmpty { updatedCount += 1 }
      } else {
        landedCount += 1
      }
      shownClaims = keys
    }
  }
}
