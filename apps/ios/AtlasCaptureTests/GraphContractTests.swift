import Foundation
@testable import AtlasCapture
import XCTest

/// Typed owner/native graph wire models round-trip the shared
/// fixtures/native-contract examples (the same messages the server test
/// parses with its zod schemas), covering the populated, empty, failed and
/// unavailable states the UI renders (VAL-NATIVE-001).
final class GraphContractTests: XCTestCase {
  let decoder = AtlasJSON.decoder()
  let encoder = AtlasJSON.encoder()

  // MARK: Summary

  func testDecodesPopulatedSummaryExample() throws {
    let summary = try decoder.decode(InterestGraphSummary.self, from: Fixtures.message("interest_graph_summary_response"))
    XCTAssertEqual(summary.ownerAccountID.uuidString.lowercased(), "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5e")
    XCTAssertEqual(summary.settings.revision, 3)
    XCTAssertFalse(summary.settings.discoveryPaused)
    XCTAssertNil(summary.settings.pausedAt)
    XCTAssertEqual(summary.projection.state, .ready)
    XCTAssertFalse(summary.projection.lagging)
    XCTAssertEqual(summary.projection.appliedTasteRevision, summary.projection.currentTasteRevision)
    XCTAssertEqual(summary.counts, InterestGraphSummary.Counts(confirmed: 1, tentative: 1, suppressed: 1))

    let interest = try XCTUnwrap(summary.interests.items.first)
    XCTAssertEqual(interest.itemID.uuidString.lowercased(), "6b1f0c2a-3d4e-4f50-9a61-7b8c9d0e1f02")
    XCTAssertEqual(interest.title, "Nina Simone")
    XCTAssertEqual(interest.kind, "artist")
    XCTAssertEqual(interest.pickIDs.count, 1)
    XCTAssertNil(interest.analysisID)
    // More pages exist for the confirmed list; the cursor rides along.
    XCTAssertNotNil(summary.interests.nextCursor)

    let states = summary.tentative.items.map(\.state)
    XCTAssertEqual(states, [.tentative, .suppressed])
    let first = try XCTUnwrap(summary.tentative.items.first)
    XCTAssertEqual(first.name, "Auguste Rodin")
    XCTAssertEqual(first.relation, .depicted)
    XCTAssertEqual(first.resolution, .resolved)
    XCTAssertTrue(first.isAnchor)
    let second = try XCTUnwrap(summary.tentative.items.last)
    XCTAssertEqual(second.relation, .resembles)
    XCTAssertEqual(second.resolution, .userConfirmed)
    XCTAssertNil(summary.tentative.nextCursor)
  }

  func testDecodesEmptyAndFailedSummaryExamples() throws {
    let empty = try decoder.decode(InterestGraphSummary.self, from: Fixtures.message("interest_graph_summary_empty_response"))
    XCTAssertEqual(empty.projection.state, .neverProjected)
    XCTAssertEqual(empty.counts, InterestGraphSummary.Counts(confirmed: 0, tentative: 0, suppressed: 0))
    XCTAssertTrue(empty.interests.items.isEmpty)
    XCTAssertTrue(empty.tentative.items.isEmpty)
    XCTAssertNil(empty.interests.nextCursor)
    XCTAssertNil(empty.tentative.nextCursor)
    XCTAssertNil(empty.projection.lastProjectedAt)
    XCTAssertEqual(empty.settings.revision, 0)

    let failed = try decoder.decode(InterestGraphSummary.self, from: Fixtures.message("interest_graph_summary_failed_response"))
    XCTAssertEqual(failed.projection.state, .failed)
    XCTAssertTrue(failed.projection.lagging)
    XCTAssertEqual(failed.projection.pendingEvents, 2)
    XCTAssertEqual(failed.projection.appliedTasteRevision, 4)
    XCTAssertEqual(failed.projection.targetTasteRevision, 5)
  }

  /// A future additive server field must not break the decoders (the same
  /// lenience the older clients rely on for why_this).
  func testSummaryDecodingIgnoresUnknownAdditiveFields() throws {
    var body = try XCTUnwrap(JSONSerialization.jsonObject(with: Fixtures.message("interest_graph_summary_empty_response")) as? [String: Any])
    body["future_field"] = "ok"
    let summary = try decoder.decode(InterestGraphSummary.self, from: JSONSerialization.data(withJSONObject: body))
    XCTAssertEqual(summary.projection.state, .neverProjected)
  }

