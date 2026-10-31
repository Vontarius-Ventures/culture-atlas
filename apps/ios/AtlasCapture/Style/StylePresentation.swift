import Foundation

/// Shared user-facing copy for the style reading and experimental label
/// (design D.4, `design/copy.json` → `experimental` / `style`). Verbatim on
/// every platform; keep in sync with web and Android.
public enum StyleCopy {
  public static let experimentalBadge = "Experimental"
  public static let experimentalNote = "Photo and video readings can miss details. Qloo explores entity-level taste and catalogue connections, not verified visual matches."
  public static let railCaption = "From an experimental reading"
  public static let whyLine = "Suggested from an experimental reading of your photo."
  public static let paused = "Photo reading is paused right now. Your photo is saved, and we'll read it when it's back."
  public static let limit = "We've hit today's limit for experimental readings. Your photo is saved, and you can read it tomorrow."
  public static let failed = "We couldn't read the style of this one."
  public static let empty = "No clear style to read here."
  public static let noCity = "Add a city to explore places."
  public static let railEmpty = "No supported Qloo connection was found for this reading on this route."
  public static let reading = "Reading the style…"
  public static let railRunning = "Exploring Qloo connections…"
  public static let updated = "Style reading updated"
  public static let tryAgain = "Try again"
  public static let addCity = "Add city"
  public static let showDetails = "Show all details"
  public static let header = "Style reading"
  public static let moreLikeThisStyle = "Explore Qloo connections"

  /// `style.qloo_links`: "Qloo also links: {names}".
  public static func qlooLinks(_ names: [String]) -> String? {
    names.isEmpty ? nil : "Qloo also links: \(names.joined(separator: ", "))"
  }
}

/// Section and rail statuses. The server's enum has used both the design's
/// names (`ready`, `empty`, `held`) and the older ones (`complete`,
/// `skipped`, `unavailable`); both are understood. Unknown statuses are
/// terminal (R-16c), so polling always ends.
public enum StyleStatus {
  public static func isRunning(_ status: String?) -> Bool { status == "pending" || status == "running" }
  public static func isReady(_ status: String?) -> Bool { ["ready", "complete", "partial"].contains(status ?? "") }
  public static func isEmpty(_ status: String?) -> Bool { ["empty", "skipped"].contains(status ?? "") }
  public static func isFailed(_ status: String?) -> Bool { ["failed", "unavailable"].contains(status ?? "") }
}

/// What the style card shows.
public enum StyleCardState: Equatable, Sendable {
  /// No style section at all (an analysis from before the style stage): no card.
  case absent
  /// Skeleton with "Reading the style…".
  case reading
  case ready(StyleReading)
  case failed
  case empty
  /// Held: paused by the kill switch, or the experimental daily limit.
  case held(message: String)

  public var isTerminal: Bool {
    if case .reading = self { return false }
    return true
  }
}

/// One row of the details list (grouped Era & lineage, Materials,
/// Construction, Details), rendered from the server's display text.
public struct StyleDetailRow: Equatable, Sendable, Identifiable, Hashable {
  public var group: String
  public var claim: StyleClaim
  public var id: String { "\(group)|\(claim.id)" }
  /// Resembles rows use secondary text color (plus the word in `display`).
  public var isResemblance: Bool { !claim.isAsserted }
}

/// Everything the style card renders for one subject, with retracted claims
/// already removed. Built from the server payload only.
public struct StyleSubjectPresentation: Equatable, Sendable, Identifiable {
  public var subject: StyleSubject
  public var aesthetics: [StyleClaim]
  public var palette: [PaletteSwatch]
  public var rows: [StyleDetailRow]
  public var moodLine: String?
  public var qlooLine: String?
  public var id: String { subject.id }

  public struct PaletteSwatch: Equatable, Sendable, Identifiable, Hashable {
    public var entry: StylePaletteEntry
    public var share: Double?
    /// Circle diameter in points: proportional to share, 28…56.
    public var diameter: Double
    public var id: Int { entry.swatch }
  }

  /// First rows shown before "Show all details" (R-17).
  public static let collapsedRowCount = 3

  public func visibleRows(expanded: Bool) -> [StyleDetailRow] {
    expanded ? rows : Array(rows.prefix(Self.collapsedRowCount))
  }

