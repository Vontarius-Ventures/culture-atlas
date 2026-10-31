#if DEBUG
import AtlasCapture
import SwiftUI
import UIKit

/// Debug-only preview of the style reading with fixture data, for screenshots
/// and hands-on review without a server. Launch with `-AtlasStyleFixture`
/// (optionally `SIMCTL_CHILD_ATLAS_STYLE_FIXTURE_IMAGE=/path/to/photo.jpg`).
/// It replays a capture going from "reading" to "ready", exactly as the
/// poller would see it. Never compiled into release builds.
enum StyleFixture {
  static var isRequested: Bool { ProcessInfo.processInfo.arguments.contains("-AtlasStyleFixture") }

  static let captureID = UUID(uuidString: "6b1f0c2a-3d4e-4f50-9a61-7b8c9d0e1f23")!

  static func capture(stage: Int) -> CaptureDetailResponse {
    let json = stage == 0 ? runningJSON : readyJSON
    // Fixture text is fixed at compile time; a decode failure is a programming error.
    return try! AtlasJSON.decoder().decode(CaptureDetailResponse.self, from: Data(json.utf8))
  }

  static let runningJSON = """
    {"id":"6b1f0c2a-3d4e-4f50-9a61-7b8c9d0e1f23","source":"upload","status":"processing",
     "image":{"url":"/fixture/outfit.jpg","width":1000,"height":1250,"alt":"Cream zip jacket on a chair"},
     "analysis":{"id":"6b1f0c2a-3d4e-4f50-9a61-7b8c9d0e1f30","version":1,"title":"Cream zip jacket",
       "interpretation":null,"sections":{"observations":"ready","references":"ready","style":"running","wear":"pending"},
       "experimental":{"label":"Experimental","note":"Readings can miss details."}},
     "style_reading":null,
     "rails":[{"key":"more_like_this:s1","kind":"more_like_this","title":"Qloo connections","subtitle":null,
       "subject_id":"s1","status":"running","empty_message":null,"cards":[]}],
     "recommendations":[],"job_id":null}
    """

  static let readyJSON = """
    {"id":"6b1f0c2a-3d4e-4f50-9a61-7b8c9d0e1f23","source":"upload","status":"ready",
     "image":{"url":"/fixture/outfit.jpg","width":1000,"height":1250,"alt":"Cream zip jacket on a chair"},
     "analysis":{"id":"6b1f0c2a-3d4e-4f50-9a61-7b8c9d0e1f30","version":1,"title":"Cream zip jacket",
       "interpretation":null,"sections":{"observations":"ready","references":"ready","style":"ready","wear":"ready","eat":"empty"},
       "experimental":{"label":"Experimental","note":"Readings can miss details."}},
     "style_reading":{
       "version":"atlas_style_reading_v1",
       "summary":"A cream zip jacket with red and slate racing stripes and a round target badge.",
       "swatches":[{"index":0,"hex":"#E3D2AE","share":0.34},{"index":1,"hex":"#B9543F","share":0.09},
                   {"index":2,"hex":"#545B6A","share":0.06},{"index":3,"hex":"#5E4B3A","share":0.38}],
       "subjects":[{
         "id":"s1","category":"fashion","label":"Zip track jacket",
         "region":{"x":0.21,"y":0.22,"w":0.58,"h":0.58},
         "aesthetics":[
           {"name":"Retro sportswear","wording":"asserted","display":"Retro sportswear","strength":"clear",
            "region":{"x":0.38,"y":0.24,"w":0.24,"h":0.55},"features":["contrast racing stripes","zip front"]},
           {"name":"Mod","wording":"resembles","display":"Resembles mod","strength":"likely",
            "region":{"x":0.60,"y":0.38,"w":0.09,"h":0.08},"features":["target roundel badge"]}],
         "era":{"name":"1960s British","display":"Suggests the 1960s","wording":"resembles"},
         "lineage":[{"name":"British mod revival","display":"Resembles British mod revival","wording":"resembles"}],
         "materials":[{"name":"brushed cotton twill","texture":"matte, soft","wording":"resembles","display":"Looks like brushed cotton twill","region":null}],
         "construction":[{"name":"boxy, hip-length cut","kind":"silhouette","wording":"asserted","display":"Boxy, hip-length cut","region":null},
                         {"name":"ribbed stand collar","kind":"cut","wording":"asserted","display":"Ribbed stand collar","region":{"x":0.43,"y":0.22,"w":0.14,"h":0.06}}],
         "palette":[{"swatch":0,"name":"cream","hex":"#E3D2AE","display":"cream"},
                    {"swatch":1,"name":"brick red","hex":"#B9543F","display":"brick red"},
                    {"swatch":2,"name":"slate","hex":"#545B6A","display":"slate"}],
         "mood":[{"name":"sporty","display":"Feels sporty"},{"name":"nostalgic","display":"Feels nostalgic"}],
         "details":[{"text":"Twin red and slate stripes down the front","display":"Twin red and slate stripes down the front","wording":"asserted",
                     "region":{"x":0.38,"y":0.24,"w":0.24,"h":0.55}},
                    {"text":"Round target badge on the chest","display":"Round target badge on the chest","wording":"asserted",
                     "region":{"x":0.60,"y":0.38,"w":0.09,"h":0.08}}],
         "brand":null,
         "qloo_links":[],
         "rail":"more_like_this:s1"}],
       "retracted":[]},
     "rails":[
       {"key":"more_like_this:s1","kind":"more_like_this","title":"Brands to explore","subtitle":"Retro sportswear · mod",
        "subject_id":"s1","status":"ready","empty_message":null,"cards":[
          {"id":"6b1f0c2a-3d4e-4f50-9a61-7b8c9d0e1f41","kind":"brand","category":"wear","title":"Fixture brand one","subtitle":null,"image":null,
           "is_example":true,"saved":false,"saved_item_id":null,"recommendation_id":null,"evidence_available":true,
           "reason":"Because of the retro sportswear and boxy cut",
           "style_match":{"subject_id":"s1","attributes":["Retro sportswear","Boxy, hip-length cut"],"palette":[],"via":null,"experimental":true}},
          {"id":"6b1f0c2a-3d4e-4f50-9a61-7b8c9d0e1f42","kind":"brand","category":"wear","title":"Fixture brand two","subtitle":null,"image":null,
           "is_example":true,"saved":false,"saved_item_id":null,"recommendation_id":null,"evidence_available":true,
           "reason":"For the mod look your photo resembles",
           "style_match":{"subject_id":"s1","attributes":["Mod"],"palette":[],"via":null,"experimental":true}},
          {"id":"6b1f0c2a-3d4e-4f50-9a61-7b8c9d0e1f43","kind":"brand","category":"wear","title":"Fixture brand three","subtitle":null,"image":null,
           "is_example":true,"saved":false,"saved_item_id":null,"recommendation_id":null,"evidence_available":true,
           "reason":"Because of the retro sportswear and the cream and brick red palette",
           "style_match":{"subject_id":"s1","attributes":["Retro sportswear"],"palette":["cream","brick red"],"via":null,"experimental":true}},
          {"id":"6b1f0c2a-3d4e-4f50-9a61-7b8c9d0e1f44","kind":"brand","category":"wear","title":"Fixture brand four","subtitle":null,"image":null,
           "is_example":true,"saved":false,"saved_item_id":null,"recommendation_id":null,"evidence_available":true,
           "reason":"Because of the ribbed stand collar and boxy cut",
           "style_match":{"subject_id":"s1","attributes":["Ribbed stand collar"],"palette":[],"via":null,"experimental":true}}]},
       {"key":"watch","kind":"cross_domain","title":"Watch","subtitle":null,"subject_id":null,"status":"ready","empty_message":null,"cards":[
          {"id":"6b1f0c2a-3d4e-4f50-9a61-7b8c9d0e1f51","kind":"movie","category":"watch","title":"Fixture film one","subtitle":null,"image":null,
           "is_example":true,"saved":false,"saved_item_id":null,"recommendation_id":null,"evidence_available":true,
           "reason":"Shares a taste with Fixture brand one, from your retro sportswear rail","style_match":null},
          {"id":"6b1f0c2a-3d4e-4f50-9a61-7b8c9d0e1f52","kind":"movie","category":"watch","title":"Fixture film two","subtitle":null,"image":null,
           "is_example":true,"saved":false,"saved_item_id":null,"recommendation_id":null,"evidence_available":true,
           "reason":null,"style_match":null}]},
       {"key":"eat","kind":"cross_domain","title":"Eat","subtitle":null,"subject_id":null,"status":"empty",
        "empty_message":"Add a city to explore places.","cards":[]}],
     "recommendations":[],"job_id":null}
    """
}

