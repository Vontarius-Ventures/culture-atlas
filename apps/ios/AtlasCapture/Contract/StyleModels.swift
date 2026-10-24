import Foundation

// Wire models for the style reading and style-driven rails
// (prp/2026-10-23-style-analysis/design.md, sections E.2 and E.3).
//
// Every field here is additive and optional on the wire: an analysis made
// before the style stage existed (no `style_reading`, no `rails`) must still
// decode and render. Decoding is lenient element by element, so one malformed
// claim or card never hides the rest of a reading. The phone never composes
// wording: every user-facing string about a claim comes from the server's
// `display`, and a claim that is not asserted and has no `display` is dropped
// rather than shown without its qualifier.

// MARK: - Lenient decoding helpers

private struct Lossy<T: Decodable>: Decodable {
  let value: T?
  init(from decoder: Decoder) throws { value = try? T(from: decoder) }
}

extension KeyedDecodingContainer {
  /// An array where elements that fail to decode are skipped; missing or
  /// mistyped arrays are empty.
  func lossyArray<T: Decodable>(_ type: T.Type, forKey key: Key) -> [T] {
    guard let raw = try? decodeIfPresent([Lossy<T>].self, forKey: key) else { return [] }
    return raw.compactMap(\.value)
  }

  /// Like `lossyArray`, keeping each survivor's index in the wire array (so
  /// server claim paths such as `subjects[0].aesthetics[1]` still match).
  func lossyIndexed<T: Decodable>(_ type: T.Type, forKey key: Key) -> [(Int, T)] {
    guard let raw = try? decodeIfPresent([Lossy<T>].self, forKey: key) else { return [] }
    return raw.enumerated().compactMap { index, item in item.value.map { (index, $0) } }
  }

  /// An optional value that is nil when missing, null or malformed.
  func lenient<T: Decodable>(_ type: T.Type, forKey key: Key) -> T? {
    (try? decodeIfPresent(T.self, forKey: key)) ?? nil
  }

  func trimmedString(forKey key: Key) -> String? {
    guard let value = lenient(String.self, forKey: key)?.trimmingCharacters(in: .whitespacesAndNewlines),
      !value.isEmpty
    else { return nil }
    return value
  }
}

// MARK: - Experimental label

/// `{ "label": "Experimental", "note": "…" }`, present when the reading came
/// from an unqualified (experimental) model role. Null when qualified.
public struct ExperimentalLabel: Codable, Sendable, Equatable, Hashable {
  public var label: String
  public var note: String

  public init(label: String = StyleCopy.experimentalBadge, note: String = StyleCopy.experimentalNote) {
    self.label = label
    self.note = note
  }

  enum CodingKeys: String, CodingKey { case label, note }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    // The label must never be lost: fall back to the shared copy (D.4).
    label = c.trimmedString(forKey: .label) ?? StyleCopy.experimentalBadge
    note = c.trimmedString(forKey: .note) ?? StyleCopy.experimentalNote
  }
}

// MARK: - Style reading

/// Normalized rectangle (0–1) on the displayed capture image.
public struct StyleRegion: Codable, Sendable, Equatable, Hashable {
  public var x: Double
  public var y: Double
  public var w: Double
  public var h: Double

  public init(x: Double, y: Double, w: Double, h: Double) {
    self.x = x
    self.y = y
    self.w = w
    self.h = h
  }

  /// Clamped to the unit square; nil when it has no area left.
  public var clamped: StyleRegion? {
    let x0 = min(1, max(0, x)), y0 = min(1, max(0, y))
    let x1 = min(1, max(0, x + w)), y1 = min(1, max(0, y + h))
    guard x1 - x0 > 0.001, y1 - y0 > 0.001 else { return nil }
    return StyleRegion(x: x0, y: y0, w: x1 - x0, h: y1 - y0)
  }

