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

  /// Right after onboarding the first page is a few seed cards topped up with
  /// examples; the poll speeds up while the seed lands and real cards push
  /// the replaced examples out (no reload).
  func testSeedLandingPollsSoonerAndRetiresReplacedExamples() throws {
    func card(_ id: String, example: Bool) -> String {
      #"{"id":"\#(id)","kind":"film","category":"watch","title":"T","subtitle":null,"image":null,"is_example":\#(example),"saved":false,"saved_item_id":null,"recommendation_id":null,"evidence_available":false}"#
    }
    let real1 = "6b1f0c2a-3d4e-4f50-9a61-7b8c9d0e1f31", real2 = "6b1f0c2a-3d4e-4f50-9a61-7b8c9d0e1f32"
    let ex1 = "6b1f0c2a-3d4e-4f50-9a61-7b8c9d0e1f41", ex2 = "6b1f0c2a-3d4e-4f50-9a61-7b8c9d0e1f42"
    func page(_ cards: [String], expansion: String) throws -> DiscoveriesResponse {
      try decode(DiscoveriesResponse.self, """
        {"items":[\(cards.joined(separator: ","))],"next_cursor":null,"feed_id":"6b1f0c2a-3d4e-4f50-9a61-7b8c9d0e1f50",
        "feed_revision":1,"is_example_feed":false,"available_categories":["watch"]\(expansion)}
        """)
    }
    let first = try page([card(real1, example: false), card(ex1, example: true), card(ex2, example: true)],
                         expansion: #","expansion":{"state":"running","poll_after_ms":4000}"#)
    XCTAssertEqual(first.nextPollSeconds, 4)
    let later = try page([card(real2, example: false), card(real1, example: false), card(ex2, example: true)],
                         expansion: #","expansion":{"state":"idle","poll_after_ms":null}"#)
    XCTAssertEqual(later.nextPollSeconds, DiscoveriesResponse.pollSeconds)
    // On screen: real1 and both examples. real1/ex2 come back in the page; ex1 was replaced, so it leaves.
    XCTAssertEqual(later.keptOnScreen(first.items), [])
    // An examples-only page (older server, no expansion) keeps everything on screen.
    let examplesOnly = try page([card(ex2, example: true)], expansion: "")
    XCTAssertNil(examplesOnly.expansion)
    XCTAssertEqual(examplesOnly.keptOnScreen(first.items).map { $0.id.uuidString.lowercased() }, [real1, ex1])
  }

  /// Qualified references are resemblances (feature map: qualified vs "Resembles …").
  func testReferencePhraseMatchesWebAndAndroid() {
    func ref(qualified: Bool, relation: String?, readText: String? = nil) -> ItemReference {
      ItemReference(id: UUID(), name: "Bauhaus", type: "style", relation: relation, qualified: qualified,
                    hasPage: false, readText: readText)
    }
    XCTAssertEqual(ref(qualified: false, relation: "depicted").phrase, "Bauhaus")
    XCTAssertEqual(ref(qualified: false, relation: nil).phrase, "Bauhaus")
    XCTAssertEqual(ref(qualified: true, relation: "depicted").phrase, "Resembles Bauhaus")
    XCTAssertEqual(ref(qualified: true, relation: "resembles").phrase, "Resembles Bauhaus")
    XCTAssertEqual(ref(qualified: false, relation: "resembles").phrase, "Resembles Bauhaus")
    let read = ref(qualified: true, relation: "depicted", readText: "BAUHAUS")
    XCTAssertEqual(read.phrase, "Bauhaus")
    XCTAssertEqual(read.attribution, "Read in the photo: “BAUHAUS”")
    XCTAssertNil(ref(qualified: false, relation: "depicted").attribution)
  }

  /// The bridged `GET /v1/captures/{id}` example decodes with its references and Qloo cards.
  func testCaptureResultDecodesTheBridgedFixture() throws {
    let capture = try AtlasJSON.decoder().decode(
      CaptureResultResponse.self, from: Fixtures.message("capture_detail_response"))
    XCTAssertEqual(capture.references.map(\.phrase), ["Eames Lounge Chair", "Resembles Mid-century modern"])
    XCTAssertEqual(capture.recommendations.map(\.title), ["Nina Simone"])
    XCTAssertEqual(capture.analysis?.title, "A lounge chair by a window")
    XCTAssertNil(capture.jobID)
    XCTAssertTrue(capture.settled)
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