  public var hasMoreRows: Bool { rows.count > Self.collapsedRowCount }
}

public enum StylePresentation {
  // MARK: Card state

  /// `waitingReason` comes from the media analysis (`ai_paused`,
  /// `daily_limit`) when known; it picks the held message.
  public static func cardState(_ capture: CaptureDetailResponse, waitingReason: String? = nil) -> StyleCardState {
    let status = capture.analysis?.sections["style"]
    if StyleStatus.isRunning(status) {
      // A reading republished during the corroboration pass stays on screen.
      if let reading = capture.styleReading, !reading.subjects.isEmpty { return .ready(reading) }
      return .reading
    }
    if status == "held" {
      return .held(message: waitingReason == "ai_paused" ? StyleCopy.paused : StyleCopy.limit)
    }
    if StyleStatus.isFailed(status) { return .failed }
    if StyleStatus.isEmpty(status) { return .empty }
    if let reading = capture.styleReading {
      return reading.subjects.isEmpty ? .empty : .ready(reading)
    }
    if StyleStatus.isReady(status) { return .empty }
    // No style section (old analysis) or an unknown status without a reading.
    if status == nil, capture.analysis == nil, isCaptureWorking(capture) { return .reading }
    return .absent
  }

  private static func isCaptureWorking(_ capture: CaptureDetailResponse) -> Bool {
    capture.status == "pending" || capture.status == "processing"
  }

  /// Keep polling `GET /v1/captures/{id}` (every 1.5 s) while anything is
  /// pending or running: a section, a rail, or the capture itself.
  public static func needsPolling(_ capture: CaptureDetailResponse) -> Bool {
    if capture.analysis == nil { return isCaptureWorking(capture) }
    if capture.analysis?.sections.values.contains(where: StyleStatus.isRunning) == true { return true }
    if capture.rails?.contains(where: { StyleStatus.isRunning($0.status) }) == true { return true }
    return false
  }

  // MARK: Subjects

  public static func subjects(_ reading: StyleReading) -> [StyleSubjectPresentation] {
    let retracted = Set(reading.retracted)
    return reading.subjects.map { subject in
      func path(_ slot: String, _ index: Int) -> String { "subjects[\(subject.sourceIndex)].\(slot)[\(index)]" }
      func keep(_ claims: [StyleClaim], _ slot: String) -> [StyleClaim] {
        claims.filter { !$0.retracted && !retracted.contains(path(slot, $0.slotIndex)) }
      }
      let aesthetics = keep(subject.aesthetics, "aesthetics")
      var rows: [StyleDetailRow] = []
      var eraLineage: [StyleClaim] = []
      if let era = subject.era, !era.retracted, !retracted.contains("subjects[\(subject.sourceIndex)].era") {
        eraLineage.append(era)
      }
      eraLineage += keep(subject.lineage, "lineage")
      rows += eraLineage.map { StyleDetailRow(group: "Era & lineage", claim: $0) }
      rows += keep(subject.materials, "materials").map { StyleDetailRow(group: "Materials", claim: $0) }
      rows += keep(subject.construction, "construction").map { StyleDetailRow(group: "Construction", claim: $0) }
      rows += keep(subject.details, "details").map { StyleDetailRow(group: "Details", claim: $0) }
      let moods = subject.mood.filter { !$0.retracted && !retracted.contains(path("mood", $0.slotIndex)) }
      let palette = subject.palette.map { entry -> StyleSubjectPresentation.PaletteSwatch in
        let share = reading.swatch(entry.swatch)?.share
        return .init(entry: entry, share: share, diameter: swatchDiameter(share: share))
      }
      return StyleSubjectPresentation(
        subject: subject, aesthetics: aesthetics, palette: palette, rows: rows,
        moodLine: moodLine(moods), qlooLine: StyleCopy.qlooLinks(subject.qlooLinks))
    }
  }

  /// "Feels rugged, utilitarian": the server's first display ("Feels rugged")
  /// carries the qualifier; the others add their names.
  public static func moodLine(_ moods: [StyleMood]) -> String? {
    guard let first = moods.first else { return nil }
    let rest = moods.dropFirst().map(\.name)
    return ([first.display] + rest).joined(separator: ", ")
  }