  /// The rect in a frame of `size` (same aspect as the capture image).
  public func rect(in size: CGSize) -> CGRect {
    let r = clamped ?? StyleRegion(x: 0, y: 0, w: 0, h: 0)
    return CGRect(x: r.x * size.width, y: r.y * size.height, width: r.w * size.width, height: r.h * size.height)
  }

  /// Spoken position for VoiceOver ("upper left of the photo").
  public var spokenPosition: String {
    let r = clamped ?? self
    let cx = r.x + r.w / 2, cy = r.y + r.h / 2
    let vertical = cy < 1.0 / 3 ? "upper" : (cy > 2.0 / 3 ? "lower" : "middle")
    let horizontal = cx < 1.0 / 3 ? "left" : (cx > 2.0 / 3 ? "right" : "center")
    if vertical == "middle" && horizontal == "center" { return "center of the photo" }
    if vertical == "middle" { return "middle \(horizontal) of the photo" }
    if horizontal == "center" { return "\(vertical) middle of the photo" }
    return "\(vertical) \(horizontal) of the photo"
  }
}

/// One claim of the reading (aesthetic, era, lineage, material, construction
/// or detail). `display` is the server's text, already worded
/// ("Workwear", "Resembles mid-century modern", "Suggests the 1950s–1970s").
public struct StyleClaim: Decodable, Sendable, Equatable, Hashable, Identifiable {
  public var name: String
  public var display: String
  /// "asserted" or "resembles"; anything else is treated as not asserted.
  public var wording: String?
  /// Coarse band ("clear" | "likely" | "possible"); exposed only to VoiceOver.
  public var strength: String?
  public var region: StyleRegion?
  public var features: [String]
  public var texture: String?
  public var kind: String?
  public var retracted: Bool
  /// Index in the server's array for this slot (for retraction paths).
  public var slotIndex: Int = 0
  /// Stable across a wording upgrade (resembles → asserted keeps the same row).
  public var id: String { name }

  public var isAsserted: Bool { wording == "asserted" }

  enum CodingKeys: String, CodingKey {
    case name, text, display, wording, strength, region, features, texture, kind, retracted
  }

  public init(
    name: String, display: String, wording: String?, strength: String? = nil, region: StyleRegion? = nil,
    features: [String] = [], texture: String? = nil, kind: String? = nil, retracted: Bool = false
  ) {
    self.name = name
    self.display = display
    self.wording = wording
    self.strength = strength
    self.region = region
    self.features = features
    self.texture = texture
    self.kind = kind
    self.retracted = retracted
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    let name = c.trimmedString(forKey: .name) ?? c.trimmedString(forKey: .text)
    let wording = c.trimmedString(forKey: .wording)
    // The server words every claim (R-16b). Without its display string only an
    // asserted claim may fall back to its plain name; anything uncertain is
    // dropped rather than shown without "Resembles".
    guard let display = c.trimmedString(forKey: .display) ?? (wording == "asserted" ? name : nil),
      let name = name ?? Optional(display)
    else {
      throw DecodingError.dataCorrupted(.init(codingPath: c.codingPath, debugDescription: "claim without display"))
    }
    self.name = name
    self.display = display
    self.wording = wording
    strength = c.trimmedString(forKey: .strength)
    region = c.lenient(StyleRegion.self, forKey: .region)?.clamped
    features = c.lossyArray(String.self, forKey: .features)
    texture = c.trimmedString(forKey: .texture)
    kind = c.trimmedString(forKey: .kind)
    retracted = c.lenient(Bool.self, forKey: .retracted) ?? false
  }

  /// VoiceOver wording for the certainty band. Never a number.
  public var strengthLabel: String? {
    switch strength {
    case "clear": return "clear"
    case "likely": return "likely"
    case "possible": return "possible"
    default: return nil
    }
  }
}

/// Measured swatch (real pixels, A.4).
public struct StyleSwatch: Codable, Sendable, Equatable, Hashable {
  public var index: Int
  public var hex: String
  public var share: Double
}

