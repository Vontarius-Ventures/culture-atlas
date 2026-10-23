import CryptoKit
@testable import AtlasCapture
import XCTest

final class EnrollmentProofTests: XCTestCase {
  func testPayloadAndSignaturesMatchVectors() throws {
    let fixture = try Fixtures.json("enrollment-signature.json")
    let x963 = try XCTUnwrap(Data(base64URLEncoded: XCTUnwrap(fixture["public_key_x963_base64url"] as? String)))
    let publicKey = try P256.Signing.PublicKey(x963Representation: x963)
    let jwk = try XCTUnwrap(EnrollmentProof.jwk(x963: x963))
    let expectedJWK = try XCTUnwrap(fixture["public_key"] as? [String: String])
    XCTAssertEqual(jwk.x, expectedJWK["x"])
    XCTAssertEqual(jwk.y, expectedJWK["y"])
    for vector in try XCTUnwrap(fixture["vectors"] as? [[String: Any]]) {
      let name = vector["name"] as? String ?? "?"
      let payload = EnrollmentProof.payload(
        nonce: try XCTUnwrap(vector["nonce"] as? String),
        installationPublicID: try UUID(fixture: vector["installation_public_id"]),
        platform: try XCTUnwrap(vector["platform"] as? String),
        enrollmentGrant: vector["enrollment_grant"] as? String)
      XCTAssertEqual(payload, vector["payload_utf8"] as? String, name)
      let raw = try XCTUnwrap(Data(base64URLEncoded: XCTUnwrap(vector["signature_p1363_base64url"] as? String)))
      let signature = try P256.Signing.ECDSASignature(rawRepresentation: raw)
      XCTAssertTrue(publicKey.isValidSignature(signature, for: Data(payload.utf8)), name)
      // CryptoKit's DER parser yields the same r||s as the fixture's conversion.
      let der = try XCTUnwrap(Data(hex: XCTUnwrap(vector["signature_der_hex"] as? String)))
      XCTAssertEqual(try P256.Signing.ECDSASignature(derRepresentation: der).rawRepresentation, raw, name)
    }
  }

  func testSoftwareSignerProducesServerEncoding() throws {
    let signer = SoftwareSigner(key: P256.Signing.PrivateKey())
    let signature = try signer.sign(Data("payload".utf8))
    XCTAssertEqual(signature.count, 64)
    XCTAssertEqual(signature.base64URLEncodedString().count, 86)
  }
}

final class PartPlannerTests: XCTestCase {
  func testPlansBatchesAndResume() throws {
    let fixture = try Fixtures.json("upload-parts.json")
    for plan in try XCTUnwrap(fixture["plans"] as? [[String: Any]]) {
      let parts = PartPlanner.plan(
        byteSize: Int64(try XCTUnwrap(plan["byte_size"] as? Int)), partSize: Int64(try XCTUnwrap(plan["part_size"] as? Int)))
      let expected = try XCTUnwrap(plan["parts"] as? [[Int]])
      XCTAssertEqual(parts.map { [$0.number, Int($0.offset), Int($0.length)] }, expected, plan["name"] as? String ?? "")
    }
    let maxVideo = try XCTUnwrap(fixture["max_video"] as? [String: Any])
    let big = PartPlanner.plan(byteSize: Int64(maxVideo["byte_size"] as! Int), partSize: Int64(maxVideo["part_size"] as! Int))
    XCTAssertEqual(big.count, maxVideo["part_count"] as? Int)
    XCTAssertEqual(big.last.map { [$0.number, Int($0.offset), Int($0.length)] }, maxVideo["last_part"] as? [Int])

    let batch = PartPlanner.batches(Array(1...205), maxPerRequest: 100)
    XCTAssertEqual(batch.map { [$0.first!, $0.last!] }, [[1, 100], [101, 200], [201, 205]])

    for resume in try XCTUnwrap(fixture["resume"] as? [[String: Any]]) {
      let receipts = { (key: String) -> [PartReceipt] in
        (resume[key] as? [[String: Any]] ?? []).map { PartReceipt(partNumber: $0["part_number"] as! Int, etag: $0["etag"] as! String) }
      }
      var merged = PartPlanner.merge(server: receipts("server_verified"), local: receipts("local_receipts"))
      let count = resume["part_count"] as! Int
      let missing = PartPlanner.missing(partCount: count, receipts: merged)
      XCTAssertEqual(missing, resume["missing"] as? [Int], resume["name"] as? String ?? "")
      XCTAssertNil(missing.isEmpty ? nil : PartPlanner.completion(partCount: count, receipts: merged))
      for number in missing { merged[number] = "\"new\(number)\"" }
      XCTAssertEqual(PartPlanner.completion(partCount: count, receipts: merged), receipts("complete_after_sending"))
    }

    for step in try XCTUnwrap(fixture["next_step"] as? [[String: String]]) {
      let state = try XCTUnwrap(UploadState(rawValue: step["server_state"]!))
      XCTAssertEqual(PartPlanner.nextStep(for: state).rawValue, step["action"], step["name"] ?? "")
    }
  }
}

