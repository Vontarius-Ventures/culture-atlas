import XCTest
@testable import AtlasCapture

/// Server library listing, native analysis results, and cancellation handling.
final class LibraryResultTests: XCTestCase {
  private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try AtlasJSON.decoder().decode(type, from: Data(json.utf8))
  }

  func testLibraryPageDecodesServerMediaDetail() throws {
    let page = try decode(MediaLibraryPage.self, """
      {"items":[{"media":{"schema_version":1,"id":"6b1f0c2a-3d4e-4f50-9a61-7b8c9d0e1f20","kind":"photo",
      "source":"upload","status":"ready","analysis_status":"complete","created_at":"2026-10-23T22:57:01.123Z",
      "title":null,"width":1200,"height":900},"generation":1,"revision":1,
      "links":{"original":"/v2/media/6b1f0c2a-3d4e-4f50-9a61-7b8c9d0e1f20/content/original",
      "playback":"/v2/media/6b1f0c2a-3d4e-4f50-9a61-7b8c9d0e1f20/content/abc","poster":null,"analysis":null},
      "error_code":null,"frames":[]}],"next_cursor":"eyJ4IjoxfQ"}
      """)
    XCTAssertEqual(page.items.count, 1)
    XCTAssertEqual(page.nextCursor, "eyJ4IjoxfQ")
    let item = try XCTUnwrap(page.items.first)
    XCTAssertTrue(item.isReady)
    XCTAssertTrue(item.analyzed)
    XCTAssertFalse(item.analyzing)
    XCTAssertEqual(item.thumbnailPath, "/v2/media/6b1f0c2a-3d4e-4f50-9a61-7b8c9d0e1f20/content/abc")
  }

  func testPhotoResultKeepsOnlyServerCandidatesAndPhrasesResemblances() throws {
    let response = try decode(AnalysisResultResponse.self, """
      {"analysis_id":"6b1f0c2a-3d4e-4f50-9a61-7b8c9d0e1f21","job_id":"6b1f0c2a-3d4e-4f50-9a61-7b8c9d0e1f22",
      "state":"complete","reused":true,"result_url":"/captures/6b1f0c2a-3d4e-4f50-9a61-7b8c9d0e1f23",
      "capture_id":"6b1f0c2a-3d4e-4f50-9a61-7b8c9d0e1f23","waiting_reason":null,"error_code":null,
      "result":{"mode":"photo","note":null,"frames":[],"candidates":[
        {"name":"Bentwood chair","type":"object","relation":"depicted","cited_frames":[]},
        {"name":"Japandi","type":"style","relation":"resembles","cited_frames":[]}],"reading":"quick"}}
      """)
    XCTAssertTrue(response.finished)
    XCTAssertFalse(response.stillWorking)
    let result = try XCTUnwrap(response.result)
    XCTAssertEqual(result.candidates.map(\.name), ["Bentwood chair", "Japandi"])
    XCTAssertFalse(result.candidates[0].isResemblance)
    XCTAssertTrue(result.candidates[1].isResemblance)
    XCTAssertEqual(result.reading, "quick")
    XCTAssertTrue(result.seeds.isEmpty)
  }

  func testMusicResultReadsMatchStateAndSeeds() throws {
    let response = try decode(AnalysisResultResponse.self, """
      {"analysis_id":"6b1f0c2a-3d4e-4f50-9a61-7b8c9d0e1f21","job_id":null,"state":"complete","reused":true,
      "result_url":"/v2/media/x/analysis/y","error_code":null,
      "result":{"music":"identified","components":{"music_match":{"state":"succeeded","reason":null}},
      "qloo_seeds":[{"name":"Nina Simone","entity_id":"Q1","entity_type":"urn:entity:artist"}]}}
      """)
    let result = try XCTUnwrap(response.result)
    XCTAssertEqual(result.music, "identified")
    XCTAssertEqual(result.seeds.map(\.name), ["Nina Simone"])
    XCTAssertEqual(result.musicHeadline, "We found who this sounds like")
  }

  func testRunningAnalysisWithoutResultStillDecodes() throws {
    let response = try decode(AnalysisResultResponse.self, """
      {"analysis_id":"6b1f0c2a-3d4e-4f50-9a61-7b8c9d0e1f21","job_id":"6b1f0c2a-3d4e-4f50-9a61-7b8c9d0e1f22",
      "state":"running","reused":true,"result_url":null,"capture_id":null,"result":null}
      """)
    XCTAssertTrue(response.stillWorking)
    XCTAssertNil(response.result)
  }

  func testNoMatchNeverClaimsAMatch() {
    XCTAssertEqual(AnalysisResult(music: "no_reliable_match").musicHeadline, "No reliable match this time")
    XCTAssertNil(AnalysisResult().musicHeadline)
  }

  func testCancelledRequestsAreNotFailures() {
    XCTAssertTrue(AtlasClientError.isCancellation(CancellationError()))
    XCTAssertTrue(AtlasClientError.isCancellation(URLError(.cancelled)))
    XCTAssertTrue(AtlasClientError.isCancellation(AtlasClientError.transport("NSURLErrorDomain:-999")))
    XCTAssertFalse(AtlasClientError.isCancellation(AtlasClientError.transport("NSURLErrorDomain:-1009")))
    XCTAssertFalse(AtlasClientError.isCancellation(
      AtlasClientError.server(status: 500, code: "internal", message: "", retryable: true, retryAfter: nil)))
  }
}
