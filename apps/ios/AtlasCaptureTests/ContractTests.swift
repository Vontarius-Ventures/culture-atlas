@testable import AtlasCapture
import XCTest

/// Wire models round-trip the example messages the server schemas accept.
final class ContractTests: XCTestCase {
  let decoder = AtlasJSON.decoder()
  let encoder = AtlasJSON.encoder()

  func testContractConstantsMatchFixture() throws {
    let contract = try Fixtures.json("contract.json")
    XCTAssertEqual(contract["contract_version"] as? String, AtlasContract.version)
    XCTAssertEqual(contract["wire_uuid_case"] as? String, "lowercase")
    let identity = try XCTUnwrap(contract["identity"] as? [String: Any])
    let callbacks = try XCTUnwrap(identity["callbacks"] as? [String: String])
    XCTAssertEqual(callbacks["ios"], AtlasContract.callbackURL.absoluteString)
    XCTAssertEqual(identity["refresh_lost_response_retry_window_seconds"] as? Double, AtlasContract.refreshRetryWindow)
    let capture = try XCTUnwrap(contract["capture"] as? [String: Any])
    XCTAssertEqual(capture["native_clip_max_seconds"] as? Int, AtlasContract.clipMaxSeconds)
    XCTAssertEqual(capture["countdown_from_seconds"] as? Int, AtlasContract.countdownFromSeconds)
    XCTAssertEqual(capture["remote_arm_max_seconds"] as? Int, AtlasContract.remoteArmMaxSeconds)
    let commands = try XCTUnwrap(contract["commands"] as? [String: Any])
    XCTAssertEqual(commands["poll_wait_seconds"] as? Int, AtlasContract.commandPollWaitSeconds)
    XCTAssertEqual(commands["heartbeat_interval_seconds"] as? Double, AtlasContract.heartbeatIntervalSeconds)
  }

  func testDecodesEveryResponseExample() throws {
    _ = try decoder.decode(NativeEmailCompletion.self, from: Fixtures.message("email_complete_native_response"))
    _ = try decoder.decode(NativeSessionTokens.self, from: Fixtures.message("native_session_tokens"))
    _ = try decoder.decode(EnrollmentChallenge.self, from: Fixtures.message("enrollment_challenge_response"))
    let enrolled = try decoder.decode(EnrollResponse.self, from: Fixtures.message("enroll_response"))
    XCTAssertEqual(enrolled.installation.readiness, .unavailable)
    _ = try decoder.decode(StatusAccepted.self, from: Fixtures.message("device_status_response"))
    _ = try decoder.decode(WearableLink.self, from: Fixtures.message("create_wearable_response"))
    _ = try decoder.decode(CaptureSessionResponse.self, from: Fixtures.message("capture_session_response"))
    let upload = try decoder.decode(UploadResponse.self, from: Fixtures.message("upload_response"))
    XCTAssertEqual(upload.partSize, 8_388_608)
    let paused = try decoder.decode(UploadResponse.self, from: Fixtures.message("upload_paused_response"))
    XCTAssertEqual(paused.state, .paused)
    XCTAssertEqual(DraftLockPolicy.effect(forUploadState: paused.state, pauseReason: paused.pauseReason), .lockToOwner)
    _ = try decoder.decode(UploadPartsResponse.self, from: Fixtures.message("upload_parts_response"))
    let batch = try decoder.decode(CommandBatch.self, from: Fixtures.message("native_command_batch"))
    XCTAssertEqual(batch.items.first?.action, .capturePhoto)
    let caps = try decoder.decode(Capabilities.self, from: Fixtures.message("capabilities_response"))
    XCTAssertFalse(caps.flag("meta_glasses_capture_enabled"))
    let error = try decoder.decode(ServerErrorBody.self, from: Fixtures.message("error_body"))
    XCTAssertEqual(error.error.code, "account_mismatch")
    _ = try decoder.decode(AccountService.SwitchResponse.self, from: Fixtures.message("switch_response"))
  }