/// A subject's palette entry: a measured swatch, named by the reading.
public struct StylePaletteEntry: Decodable, Sendable, Equatable, Hashable, Identifiable {
  public var swatch: Int
  public var name: String
  public var hex: String
  public var display: String
  public var id: Int { swatch }

  enum CodingKeys: String, CodingKey { case swatch, name, hex, display }

  public init(swatch: Int, name: String, hex: String, display: String? = nil) {
    self.swatch = swatch
    self.name = name
    self.hex = hex
    self.display = display ?? name
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    swatch = try c.decode(Int.self, forKey: .swatch)
    // Colors are measured, so they are always asserted: the name is the display.
    guard let name = c.trimmedString(forKey: .name) ?? c.trimmedString(forKey: .display),
      let hex = c.trimmedString(forKey: .hex), StyleColor.rgb(hex) != nil
    else {
      throw DecodingError.dataCorrupted(.init(codingPath: c.codingPath, debugDescription: "palette entry"))
    }
    self.name = name
    self.hex = hex
    display = c.trimmedString(forKey: .display) ?? name
  }
}

/// Mood is never asserted; the server's display reads "Feels rugged".
public struct StyleMood: Decodable, Sendable, Equatable, Hashable, Identifiable {
  public var name: String
  public var display: String
  public var retracted: Bool
  public var slotIndex: Int = 0
  public var id: String { name }

  enum CodingKeys: String, CodingKey { case name, display, retracted }

  public init(name: String, display: String) {
    self.name = name
    self.display = display
    retracted = false
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    guard let display = c.trimmedString(forKey: .display) else {
      throw DecodingError.dataCorrupted(.init(codingPath: c.codingPath, debugDescription: "mood without display"))
    }
    self.display = display
    name = c.trimmedString(forKey: .name) ?? display
    retracted = c.lenient(Bool.self, forKey: .retracted) ?? false
  }
}

/// Brand only ever appears with the text read from the photo.
public struct StyleBrand: Codable, Sendable, Equatable, Hashable {
  public var name: String
  public var readText: String

  enum CodingKeys: String, CodingKey {
    case name
    case readText = "read_text"
  }
}

public struct StyleSubject: Decodable, Sendable, Equatable, Hashable, Identifiable {
  public var id: String
  public var category: String
  public var label: String
  public var region: StyleRegion?
  public var aesthetics: [StyleClaim]
  public var era: StyleClaim?
  public var lineage: [StyleClaim]
  public var materials: [StyleClaim]
  public var construction: [StyleClaim]
  public var palette: [StylePaletteEntry]
  public var mood: [StyleMood]
  public var details: [StyleClaim]
  public var brand: StyleBrand?
  public var qlooLinks: [String]
  public var rail: String?
  /// Index in the server's `subjects` array (for retraction paths).
  public var sourceIndex: Int = 0

  enum CodingKeys: String, CodingKey {
    case id, category, label, region, aesthetics, era, lineage, materials, construction, palette, mood, details, brand, rail
    case qlooLinks = "qloo_links"
  }