  /// 28 pt at no share, growing with share up to 56 pt (a quarter of the image or more).
  public static func swatchDiameter(share: Double?) -> Double {
    guard let share, share.isFinite else { return 28 }
    return min(56, max(28, 28 + share * 112))
  }

  /// All claim ids currently visible (to announce "Style reading updated"
  /// when one disappears after a retraction).
  public static func visibleClaimKeys(_ reading: StyleReading) -> Set<String> {
    var keys = Set<String>()
    for subject in subjects(reading) {
      for claim in subject.aesthetics { keys.insert("\(subject.id)|a|\(claim.id)") }
      for row in subject.rows { keys.insert("\(subject.id)|\(row.id)") }
    }
    return keys
  }

  // MARK: Rails

  public struct RailItem: Equatable, Sendable, Identifiable {
    public var rail: CaptureRail
    /// "From an experimental reading" above this rail.
    public var caption: String?
    public var id: String { rail.id }

    public var isRunning: Bool { StyleStatus.isRunning(rail.status) }
    /// Cards to draw; a rail that is not running and has none shows `emptyText`.
    public var showsEmpty: Bool { !isRunning && rail.cards.isEmpty }
    public var emptyText: String { rail.emptyMessage ?? StyleCopy.railEmpty }
    /// The empty message asks for a city: offer "Add city".
    public var offersAddCity: Bool {
      showsEmpty && (rail.emptyMessage == StyleCopy.noCity || rail.emptyMessage == "Add a city to see places with this style.")
    }
  }

  /// Rails in server order. The experimental caption appears on the first
  /// More-like-this rail and once above the cross-domain group (R-17).
  /// Without `rails` (older analysis) the flat recommendations become one
  /// cross-domain rail.
  public static func rails(_ capture: CaptureDetailResponse) -> [RailItem] {
    let experimental = capture.analysis?.experimental != nil
    let rails: [CaptureRail]
    if let given = capture.rails {
      rails = given
    } else if !capture.recommendations.isEmpty {
      rails = [CaptureRail(
        key: "recommendations", kind: "cross_domain", title: "From this photo", status: "ready",
        cards: capture.recommendations)]
    } else {
      rails = []
    }
    var sawMoreLikeThis = false
    var sawCrossDomain = false
    return rails.map { rail in
      var caption: String?
      if experimental {
        if rail.isMoreLikeThis, !sawMoreLikeThis {
          caption = StyleCopy.railCaption
          sawMoreLikeThis = true
        } else if !rail.isMoreLikeThis, !sawCrossDomain {
          caption = StyleCopy.railCaption
          sawCrossDomain = true
        }
      }
      return RailItem(rail: rail, caption: caption)
    }
  }

  // MARK: Why this

  /// Attribute chips for "Why this?" (non-interactive) plus the experimental line.
  public static func whyThis(styleMatch: StyleMatch?, experimentalLine: String?) -> (attributes: [String], line: String?) {
    let attributes = styleMatch?.attributes ?? []
    let line = experimentalLine ?? (styleMatch?.experimental == true ? StyleCopy.whyLine : nil)
    return (attributes, line)
  }
}

extension StyleRegion {
  /// The region's rect inside a container that shows the image with
  /// aspect-fill (`scaledToFill`, clipped). `imageAspect` is width / height of
  /// the capture image; nil means the image exactly fills the container.
  public func rect(inAspectFill container: CGSize, imageAspect: Double?) -> CGRect {
    guard let aspect = imageAspect, aspect > 0, container.width > 0, container.height > 0 else {
      return rect(in: container)
    }
    let containerAspect = container.width / container.height
    var drawn = container
    if aspect > containerAspect {
      drawn = CGSize(width: container.height * aspect, height: container.height)
    } else {
      drawn = CGSize(width: container.width, height: container.width / aspect)
    }
    let origin = CGPoint(x: (container.width - drawn.width) / 2, y: (container.height - drawn.height) / 2)
    let inner = rect(in: drawn).offsetBy(dx: origin.x, dy: origin.y)
    return inner.intersection(CGRect(origin: .zero, size: container))
  }
}