  /// Requests encode to exactly the example JSON (key names, lowercase UUIDs, dates).
  func testRequestsEncodeToTheExampleBodies() throws {
    try assertRoundTrip(EmailStartRequest.self, "email_start_ios")
    try assertRoundTrip(EmailCompleteRequest.self, "email_complete_request")
    try assertRoundTrip(RefreshRequest.self, "refresh_request")
    try assertRoundTrip(EnrollmentChallengeRequest.self, "enrollment_challenge_request")
    try assertRoundTrip(EnrollRequest.self, "enroll_request")
    try assertRoundTrip(DeviceStatusRequest.self, "device_status_request")
    try assertRoundTrip(CreateWearableRequest.self, "create_wearable_request")
    try assertRoundTrip(CreateCaptureSessionRequest.self, "create_capture_session_request")
    try assertRoundTrip(ArmRequest.self, "arm_request")
    try assertRoundTrip(EndSessionRequest.self, "end_session_request")
    try assertRoundTrip(CreateUploadRequest.self, "create_upload_photo_request")
    try assertRoundTrip(CreateUploadRequest.self, "create_upload_glasses_video_request")
    try assertRoundTrip(UploadPartsRequest.self, "upload_parts_request")
    try assertRoundTrip(CompleteUploadRequest.self, "complete_upload_request")
    for key in ["command_ack_executing", "command_ack_succeeded", "command_ack_unknown", "command_ack_failed", "command_ack_awaiting_user"] {
      try assertRoundTrip(CommandAck.self, key)
    }
  }

  private func assertRoundTrip<T: Codable>(_ type: T.Type, _ key: String, file: StaticString = #filePath, line: UInt = #line) throws {
    let example = try Fixtures.messageObject(key)
    let model = try decoder.decode(T.self, from: Fixtures.message(key))
    let encoded = try XCTUnwrap(JSONSerialization.jsonObject(with: encoder.encode(model)) as? NSDictionary)
    XCTAssertEqual(encoded, example, "\(key) does not encode to its example", file: file, line: line)
  }

  func testCallbackParsingAcceptsOnlyTheFixedDestination() {
    let good = URL(string: "cultureatlas://identity/callback#challenge_id=4f1d9a52-7b8c-4e3d-9a10-2b3c4d5e6f70&token=t0k&state=s&nonce=n")!
    XCTAssertEqual(AccountService.parseCallback(good)?["challenge_id"], "4f1d9a52-7b8c-4e3d-9a10-2b3c4d5e6f70")
    XCTAssertNil(AccountService.parseCallback(URL(string: "cultureatlas://evil/callback#challenge_id=a&token=b&state=c&nonce=d")!))
    XCTAssertNil(AccountService.parseCallback(URL(string: "cultureatlas://identity/callback#challenge_id=a&token=b")!))
    XCTAssertNil(AccountService.parseCallback(URL(string: "https://app.cultureatlas.com/identity/callback#challenge_id=a&token=b&state=c&nonce=d")!))
  }

  func testUniversalCallbackAcceptsOnlyTheConfiguredHost() {
    let proof = "challenge_id=4f1d9a52-7b8c-4e3d-9a10-2b3c4d5e6f70&token=t0k&state=s&nonce=n"
    let host = "culture-atlas.example.ts.net"
    let good = URL(string: "https://\(host)/identity/callback?destination=ios#\(proof)")!
    XCTAssertEqual(AccountService.parseCallback(good, appHost: host)?["token"], "t0k")
    XCTAssertNil(AccountService.parseCallback(good))
    XCTAssertNil(AccountService.parseCallback(good, appHost: "other.example"))
    for bad in [
      "https://evil.example/identity/callback?destination=ios#\(proof)",
      "http://\(host)/identity/callback?destination=ios#\(proof)",
      "https://\(host):8443/identity/callback?destination=ios#\(proof)",
      "https://\(host)/identity/other?destination=ios#\(proof)",
      "https://\(host)/identity/callback#\(proof)",
      "https://\(host)/identity/callback?destination=web#\(proof)",
      "https://\(host)/identity/callback?destination=ios&next=x#\(proof)",
    ] {
      XCTAssertNil(AccountService.parseCallback(URL(string: bad)!, appHost: host), bad)
    }
  }

  func testPKCEChallengeIsS256Base64URL() {
    // RFC 7636 appendix B.
    XCTAssertEqual(
      AccountService.pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
    XCTAssertEqual(SessionStore.newRequestID().count, 43)
  }
}
