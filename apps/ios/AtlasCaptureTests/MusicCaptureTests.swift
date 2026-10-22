@testable import AtlasCapture
import XCTest

/// Music Mode (amendment 2.3): camera-off audio capture, verified routes, speech off.
final class MusicCaptureTests: XCTestCase {
  @MainActor
  func testContractLimits() {
    XCTAssertEqual(AtlasContract.audioMaxSeconds, 120)
    XCTAssertEqual(AtlasContract.musicRecognitionDefaultSeconds, 15)
    XCTAssertEqual(AtlasContract.musicRecognitionMinSeconds, 5)
    XCTAssertEqual(AtlasContract.musicRecognitionMaxSeconds, 30)
    XCTAssertFalse(AudioRoutePolicy.speechAnalysisEnabled)
    XCTAssertFalse(MusicCapture.initializesCamera)
    XCTAssertFalse(MusicCapture.usesCaptureSession)
    XCTAssertFalse(MusicCapture.usesPhotoOutput)
    XCTAssertFalse(MusicCapture.speechAnalysisEnabled)
    XCTAssertFalse(MusicCapturePolicy.requestsCameraPermission)
    XCTAssertFalse(MusicCapturePolicy.initializesVideoCaptureSession)
    XCTAssertFalse(MusicCapturePolicy.initializesAVCaptureDeviceVideo)
    XCTAssertFalse(MusicCapturePolicy.autoplayWithSound)
    XCTAssertFalse(MusicCapturePolicy.speechTranscriptionDefault)
  }

  func testClipClockUsesTwoMinuteLimit() {
    let clock = ClipClock(limitSeconds: AtlasContract.audioMaxSeconds)
    XCTAssertEqual(clock.display(elapsed: 12).elapsedText, "0:12 / 2:00")
    XCTAssertNil(clock.display(elapsed: 109).countdown)
    XCTAssertEqual(clock.display(elapsed: 110).countdown, 10)
    XCTAssertTrue(clock.display(elapsed: 120).shouldStop)
  }

  func testPhoneMicrophoneIsAlwaysOffered() {
    let options = AudioRoutePolicy.options(inputs: [
      .init(uid: "mic", name: "iPhone Microphone", type: "MicrophoneBuiltIn"),
    ])
    XCTAssertEqual(options.count, 2)
    XCTAssertTrue(options[0].available)
    XCTAssertEqual(options[0].route, .phoneMicrophone)
    XCTAssertEqual(options[0].title, "Phone microphone")
    XCTAssertFalse(options[1].available)
    XCTAssertEqual(options[1].title, "Glasses microphone unavailable")
  }

  func testVerifiedGlassesInputIsOfferedWithoutReplacingPhone() {
    let options = AudioRoutePolicy.options(inputs: [
      .init(uid: "mic", name: "iPhone Microphone", type: "MicrophoneBuiltIn"),
      .init(uid: "rb", name: "Ray-Ban Meta", type: "BluetoothHFP"),
    ])
    XCTAssertTrue(options[0].available)
    XCTAssertTrue(options[1].available)
    XCTAssertEqual(options[1].route, .glassesMicrophone)
    XCTAssertTrue(options[1].title.contains("Verified input"))
  }

  func testBluetoothOutputAloneDoesNotVerifyGlasses() {
    let options = AudioRoutePolicy.options(
      inputs: [.init(uid: "mic", name: "iPhone Microphone", type: "MicrophoneBuiltIn")],
      outputs: [.init(uid: "bt", name: "Ray-Ban Meta", type: "BluetoothA2DP")])
    XCTAssertFalse(options[1].available, "playback over Bluetooth is not a glasses microphone")
  }

  func testAirPodsAreNotGlasses() {
    XCTAssertFalse(AudioRoutePolicy.isVerifiedGlassesInput(name: "AirPods Pro", type: "BluetoothHFP"))
    XCTAssertEqual(
      AudioRoutePolicy.activeRoute(inputs: [.init(uid: "a", name: "AirPods Pro", type: "BluetoothHFP")]),
      nil)
  }

  func testUnnamedHFPIsNotGlasses() {
    XCTAssertFalse(AudioRoutePolicy.isVerifiedGlassesInput(name: "Wireless Headphones", type: "BluetoothHFP"))
  }

  func testNeverSilentlyFallsBackFromGlassesToPhone() {
    let glasses: AudioInputRoute = .glassesMicrophone
    let nowPhone = [AudioRoutePolicy.Port(uid: "mic", name: "iPhone Microphone", type: "MicrophoneBuiltIn")]
    XCTAssertFalse(AudioRoutePolicy.matches(expected: glasses, inputs: nowPhone))
    XCTAssertEqual(AudioRoutePolicy.activeRoute(inputs: nowPhone), .phoneMicrophone)
  }

  func testPhoneRouteDoesNotMatchGlassesInput() {
    let glassesIn = [AudioRoutePolicy.Port(uid: "rb", name: "Ray-Ban Meta", type: "BluetoothHFP")]
    XCTAssertFalse(AudioRoutePolicy.matches(expected: .phoneMicrophone, inputs: glassesIn))
    XCTAssertEqual(AudioRoutePolicy.activeRoute(inputs: glassesIn), .glassesMicrophone)
  }