  public init(
    id: String, category: String, label: String, region: StyleRegion? = nil, aesthetics: [StyleClaim] = [],
    era: StyleClaim? = nil, lineage: [StyleClaim] = [], materials: [StyleClaim] = [], construction: [StyleClaim] = [],
    palette: [StylePaletteEntry] = [], mood: [StyleMood] = [], details: [StyleClaim] = [], brand: StyleBrand? = nil,
    qlooLinks: [String] = [], rail: String? = nil
  ) {
    self.id = id
    self.category = category
    self.label = label
    self.region = region
    self.aesthetics = aesthetics
    self.era = era
    self.lineage = lineage
    self.materials = materials
    self.construction = construction
    self.palette = palette
    self.mood = mood
    self.details = details
    self.brand = brand
    self.qlooLinks = qlooLinks
    self.rail = rail
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id)
    guard let label = c.trimmedString(forKey: .label) else {
      throw DecodingError.dataCorrupted(.init(codingPath: c.codingPath, debugDescription: "subject without label"))
    }
    self.label = label
    category = c.trimmedString(forKey: .category) ?? "other"
    region = c.lenient(StyleRegion.self, forKey: .region)?.clamped
    func claims(_ key: CodingKeys) -> [StyleClaim] {
      c.lossyIndexed(StyleClaim.self, forKey: key).map { index, claim in
        var claim = claim
        claim.slotIndex = index
        return claim
      }
    }
    aesthetics = claims(.aesthetics)
    era = c.lenient(StyleClaim.self, forKey: .era)
    lineage = claims(.lineage)
    materials = claims(.materials)
    construction = claims(.construction)
    palette = c.lossyArray(StylePaletteEntry.self, forKey: .palette)
    mood = c.lossyIndexed(StyleMood.self, forKey: .mood).map { index, mood in
      var mood = mood
      mood.slotIndex = index
      return mood
    }
    details = claims(.details)
    brand = c.lenient(StyleBrand.self, forKey: .brand)
    // Names exactly as Qloo returned them (R-18); blanks are dropped.
    qlooLinks = c.lossyArray(String.self, forKey: .qlooLinks)
      .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
      .filter { !$0.isEmpty }
    rail = c.trimmedString(forKey: .rail)
  }
}

/// `style_reading` on `GET /v1/captures/{id}`. Null until `sections.style == "ready"`.
public struct StyleReading: Decodable, Sendable, Equatable, Hashable {
  public var version: String?
  public var summary: String?
  public var swatches: [StyleSwatch]
  public var subjects: [StyleSubject]
  /// Claim paths removed after a stage-2 veto (`subjects[0].aesthetics[1]`).
  public var retracted: [String]

  enum CodingKeys: String, CodingKey { case version, summary, swatches, subjects, retracted }

  public init(
    version: String? = "atlas_style_reading_v1", summary: String?, swatches: [StyleSwatch] = [],
    subjects: [StyleSubject], retracted: [String] = []
  ) {
    self.version = version
    self.summary = summary
    self.swatches = swatches
    self.subjects = subjects
    self.retracted = retracted
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    version = c.trimmedString(forKey: .version)
    summary = c.trimmedString(forKey: .summary)
    swatches = c.lossyArray(StyleSwatch.self, forKey: .swatches)
    subjects = c.lossyIndexed(StyleSubject.self, forKey: .subjects).map { index, subject in
      var subject = subject
      subject.sourceIndex = index
      return subject
    }
    retracted = c.lossyArray(String.self, forKey: .retracted)
  }

  public func swatch(_ index: Int) -> StyleSwatch? { swatches.first { $0.index == index } }
}

// MARK: - Rails and style match

/// Structured "why" for a card from a capture rail (C.4). Attributes are the
/// reading's own (guarded) claim names, not Qloo tag labels.
public struct StyleMatch: Decodable, Sendable, Equatable, Hashable {
  public var subjectID: String?
  public var attributes: [String]
  public var palette: [String]
  public var via: String?
  public var experimental: Bool

  enum CodingKeys: String, CodingKey {
    case attributes, palette, via, experimental
    case subjectID = "subject_id"
  }

  public init(subjectID: String? = nil, attributes: [String] = [], palette: [String] = [], via: String? = nil, experimental: Bool = false) {
    self.subjectID = subjectID
    self.attributes = attributes
    self.palette = palette
    self.via = via
    self.experimental = experimental
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    subjectID = c.trimmedString(forKey: .subjectID)
    attributes = c.lossyArray(String.self, forKey: .attributes).filter { !$0.isEmpty }
    palette = c.lossyArray(String.self, forKey: .palette).filter { !$0.isEmpty }
    via = c.trimmedString(forKey: .via)
    experimental = c.lenient(Bool.self, forKey: .experimental) ?? false
  }
}