final class CommandProcessorTests: XCTestCase {
  func testDecisionTable() throws {
    let fixture = try Fixtures.json("command-lifecycle.json")
    for item in try XCTUnwrap(fixture["decisions"] as? [[String: Any]]) {
      let name = item["name"] as? String ?? "?"
      let local = try XCTUnwrap(item["local"] as? [String: Any])
      let commandJSON = try XCTUnwrap(item["command"] as? [String: Any])
      let command = DeviceCommand(
        commandID: try UUID(fixture: commandJSON["command_id"]), sessionID: try UUID(fixture: commandJSON["session_id"]),
        generation: commandJSON["generation"] as! Int, action: CommandAction(rawValue: commandJSON["action"] as! String)!,
        deliverySequence: 1, durationSeconds: commandJSON["duration_seconds"] as? Int,
        captureClientID: try UUID(fixture: commandJSON["capture_client_id"]), authorizationVersion: 1, state: "delivered",
        expiresAt: try XCTUnwrap(Fixtures.date(commandJSON["expires_at"])), resultAssetID: nil, errorCode: nil)
      let state = CommandLocalState(
        armedSessionID: (local["armed_session_id"] as? String).flatMap(UUID.init(uuidString:)),
        armedGeneration: local["armed_generation"] as? Int, armExpiresAt: Fixtures.date(local["arm_expires_at"]),
        sessionMode: (local["session_mode"] as? String).flatMap(MediaKind.init(rawValue:)),
        sourceReady: local["source_ready"] as! Bool,
        recordingCommandID: (local["recording_command_id"] as? String).flatMap(UUID.init(uuidString:)),
        storageOK: local["storage_ok"] as! Bool)
      var receipt: ReceiptSnapshot?
      if let r = item["receipt"] as? [String: Any] {
        receipt = ReceiptSnapshot(
          state: CommandReceipt.State(rawValue: r["state"] as! String)!, lastAckSequence: r["last_ack_sequence"] as! Int,
          draftSaved: r["draft_saved"] as! Bool, resultAssetID: (r["result_asset_id"] as? String).flatMap(UUID.init(uuidString:)))
      }
      let decision = CommandProcessor.decide(
        command: command, receipt: receipt, local: state, now: try XCTUnwrap(Fixtures.date(item["now"])))
      let expect = try XCTUnwrap(item["expect"] as? [String: Any])
      XCTAssertEqual(decision.kind.rawValue, expect["decision"] as? String, name)
      XCTAssertEqual(decision.persistReceipt?.rawValue, expect["persist_receipt"] as? String, name)
      let encoded = try JSONSerialization.jsonObject(with: AtlasJSON.encoder().encode(decision.acks)) as? NSArray
      XCTAssertEqual(encoded, expect["acks"] as? NSArray, name)
      if expect.keys.contains("duration_seconds") {
        XCTAssertEqual(decision.durationSeconds, expect["duration_seconds"] as? Int, name)
      }
    }
  }

  func testOutcomeAcks() throws {
    let fixture = try Fixtures.json("command-lifecycle.json")
    for item in try XCTUnwrap(fixture["outcomes"] as? [[String: Any]]) {
      let outcome = try XCTUnwrap(CommandProcessor.Outcome(rawValue: item["outcome"] as! String))
      let ack = CommandProcessor.ack(for: outcome, sequence: 2, resultAssetID: nil)
      let expected = try XCTUnwrap(item["ack"] as? [String: String])
      XCTAssertEqual(ack.state.rawValue, expected["state"])
      XCTAssertEqual(ack.safeError?.rawValue, expected["safe_error"])
    }
  }

