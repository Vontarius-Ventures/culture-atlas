import Foundation

/// Local drafts belong to the account that captured them (TEN-02,
/// fixtures/native-contract/draft-lock.json). They are listed and uploaded
/// only while that account is signed in, and are never re-owned.
public enum DraftLockPolicy {
  public struct Visibility: Equatable, Sendable {
    public var visible: Bool
    public var uploadable: Bool
    public var lockedNotice: Bool
  }

  public static func visibility(draftOwner: UUID, signedIn: UUID?) -> Visibility {
    let owner = signedIn == draftOwner
    return Visibility(visible: owner, uploadable: owner, lockedNotice: !owner)
  }

  /// Header value for every upload mutation: the draft owner, not whoever is
  /// signed in now, so a switched credential fails with `account_mismatch`.
  public static func expectedAccountHeader(draftOwner: UUID) -> String {
    draftOwner.uuidString.lowercased()
  }

  public enum Effect: String, Equatable, Sendable {
    case lockToOwner = "lock_to_owner"
    case keepLocked = "keep_locked"
    case none
  }

  public static func effect(forErrorCode code: String) -> Effect {
    switch code {
    case "account_mismatch": return .lockToOwner
    case "token_revoked", "unauthenticated": return .keepLocked
    default: return .none
    }
  }

  public static func effect(forUploadState state: UploadState, pauseReason: String?) -> Effect {
    state == .paused && pauseReason == "authority_ended" ? .lockToOwner : .none
  }

  public enum SignOutStep: String, CaseIterable, Sendable {
    case stopCaptureAndRecording = "stop_capture_and_recording"
    case disarmAndEndCaptureSession = "disarm_and_end_capture_session_best_effort"
    case stopCommandPolling = "stop_command_polling"
    case cancelInFlightTransfers = "cancel_in_flight_transfers"
    case lockPendingDrafts = "lock_pending_drafts_to_owner"
    case callIdentitySwitch = "call_identity_switch"
    case clearCredentials = "clear_credentials"
  }

  /// Order matters: authority ends locally before credentials disappear.
  public static let signOutOrder: [SignOutStep] = SignOutStep.allCases
}
