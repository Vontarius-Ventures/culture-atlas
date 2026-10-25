import XCTest
@testable import AtlasCapture

/// Client-recognized songs (ShazamKit hint) round-trip the contract-2 analyze
/// request exactly as the server schema accepts it, and the recognizer seam
/// stays honest when the build carries no xcframework.
final class ClientRecognizedSongTests: XCTestCase {
  let encoder = AtlasJSON.encoder()
  let decoder = AtlasJSON.decoder()

  func testSongEncodesSnakeCaseWithOnlyTheVendorFields() throws {
    let song = ClientRecognizedSong(
      artistName: "Fleetwood Mac", title: "Dreams", matchedAtMS: 4200, vendorRecordingID: "shazam-40339261")
    let json = try XCTUnwrap(JSONSerialization.jsonObject(with: encoder.encode(song)) as? [String: Any])
    XCTAssertEqual(json["vendor"] as? String, "shazamkit")
    XCTAssertEqual(json["artist_name"] as? String, "Fleetwood Mac")
    XCTAssertEqual(json["title"] as? String, "Dreams")
    XCTAssertEqual(json["matched_at_ms"] as? Int, 4200)
    XCTAssertEqual(json["vendor_recording_id"] as? String, "shazam-40339261")
    // The vendor's words only: no confidence, no transcript, no audio field.
    XCTAssertEqual(Set(json.keys), ["vendor", "artist_name", "title", "matched_at_ms", "vendor_recording_id"])
    let back = try decoder.decode(ClientRecognizedSong.self, from: encoder.encode(song))
    XCTAssertEqual(back, song)
  }

  func testRequestCarriesTheHintOnlyWhenThereIsOne() throws {
    let plain = AnalyzeAudioRequest.musicMatch(expectedGeneration: 3, startMS: 0, endMS: 15_000)
    let plainJSON = try XCTUnwrap(JSONSerialization.jsonObject(with: encoder.encode(plain)) as? [String: Any])
    XCTAssertNil(plainJSON["client_recognition"])
    XCTAssertEqual(plainJSON["contract_version"] as? Int, 2)

    let hinted = AnalyzeAudioRequest.musicMatch(
      expectedGeneration: 3, startMS: 0, endMS: 15_000,
      clientRecognition: ClientRecognizedSong(artistName: "Nina Simone"))
    let hintedJSON = try XCTUnwrap(JSONSerialization.jsonObject(with: encoder.encode(hinted)) as? [String: Any])
    let recognition = try XCTUnwrap(hintedJSON["client_recognition"] as? [String: Any])
    XCTAssertEqual(recognition["artist_name"] as? String, "Nina Simone")
    XCTAssertEqual(recognition["vendor"] as? String, "shazamkit")
  }

  func testUnavailableBuildAnswersNoHint() async {
    // In a build without the ShazamKit xcframework the factory is honest:
    // recognition simply never claims a song.
    let recognizer = SongRecognizerFactory.make()
    let song = await recognizer.recognize(fileURL: URL(fileURLWithPath: "/dev/null"))
    if !SongRecognizerFactory.isShazamKitAvailable {
      XCTAssertNil(song)
    }
  }
}