  func testAckKeysAreDeterministicRFC4122UUIDs() {
    let id = UUID()
    let a = RemoteCommandRunner.ackKey(commandID: id, sequence: 2)
    XCTAssertEqual(a, RemoteCommandRunner.ackKey(commandID: id, sequence: 2))
    XCTAssertNotEqual(a, RemoteCommandRunner.ackKey(commandID: id, sequence: 3))
    let text = a.uuidString.lowercased()
    XCTAssertEqual(Array(text)[14], "8")
    XCTAssertTrue("89ab".contains(Array(text)[19]))
  }
}

final class DraftLockPolicyTests: XCTestCase {
  func testVisibilityAndSignOutOrder() throws {
    let fixture = try Fixtures.json("draft-lock.json")
    let accounts = try XCTUnwrap(fixture["accounts"] as? [String: String])
    for row in try XCTUnwrap(fixture["visibility"] as? [[String: Any]]) {
      let owner = try UUID(fixture: accounts[row["draft_owner"] as! String])
      let signedIn = (row["signed_in"] as? String).flatMap { accounts[$0] }.flatMap(UUID.init(uuidString:))
      let result = DraftLockPolicy.visibility(draftOwner: owner, signedIn: signedIn)
      XCTAssertEqual(result.visible, row["visible"] as? Bool)
      XCTAssertEqual(result.uploadable, row["uploadable"] as? Bool)
      XCTAssertEqual(result.lockedNotice, row["locked_notice"] as? Bool)
    }
    let header = try XCTUnwrap((fixture["upload_headers"] as? [[String: String]])?.first)
    XCTAssertEqual(
      DraftLockPolicy.expectedAccountHeader(draftOwner: try UUID(fixture: accounts[header["draft_owner"]!])),
      accounts[header["expected_account_header"]!])
    for response in try XCTUnwrap(fixture["server_responses"] as? [[String: Any]]) {
      if let code = response["error_code"] as? String {
        XCTAssertNotEqual(DraftLockPolicy.effect(forErrorCode: code), .none, code)
      }
    }
    XCTAssertEqual(DraftLockPolicy.signOutOrder.map(\.rawValue), fixture["sign_out_order"] as? [String])
  }

  func testDraftsOfAnotherAccountAreNeverListed() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let keys = SymmetricKey(size: .bits256)
    let store = DraftStore(root: root, keychain: KeychainStore(service: "test.\(UUID())"), keyOverride: { _ in keys })
    let a = UUID(), b = UUID()
    var draft = DraftRecord.new(owner: a, kind: .photo, source: .phoneCamera, contentType: "image/jpeg", capturedAt: Date())
    let plain = root.appendingPathComponent("plain.jpg")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    try Data(repeating: 7, count: 3000).write(to: plain)
    try store.ingest(plaintext: plain, into: &draft)
    XCTAssertEqual(store.drafts(owner: a).map(\.id), [draft.id])
    XCTAssertTrue(store.drafts(owner: b).isEmpty)
    XCTAssertTrue(store.hasLockedDrafts(otherThan: b))
    XCTAssertFalse(store.hasLockedDrafts(otherThan: a))
  }
}

