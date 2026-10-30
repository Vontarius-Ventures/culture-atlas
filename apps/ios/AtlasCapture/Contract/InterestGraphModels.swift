import Foundation

/// Wire models for the typed owner/native graph operations (PR 8 package E;
/// VAL-API-001/VAL-NATIVE-001). The owner is always the signed-in account of
/// the installation session — no route names an account id — and the shared
/// fixtures/native-contract/messages.json examples pin every body shape.
/// Unknown response fields are ignored, so additive server fields keep this
/// and older clients decoding.

// MARK: - Summary (GET /v2/me/interest-graph)

/// One confirmed explicit interest: the owner's own current save or pick.
public struct InterestSummaryItem: Codable, Sendable, Equatable, Identifiable, Hashable {
  public var edgeID: UUID?
  public var itemID: UUID
  public var canonicalKey: String
  public var kind: String
  public var title: String
  public var savedItemID: UUID
  public var pickIDs: [UUID]
  public var captureID: UUID?
  public var analysisID: UUID?

  public var id: UUID { itemID }

  enum CodingKeys: String, CodingKey {
    case kind, title
    case edgeID = "edge_id"
    case itemID = "item_id"
    case canonicalKey = "canonical_key"
    case savedItemID = "saved_item_id"
    case pickIDs = "pick_ids"
    case captureID = "capture_id"
    case analysisID = "analysis_id"
  }
}

/// One derived tentative affinity; suppression survives projection rebuilds.
public struct TentativeInterestItem: Codable, Sendable, Equatable, Identifiable, Hashable {
  public enum Relation: String, Codable, Sendable { case depicted, resembles, userSelected = "user_selected" }
  public enum Resolution: String, Codable, Sendable { case resolved, userConfirmed = "user_confirmed" }
  public enum State: String, Codable, Sendable { case tentative, suppressed }

  public var edgeID: UUID
  public var nodeID: UUID
  public var name: String
  public var relation: Relation
  public var resolution: Resolution
  public var isAnchor: Bool
  public var state: State
  public var captureID: UUID
  public var analysisID: UUID?
  public var analysisVersion: Int?
  public var captureReferenceID: UUID
  public var referenceID: UUID

  public var id: UUID { edgeID }

  enum CodingKeys: String, CodingKey {
    case name, relation, state
    case edgeID = "edge_id"
    case nodeID = "node_id"
    case resolution = "resolution_status"
    case isAnchor = "is_anchor"
    case captureID = "capture_id"
    case analysisID = "analysis_id"
    case analysisVersion = "analysis_version"
    case captureReferenceID = "capture_reference_id"
    case referenceID = "reference_id"
  }
}

/// One bounded page of the owner's two graph lists.
public struct InterestGraphPage<Item: Codable & Sendable & Equatable & Hashable>: Codable, Sendable, Equatable {
  public var items: [Item]
  public var nextCursor: String?

  enum CodingKeys: String, CodingKey {
    case items
    case nextCursor = "next_cursor"
  }
}

/// The graph-control state every control response echoes back (one shared
/// optimistic revision for every typed mutation).
public struct InterestGraphSettings: Codable, Sendable, Equatable {
  public var revision: Int
  public var discoveryPaused: Bool
  public var pausedAt: Date?

  enum CodingKeys: String, CodingKey {
    case revision
    case discoveryPaused = "discovery_paused"
    case pausedAt = "paused_at"
  }
}

/// Honest projection/background status (a pure read: no provider or model
/// calls happen to fill this in).
public struct InterestGraphProjection: Codable, Sendable, Equatable {
  public enum State: String, Codable, Sendable {
    case neverProjected = "never_projected"
    case idle, queued, running, ready, failed
  }

  public var state: State
  public var supportVersion: Int
  public var targetTasteRevision: Int
  public var appliedTasteRevision: Int
  public var currentTasteRevision: Int
  public var lagging: Bool
  public var pendingEvents: Int
  public var lastProjectedAt: Date?

  enum CodingKeys: String, CodingKey {
    case state, lagging
    case supportVersion = "support_version"
    case targetTasteRevision = "target_taste_revision"
    case appliedTasteRevision = "applied_taste_revision"
    case currentTasteRevision = "current_taste_revision"
    case pendingEvents = "pending_events"
    case lastProjectedAt = "last_projected_at"
  }
}

/// GET /v2/me/interest-graph response: settings, projection status and the
/// two paginated lists, all scoped to the caller's account.
public struct InterestGraphSummary: Codable, Sendable, Equatable {
  public var ownerAccountID: UUID
  public var settings: InterestGraphSettings
  public var projection: InterestGraphProjection
  public var counts: Counts
  public var interests: InterestGraphPage<InterestSummaryItem>
  public var tentative: InterestGraphPage<TentativeInterestItem>

  public struct Counts: Codable, Sendable, Equatable {
    public var confirmed: Int
    public var tentative: Int
    public var suppressed: Int
  }

  enum CodingKeys: String, CodingKey {
    case settings, projection, counts, interests, tentative
    case ownerAccountID = "owner_account_id"
  }
}

// MARK: - Controls (PATCH bodies and responses)

/// PATCH /v2/me/interest-graph/settings — desired state, so a retry of an
/// already-satisfied request is an idempotent no-op instead of a conflict.
public struct UpdateInterestGraphSettingsBody: Codable, Sendable, Equatable {
  public var expectedRevision: Int
  public var discoveryPaused: Bool

  public init(expectedRevision: Int, discoveryPaused: Bool) {
    self.expectedRevision = expectedRevision
    self.discoveryPaused = discoveryPaused
  }

  enum CodingKeys: String, CodingKey {
    case discoveryPaused = "discovery_paused"
    case expectedRevision = "expected_revision"
  }
}

