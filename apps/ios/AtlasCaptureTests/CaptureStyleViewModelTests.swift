import XCTest
@testable import AtlasCapture

/// The capture style poller: polls while anything is pending or running,
/// stops at the terminal state, reports the first landing and retractions,
/// and allows exactly one style retry.
@MainActor
final class CaptureStyleViewModelTests: XCTestCase {
  /// Serves a scripted sequence of captures (the last one repeats).
  private actor Script {
    var responses: [Result<CaptureDetailResponse, Error>]
    var calls = 0
    init(_ responses: [Result<CaptureDetailResponse, Error>]) { self.responses = responses }
    func next() throws -> CaptureDetailResponse {
      defer { calls += 1 }
      return try responses[min(calls, responses.count - 1)].get()
    }
    func append(_ response: CaptureDetailResponse) { responses.append(.success(response)) }
  }

  private actor Counter {
    var count = 0
    func hit() { count += 1 }
  }

  private let analysisID = UUID()

  private func capture(style: String, reading: StyleReading? = nil, rail: String = "ready") -> CaptureDetailResponse {
    CaptureDetailResponse(
      id: UUID(uuidString: "6b1f0c2a-3d4e-4f50-9a61-7b8c9d0e1f23")!,
      image: LibraryImage(url: "/x.jpg", width: 1000, height: 1250, alt: ""),
      analysis: CaptureAnalysisSummary(id: analysisID, sections: ["style": style], experimental: ExperimentalLabel()),
      styleReading: reading,
      rails: [CaptureRail(key: "more_like_this:s1", kind: "more_like_this", title: "More like this", status: rail)])
  }

  private func reading(aesthetics: [String], retracted: [String] = []) -> StyleReading {
    StyleReading(summary: "A jacket.", subjects: [StyleSubject(
      id: "s1", category: "fashion", label: "Jacket",
      aesthetics: aesthetics.enumerated().map { index, name in
        var claim = StyleClaim(name: name, display: name, wording: "asserted")
        claim.slotIndex = index
        return claim
      })], retracted: retracted)
  }

  func testPollsUntilTerminalAndHapticFiresOnceWhenReadingLands() async {
    let script = Script([
      .success(capture(style: "running", rail: "pending")),
      .success(capture(style: "ready", reading: reading(aesthetics: ["Workwear"]), rail: "running")),
      .success(capture(style: "ready", reading: reading(aesthetics: ["Workwear"]), rail: "ready")),
      .success(capture(style: "ready", reading: reading(aesthetics: ["Workwear"]), rail: "ready")),
    ])
    let model = CaptureStyleViewModel(load: { try await script.next() }, pollInterval: 0.01)
    XCTAssertEqual(model.cardState, .reading)
    await model.run()
    let calls = await script.calls
    XCTAssertEqual(calls, 3, "stops as soon as nothing is pending or running")
    XCTAssertEqual(model.cardState, .ready(reading(aesthetics: ["Workwear"])))
    XCTAssertEqual(model.landedCount, 1)
    XCTAssertEqual(model.updatedCount, 0)
    XCTAssertEqual(model.rails.first?.caption, StyleCopy.railCaption)
    XCTAssertEqual(model.imageAspect ?? 0, 0.8, accuracy: 0.0001)
    XCTAssertEqual(model.experimental?.label, "Experimental")
  }

  func testRetractionAnnouncesUpdateAndWordingUpgradeDoesNot() {
    let model = CaptureStyleViewModel(load: { throw CancellationError() })
    model.apply(capture(style: "running", reading: reading(aesthetics: ["Workwear", "Americana"])))
    XCTAssertEqual(model.landedCount, 1)
    // Same claims again (for example a resembles → asserted upgrade): no announcement.
    model.apply(capture(style: "ready", reading: reading(aesthetics: ["Workwear", "Americana"])))
    XCTAssertEqual(model.updatedCount, 0)
    // Stage-2 veto retracts one claim: announce "Style reading updated".
    model.apply(capture(style: "ready", reading: reading(aesthetics: ["Workwear", "Americana"], retracted: ["subjects[0].aesthetics[1]"])))
    XCTAssertEqual(model.updatedCount, 1)
    XCTAssertEqual(model.landedCount, 1)
  }

  func testPollingIsBoundedAndCancellationStopsQuietly() async {
    let script = Script([.success(capture(style: "running"))])
    let model = CaptureStyleViewModel(load: { try await script.next() }, pollInterval: 0.001, maxPolls: 5)
    await model.run()
    let calls = await script.calls
    XCTAssertEqual(calls, 5)
    XCTAssertEqual(model.cardState, .reading)

    let cancelled = CaptureStyleViewModel(load: { throw CancellationError() }, pollInterval: 0.001)
    await cancelled.run()
    XCTAssertFalse(cancelled.unreachable)
  }

  func testUnreachableFirstLoadGivesUpAfterAFewTries() async {
    let script = Script([.failure(AtlasClientError.transport("NSURLErrorDomain:-1009"))])
    let model = CaptureStyleViewModel(load: { try await script.next() }, pollInterval: 0.001)
    await model.run()
    XCTAssertTrue(model.unreachable)
    let calls = await script.calls
    XCTAssertEqual(calls, 4)
  }

  func testOneRetryReQueuesTheStyleStage() async {
    let script = Script([.success(capture(style: "failed"))])
    let retries = Counter()
    let model = CaptureStyleViewModel(
      load: { try await script.next() },
      retry: {
        await retries.hit()
        await script.append(self.capture(style: "running"))
        await script.append(self.capture(style: "ready", reading: self.reading(aesthetics: ["Workwear"])))
      },
      pollInterval: 0.001)
    await model.run()
    XCTAssertEqual(model.cardState, .failed)
    XCTAssertTrue(model.retryAvailable)
    await model.retry()
    let count = await retries.count
    XCTAssertEqual(count, 1)
    XCTAssertFalse(model.retryAvailable)
    XCTAssertEqual(model.cardState, .ready(reading(aesthetics: ["Workwear"])))
    // A second tap does nothing.
    await model.retry()
    let after = await retries.count
    XCTAssertEqual(after, 1)
  }

  func testRetryUsedHidesTheButton() async {
    let model = CaptureStyleViewModel(
      load: { await self.capture(style: "failed") },
      retry: {
        throw AtlasClientError.server(status: 409, code: "retry_used", message: "", retryable: false, retryAfter: nil)
      },
      pollInterval: 0.001)
    await model.run()
    await model.retry()
    XCTAssertFalse(model.retryAvailable)
    XCTAssertEqual(model.cardState, .failed)
  }

  func testNoRetryWithoutRetryAction() {
    XCTAssertFalse(CaptureStyleViewModel(load: { throw CancellationError() }).retryAvailable)
  }
}