final class CapabilityGateTests: XCTestCase {
  func testCases() throws {
    let fixture = try Fixtures.json("capability-gate.json")
    for item in try XCTUnwrap(fixture["cases"] as? [[String: Any]]) {
      let name = item["name"] as? String ?? "?"
      let server = try XCTUnwrap(item["server"] as? [String: Any])
      let local = try XCTUnwrap(item["local"] as? [String: Any])
      let result = CapabilityGate.evaluate(
        buildIncludesSDK: item["build_includes_sdk"] as! Bool,
        serverReasons: server["reasons"] as! [String],
        local: CapabilityGate.Local(
          registration: CapabilityGate.Registration(rawValue: local["registration"] as! String)!,
          permission: CapabilityGate.Permission(rawValue: local["permission"] as! String)!,
          deviceAvailable: local["device_available"] as! Bool,
          stream: CapabilityGate.Stream(rawValue: local["stream"] as! String)!,
          recording: local["recording"] as! Bool,
          wasConnected: local["was_connected"] as? Bool ?? false,
          error: local["error"] as? String))
      let expect = try XCTUnwrap(item["expect"] as? [String: Any])
      XCTAssertEqual(result.state.rawValue, expect["state"] as? String, name)
      XCTAssertEqual(result.reasons, expect["reasons"] as? [String], name)
      XCTAssertEqual(result.allowCapture, expect["allow_capture"] as? Bool, name)
      XCTAssertTrue(result.showCameraAndUpload, name)
    }
    for row in try XCTUnwrap(fixture["status_freshness"] as? [[String: Any]]) {
      XCTAssertEqual(
        CapabilityGate.mayShowReady(lastStatusAge: TimeInterval(row["last_status_age_seconds"] as! Int)),
        row["may_show_ready"] as? Bool)
    }
  }

  func testPhotoAnalysisUnavailableWhenVisionIsUnqualified() {
    let caps = Capabilities(
      contractVersion: "2",
      flags: ["concentrate_analysis_enabled": false, "camera_photo": true],
      limits: [:],
      availability: [
        "analysis": Capabilities.Availability(available: false, reasons: ["model_unqualified"]),
      ])
    let analysis = CapabilityGate.photoAnalysis(caps)
    XCTAssertFalse(analysis.available)
    XCTAssertTrue(analysis.message.contains("isn't qualified"))
    XCTAssertTrue(CapabilityGate.phoneCamera(caps).photo)
  }

  func testPhoneCameraStaysOnWhenCapabilitiesHaveNotLoaded() {
    XCTAssertTrue(CapabilityGate.phoneCamera(nil).photo)
    XCTAssertTrue(CapabilityGate.phoneCamera(nil).video)
    let paused = Capabilities(
      contractVersion: "2",
      flags: ["camera_photo": false, "camera_video": false],
      limits: [:],
      availability: [:])
    XCTAssertFalse(CapabilityGate.phoneCamera(paused).photo)
  }

  func testMusicMatchUnavailableWhenFingerprintAndTranscriptAreOff() {
    let caps = Capabilities(
      contractVersion: "2",
      flags: ["microphone_audio": true],
      limits: [:],
      availability: [
        "music_match": Capabilities.Availability(
          available: false, reasons: ["fingerprint_unavailable", "transcript_unconfigured"]),
      ])
    let match = CapabilityGate.musicMatch(caps)
    XCTAssertFalse(match.available)
    XCTAssertTrue(match.message.contains("Nothing was invented"))
  }
}

final class ErrorPolicyTests: XCTestCase {
  func testCodesBackoffAndRefresh() throws {
    let fixture = try Fixtures.json("error-policy.json")
    for row in try XCTUnwrap(fixture["codes"] as? [[String: Any]]) {
      XCTAssertEqual(ErrorPolicy.action(forCode: row["code"] as! String).rawValue, row["action"] as? String, row["code"] as? String ?? "")
    }
    XCTAssertEqual(Set(fixture["switch_endpoint_terminal_codes"] as! [String]), ErrorPolicy.switchTerminalCodes)
    let backoff = try XCTUnwrap(fixture["backoff"] as? [String: Any])
    for row in try XCTUnwrap(backoff["schedule_without_jitter"] as? [[String: Int]]) {
      XCTAssertEqual(Backoff.delay(attempt: row["attempt"]!), TimeInterval(row["delay_seconds"]!))
    }
    for row in try XCTUnwrap(backoff["retry_after_cases"] as? [[String: Int]]) {
      XCTAssertEqual(
        Backoff.delay(attempt: row["attempt"]!, retryAfter: TimeInterval(row["retry_after_seconds"]!)),
        TimeInterval(row["delay_seconds"]!))
    }
    let refresh = try XCTUnwrap(fixture["refresh"] as? [String: Any])
    for row in try XCTUnwrap(refresh["cases"] as? [[String: Any]]) {
      let outcome: RefreshPolicy.Outcome
      switch row["outcome"] as! String {
      case "success": outcome = .success
      case "network_error": outcome = .networkError
      case let http: outcome = .http(Int(http.replacingOccurrences(of: "http_", with: ""))!)
      }
      XCTAssertEqual(
        RefreshPolicy.action(outcome: outcome, elapsed: TimeInterval(row["elapsed_seconds"] as! Int)).rawValue,
        row["action"] as? String, row["name"] as? String ?? "")
    }
  }
}

