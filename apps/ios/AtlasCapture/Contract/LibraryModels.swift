import Foundation

/// Wire models for Discover (`GET /v1/discoveries`) and boards
/// (`/v1/collections*`). An enrolled phone may call these as its account owner
/// (native owner bridge, fixtures/native-contract/onboarding.json).

public struct LibraryImage: Codable, Sendable, Equatable, Hashable {
  public var url: String
  public var width: Int?
  public var height: Int?
  public var alt: String

  public func resolved(against baseURL: URL) -> URL? {
    if let absolute = URL(string: url), absolute.scheme == "https" {
      return absolute
    }
    guard url.hasPrefix("/") else { return nil }
    return URL(string: url, relativeTo: baseURL)?.absoluteURL
  }
}

public struct DiscoveryCard: Codable, Sendable, Equatable, Identifiable, Hashable {
  public var id: UUID
  public var kind: String
  public var category: TasteCategory?
  public var title: String
  public var subtitle: String?
  public var image: LibraryImage?
  public var isExample: Bool
  public var saved: Bool
  public var savedItemID: UUID?
  public var recommendationID: UUID?
  public var evidenceAvailable: Bool
  /// Capture rails only (C.4): the server's reason, at most 90 characters,
  /// built from real overlap with the style reading. Older payloads omit it.
  public var reason: String? = nil
  /// Capture rails only: which style attributes connected this card.
  public var styleMatch: StyleMatch? = nil

  enum CodingKeys: String, CodingKey {
    case id, kind, category, title, subtitle, image, saved, reason
    case styleMatch = "style_match"
    case isExample = "is_example"
    case savedItemID = "saved_item_id"
    case recommendationID = "recommendation_id"
    case evidenceAvailable = "evidence_available"
  }
}

public struct DiscoveriesResponse: Codable, Sendable, Equatable {
  public var items: [DiscoveryCard]
  public var nextCursor: String?
  public var feedID: UUID
  public var feedRevision: Int
  public var isExampleFeed: Bool
  public var availableCategories: [TasteCategory]
  /// The server is still adding cards (the taste seed publishing categories
  /// right after onboarding, an expand wave, Music Mode suggestions).
  public var expansion: Expansion?

  public struct Expansion: Codable, Sendable, Equatable {
    public var state: String
    public var pollAfterMS: Int?

    enum CodingKeys: String, CodingKey {
      case state
      case pollAfterMS = "poll_after_ms"
    }
  }

  enum CodingKeys: String, CodingKey {
    case items, expansion
    case nextCursor = "next_cursor"
    case feedID = "feed_id"
    case feedRevision = "feed_revision"
    case isExampleFeed = "is_example_feed"
    case availableCategories = "available_categories"
  }

  /// Usual feed poll (spec: every 8 s while the example feed shows).
  public static let pollSeconds: Double = 8

  /// When to look again: sooner while the server says cards are on their way.
  public var nextPollSeconds: Double {
    guard expansion?.state == "running" else { return Self.pollSeconds }
    let ms = Double(expansion?.pollAfterMS ?? 4000)
    return min(Self.pollSeconds, max(2, ms / 1000))
  }

  /// Which of the cards still on screen stay in the pool after this page.
  /// Once real cards land, examples the server no longer lists leave the pool
  /// (the conveyor lets them drift off; they never come back), so the real
  /// ones float in without a reload. Real cards on screen always stay.
  public func keptOnScreen(_ onScreen: [DiscoveryCard]) -> [DiscoveryCard] {
    let incoming = Set(items.map(\.id))
    let landedReal = items.contains { $0.isExample == false }
    return onScreen.filter { card in
      !incoming.contains(card.id) && !(landedReal && card.isExample)
    }
  }
}

public struct CollectionSummary: Codable, Sendable, Equatable, Identifiable, Hashable {
  public var id: UUID
  public var name: String
  public var description: String?
  public var itemCount: Int
  public var cover: [LibraryImage]
  public var revision: Int
  public var createdAt: Date
  public var updatedAt: Date

  enum CodingKeys: String, CodingKey {
    case id, name, description, cover, revision
    case itemCount = "item_count"
    case createdAt = "created_at"
    case updatedAt = "updated_at"
  }
}

public struct CollectionsUnfiled: Codable, Sendable, Equatable {
  public var itemCount: Int
  public var cover: [LibraryImage]

  enum CodingKeys: String, CodingKey {
    case cover
    case itemCount = "item_count"
  }
}

public struct CollectionsListResponse: Codable, Sendable, Equatable {
  public var collections: [CollectionSummary]
  public var unfiled: CollectionsUnfiled?
}

public struct CreateCollectionRequest: Codable, Sendable, Equatable {
  public var name: String
  public var description: String?

  public init(name: String, description: String? = nil) {
    self.name = name
    self.description = description
  }

