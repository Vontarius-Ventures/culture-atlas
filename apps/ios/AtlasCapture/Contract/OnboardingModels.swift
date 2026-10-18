import Foundation

/// Wire models for taste onboarding (spec amendment 2.2, screens 14, 15 and
/// 18), Settings → Taste, push registration and ready notices. The onboarding
/// routes are the server's `/v1/onboarding/*` and `/v1/taste/picks`, which an
/// enrolled phone may call as its account owner (the native owner bridge,
/// fixtures/native-contract/onboarding.json). Every type is checked against
/// the examples in fixtures/native-contract/messages.json by `OnboardingTests`.
public enum TasteCategory: String, Codable, Sendable, CaseIterable, Identifiable {
  case wear, play, watch, eat
  public var id: String { rawValue }
}

public struct OnboardingImage: Codable, Sendable, Equatable, Hashable {
  /// Public asset path ("/samples/…") resolved against the API base URL, or an absolute https URL.
  public var url: String
  public var width: Int
  public var height: Int
  public var alt: String
  public var credit: String?
  public var license: String?

  public func resolved(against baseURL: URL) -> URL? {
    if let absolute = URL(string: url), absolute.scheme == "https" { return absolute }
    guard url.hasPrefix("/") else { return nil }
    return URL(string: url, relativeTo: baseURL)?.absoluteURL
  }
}

public struct OnboardingCatalogEntry: Codable, Sendable, Equatable, Identifiable, Hashable {
  public enum Kind: String, Codable, Sendable { case image, chip }

  public var id: String
  public var kind: Kind
  public var category: TasteCategory
  public var label: String
  public var image: OnboardingImage?
  public var picked: Bool
  public var pickID: UUID?

  enum CodingKeys: String, CodingKey {
    case id, kind, category, label, image, picked
    case pickID = "pick_id"
  }
}

public struct OnboardingCatalog: Codable, Sendable, Equatable {
  public struct Chips: Codable, Sendable, Equatable {
    public var wear: [OnboardingCatalogEntry]
    public var play: [OnboardingCatalogEntry]
    public var watch: [OnboardingCatalogEntry]
    public var eat: [OnboardingCatalogEntry]

    public subscript(category: TasteCategory) -> [OnboardingCatalogEntry] {
      switch category {
      case .wear: return wear
      case .play: return play
      case .watch: return watch
      case .eat: return eat
      }
    }
  }

  public var catalogVersion: String
  public var images: [OnboardingCatalogEntry]
  public var chips: Chips
  public var exclusionSuggestions: [String]
  public var minPicks: Int

  enum CodingKeys: String, CodingKey {
    case images, chips
    case catalogVersion = "catalog_version"
    case exclusionSuggestions = "exclusion_suggestions"
    case minPicks = "min_picks"
  }

  public var allEntries: [OnboardingCatalogEntry] {
    images + TasteCategory.allCases.flatMap { chips[$0] }
  }
}

public struct OnboardingSearchResult: Codable, Sendable, Equatable, Identifiable, Hashable {
  /// Opaque, server-signed token: the only way to save a search result.
  public var resultID: String
  public var name: String
  /// Plain-language type ("Artist", "Film", …); results show name and type only.
  public var typeLabel: String
  public var category: TasteCategory?
  public var picked: Bool
  public var id: String { resultID }

  enum CodingKeys: String, CodingKey {
    case name, category, picked
    case resultID = "result_id"
    case typeLabel = "type_label"
  }
}

public struct OnboardingSearchResponse: Codable, Sendable, Equatable {
  public enum Status: String, Codable, Sendable { case ok, unavailable }
  public var status: Status
  public var results: [OnboardingSearchResult]
}

/// POST /v1/onboarding/picks and /v1/taste/picks. A client can only name a
/// catalog item or a signed search result, never a provider id of its own.
public enum CreatePickRequest: Codable, Sendable, Equatable {
  case catalog(itemID: String)
  case search(resultID: String)