final class LocalMediaTests: XCTestCase {
  func testEncryptedDraftsRoundTripRangesAndDetectTampering() throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let plain = dir.appendingPathComponent("plain")
    let bytes = Data((0..<10_000).map { UInt8($0 % 251) })
    try bytes.write(to: plain)
    let key = SymmetricKey(size: .bits256)
    let sealed = try EncryptedFile.seal(source: plain, destination: dir.appendingPathComponent("enc"), key: key, chunkSize: 1024)
    XCTAssertEqual(sealed.byteSize, 10_000)
    XCTAssertEqual(sealed.sha256Hex, SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined())
    for (offset, length) in [(0, 10_000), (1000, 3000), (9999, 1), (1024, 1024)] {
      let out = dir.appendingPathComponent("part-\(offset)")
      try EncryptedFile.decryptRange(source: dir.appendingPathComponent("enc"), offset: Int64(offset), length: Int64(length), destination: out, key: key)
      XCTAssertEqual(try Data(contentsOf: out), bytes.subdata(in: offset..<(offset + length)))
    }
    var tampered = try Data(contentsOf: dir.appendingPathComponent("enc"))
    tampered[40] ^= 0xFF
    try tampered.write(to: dir.appendingPathComponent("bad"))
    XCTAssertThrowsError(try EncryptedFile.decryptRange(
      source: dir.appendingPathComponent("bad"), offset: 0, length: 100, destination: dir.appendingPathComponent("x"), key: key))
    XCTAssertThrowsError(try EncryptedFile.decryptRange(
      source: dir.appendingPathComponent("enc"), offset: 0, length: 100, destination: dir.appendingPathComponent("y"),
      key: SymmetricKey(size: .bits256)))
  }

  func testClipClockCountdown() {
    let clock = ClipClock()
    XCTAssertEqual(clock.display(elapsed: 7.4).elapsedText, "0:07 / 1:00")
    XCTAssertNil(clock.display(elapsed: 49).countdown)
    XCTAssertEqual(clock.display(elapsed: 50).countdown, 10)
    XCTAssertEqual(clock.display(elapsed: 59.9).countdown, 1)
    XCTAssertTrue(clock.display(elapsed: 60).shouldStop)
  }

  func testAudioClockUsesTwoMinutes() {
    let clock = MusicCapturePolicy.clock()
    XCTAssertEqual(clock.display(elapsed: 12).elapsedText, "0:12 / 2:00")
    XCTAssertEqual(clock.display(elapsed: 110).countdown, 10)
    XCTAssertTrue(clock.display(elapsed: 120).shouldStop)
  }
}

final class AudioRoutePolicyTests: XCTestCase {
  func testPhoneBuiltInMicIsThePhoneRoute() {
    let phone = AudioRoutePolicy.Port(uid: "1", name: "iPhone Microphone", type: "MicrophoneBuiltIn")
    XCTAssertEqual(AudioRoutePolicy.activeRoute(inputs: [phone]), .phoneMicrophone)
    XCTAssertTrue(AudioRoutePolicy.matches(expected: .phoneMicrophone, inputs: [phone]))
  }

  func testVerifiedGlassesInputRequiresNameAndInputPort() {
    let glasses = AudioRoutePolicy.Port(uid: "g", name: "Ray-Ban Meta Smart Glasses", type: "BluetoothHFP")
    XCTAssertTrue(AudioRoutePolicy.isVerifiedGlassesInput(name: glasses.name, type: glasses.type))
    XCTAssertEqual(AudioRoutePolicy.activeRoute(inputs: [glasses]), .glassesMicrophone)
  }

