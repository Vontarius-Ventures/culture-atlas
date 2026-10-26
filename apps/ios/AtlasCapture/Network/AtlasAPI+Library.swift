import Foundation

/// Server library (`GET /v2/library`) and native analysis results
/// (`GET /v2/media/{id}/analysis/{analysisId}` with its `result`).
extension AtlasAPI {
  /// Photos and videos in the signed-in account's private library, newest
  /// first. Includes captures made on the web, by glasses or by agents.
  public func mediaLibrary(cursor: String? = nil, limit: Int = 30) async throws -> MediaLibraryPage {
    var query = [URLQueryItem(name: "limit", value: String(limit))]
    if let cursor { query.append(URLQueryItem(name: "cursor", value: cursor)) }
    return try await get("/v2/library", query: query)
  }

  public func mediaItem(_ id: UUID) async throws -> MediaLibraryItem {
    try await get("/v2/media/\(id.uuidString.lowercased())")
  }

  /// The analysis status with its published result (photo candidates or the
  /// music match). Decoded leniently: unknown fields are ignored.
  public func analysisResult(mediaID: UUID, analysisID: UUID) async throws -> AnalysisResultResponse {
    try await get("/v2/media/\(mediaID.uuidString.lowercased())/analysis/\(analysisID.uuidString.lowercased())")
  }

  /// `GET /v1/captures/{id}` through the native owner bridge: the compiled
  /// result's sourced references and the Qloo-backed recommendations made
  /// from them. Read-only, and only the signed-in account's own captures.
  public func captureResult(_ captureID: UUID) async throws -> CaptureResultResponse {
    try await get("/v1/captures/\(captureID.uuidString.lowercased())")
  }

  /// Re-requesting the same photo exploration returns the existing analysis
  /// (`reused: true`, no allowance used), so this finds the analysis of a
  /// capture explored on another device.
  public func photoAnalysis(mediaID: UUID, generation: Int) async throws -> AnalysisStatus {
    try await startAnalysis(mediaID: mediaID, generation: generation)
  }
}

public struct MediaLibraryPage: Codable, Sendable, Equatable {
  public var items: [MediaLibraryItem]
  public var nextCursor: String?

  enum CodingKeys: String, CodingKey {
    case items
    case nextCursor = "next_cursor"
  }
}

/// One `MediaDetailResponse` from the server library.
public struct MediaLibraryItem: Codable, Sendable, Equatable, Hashable, Identifiable {
  public struct Media: Codable, Sendable, Equatable, Hashable {
    public var id: UUID
    public var kind: String
    public var source: String
    public var status: String
    public var analysisStatus: String
    public var createdAt: Date
    public var title: String?
    public var durationMS: Int?
    public var width: Int?
    public var height: Int?

    enum CodingKeys: String, CodingKey {
      case id, kind, source, status, title, width, height
      case analysisStatus = "analysis_status"
      case createdAt = "created_at"
      case durationMS = "duration_ms"
    }
  }

  public struct Links: Codable, Sendable, Equatable, Hashable {
    public var original: String?
    public var playback: String?
    public var poster: String?
    public var analysis: String?
  }

  public var media: Media
  public var generation: Int
  public var revision: Int
  public var links: Links

  public var id: UUID { media.id }

  /// Best picture for a tile: the normalized photo, else the video poster.
  public var thumbnailPath: String? {
    media.kind == "photo" ? (links.playback ?? links.original) : (links.poster ?? links.playback)
  }

  public var isReady: Bool { media.status == "ready" }
  public var analyzed: Bool { media.analysisStatus == "complete" }
  public var analyzing: Bool { media.analysisStatus == "queued" || media.analysisStatus == "running" }
}

/// `GET /v2/media/{id}/analysis/{analysisId}`. Photo results carry the
/// guardrail-published candidates; music results carry the match state and
/// the Qloo seeds it resolved. Nothing here is invented on the phone.
public struct AnalysisResultResponse: Codable, Sendable, Equatable {
  public var analysisID: UUID
  public var state: AnalysisState
  public var resultURL: String?
  public var captureID: UUID?
  public var waitingReason: String?
  public var errorCode: String?
  public var result: AnalysisResult?
  /// Present when the reading came from an experimental (unqualified) role.
  public var experimental: ExperimentalLabel?

  enum CodingKeys: String, CodingKey {
    case state, result, experimental
    case analysisID = "analysis_id"
    case resultURL = "result_url"
    case captureID = "capture_id"
    case waitingReason = "waiting_reason"
    case errorCode = "error_code"
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    analysisID = try c.decode(UUID.self, forKey: .analysisID)
    state = try c.decode(AnalysisState.self, forKey: .state)
    resultURL = try c.decodeIfPresent(String.self, forKey: .resultURL)
    captureID = try? c.decodeIfPresent(UUID.self, forKey: .captureID)
    waitingReason = try c.decodeIfPresent(String.self, forKey: .waitingReason)
    errorCode = try c.decodeIfPresent(String.self, forKey: .errorCode)
    result = try? c.decodeIfPresent(AnalysisResult.self, forKey: .result)
    experimental = c.lenient(ExperimentalLabel.self, forKey: .experimental)
  }

