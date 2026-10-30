import Foundation
@testable import AtlasCapture
import XCTest

/// Account-deletion wire models round-trip the shared
/// fixtures/native-contract examples (the same messages the server test
/// parses with its zod schemas): the owner overview, the typed acceptance,
/// and the token-gated status answer that keeps working after every
/// authority is revoked (VAL-DELETE-001/002/004).
final class AccountDeletionContractTests: XCTestCase {
  let decoder = AtlasJSON.decoder()
  let encoder = AtlasJSON.encoder()

  func testDecodesOverviewExample() throws {
    let overview = try decoder.decode(AccountDeletionOverview.self, from: Fixtures.message("account_deletion_overview_response"))
    XCTAssertFalse(overview.requested)
    XCTAssertEqual(overview.state, .none)
    XCTAssertNil(overview.status)
    XCTAssertEqual(overview.disclosure.immediate.count, 2)
    XCTAssertEqual(overview.disclosure.cleanupSteps.count, 2)
    XCTAssertEqual(overview.disclosure.retained.count, 4)
    XCTAssertTrue(overview.disclosure.summary.contains("revokes every credential"))
    // The retention lines stay honest: backups and provider records are
    // described as their actual limits, not as immediate erasure.
    XCTAssertTrue(overview.disclosure.retained.contains { $0.contains("backups roll off") })
    XCTAssertTrue(overview.disclosure.retained.contains { $0.contains("this server cannot delete them") })
  }

  func testAcceptanceRequestEncodesToTheExampleBody() throws {
    let body = try decoder.decode(RequestAccountDeletionBody.self, from: Fixtures.message("account_deletion_accept_request"))
    XCTAssertTrue(body.confirm)
    XCTAssertEqual(body.statusToken?.count, 47)
    let encoded = try XCTUnwrap(JSONSerialization.jsonObject(with: encoder.encode(body)) as? NSDictionary)
    let example = try Fixtures.messageObject("account_deletion_accept_request")
    XCTAssertEqual(encoded, example, "account_deletion_accept_request does not encode to its example")
  }

  func testDecodesAcceptanceResponseExample() throws {
    let response = try decoder.decode(RequestAccountDeletionResponse.self, from: Fixtures.message("account_deletion_accept_response"))
    XCTAssertEqual(response.status.state, .pending)
    XCTAssertEqual(response.status.completedSteps, [])
    XCTAssertEqual(response.status.pendingSteps, ["media_objects", "private_rows"])
    XCTAssertTrue(response.status.retrying)
    XCTAssertNil(response.status.completedAt)
    XCTAssertNil(response.status.lastErrorCode)
    XCTAssertNotNil(response.statusToken)
    XCTAssertEqual(response.disclosure.cleanupSteps.count, 2)
  }

  func testDecodesStatusResponseExample() throws {
    let answer = try decoder.decode(AccountDeletionStatusResponse.self, from: Fixtures.message("account_deletion_status_response"))
    XCTAssertEqual(answer.status.state, .complete)
    XCTAssertEqual(answer.status.completedSteps, ["media_objects", "private_rows"])
    XCTAssertEqual(answer.status.pendingSteps, [])
    XCTAssertFalse(answer.status.retrying)
    XCTAssertNotNil(answer.status.completedAt)
    XCTAssertEqual(answer.disclosure.retained.count, 4)
  }

  /// A future additive server field must not break the decoders.
  func testDecodingIgnoresUnknownAdditiveFields() throws {
    var body = try XCTUnwrap(JSONSerialization.jsonObject(with: Fixtures.message("account_deletion_accept_response")) as? [String: Any])
    body["future_field"] = "ok"
    let response = try decoder.decode(RequestAccountDeletionResponse.self, from: JSONSerialization.data(withJSONObject: body))
    XCTAssertEqual(response.status.state, .pending)
  }
}
