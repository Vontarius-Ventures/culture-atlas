import XCTest
@testable import AtlasCapture

/// The server's own wire examples (fixtures/native-contract/messages.json,
/// validated against the zod contract by apps/web/lib/server/native-contract.test.ts)
/// decode and present on iOS. This is the check that the app reads what the
/// server actually sends, not only the design's hand-written examples.
final class StyleServerContractTests: XCTestCase {
  private func capture(_ key: String) throws -> CaptureDetailResponse {
    try AtlasJSON.decoder().decode(CaptureDetailResponse.self, from: Fixtures.message(key))
  }

  func testReadyCaptureFromTheServer() throws {
    let c = try capture("capture_style_response")
    guard case .ready(let reading) = StylePresentation.cardState(c) else {
      return XCTFail("expected a ready style card, got \(StylePresentation.cardState(c))")
    }
    XCTAssertEqual(reading.subjects.count, 1)
    XCTAssertFalse(StylePresentation.needsPolling(c))
    let rails = StylePresentation.rails(c)
    let mlt = try XCTUnwrap(rails.first)
    XCTAssertTrue(mlt.rail.isMoreLikeThis)
    XCTAssertEqual(mlt.rail.cards.count, 2)
    XCTAssertTrue(mlt.rail.cards.allSatisfy { ($0.reason ?? "").isEmpty == false }, "every style card carries the server reason")
    XCTAssertEqual(mlt.caption, StyleCopy.railCaption)
    XCTAssertEqual(rails.filter { $0.caption != nil && !$0.rail.isMoreLikeThis }.count, 1)
    XCTAssertEqual(c.analysis?.experimental?.label, "Experimental")
  }

  func testRunningAndFailedCapturesFromTheServer() throws {
    let running = try capture("capture_style_running_response")
    XCTAssertEqual(StylePresentation.cardState(running), .reading)
    XCTAssertTrue(StylePresentation.needsPolling(running))
    let failed = try capture("capture_style_failed_response")
    XCTAssertEqual(StylePresentation.cardState(failed), .failed)
  }

  func testNoCityRailOffersAddCity() throws {
    let c = try capture("capture_style_no_city_response")
    let mlt = try XCTUnwrap(StylePresentation.rails(c).first { $0.rail.isMoreLikeThis })
    XCTAssertTrue(mlt.offersAddCity)
    XCTAssertEqual(mlt.emptyText, StyleCopy.noCity)
  }

  func testMediaAnalysisPreviewFromTheServer() throws {
    let r = try AtlasJSON.decoder().decode(AnalysisResultResponse.self, from: Fixtures.message("analysis_style_response"))
    XCTAssertTrue(r.finished)
    XCTAssertEqual(r.experimental?.label, "Experimental")
    let preview = try XCTUnwrap(r.result?.style)
    XCTAssertEqual(preview.swatches.count, 2)
  }
}