  func testInputRouteRawValues() {
    XCTAssertEqual(AudioInputRoute.phoneMicrophone.rawValue, "phone_microphone")
    XCTAssertEqual(AudioInputRoute.glassesMicrophone.rawValue, "glasses_microphone")
    XCTAssertEqual(MediaSource.phoneMicrophone.rawValue, "phone_microphone")
    XCTAssertEqual(MediaSource.glassesMicrophone.rawValue, "glasses_microphone")
    XCTAssertEqual(MediaKind.audio.rawValue, "audio")
  }

  func testAudioDraftFilenameAndContentType() {
    let draft = DraftRecord.new(
      owner: UUID(), kind: .audio, source: .phoneMicrophone, contentType: "audio/mp4", capturedAt: Date())
    XCTAssertTrue(draft.filename.hasPrefix("AUD-"))
    XCTAssertTrue(draft.filename.hasSuffix(".m4a"))
    XCTAssertTrue(draft.audioPresent)
    XCTAssertEqual(draft.kind, .audio)
  }

  func testMusicAnalysisRequestNeverAsksForSpeech() throws {
    let request = AnalyzeAudioRequest.musicMatch(expectedGeneration: 1, startMS: 0, endMS: 15_000)
    XCTAssertEqual(request.contractVersion, 2)
    XCTAssertEqual(request.requestedComponents, ["music_match"])
    XCTAssertFalse(request.requestedComponents.contains("speech_references"))
    XCTAssertFalse(request.requestedComponents.contains("transcript"))
    let encoded = try XCTUnwrap(JSONSerialization.jsonObject(with: AtlasJSON.encoder().encode(request)) as? [String: Any])
    let components = try XCTUnwrap(encoded["requested_components"] as? [String])
    XCTAssertEqual(components, ["music_match"])
    XCTAssertEqual(encoded["contract_version"] as? Int, 2)
  }

  func testPhotoAnalysisRequestStillMatchesFixture() throws {
    let request = AnalyzeMediaRequest(expectedGeneration: 1)
    let encoded = try XCTUnwrap(JSONSerialization.jsonObject(with: AtlasJSON.encoder().encode(request)) as? NSDictionary)
    XCTAssertEqual(encoded, try Fixtures.messageObject("analyze_photo_request"))
  }

  func testPhotoUploadRequestOmitsAudioSourceRoute() throws {
    try assertRoundTrip(CreateUploadRequest.self, "create_upload_photo_request")
  }

  @MainActor
  func testMusicCaptureHasNoCaptureSession() {
    let capture = MusicCapture()
    let labels = Set(Mirror(reflecting: capture).children.compactMap(\.label))
    XCTAssertFalse(labels.contains("session"))
    XCTAssertFalse(labels.contains("photoOutput"))
    XCTAssertFalse(labels.contains("movieOutput"))
    XCTAssertFalse(labels.contains("videoInput"))
  }

  func testMusicModeSourcesNeverMentionCaptureDevices() throws {
    let forbidden = [
      "AVCaptureDevice", "AVCaptureSession", "AVCapturePhotoOutput", "AVCaptureMovieFileOutput",
      "AVCaptureVideoPreviewLayer", "PhoneCamera", "photoOutput",
    ]
    for url in try musicModeSources() {
      let text = try String(contentsOf: url, encoding: .utf8)
      let code = text.split(separator: "\n").filter {
        let trimmed = $0.trimmingCharacters(in: .whitespaces)
        return !trimmed.hasPrefix("//") && !trimmed.hasPrefix("///") && !trimmed.hasPrefix("*")
      }.joined(separator: "\n")
      for token in forbidden {
        XCTAssertFalse(code.contains(token), "\(url.lastPathComponent) must not mention \(token)")
      }
    }
  }

  func testDefaultMusicSelection() {
    XCTAssertEqual(AudioRoutePolicy.defaultRange(durationSeconds: 42).end, 15)
    XCTAssertEqual(AudioRoutePolicy.defaultRange(durationSeconds: 8).end, 8)
    XCTAssertEqual(AudioRoutePolicy.defaultRange(durationSeconds: 8).start, 0)
  }

  private func assertRoundTrip<T: Codable>(_ type: T.Type, _ key: String) throws {
    let example = try Fixtures.messageObject(key)
    let model = try AtlasJSON.decoder().decode(T.self, from: Fixtures.message(key))
    let encoded = try XCTUnwrap(JSONSerialization.jsonObject(with: AtlasJSON.encoder().encode(model)) as? NSDictionary)
    XCTAssertEqual(encoded, example, "\(key) does not encode to its example")
  }

  private func musicModeSources() throws -> [URL] {
    let ios = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    let files = [
      "AtlasCapture/Capture/MusicCapture.swift",
      "AtlasCapture/Policy/AudioRoutePolicy.swift",
      "CultureAtlas/Views/MusicView.swift",
      "CultureAtlas/Views/AudioDetailView.swift",
    ]
    return try files.map { rel in
      let url = ios.appendingPathComponent(rel)
      XCTAssertTrue(FileManager.default.fileExists(atPath: url.path), rel)
      return url
    }
  }
}