  enum CodingKeys: String, CodingKey {
    case source
    case catalogItemID = "catalog_item_id"
    case resultID = "result_id"
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    switch try container.decode(String.self, forKey: .source) {
    case "catalog": self = .catalog(itemID: try container.decode(String.self, forKey: .catalogItemID))
    case "search": self = .search(resultID: try container.decode(String.self, forKey: .resultID))
    default:
      throw DecodingError.dataCorruptedError(forKey: .source, in: container, debugDescription: "Unknown pick source")
    }
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    switch self {
    case .catalog(let itemID):
      try container.encode("catalog", forKey: .source)
      try container.encode(itemID, forKey: .catalogItemID)
    case .search(let resultID):
      try container.encode("search", forKey: .source)
      try container.encode(resultID, forKey: .resultID)
    }
  }
}

/// One counted choice, backed by one or more explicit saves (a multi-tag image counts once).
public struct OnboardingPick: Codable, Sendable, Equatable, Identifiable, Hashable {
  public var id: UUID
  public var source: String
  public var catalogItemID: String?
  public var label: String
  public var category: TasteCategory?
  public var itemKind: String
  public var savedItemIDs: [UUID]
  public var discoveryItemIDs: [UUID]
  public var image: OnboardingImage?
  public var createdAt: Date

  enum CodingKeys: String, CodingKey {
    case id, source, label, category, image
    case catalogItemID = "catalog_item_id"
    case itemKind = "item_kind"
    case savedItemIDs = "saved_item_ids"
    case discoveryItemIDs = "discovery_item_ids"
    case createdAt = "created_at"
  }
}

public struct OnboardingState: Codable, Sendable, Equatable {
  public var required: Bool
  public var picksCount: Int
  public var minPicks: Int
  public var startedAt: Date?
  public var completedAt: Date?
  public var catalogVersion: String?

  enum CodingKeys: String, CodingKey {
    case required
    case picksCount = "picks_count"
    case minPicks = "min_picks"
    case startedAt = "started_at"
    case completedAt = "completed_at"
    case catalogVersion = "catalog_version"
  }
}

public struct CreatePickResponse: Codable, Sendable, Equatable {
  public var pick: OnboardingPick
  public var state: OnboardingState
  public var tasteRevision: Int
  public var alreadyPicked: Bool

  enum CodingKeys: String, CodingKey {
    case pick, state
    case tasteRevision = "taste_revision"
    case alreadyPicked = "already_picked"
  }
}

public struct DeletePickResponse: Codable, Sendable, Equatable {
  public var removedPickID: UUID
  public var state: OnboardingState
  public var tasteRevision: Int

  enum CodingKeys: String, CodingKey {
    case state
    case removedPickID = "removed_pick_id"
    case tasteRevision = "taste_revision"
  }
}

/// PUT /v1/onboarding/exclusions request and response (preferences, never picks).
public struct FoodExclusionsBody: Codable, Sendable, Equatable {
  public var foodExclusions: [String]

  public init(foodExclusions: [String]) { self.foodExclusions = foodExclusions }

  enum CodingKeys: String, CodingKey {
    case foodExclusions = "food_exclusions"
  }
}

public enum SeedState: String, Codable, Sendable {
  case notStarted = "not_started"
  case queued, running, retrying, partial, complete, failed
}

public enum SeedCategoryState: String, Codable, Sendable {
  case pending, ready, empty, unavailable
}

public struct TasteSeedStatus: Codable, Sendable, Equatable {
  public struct Category: Codable, Sendable, Equatable {
    public var category: TasteCategory
    public var state: SeedCategoryState
    public var cardCount: Int
    public var readyAt: Date?

    enum CodingKeys: String, CodingKey {
      case category, state
      case cardCount = "card_count"
      case readyAt = "ready_at"
    }
  }

  public var jobID: UUID?
  public var state: SeedState
  public var categories: [Category]
  public var firstReadyAt: Date?
  public var pollAfterMS: Int?

  enum CodingKeys: String, CodingKey {
    case state, categories
    case jobID = "job_id"
    case firstReadyAt = "first_ready_at"
    case pollAfterMS = "poll_after_ms"
  }
}