  enum CodingKeys: String, CodingKey { case name, description }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(name, forKey: .name)
    try container.encodeIfPresent(description, forKey: .description)
  }
}

public struct CollectionMember: Codable, Sendable, Equatable, Identifiable, Hashable {
  public var membershipID: UUID
  public var savedItemID: UUID
  public var position: Int
  public var addedAt: Date
  public var item: DiscoveryCard
  public var id: UUID { membershipID }

  enum CodingKeys: String, CodingKey {
    case position, item
    case membershipID = "membership_id"
    case savedItemID = "saved_item_id"
    case addedAt = "added_at"
  }
}

public struct CollectionDetailResponse: Codable, Sendable, Equatable {
  public var collection: CollectionSummary
  public var items: [CollectionMember]
  public var nextCursor: String?
  public var availableFilters: [String]

  enum CodingKeys: String, CodingKey {
    case collection, items
    case nextCursor = "next_cursor"
    case availableFilters = "available_filters"
  }
}

public struct AddCollectionItemResponse: Codable, Sendable, Equatable {
  public var collectionID: UUID
  public var membershipID: UUID
  public var savedItemID: UUID
  public var collectionRevision: Int
  public var created: Bool
  public var saved: Bool

  enum CodingKeys: String, CodingKey {
    case created, saved
    case collectionID = "collection_id"
    case membershipID = "membership_id"
    case savedItemID = "saved_item_id"
    case collectionRevision = "collection_revision"
  }
}

public struct ItemSource: Codable, Sendable, Equatable, Identifiable, Hashable {
  public var id: UUID
  public var url: String
  public var title: String?
  public var publisher: String?
  public var retrievedAt: Date

  enum CodingKeys: String, CodingKey {
    case id, url, title, publisher
    case retrievedAt = "retrieved_at"
  }
}

public struct ItemWhyThis: Codable, Sendable, Equatable, Hashable {
  public var text: String
  public var sources: [ItemSource]
}

public struct ItemReference: Codable, Sendable, Equatable, Identifiable, Hashable {
  public var id: UUID
  public var name: String
  public var type: String
  public var relation: String?
  public var qualified: Bool
  public var hasPage: Bool
  public var readText: String?

  /// Chip text. A qualified (uncertain) reference is phrased as a
  /// resemblance, the same as web and Android (ReferenceCopy).
  public var displayName: String { qualified ? "Resembles \(name)" : name }

  enum CodingKeys: String, CodingKey {
    case id, name, type, relation, qualified
    case hasPage = "has_page"
    case readText = "read_text"
  }
}

extension ItemReference {
  /// How a reference reads on screen (same rule as the web and Android):
  /// `qualified` marks a resemblance or an uncertain match, so it and a
  /// `resembles` relation read "Resembles …"; only an unqualified depiction
  /// is the bare name. A text-only reference (a name read in the photo) is
  /// neither, and shows its name with `attribution`.
  public var phrase: String {
    if readText != nil { return name }
    if qualified || relation == "resembles" { return "Resembles \(name)" }
    return name
  }

  /// "Read in the photo: “…”" for a text-only reference, else nil.
  public var attribution: String? {
    readText.map { "Read in the photo: “\($0)”" }
  }
}

/// GET /v1/items/{id} — sourced detail plus cached related (at most 6).
public struct ItemDetailResponse: Codable, Sendable, Equatable {
  public var item: DiscoveryCard
  public var description: String?
  public var detail: String?
  public var reason: String?
  public var whyThis: ItemWhyThis?
  public var destinationURL: String?
  public var references: [ItemReference]
  public var related: [DiscoveryCard]
  public var relatedState: String
  public var relatedJobID: UUID?
  public var collectionIDs: [UUID]
  public var captureID: UUID?
  /// Style attributes that connected a capture-rail card (non-interactive chips).
  public var styleMatch: StyleMatch? = nil
  /// "From your photo." when it applies.
  public var experimentalLine: String? = nil

  enum CodingKeys: String, CodingKey {
    case item, description, detail, reason, references, related
    case styleMatch = "style_match"
    case experimentalLine = "experimental_line"
    case whyThis = "why_this"
    case destinationURL = "destination_url"
    case relatedState = "related_state"
    case relatedJobID = "related_job_id"
    case collectionIDs = "collection_ids"
    case captureID = "capture_id"
  }
}

/// POST /v1/items/{id}/discoveries — 202, explicit and bounded.
public struct RelatedDiscoveryResponse: Codable, Sendable, Equatable {
  public var jobID: UUID
  public var discoveryJobID: UUID
  public var reused: Bool

  enum CodingKeys: String, CodingKey {
    case reused
    case jobID = "job_id"
    case discoveryJobID = "discovery_job_id"
  }
}