/// PATCH /v2/me/interest-graph/settings response (the echoed settings).
public struct UpdateInterestGraphSettingsResponse: Codable, Sendable, Equatable {
  public var settings: InterestGraphSettings
}

/// PATCH /v2/me/interest-graph/interests/{id} — suppress or restore a
/// tentative affinity (desired state, same optimistic revision).
public struct UpdateInterestGraphInterestBody: Codable, Sendable, Equatable {
  public var expectedRevision: Int
  public var state: TentativeInterestItem.State

  public init(expectedRevision: Int, state: TentativeInterestItem.State) {
    self.expectedRevision = expectedRevision
    self.state = state
  }

  enum CodingKeys: String, CodingKey {
    case state
    case expectedRevision = "expected_revision"
  }
}

/// PATCH /v2/me/interest-graph/interests/{id} response.
public struct UpdateInterestGraphInterestResponse: Codable, Sendable, Equatable {
  public var edgeID: UUID
  public var nodeID: UUID
  public var state: TentativeInterestItem.State
  public var settings: InterestGraphSettings

  enum CodingKeys: String, CodingKey {
    case state, settings
    case edgeID = "edge_id"
    case nodeID = "node_id"
  }
}

// MARK: - Recommendation connection (GET /v2/me/recommendations/{id}/connection)

/// One named endpoint of a shared cultural edge.
public struct ConnectionNodeRef: Codable, Sendable, Equatable, Hashable {
  public var nodeID: UUID
  public var name: String

  enum CodingKeys: String, CodingKey {
    case name
    case nodeID = "node_id"
  }
}

/// One shared cultural edge behind a connection.
public struct ConnectionEdge: Codable, Sendable, Equatable, Hashable {
  public enum Predicate: String, Codable, Sendable {
    case createdBy = "CREATED_BY"
    case about = "ABOUT"
    case usesTechnique = "USES_TECHNIQUE"
    case hasAttribute = "HAS_ATTRIBUTE"
    case documentedAssociation = "DOCUMENTED_ASSOCIATION"
    case audienceAffinity = "AUDIENCE_AFFINITY"
  }

  public var subject: ConnectionNodeRef
  public var predicate: Predicate
  public var object: ConnectionNodeRef
  public var associationSubtype: String?

  enum CodingKeys: String, CodingKey {
    case subject, predicate, object
    case associationSubtype = "association_subtype"
  }

  /// Minimal, mechanical phrasing (the same rule as the web disclosure).
  public var predicateText: String {
    switch predicate {
    case .createdBy: return "created by"
    case .about: return "about"
    case .usesTechnique: return "uses technique"
    case .hasAttribute: return "has attribute"
    case .audienceAffinity: return "liked by people who like"
    case .documentedAssociation:
      return (associationSubtype ?? "documented association").replacingOccurrences(of: "_", with: " ")
    }
  }
}

/// A permitted source link behind the connection.
public struct ConnectionSource: Codable, Sendable, Equatable, Identifiable, Hashable {
  public var id: UUID
  public var url: String
  public var title: String?
  public var publisher: String?
  public var locator: String?
  public var excerpt: String?
  public var retrievedAt: Date

  enum CodingKeys: String, CodingKey {
    case id, url, title, publisher, locator, excerpt
    case retrievedAt = "retrieved_at"
  }
}

/// The owner's own current support behind the relevance half (no scores).
public struct ConnectionSupportRoot: Codable, Sendable, Equatable, Hashable {
  public enum Origin: String, Codable, Sendable {
    case explicitSave = "explicit_save"
    case pickGroup = "pick_group"
    case captureReference = "capture_reference"
    case analysis
  }

  public var edgeID: UUID
  public var origin: Origin
  public var label: String

  enum CodingKeys: String, CodingKey {
    case origin, label
    case edgeID = "edge_id"
  }

  /// How the support reads on screen, phrased by how it was earned (the same
  /// rule as the web disclosure).
  public var phrase: String {
    switch origin {
    case .explicitSave: return "Because you saved \(label)."
    case .pickGroup: return "Because you picked \(label)."
    case .captureReference: return "Because your photo shows \(label)."
    case .analysis: return "Because your photo's reading includes \(label)."
    }
  }
}

public struct ConnectionSupport: Codable, Sendable, Equatable {
  public var roots: [ConnectionSupportRoot]
}

/// GET /v2/me/recommendations/{id}/connection response. `provenance` says
/// honestly what backs the reason; `state == unavailable` is shown as
/// unavailable, never substituted by another reason. `origin` is an internal
/// server value that is never shown raw, so it decodes as a plain string.
public struct RecommendationConnection: Codable, Sendable, Equatable {
  public enum Provenance: String, Codable, Sendable { case graphRun = "graph_run", scopedDiscovery = "scoped_discovery", legacy }
  public enum State: String, Codable, Sendable { case connected, unavailable }
  public enum Intent: String, Codable, Sendable { case personal, photo }

  public struct Reason: Codable, Sendable, Equatable {
    public var text: String?
    public var template: String?
  }

  public var recommendationID: UUID
  public var origin: String
  public var provenance: Provenance
  public var state: State
  public var intent: Intent?
  public var graphRunID: UUID?
  public var reason: Reason
  public var path: [ConnectionEdge]?
  public var sources: [ConnectionSource]
  public var support: ConnectionSupport?
  public var unavailableReason: String?

  enum CodingKeys: String, CodingKey {
    case origin, provenance, state, intent, reason, path, sources, support
    case recommendationID = "recommendation_id"
    case graphRunID = "graph_run_id"
    case unavailableReason = "unavailable_reason"
  }
}