public struct OnboardingStateResponse: Codable, Sendable, Equatable {
  public var state: OnboardingState
  public var picks: [OnboardingPick]
  public var foodExclusions: [String]
  public var seed: TasteSeedStatus

  enum CodingKeys: String, CodingKey {
    case state, picks, seed
    case foodExclusions = "food_exclusions"
  }
}

public struct CompleteOnboardingResponse: Codable, Sendable, Equatable {
  public var state: OnboardingState
  public var seed: TasteSeedStatus
}

/// GET /v1/taste/picks (Settings → Taste).
public struct TastePicksResponse: Codable, Sendable, Equatable {
  public struct Grouped: Codable, Sendable, Equatable {
    public var wear: [OnboardingPick]
    public var play: [OnboardingPick]
    public var watch: [OnboardingPick]
    public var eat: [OnboardingPick]
    public var other: [OnboardingPick]
  }

  public var picks: Grouped
  public var picksCount: Int
  public var foodExclusions: [String]?

  enum CodingKeys: String, CodingKey {
    case picks
    case picksCount = "picks_count"
    case foodExclusions = "food_exclusions"
  }
}

/// `/v1` errors are flat (`{code,message,retryable,request_id}`), unlike `/v2`.
public struct FlatServerError: Codable, Sendable, Equatable {
  public var code: String
  public var message: String
  public var retryable: Bool
  public var requestID: String
  public var retryAfterMS: Double?

  enum CodingKeys: String, CodingKey {
    case code, message, retryable
    case requestID = "request_id"
    case retryAfterMS = "retry_after_ms"
  }
}

// MARK: - Push registration and ready notices

/// PUT /v2/device/push-token. The token is a secret of this installation.
public struct PushTokenRequest: Codable, Sendable, Equatable {
  public enum Provider: String, Codable, Sendable { case apns, fcm }
  public enum Environment: String, Codable, Sendable { case production, sandbox }

  public var provider: Provider
  public var token: String
  public var environment: Environment

  public init(provider: Provider, token: String, environment: Environment) {
    self.provider = provider
    self.token = token
    self.environment = environment
  }
}

public struct PushTokenResponse: Codable, Sendable, Equatable {
  public var registered: Bool
  public var provider: PushTokenRequest.Provider?
}

/// The fields of GET /v2/media/{id} the ready notice needs.
public struct MediaDetail: Codable, Sendable, Equatable {
  public struct Media: Codable, Sendable, Equatable {
    public var id: UUID
    public var kind: MediaKind
    public var status: String
    public var analysisStatus: String

    enum CodingKeys: String, CodingKey {
      case id, kind, status
      case analysisStatus = "analysis_status"
    }
  }

  public var media: Media
  public var generation: Int
}

/// POST /v2/media/{id}/analysis: the user starts exploring a photo.
public struct AnalyzeMediaRequest: Codable, Sendable, Equatable {
  public var focus: String
  public var mode: String
  public var expectedGeneration: Int

  public init(focus: String = "", mode: String = "photo", expectedGeneration: Int) {
    self.focus = focus
    self.mode = mode
    self.expectedGeneration = expectedGeneration
  }

  enum CodingKeys: String, CodingKey {
    case focus, mode
    case expectedGeneration = "expected_generation"
  }
}

public enum AnalysisState: String, Codable, Sendable, CaseIterable {
  case queued, running, partial, complete, failed, cancelled
}

/// POST /v2/media/{id}/analysis and GET /v2/media/{id}/analysis/{analysisId}.
public struct AnalysisStatus: Codable, Sendable, Equatable {
  public var analysisID: UUID
  public var jobID: UUID
  public var state: AnalysisState
  public var reused: Bool
  /// Web path of the result ("/captures/{id}") once published.
  public var resultURL: String?
  public var captureID: UUID?
  public var waitingReason: String?
  public var errorCode: String?

  enum CodingKeys: String, CodingKey {
    case state, reused
    case analysisID = "analysis_id"
    case jobID = "job_id"
    case resultURL = "result_url"
    case captureID = "capture_id"
    case waitingReason = "waiting_reason"
    case errorCode = "error_code"
  }
}