  func testBluetoothOutputAloneIsNotGlasses() {
    let output = AudioRoutePolicy.Port(uid: "out", name: "Ray-Ban Meta Smart Glasses", type: "BluetoothA2DPOutput")
    XCTAssertFalse(AudioRoutePolicy.isVerifiedGlassesInput(name: output.name, type: output.type))
    let options = AudioRoutePolicy.options(inputs: [], outputs: [output])
    XCTAssertEqual(options.first { $0.route == .glassesMicrophone }?.available, false)
    XCTAssertEqual(options.first { $0.route == .glassesMicrophone }?.title, "Glasses microphone unavailable")
  }

  func testAirPodsAreNeverLabelledGlasses() {
    let pods = AudioRoutePolicy.Port(uid: "a", name: "Vontarius’s AirPods", type: "BluetoothHFP")
    XCTAssertFalse(AudioRoutePolicy.isVerifiedGlassesInput(name: pods.name, type: pods.type))
    XCTAssertNil(AudioRoutePolicy.activeRoute(inputs: [pods]))
  }

  func testGlassesMismatchNeverFallsBackToPhone() {
    let phone = AudioRoutePolicy.Port(uid: "1", name: "iPhone Microphone", type: "MicrophoneBuiltIn")
    XCTAssertFalse(AudioRoutePolicy.matches(expected: .glassesMicrophone, inputs: [phone]))
    XCTAssertEqual(AudioRoutePolicy.activeRoute(inputs: [phone]), .phoneMicrophone)
  }

  func testDefaultRouteIsAlwaysThePhone() {
    let glasses = AudioRoutePolicy.Port(uid: "g", name: "Ray-Ban Meta", type: "BluetoothHFP")
    let options = AudioRoutePolicy.options(inputs: [glasses])
    XCTAssertEqual(MusicCapturePolicy.defaultRoute(options: options), .phoneMicrophone)
  }
}

final class MusicCapturePolicyTests: XCTestCase {
  @MainActor
  func testAUD01CameraIsOutOfBounds() {
    XCTAssertFalse(MusicCapturePolicy.requestsCameraPermission)
    XCTAssertFalse(MusicCapturePolicy.initializesVideoCaptureSession)
    XCTAssertFalse(MusicCapturePolicy.initializesCaptureDeviceVideo)
    XCTAssertFalse(MusicCapture.initializesCamera)
    XCTAssertFalse(MusicCapture.usesCaptureSession)
    XCTAssertFalse(MusicCapture.usesPhotoOutput)
    XCTAssertFalse(MusicCapturePolicy.autoplayWithSound)
    XCTAssertFalse(MusicCapturePolicy.speechTranscriptionDefault)
  }

  func testRecordLabelsDoNotRelyOnColour() {
    XCTAssertEqual(MusicCapturePolicy.recordButtonLabel(isRecording: false), "Record")
    XCTAssertEqual(MusicCapturePolicy.recordButtonLabel(isRecording: true), "Stop recording")
    XCTAssertTrue(MusicCapturePolicy.recordAccessibility(isRecording: true, elapsed: "0:12 / 2:00").contains("Stop recording"))
    XCTAssertTrue(MusicCapturePolicy.recordAccessibility(isRecording: false, elapsed: "0:00 / 2:00").contains("Camera off"))
  }

  func testMusicAnalysisRequestOmitsSpeech() throws {
    let request = AnalyzeAudioRequest.musicMatch(expectedGeneration: 1, startMS: 0, endMS: 15_000)
    XCTAssertEqual(request.requestedComponents, ["music_match"])
    XCTAssertEqual(request.contractVersion, 2)
    let encoded = try JSONSerialization.jsonObject(with: AtlasJSON.encoder().encode(request)) as? [String: Any]
    XCTAssertEqual(encoded?["requested_components"] as? [String], ["music_match"])
    XCTAssertFalse(((encoded?["requested_components"] as? [String]) ?? []).contains("speech_references"))
  }

  func testAudioDraftFilename() {
    let draft = DraftRecord.new(
      owner: UUID(), kind: .audio, source: .phoneMicrophone, contentType: "audio/mp4", capturedAt: Date())
    XCTAssertTrue(draft.filename.hasPrefix("AUD-"))
    XCTAssertTrue(draft.filename.hasSuffix(".m4a"))
    XCTAssertEqual(draft.sourceRoute, "phone_microphone")
    XCTAssertTrue(draft.audioPresent)
  }
}