extension StyleMatch: Encodable {
  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encodeIfPresent(subjectID, forKey: .subjectID)
    try c.encode(attributes, forKey: .attributes)
    try c.encode(palette, forKey: .palette)
    try c.encodeIfPresent(via, forKey: .via)
    try c.encode(experimental, forKey: .experimental)
  }
}

/// One rail on the capture (`more_like_this:s1`, `wear`, …), in display order.
public struct CaptureRail: Decodable, Sendable, Equatable, Hashable, Identifiable {
  public var key: String
  public var kind: String
  public var title: String
  public var subtitle: String?
  public var subjectID: String?
  public var status: String
  public var emptyMessage: String?
  public var cards: [DiscoveryCard]
  public var id: String { key }

  public var isMoreLikeThis: Bool { kind == "more_like_this" }

  enum CodingKeys: String, CodingKey {
    case key, kind, title, subtitle, status, cards
    case subjectID = "subject_id"
    case emptyMessage = "empty_message"
  }

  public init(
    key: String, kind: String, title: String, subtitle: String? = nil, subjectID: String? = nil,
    status: String, emptyMessage: String? = nil, cards: [DiscoveryCard] = []
  ) {
    self.key = key
    self.kind = kind
    self.title = title
    self.subtitle = subtitle
    self.subjectID = subjectID
    self.status = status
    self.emptyMessage = emptyMessage
    self.cards = cards
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    key = try c.decode(String.self, forKey: .key)
    kind = c.trimmedString(forKey: .kind) ?? "cross_domain"
    title = c.trimmedString(forKey: .title) ?? ""
    subtitle = c.trimmedString(forKey: .subtitle)
    subjectID = c.trimmedString(forKey: .subjectID)
    status = c.trimmedString(forKey: .status) ?? "ready"
    emptyMessage = c.trimmedString(forKey: .emptyMessage)
    cards = c.lossyArray(DiscoveryCard.self, forKey: .cards)
  }
}

// MARK: - GET /v1/captures/{id}

public struct CaptureAnalysisSummary: Decodable, Sendable, Equatable, Hashable {
  public var id: UUID
  public var version: Int
  public var title: String?
  public var interpretation: String?
  public var sections: [String: String]
  public var experimental: ExperimentalLabel?

  enum CodingKeys: String, CodingKey { case id, version, title, interpretation, sections, experimental }

  public init(
    id: UUID, version: Int = 1, title: String? = nil, interpretation: String? = nil, sections: [String: String] = [:],
    experimental: ExperimentalLabel? = nil
  ) {
    self.id = id
    self.version = version
    self.title = title
    self.interpretation = interpretation
    self.sections = sections
    self.experimental = experimental
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decode(UUID.self, forKey: .id)
    version = c.lenient(Int.self, forKey: .version) ?? 1
    title = c.trimmedString(forKey: .title)
    interpretation = c.trimmedString(forKey: .interpretation)
    sections = c.lenient([String: String].self, forKey: .sections) ?? [:]
    experimental = c.lenient(ExperimentalLabel.self, forKey: .experimental)
  }
}

/// The capture with its analysis, style reading and rails. Only the fields the
/// phone renders are decoded; everything else is ignored.
public struct CaptureDetailResponse: Decodable, Sendable, Equatable {
  public var id: UUID
  public var status: String
  public var image: LibraryImage?
  public var analysis: CaptureAnalysisSummary?
  public var styleReading: StyleReading?
  /// Nil for an analysis made before rails existed (render `recommendations`).
  public var rails: [CaptureRail]?
  public var recommendations: [DiscoveryCard]
  public var jobID: UUID?

  enum CodingKeys: String, CodingKey {
    case id, status, image, analysis, rails, recommendations
    case styleReading = "style_reading"
    case jobID = "job_id"
  }

