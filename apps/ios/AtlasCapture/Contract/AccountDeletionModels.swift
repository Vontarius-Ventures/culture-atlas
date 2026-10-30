import Foundation

/// Wire models for the first-party account-deletion lifecycle (VAL-DELETE-001/
/// 002/004). The owner is always the signed-in account of the installation
/// session — no route names an account id — and the one-time status token is
/// the only credential that keeps answering after the acceptance revoked
/// every other authority. Unknown response fields are ignored, so additive
/// server fields keep this and older clients decoding.

// MARK: - Disclosure (served with every state and status answer)

/// The truthful, user-facing disclosure: what the acceptance revokes
/// immediately, what the durable cleanup removes, and what is retained with
/// its actual limits (never claimed as immediate erasure).
public struct AccountDeletionDisclosure: Codable, Sendable, Equatable {
  public var summary: String
  public var immediate: [String]
  public var cleanupSteps: [String]
  public var retained: [String]

  enum CodingKeys: String, CodingKey {
    case summary, immediate, retained
    case cleanupSteps = "cleanup_steps"
  }
}

// MARK: - Status (one deletion's honest lifecycle snapshot)

public struct AccountDeletionStatus: Codable, Sendable, Equatable {
  public enum State: String, Codable, Sendable {
    case pending, purging, failed, complete
  }

  public var state: State
  public var requestedAt: Date
  public var acceptedAt: Date
  public var completedAt: Date?
  /// Steps finished, in run order; a step appears only once it is done.
  public var completedSteps: [String]
  /// Steps still owed for completion.
  public var pendingSteps: [String]
  /// Cleanup attempts so far (every attempt that started work).
  public var attempts: Int
  /// The last attempt's error code; never a provider or internal detail.
  public var lastErrorCode: String?
  /// True while private data still exists and the cleanup will retry.
  public var retrying: Bool

  enum CodingKeys: String, CodingKey {
    case state, attempts, retrying
    case requestedAt = "requested_at"
    case acceptedAt = "accepted_at"
    case completedAt = "completed_at"
    case completedSteps = "completed_steps"
    case pendingSteps = "pending_steps"
    case lastErrorCode = "last_error_code"
  }
}

// MARK: - GET /v2/me/account-deletion (the owner's own state)

public struct AccountDeletionOverview: Codable, Sendable, Equatable {
  public enum State: String, Codable, Sendable {
    case none, pending, purging, failed, complete
  }

  public var requested: Bool
  public var state: State
  /// Present when a deletion has been accepted (null while state is 'none').
  public var status: AccountDeletionStatus?
  public var disclosure: AccountDeletionDisclosure
}

// MARK: - POST /v2/me/account-deletion (accept the deletion)

/// The typed acceptance: `confirm` must be literally true. `statusToken` is
/// the caller-generated one-time capability for the public status route
/// (>= 32 random bytes, URL-safe; the server stores only its SHA-256).
public struct RequestAccountDeletionBody: Codable, Sendable, Equatable {
  public var confirm: Bool
  public var statusToken: String?

  enum CodingKeys: String, CodingKey {
    case confirm
    case statusToken = "status_token"
  }

  public init(confirm: Bool, statusToken: String?) {
    self.confirm = confirm
    self.statusToken = statusToken
  }
}

public struct RequestAccountDeletionResponse: Codable, Sendable, Equatable {
  public var status: AccountDeletionStatus
  /// The status capability token: present when first accepted (caller-supplied
  /// or server-minted) and on a retry that re-presents the same stored token;
  /// null when the caller cannot re-present a server-minted one.
  public var statusToken: String?
  public var disclosure: AccountDeletionDisclosure

  enum CodingKeys: String, CodingKey {
    case status, disclosure
    case statusToken = "status_token"
  }
}

// MARK: - GET /v2/account-deletion/status (capability-token gated, public)

public struct AccountDeletionStatusResponse: Codable, Sendable, Equatable {
  public var status: AccountDeletionStatus
  public var disclosure: AccountDeletionDisclosure
}
