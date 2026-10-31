import XCTest
@testable import AtlasCapture

/// Style reading wire models (design E.2 / E.3), their lenient decoding, and
/// the presentation rules the views follow. Payloads mirror the design's
/// contract examples; older payloads without any style field must still decode.
final class StyleReadingTests: XCTestCase {
  private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try AtlasJSON.decoder().decode(type, from: Data(json.utf8))
  }

  static let card = """
    {"id":"6b1f0c2a-3d4e-4f50-9a61-7b8c9d0e1f41","kind":"brand","category":"wear","title":"Filson","subtitle":null,
     "image":null,"is_example":false,"saved":false,"saved_item_id":null,"recommendation_id":"6b1f0c2a-3d4e-4f50-9a61-7b8c9d0e1f61",
     "evidence_available":true,"reason":"Because of the workwear cut and duck canvas",
     "style_match":{"subject_id":"s1","attributes":["Workwear","duck canvas"],"palette":["tobacco brown"],"via":null,"experimental":true}}
    """

  /// The E.2 example, with every optional field present.
  static let readyCapture = """
    {"id":"6b1f0c2a-3d4e-4f50-9a61-7b8c9d0e1f23","source":"photo","status":"ready","received_at":"2026-10-23T10:00:00Z",
     "image":{"url":"/v1/captures/6b1f0c2a-3d4e-4f50-9a61-7b8c9d0e1f23/image","width":1024,"height":768,"alt":"A jacket"},
     "analysis":{"id":"6b1f0c2a-3d4e-4f50-9a61-7b8c9d0e1f30","version":1,"title":"Canvas work jacket","interpretation":"A jacket.",
       "sections":{"observations":"ready","references":"ready","style":"ready","wear":"ready","play":"running","watch":"pending","eat":"empty"},
       "question":null,"warnings":[],"created_at":"2026-10-23T10:00:05Z",
       "experimental":{"label":"Experimental","note":"Photo and video readings can miss details. Qloo explores entity-level taste and catalogue connections, not verified visual matches."}},
     "style_reading":{
       "version":"atlas_style_reading_v1",
       "summary":"A heavyweight canvas work jacket with a rugged, utilitarian look.",
       "swatches":[{"index":0,"hex":"#7B5A3A","share":0.31},{"index":3,"hex":"#2B2A28","share":0.18}],
       "subjects":[{
         "id":"s1","category":"fashion","label":"Canvas work jacket",
         "region":{"x":0.18,"y":0.10,"w":0.60,"h":0.78},
         "aesthetics":[
           {"name":"Workwear","wording":"asserted","display":"Workwear","strength":"clear",
            "region":{"x":0.2,"y":0.1,"w":0.5,"h":0.3},"features":["duck canvas shell","corduroy collar"]},
           {"name":"Americana","wording":"resembles","display":"Resembles Americana","strength":"possible","region":null,"features":[]}],
         "era":{"name":"1950s–1970s American","display":"Suggests the 1950s–1970s","wording":"resembles","strength":null},
         "lineage":[{"name":"American heritage workwear","display":"Resembles American heritage workwear","wording":"resembles"}],
         "materials":[{"name":"duck canvas","texture":"stiff, matte, slightly faded","wording":"asserted","display":"Duck canvas",
                       "region":{"x":0.3,"y":0.4,"w":0.2,"h":0.2}}],
         "construction":[{"name":"boxy, hip-length cut","kind":"silhouette","wording":"asserted","display":"Boxy, hip-length cut","region":null}],
         "palette":[{"swatch":0,"name":"tobacco brown","hex":"#7B5A3A","display":"tobacco brown"},
                    {"swatch":3,"name":"faded black","hex":"#2B2A28"}],
         "mood":[{"name":"rugged","display":"Feels rugged"},{"name":"utilitarian","display":"Feels utilitarian"}],
         "details":[{"text":"Metal snap closures at the cuffs","display":"Metal snap closures at the cuffs","wording":"asserted",
                     "region":{"x":0.6,"y":0.7,"w":0.1,"h":0.08}}],
         "brand":null,
         "qloo_links":["Filson","Patagonia","Pendleton"],
         "rail":"more_like_this:s1"}],
       "retracted":[]},
     "rails":[
       {"key":"more_like_this:s1","kind":"more_like_this","title":"More like this","subtitle":"Workwear · duck canvas",
        "subject_id":"s1","status":"ready","empty_message":null,"cards":[\(card)]},
       {"key":"wear","kind":"cross_domain","title":"Wear","subtitle":null,"subject_id":null,"status":"ready","empty_message":null,"cards":[]},
       {"key":"play","kind":"cross_domain","title":"Play","subtitle":null,"subject_id":null,"status":"running","empty_message":null,"cards":[]},
       {"key":"eat","kind":"cross_domain","title":"Eat","subtitle":null,"subject_id":null,"status":"empty",
        "empty_message":"Add a city to explore places.","cards":[]}],
     "references":[],"recommendations":[],"available_categories":["wear"],"job_id":null}
    """

  /// A capture analysed before the style stage existed.
  static let oldCapture = """
    {"id":"6b1f0c2a-3d4e-4f50-9a61-7b8c9d0e1f23","source":"upload","status":"ready","received_at":"2026-10-20T10:00:00Z",
     "captured_at":null,"image":{"url":"/x.jpg","width":null,"height":null,"alt":""},"focus":{"kind":"whole"},
     "is_example":false,"discovery_item_id":null,"saved":false,
     "analysis":{"id":"6b1f0c2a-3d4e-4f50-9a61-7b8c9d0e1f30","version":2,"title":"A room","interpretation":null,
       "sections":{"observations":"complete","references":"complete","wear":"complete","play":"skipped"},
       "question":null,"warnings":[],"created_at":"2026-10-20T10:00:05Z"},
     "references":[],
     "recommendations":[{"id":"6b1f0c2a-3d4e-4f50-9a61-7b8c9d0e1f42","kind":"brand","category":"wear","title":"Hay","subtitle":null,
       "image":null,"is_example":false,"saved":false,"saved_item_id":null,"recommendation_id":null,"evidence_available":false}],
     "available_categories":["wear"],"job_id":null}
    """

  // MARK: Decoding

  func testFullCaptureStyleReadingDecodes() throws {
    let capture = try decode(CaptureDetailResponse.self, Self.readyCapture)
    XCTAssertEqual(capture.analysis?.sections["style"], "ready")
    XCTAssertEqual(capture.analysis?.experimental?.label, "Experimental")
    let reading = try XCTUnwrap(capture.styleReading)
    XCTAssertEqual(reading.summary, "A heavyweight canvas work jacket with a rugged, utilitarian look.")
    XCTAssertEqual(reading.swatches.map(\.hex), ["#7B5A3A", "#2B2A28"])
    let subject = try XCTUnwrap(reading.subjects.first)
    XCTAssertEqual(subject.label, "Canvas work jacket")
    XCTAssertEqual(subject.aesthetics.map(\.display), ["Workwear", "Resembles Americana"])
    XCTAssertTrue(subject.aesthetics[0].isAsserted)
    XCTAssertFalse(subject.aesthetics[1].isAsserted)
    XCTAssertEqual(subject.aesthetics[0].features, ["duck canvas shell", "corduroy collar"])
    XCTAssertEqual(subject.aesthetics[0].strengthLabel, "clear")
    XCTAssertEqual(subject.era?.display, "Suggests the 1950s–1970s")
    XCTAssertEqual(subject.materials.first?.texture, "stiff, matte, slightly faded")
    // A palette entry without display reads its (measured, asserted) name.
    XCTAssertEqual(subject.palette.map(\.display), ["tobacco brown", "faded black"])
    XCTAssertEqual(subject.mood.map(\.display), ["Feels rugged", "Feels utilitarian"])
    XCTAssertEqual(subject.details.first?.display, "Metal snap closures at the cuffs")
    XCTAssertEqual(subject.qlooLinks, ["Filson", "Patagonia", "Pendleton"])
    XCTAssertEqual(subject.rail, "more_like_this:s1")

    let rails = try XCTUnwrap(capture.rails)
    XCTAssertEqual(rails.map(\.key), ["more_like_this:s1", "wear", "play", "eat"])
    let card = try XCTUnwrap(rails[0].cards.first)
    XCTAssertEqual(card.reason, "Because of the workwear cut and duck canvas")
    XCTAssertEqual(card.styleMatch?.attributes, ["Workwear", "duck canvas"])
    XCTAssertEqual(card.styleMatch?.palette, ["tobacco brown"])
    XCTAssertEqual(card.styleMatch?.experimental, true)
    XCTAssertEqual(capture.imageAspectForTest, 1024.0 / 768.0, accuracy: 0.0001)
  }

  func testOlderCaptureWithoutStyleStillDecodesAndRenders() throws {
    let capture = try decode(CaptureDetailResponse.self, Self.oldCapture)
    XCTAssertNil(capture.styleReading)
    XCTAssertNil(capture.rails)
    XCTAssertNil(capture.analysis?.experimental)
    XCTAssertEqual(capture.recommendations.map(\.title), ["Hay"])
    XCTAssertNil(capture.recommendations[0].reason)
    XCTAssertNil(capture.recommendations[0].styleMatch)
    // No style section: no card at all.
    XCTAssertEqual(StylePresentation.cardState(capture), .absent)
    // Flat recommendations become one rail; no experimental caption.
    let rails = StylePresentation.rails(capture)
    XCTAssertEqual(rails.map(\.rail.title), ["From this photo"])
    XCTAssertNil(rails[0].caption)
    XCTAssertFalse(StylePresentation.needsPolling(capture))
  }

  func testUncertainClaimWithoutServerWordingIsDroppedNotShownBare() throws {
    let subject = try decode(StyleSubject.self, """
      {"id":"s1","category":"interior","label":"Lounge chair",
       "aesthetics":[{"name":"Mid-century modern","wording":"resembles"},
                     {"name":"Japandi","wording":"asserted"},
                     {"display":"Resembles Scandinavian","wording":"resembles"},
                     "not an object", {"name":"","display":""}],
       "materials":[{"name":"teak","wording":"resembles","display":"Looks like teak","region":{"x":-0.2,"y":0.5,"w":0.5,"h":0.9}}],
       "palette":[{"swatch":1,"name":"oat","hex":"oat"},{"swatch":2,"name":"charcoal","hex":"#333333"}],
       "mood":[{"name":"airy"}],
       "qloo_links":["", "  Hay "]}
      """)
    // "Resembles" can never be lost: no display + not asserted → dropped.
    XCTAssertEqual(subject.aesthetics.map(\.display), ["Japandi", "Resembles Scandinavian"])
    // Indices in the wire array are kept for retraction paths.
    XCTAssertEqual(subject.aesthetics.map(\.slotIndex), [1, 2])
    // Regions are clamped to the photo.
    let region = try XCTUnwrap(subject.materials.first?.region)
    XCTAssertEqual(region.x, 0, accuracy: 0.0001)
    XCTAssertEqual(region.w, 0.3, accuracy: 0.0001)
    XCTAssertEqual(region.y + region.h, 1, accuracy: 0.0001)
    // Only real #RRGGBB swatches.
    XCTAssertEqual(subject.palette.map(\.name), ["charcoal"])
    // Mood without its "Feels …" display is not shown.
    XCTAssertTrue(subject.mood.isEmpty)
    XCTAssertEqual(subject.qlooLinks, ["Hay"])
  }

  func testOneBadCardOrRailNeverHidesTheRest() throws {
    let capture = try decode(CaptureDetailResponse.self, """
      {"id":"6b1f0c2a-3d4e-4f50-9a61-7b8c9d0e1f23","status":"ready",
       "analysis":{"id":"6b1f0c2a-3d4e-4f50-9a61-7b8c9d0e1f30","version":1,"sections":{"style":"ready"}},
       "style_reading":{"summary":"x","subjects":[{"id":"s1"},{"id":"s2","label":"Ramen bowl","category":"food"}]},
       "rails":[{"title":"no key"},
                {"key":"more_like_this:s2","kind":"more_like_this","title":"More like this","status":"ready",
                 "cards":[{"id":"nope"}, \(Self.card),
                          {"id":"6b1f0c2a-3d4e-4f50-9a61-7b8c9d0e1f49","kind":"place","category":"somewhere-new","title":"X",
                           "subtitle":null,"image":null,"is_example":false,"saved":false,"saved_item_id":null,
                           "recommendation_id":null,"evidence_available":false}]}],
       "recommendations":"not an array"}
      """)
    XCTAssertEqual(capture.styleReading?.subjects.map(\.id), ["s2"])
    XCTAssertEqual(capture.styleReading?.subjects.first?.sourceIndex, 1)
    XCTAssertEqual(capture.rails?.map(\.key), ["more_like_this:s2"])
    XCTAssertEqual(capture.rails?.first?.cards.map(\.title), ["Filson"])
    XCTAssertTrue(capture.recommendations.isEmpty)
  }

  func testMediaAnalysisCarriesStylePreviewAndExperimentalLabel() throws {
    let response = try decode(AnalysisResultResponse.self, """
      {"analysis_id":"6b1f0c2a-3d4e-4f50-9a61-7b8c9d0e1f21","state":"complete","capture_id":"6b1f0c2a-3d4e-4f50-9a61-7b8c9d0e1f23",
       "result_url":"/captures/6b1f0c2a-3d4e-4f50-9a61-7b8c9d0e1f23",
       "experimental":{"label":"Experimental","note":"Photo and video readings can miss details. Qloo explores entity-level taste and catalogue connections, not verified visual matches."},
       "result":{"mode":"photo","note":null,"frames":1,
         "candidates":[{"name":"Canvas jacket","type":"object","relation":"depicted","cited_frames":[0]}],
         "reading":"quick",
         "style":{"status":"ready","summary":"A canvas work jacket.",
           "aesthetics":[{"subject_id":"s1","display":"Workwear","wording":"asserted"},
                         {"subject_id":"s1","display":"Resembles Americana","wording":"resembles"},
                         {"subject_id":"s1","wording":"resembles"}],
           "swatches":["#7B5A3A","#2B2A28","bad"],"frame_index":null}}}
      """)
    XCTAssertEqual(response.experimental?.note, StyleCopy.experimentalNote)
    let style = try XCTUnwrap(response.result?.style)
    XCTAssertEqual(style.aesthetics.map(\.display), ["Workwear", "Resembles Americana"])
    XCTAssertEqual(style.swatches, ["#7B5A3A", "#2B2A28"])
    XCTAssertEqual(response.result?.candidates.count, 1)

    let older = try decode(AnalysisResultResponse.self, """
      {"analysis_id":"6b1f0c2a-3d4e-4f50-9a61-7b8c9d0e1f21","state":"complete","result":{"candidates":[]}}
      """)
    XCTAssertNil(older.experimental)
    XCTAssertNil(older.result?.style)
  }

  func testExperimentalLabelNeverLosesItsWords() throws {
    let label = try decode(ExperimentalLabel.self, #"{"label":"","note":null}"#)
    XCTAssertEqual(label.label, "Experimental")
    XCTAssertEqual(label.note, StyleCopy.experimentalNote)
  }

  // MARK: Capabilities (production experimental mode)

  func testCapabilitiesExposeExperimentalProductionLabel() throws {
    let caps = try decode(Capabilities.self, """
      {"contract_version":"2","flags":{},"limits":{},
       "availability":{"analysis":{"available":true,"experimental":true,"label":"Experimental",
         "note":"Photo and video readings can miss details. Qloo explores entity-level taste and catalogue connections, not verified visual matches.","reason":"experimental_production"}}}
      """)
    let gate = CapabilityGate.photoAnalysis(caps)
    XCTAssertTrue(gate.available)
    XCTAssertTrue(gate.experimental)
    XCTAssertEqual(gate.label, "Experimental")
    XCTAssertEqual(gate.note, StyleCopy.experimentalNote)
    XCTAssertEqual(caps.availability["analysis"]?.reasons, [])

    let paused = try decode(Capabilities.self, """
      {"contract_version":"2","flags":{},"limits":{},
       "availability":{"analysis":{"available":false,"reasons":[],"reason":"paused","experimental":true}}}
      """)
    let pausedGate = CapabilityGate.photoAnalysis(paused)
    XCTAssertFalse(pausedGate.available)
    XCTAssertEqual(pausedGate.message, StyleCopy.paused)
    // Label falls back to the shared copy when the server omits it.
    XCTAssertEqual(pausedGate.label, "Experimental")

    let qualified = try decode(Capabilities.self, """
      {"contract_version":"2","flags":{},"limits":{},"availability":{"analysis":{"available":true,"reasons":[]}}}
      """)
    XCTAssertFalse(CapabilityGate.photoAnalysis(qualified).experimental)
    XCTAssertNil(CapabilityGate.photoAnalysis(qualified).label)
  }

  // MARK: Presentation

  private func capture(style: String?, reading: StyleReading? = nil, rails: [CaptureRail]? = nil,
                       experimental: Bool = true, status: String = "ready") -> CaptureDetailResponse {
    var sections: [String: String] = ["observations": "ready"]
    if let style { sections["style"] = style }
    return CaptureDetailResponse(
      id: UUID(), status: status,
      analysis: CaptureAnalysisSummary(id: UUID(), sections: sections, experimental: experimental ? ExperimentalLabel() : nil),
      styleReading: reading, rails: rails)
  }

  private var sampleReading: StyleReading {
    StyleReading(summary: "s", subjects: [StyleSubject(
      id: "s1", category: "fashion", label: "Jacket",
      aesthetics: [StyleClaim(name: "Workwear", display: "Workwear", wording: "asserted")])])
  }

  func testCardStateFollowsSectionStatus() {
    XCTAssertEqual(StylePresentation.cardState(capture(style: "pending")), .reading)
    XCTAssertEqual(StylePresentation.cardState(capture(style: "running")), .reading)
    XCTAssertEqual(StylePresentation.cardState(capture(style: "failed")), .failed)
    XCTAssertEqual(StylePresentation.cardState(capture(style: "empty")), .empty)
    XCTAssertEqual(StylePresentation.cardState(capture(style: "held")), .held(message: StyleCopy.limit))
    XCTAssertEqual(
      StylePresentation.cardState(capture(style: "held"), waitingReason: "ai_paused"), .held(message: StyleCopy.paused))
    XCTAssertEqual(StylePresentation.cardState(capture(style: "ready", reading: sampleReading)), .ready(sampleReading))
    // The older enum names mean the same thing.
    XCTAssertEqual(StylePresentation.cardState(capture(style: "complete", reading: sampleReading)), .ready(sampleReading))
    XCTAssertEqual(StylePresentation.cardState(capture(style: "skipped")), .empty)
    // A reading republished during corroboration stays on screen while running.
    XCTAssertEqual(StylePresentation.cardState(capture(style: "running", reading: sampleReading)), .ready(sampleReading))
    // Ready without any subject is the honest empty state.
    XCTAssertEqual(
      StylePresentation.cardState(capture(style: "ready", reading: StyleReading(summary: nil, subjects: []))), .empty)
    // Unknown statuses are terminal: nothing to show, nothing to wait for.
    XCTAssertEqual(StylePresentation.cardState(capture(style: "mystery")), .absent)
  }

  func testPollingStopsOnlyWhenEverySectionAndRailIsTerminal() {
    XCTAssertTrue(StylePresentation.needsPolling(capture(style: "running")))
    let runningRail = CaptureRail(key: "wear", kind: "cross_domain", title: "Wear", status: "pending")
    XCTAssertTrue(StylePresentation.needsPolling(capture(style: "ready", reading: sampleReading, rails: [runningRail])))
    for terminal in ["ready", "empty", "failed", "held", "complete", "mystery"] {
      let rail = CaptureRail(key: "wear", kind: "cross_domain", title: "Wear", status: terminal)
      XCTAssertFalse(StylePresentation.needsPolling(capture(style: terminal, rails: [rail])), terminal)
    }
    // No analysis yet while the capture is still processing.
    XCTAssertTrue(StylePresentation.needsPolling(CaptureDetailResponse(id: UUID(), status: "processing")))
    XCTAssertFalse(StylePresentation.needsPolling(CaptureDetailResponse(id: UUID(), status: "failed")))
  }

  func testExperimentalCaptionOnFirstMoreLikeThisAndOnceAboveCrossDomain() throws {
    let capture = try decode(CaptureDetailResponse.self, Self.readyCapture)
    let rails = StylePresentation.rails(capture)
    XCTAssertEqual(rails.map(\.caption), [StyleCopy.railCaption, StyleCopy.railCaption, nil, nil])
    var qualified = capture
    qualified.analysis?.experimental = nil
    XCTAssertTrue(StylePresentation.rails(qualified).allSatisfy { $0.caption == nil })
  }

  func testRailEmptyRunningAndAddCityStates() throws {
    let rails = StylePresentation.rails(try decode(CaptureDetailResponse.self, Self.readyCapture))
    let wear = try XCTUnwrap(rails.first { $0.rail.key == "wear" })
    XCTAssertTrue(wear.showsEmpty)
    XCTAssertEqual(wear.emptyText, StyleCopy.railEmpty)
    XCTAssertFalse(wear.offersAddCity)
    let play = try XCTUnwrap(rails.first { $0.rail.key == "play" })
    XCTAssertTrue(play.isRunning)
    XCTAssertFalse(play.showsEmpty)
    let eat = try XCTUnwrap(rails.first { $0.rail.key == "eat" })
    XCTAssertEqual(eat.emptyText, StyleCopy.noCity)
    XCTAssertTrue(eat.offersAddCity)
  }

  func testSubjectPresentationGroupsRowsAndWritesMoodLine() throws {
    let reading = try XCTUnwrap(try decode(CaptureDetailResponse.self, Self.readyCapture).styleReading)
    let subject = try XCTUnwrap(StylePresentation.subjects(reading).first)
    XCTAssertEqual(subject.rows.map(\.group), ["Era & lineage", "Era & lineage", "Materials", "Construction", "Details"])
    XCTAssertEqual(subject.rows.map(\.claim.display), [
      "Suggests the 1950s–1970s", "Resembles American heritage workwear", "Duck canvas", "Boxy, hip-length cut",
      "Metal snap closures at the cuffs",
    ])
    XCTAssertTrue(subject.rows[0].isResemblance)
    XCTAssertFalse(subject.rows[2].isResemblance)
    // First 3 rows, then "Show all details".
    XCTAssertEqual(subject.visibleRows(expanded: false).count, 3)
    XCTAssertEqual(subject.visibleRows(expanded: true).count, 5)
    XCTAssertTrue(subject.hasMoreRows)
    XCTAssertEqual(subject.moodLine, "Feels rugged, utilitarian")
    XCTAssertEqual(subject.qlooLine, "Qloo also links: Filson, Patagonia, Pendleton")
    XCTAssertEqual(subject.palette.map(\.diameter), [56, 48.16].map { min(56, $0) }, accuracy: 0.01)
    XCTAssertEqual(StylePresentation.swatchDiameter(share: nil), 28)
    XCTAssertEqual(StylePresentation.swatchDiameter(share: 0), 28)
    XCTAssertEqual(StylePresentation.swatchDiameter(share: 0.9), 56)
    XCTAssertNil(StylePresentation.moodLine([]))
    XCTAssertNil(StyleCopy.qlooLinks([]))
  }

  func testRetractedClaimsAreRemoved() throws {
    var reading = try XCTUnwrap(try decode(CaptureDetailResponse.self, Self.readyCapture).styleReading)
    let before = StylePresentation.visibleClaimKeys(reading)
    reading.retracted = ["subjects[0].aesthetics[1]", "subjects[0].era", "subjects[0].mood[0]"]
    let subject = try XCTUnwrap(StylePresentation.subjects(reading).first)
    XCTAssertEqual(subject.aesthetics.map(\.display), ["Workwear"])
    XCTAssertFalse(subject.rows.contains { $0.claim.display == "Suggests the 1950s–1970s" })
    XCTAssertEqual(subject.moodLine, "Feels utilitarian")
    XCTAssertTrue(before.isStrictSuperset(of: StylePresentation.visibleClaimKeys(reading)))

    // The per-claim flag works too.
    var flagged = try XCTUnwrap(try decode(CaptureDetailResponse.self, Self.readyCapture).styleReading)
    flagged.subjects[0].materials[0].retracted = true
    XCTAssertFalse(StylePresentation.subjects(flagged)[0].rows.contains { $0.group == "Materials" })
  }

  func testRegionGeometryAndSpokenPosition() {
    let region = StyleRegion(x: 0.1, y: 0.05, w: 0.2, h: 0.2)
    XCTAssertEqual(region.spokenPosition, "upper left of the photo")
    XCTAssertEqual(StyleRegion(x: 0.4, y: 0.4, w: 0.2, h: 0.2).spokenPosition, "center of the photo")
    XCTAssertEqual(StyleRegion(x: 0.7, y: 0.75, w: 0.2, h: 0.2).spokenPosition, "lower right of the photo")
    XCTAssertNil(StyleRegion(x: 1.2, y: 0, w: 0.3, h: 0.3).clamped)
    // Exact fit.
    let exact = region.rect(in: CGSize(width: 100, height: 200))
    XCTAssertEqual(exact.minX, 10, accuracy: 0.001)
    XCTAssertEqual(exact.minY, 10, accuracy: 0.001)
    XCTAssertEqual(exact.width, 20, accuracy: 0.001)
    XCTAssertEqual(exact.height, 40, accuracy: 0.001)
    // Aspect-fill: a 4:3 photo in a 4:5 frame is cropped left and right.
    let fill = StyleRegion(x: 0.5, y: 0, w: 0.5, h: 1).rect(inAspectFill: CGSize(width: 400, height: 500), imageAspect: 4.0 / 3.0)
    // Drawn width 666.67, offset -133.33; the region starts at the drawn middle (200) and is clipped at 400.
    XCTAssertEqual(fill.minX, 200, accuracy: 0.01)
    XCTAssertEqual(fill.maxX, 400, accuracy: 0.01)
    XCTAssertEqual(fill.height, 500, accuracy: 0.01)
  }

  // MARK: Why this, references

  func testWhyThisShowsAttributesAndExperimentalLine() throws {
    let detail = try decode(ItemDetailResponse.self, """
      {"item":\(Self.card),"description":null,"detail":null,"reason":"Because of the workwear cut and duck canvas",
       "why_this":null,"destination_url":null,"references":[],"related":[],"related_state":"none","related_job_id":null,
       "collection_ids":[],"capture_id":null,
       "style_match":{"subject_id":"s1","attributes":["Workwear","duck canvas"],"palette":[],"via":null,"experimental":true},
       "experimental_line":"Suggested from an experimental reading of your photo."}
      """)
    let why = StylePresentation.whyThis(styleMatch: detail.styleMatch, experimentalLine: detail.experimentalLine)
    XCTAssertEqual(why.attributes, ["Workwear", "duck canvas"])
    XCTAssertEqual(why.line, StyleCopy.whyLine)
    // An experimental match without the line still carries the label.
    XCTAssertEqual(StylePresentation.whyThis(styleMatch: StyleMatch(experimental: true), experimentalLine: nil).line, StyleCopy.whyLine)
    XCTAssertNil(StylePresentation.whyThis(styleMatch: nil, experimentalLine: nil).line)
  }

  /// Bug fix (design F.3): a qualified (uncertain) reference reads
  /// "Resembles …", the same as web and Android; a confirmed one is bare.
  func testQualifiedReferenceIsPhrasedAsResemblance() throws {
    let refs = try decode([ItemReference].self, """
      [{"id":"6b1f0c2a-3d4e-4f50-9a61-7b8c9d0e1f71","name":"Bauhaus","type":"style","relation":"resembles","qualified":true,"has_page":false},
       {"id":"6b1f0c2a-3d4e-4f50-9a61-7b8c9d0e1f72","name":"Eames lounge chair","type":"work","relation":"depicted","qualified":false,"has_page":true}]
      """)
    XCTAssertEqual(refs.map(\.displayName), ["Resembles Bauhaus", "Eames lounge chair"])
  }

  func testCopyIsTheSharedContractText() {
    XCTAssertEqual(StyleCopy.experimentalBadge, "Experimental")
    XCTAssertEqual(StyleCopy.railCaption, "From an experimental reading")
    XCTAssertEqual(StyleCopy.failed, "We couldn't read the style of this one.")
    XCTAssertEqual(StyleCopy.noCity, "Add a city to explore places.")
    XCTAssertEqual(StyleCopy.railEmpty, "No supported Qloo connection was found for this reading on this route.")
    // Lowercase product name and no model talk anywhere in the copy.
    for copy in [StyleCopy.experimentalNote, StyleCopy.paused, StyleCopy.limit, StyleCopy.whyLine] {
      XCTAssertFalse(copy.lowercased().contains("model"))
      XCTAssertFalse(copy.contains("Culture Atlas"))
    }
  }

  func testCityRequestEncodesNullToClear() throws {
    let set = String(data: try AtlasJSON.encoder().encode(CityRequest(city: "Los Angeles, CA")), encoding: .utf8)
    XCTAssertEqual(set, #"{"city":"Los Angeles, CA"}"#)
    let clear = String(data: try AtlasJSON.encoder().encode(CityRequest(city: nil)), encoding: .utf8)
    XCTAssertEqual(clear, #"{"city":null}"#)
  }
}

private extension CaptureDetailResponse {
  var imageAspectForTest: Double {
    guard let w = image?.width, let h = image?.height else { return 0 }
    return Double(w) / Double(h)
  }
}

private func XCTAssertEqual(_ a: [Double], _ b: [Double], accuracy: Double, file: StaticString = #filePath, line: UInt = #line) {
  XCTAssertEqual(a.count, b.count, file: file, line: line)
  for (x, y) in zip(a, b) { XCTAssertEqual(x, y, accuracy: accuracy, file: file, line: line) }
}