  public var finished: Bool { state == .complete || state == .partial }
  public var stillWorking: Bool { state == .queued || state == .running }
}

public struct AnalysisResult: Codable, Sendable, Equatable {
  /// A thing the photo reading published (name, type, relation).
  public struct Candidate: Codable, Sendable, Equatable, Hashable, Identifiable {
    public var name: String
    public var type: String?
    public var relation: String?
    public var id: String { "\(name)|\(type ?? "")" }

    /// Anything not directly shown is phrased as a resemblance.
    public var isResemblance: Bool { relation != "depicted" }
  }

  /// A Qloo entity the music match resolved.
  public struct Seed: Codable, Sendable, Equatable, Hashable, Identifiable {
    public var name: String
    public var entityID: String?
    public var entityType: String?
    public var id: String { entityID ?? name }

    enum CodingKeys: String, CodingKey {
      case name
      case entityID = "entity_id"
      case entityType = "entity_type"
    }
  }

  public var candidates: [Candidate]
  public var music: String?
  public var seeds: [Seed]
  public var reading: String?
  public var note: String?
  /// Compact style preview (chips and swatches); nil until the style section is ready.
  public var style: StylePreview?

  enum CodingKeys: String, CodingKey {
    case candidates, music, reading, note, style
    case seeds = "qloo_seeds"
  }

  public init(
    candidates: [Candidate] = [], music: String? = nil, seeds: [Seed] = [], reading: String? = nil, note: String? = nil,
    style: StylePreview? = nil
  ) {
    self.style = style
    self.candidates = candidates
    self.music = music
    self.seeds = seeds
    self.reading = reading
    self.note = note
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    candidates = (try? c.decodeIfPresent([Candidate].self, forKey: .candidates)) ?? []
    music = try? c.decodeIfPresent(String.self, forKey: .music)
    seeds = (try? c.decodeIfPresent([Seed].self, forKey: .seeds)) ?? []
    reading = try? c.decodeIfPresent(String.self, forKey: .reading)
    note = try? c.decodeIfPresent(String.self, forKey: .note)
    style = c.lenient(StylePreview.self, forKey: .style)
  }

  /// Plain-language music outcome; never claims a match the server did not make.
  public var musicHeadline: String? {
    switch music {
    case "identified": return "We found who this sounds like"
    case "possible_matches": return "A few possible matches"
    case "no_reliable_match": return "No reliable match this time"
    case "provider_unavailable": return "Music matching isn't available right now"
    case "matching": return "Still listening"
    default: return nil
    }
  }
}

extension AtlasClientError {
  /// A request the system cancelled (view went away, refresh superseded).
  /// It is not a failure and must never be reported to the user as one.
  public var isCancellation: Bool {
    if case .transport(let detail) = self { return detail.hasSuffix(":\(NSURLErrorCancelled)") }
    return false
  }

  public static func isCancellation(_ error: Error) -> Bool {
    if error is CancellationError { return true }
    if let urlError = error as? URLError, urlError.code == .cancelled { return true }
    return (error as? AtlasClientError)?.isCancellation == true
  }
}

/// `GET /v1/captures/{id}`, decoded leniently: only what the native result
/// screen shows. A field that fails to decode leaves it empty rather than
/// hiding the whole result.
public struct CaptureResultResponse: Decodable, Sendable, Equatable {
  public struct Analysis: Decodable, Sendable, Equatable {
    public var title: String?
    public var interpretation: String?
  }

  public var id: UUID
  public var status: String?
  public var analysis: Analysis?
  public var references: [ItemReference]
  public var recommendations: [DiscoveryCard]
  public var jobID: UUID?

  enum CodingKeys: String, CodingKey {
    case id, status, analysis, references, recommendations
    case jobID = "job_id"
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decode(UUID.self, forKey: .id)
    status = try? c.decodeIfPresent(String.self, forKey: .status)
    analysis = try? c.decodeIfPresent(Analysis.self, forKey: .analysis)
    references = (try? c.decodeIfPresent([ItemReference].self, forKey: .references)) ?? []
    recommendations = (try? c.decodeIfPresent([DiscoveryCard].self, forKey: .recommendations)) ?? []
    jobID = try? c.decodeIfPresent(UUID.self, forKey: .jobID)
  }

  /// Done compiling: recommendations are in, or no job is left to add them.
  public var settled: Bool { recommendations.isEmpty == false || jobID == nil }
}