/// The analysis screen as it renders a style reading, fed by the fixture.
struct StyleFixtureScreen: View {
  @StateObject private var model: CaptureStyleViewModel
  @State private var highlight: StyleRegion?
  @State private var photo: UIImage?

  init() {
    let stage = Stage()
    _model = StateObject(wrappedValue: CaptureStyleViewModel(
      load: { await stage.next() },
      retry: {},
      pollInterval: 1.5))
  }

  /// First poll: reading; afterwards: ready.
  private actor Stage {
    var count = 0
    func next() -> CaptureDetailResponse {
      defer { count += 1 }
      return StyleFixture.capture(stage: min(count, 1))
    }
  }

  var body: some View {
    NavigationStack {
      ScrollViewReader { reader in
        ScrollView {
          VStack(alignment: .leading, spacing: 20) {
            Text("Fixture data (debug build)")
              .font(.caption2)
              .foregroundStyle(AtlasTheme.muted)
            Color.clear
              .aspectRatio(4 / 5, contentMode: .fit)
              .overlay {
                if let photo {
                  Image(uiImage: photo).resizable().scaledToFill()
                } else {
                  AtlasTheme.quiet
                }
              }
              .overlay {
                StyleRegionOverlay(region: highlight, imageAspect: model.imageAspect) { highlight = nil }
              }
              .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
              .shadow(color: .black.opacity(0.08), radius: 14, y: 6)
              .accessibilityIdentifier("fixture.photo")
            if let label = model.experimental {
              ExperimentalNotice(label: label)
            }
            CaptureStyleSection(
              model: model, highlight: $highlight, baseURL: URL(string: "https://example.invalid")!,
              scrollProxy: reader, setCity: { _ in })
          }
          .padding(20)
        }
      }
      .background(AtlasTheme.ivory.ignoresSafeArea())
      .navigationTitle("Your photo")
      .navigationBarTitleDisplayMode(.inline)
    }
    .tint(AtlasTheme.olive)
    .task {
      if let path = ProcessInfo.processInfo.environment["ATLAS_STYLE_FIXTURE_IMAGE"] {
        photo = UIImage(contentsOfFile: path)
      }
      if ProcessInfo.processInfo.arguments.contains("-AtlasStyleFixtureHighlight") {
        try? await Task.sleep(nanoseconds: 3_500_000_000)
        highlight = StyleRegion(x: 0.38, y: 0.24, w: 0.24, h: 0.55)
      }
    }
    .task { await model.run() }
  }
}
#endif