  public init(
    id: UUID, status: String = "ready", image: LibraryImage? = nil, analysis: CaptureAnalysisSummary? = nil,
    styleReading: StyleReading? = nil, rails: [CaptureRail]? = nil, recommendations: [DiscoveryCard] = [], jobID: UUID? = nil
  ) {
    self.id = id
    self.status = status
    self.image = image
    self.analysis = analysis
    self.styleReading = styleReading
    self.rails = rails
    self.recommendations = recommendations
    self.jobID = jobID
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decode(UUID.self, forKey: .id)
    status = c.trimmedString(forKey: .status) ?? "ready"
    image = c.lenient(LibraryImage.self, forKey: .image)
    analysis = c.lenient(CaptureAnalysisSummary.self, forKey: .analysis)
    styleReading = c.lenient(StyleReading.self, forKey: .styleReading)
    if c.contains(.rails), (try? c.decodeNil(forKey: .rails)) == false {
      rails = c.lossyArray(CaptureRail.self, forKey: .rails)
    } else {
      rails = nil
    }
    recommendations = c.lossyArray(DiscoveryCard.self, forKey: .recommendations)
    jobID = c.lenient(UUID.self, forKey: .jobID)
  }
}

// MARK: - Compact preview on the media analysis (E.3)

public struct StylePreview: Codable, Sendable, Equatable, Hashable {
  public struct Aesthetic: Codable, Sendable, Equatable, Hashable, Identifiable {
    public var subjectID: String?
    public var display: String
    public var wording: String?
    public var id: String { "\(subjectID ?? "")|\(display)" }
    public var isAsserted: Bool { wording == "asserted" }

    enum CodingKeys: String, CodingKey {
      case display, wording
      case subjectID = "subject_id"
    }

    public init(subjectID: String?, display: String, wording: String?) {
      self.subjectID = subjectID
      self.display = display
      self.wording = wording
    }

    public init(from decoder: Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      guard let display = c.trimmedString(forKey: .display) else {
        throw DecodingError.dataCorrupted(.init(codingPath: c.codingPath, debugDescription: "aesthetic without display"))
      }
      self.display = display
      wording = c.trimmedString(forKey: .wording)
      subjectID = c.trimmedString(forKey: .subjectID)
    }
  }

  public var status: String
  public var summary: String?
  public var aesthetics: [Aesthetic]
  public var swatches: [String]
  public var frameIndex: Int?

  enum CodingKeys: String, CodingKey {
    case status, summary, aesthetics, swatches
    case frameIndex = "frame_index"
  }

  public init(status: String, summary: String? = nil, aesthetics: [Aesthetic] = [], swatches: [String] = [], frameIndex: Int? = nil) {
    self.status = status
    self.summary = summary
    self.aesthetics = aesthetics
    self.swatches = swatches
    self.frameIndex = frameIndex
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    status = c.trimmedString(forKey: .status) ?? "ready"
    summary = c.trimmedString(forKey: .summary)
    aesthetics = Array(c.lossyArray(Aesthetic.self, forKey: .aesthetics).prefix(4))
    swatches = c.lossyArray(String.self, forKey: .swatches).filter { StyleColor.rgb($0) != nil }
    frameIndex = c.lenient(Int.self, forKey: .frameIndex)
  }
}

// MARK: - Colors

public enum StyleColor {
  /// "#7B5A3A" → (r, g, b) in 0…1. Nil for anything that is not #RRGGBB.
  public static func rgb(_ hex: String) -> (red: Double, green: Double, blue: Double)? {
    var raw = hex.trimmingCharacters(in: .whitespaces)
    guard raw.hasPrefix("#") else { return nil }
    raw.removeFirst()
    guard raw.count == 6, let value = UInt32(raw, radix: 16) else { return nil }
    return (Double((value >> 16) & 0xFF) / 255, Double((value >> 8) & 0xFF) / 255, Double(value & 0xFF) / 255)
  }
}

// MARK: - Requests

/// `PUT /v1/me/city` (C.6). `nil` clears it.
public struct CityRequest: Encodable, Sendable, Equatable {
  public var city: String?

  public init(city: String?) { self.city = city }

  enum CodingKeys: String, CodingKey { case city }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(city, forKey: .city)
  }
}