  // MARK: Controls

  func testControlRequestsEncodeToTheExampleBodies() throws {
    try assertRoundTrip(UpdateInterestGraphSettingsBody.self, "interest_graph_settings_request")
    try assertRoundTrip(UpdateInterestGraphInterestBody.self, "interest_graph_interest_request")
  }

  func testDecodesControlResponsesAndConflictError() throws {
    let settings = try decoder.decode(UpdateInterestGraphSettingsResponse.self, from: Fixtures.message("interest_graph_settings_response"))
    XCTAssertEqual(settings.settings.revision, 4)
    XCTAssertTrue(settings.settings.discoveryPaused)
    XCTAssertNotNil(settings.settings.pausedAt)

    let interest = try decoder.decode(UpdateInterestGraphInterestResponse.self, from: Fixtures.message("interest_graph_interest_response"))
    XCTAssertEqual(interest.state, .suppressed)
    XCTAssertEqual(interest.settings.revision, 5)
    XCTAssertEqual(interest.settings.discoveryPaused, interest.settings.discoveryPaused)

    let conflict = try decoder.decode(ServerErrorBody.self, from: Fixtures.message("revision_conflict_error"))
    XCTAssertEqual(conflict.error.code, "revision_conflict")
    XCTAssertFalse(conflict.error.retryable)
  }

  // MARK: Recommendation connection (Why this)

  func testDecodesConnectedConnectionExample() throws {
    let connection = try decoder.decode(RecommendationConnection.self, from: Fixtures.message("recommendation_connection_response"))
    XCTAssertEqual(connection.state, .connected)
    XCTAssertEqual(connection.provenance, .graphRun)
    XCTAssertEqual(connection.intent, .personal)
    XCTAssertEqual(connection.reason.text, "Also work on display at Art Institute of Chicago.")

    let path = try XCTUnwrap(connection.path)
    XCTAssertEqual(path.count, 2)
    XCTAssertEqual(path[0].predicateText, "created by")
    XCTAssertEqual(path[0].subject.name, "The Thinker")
    XCTAssertEqual(path[0].object.name, "Auguste Rodin")
    XCTAssertEqual(path[1].predicate, .documentedAssociation)
    XCTAssertEqual(path[1].associationSubtype, "work_on_display_at")
    XCTAssertEqual(path[1].predicateText, "work on display at")

    let source = try XCTUnwrap(connection.sources.first)
    XCTAssertEqual(source.publisher, "Art Institute of Chicago")
    XCTAssertEqual(source.locator, "Collections, object data")
    XCTAssertNotNil(source.retrievedAt)

    let roots = try XCTUnwrap(connection.support).roots
    XCTAssertEqual(roots.map(\.phrase), ["Because you saved Auguste Rodin.", "Because you picked Impressionism."])
    XCTAssertNil(connection.unavailableReason)
  }

  func testDecodesScopedAndUnavailableConnectionExamples() throws {
    let scoped = try decoder.decode(RecommendationConnection.self, from: Fixtures.message("recommendation_connection_scoped_response"))
    XCTAssertEqual(scoped.provenance, .scopedDiscovery)
    XCTAssertEqual(scoped.intent, .photo)
    XCTAssertNil(scoped.support)
    XCTAssertEqual(scoped.path?.count, 1)
    XCTAssertNil(scoped.graphRunID)

    let unavailable = try decoder.decode(RecommendationConnection.self, from: Fixtures.message("recommendation_connection_unavailable_response"))
    XCTAssertEqual(unavailable.state, .unavailable)
    XCTAssertEqual(unavailable.unavailableReason, "support_withdrawn")
    XCTAssertNil(unavailable.reason.text)
    XCTAssertNil(unavailable.path)
    XCTAssertTrue(unavailable.sources.isEmpty)
    XCTAssertNil(unavailable.support)
    XCTAssertNil(unavailable.intent)
  }

  private func assertRoundTrip<T: Codable>(_ type: T.Type, _ key: String, file: StaticString = #filePath, line: UInt = #line) throws {
    let example = try Fixtures.messageObject(key)
    let model = try decoder.decode(T.self, from: Fixtures.message(key))
    let encoded = try XCTUnwrap(JSONSerialization.jsonObject(with: encoder.encode(model)) as? NSDictionary)
    XCTAssertEqual(encoded, example, "\(key) does not encode to its example", file: file, line: line)
  }
}
