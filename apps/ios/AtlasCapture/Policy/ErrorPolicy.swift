import Foundation

/// Client reaction to each server error code (fixtures/native-contract/error-policy.json).
public enum ErrorPolicy {
  public enum Action: String, Equatable, Sendable {
    case surfaceNoRetry = "surface_no_retry"
    case signInRequired = "sign_in_required"
    case refreshThenRetryOnce = "refresh_then_retry_once"
    case featureUnavailableKeepLocal = "feature_unavailable_keep_local"
    case reloadState = "reload_state"
    case lockToOriginalAccount = "lock_to_original_account"
    case showLocalAction = "show_local_action"
    case retryBackoff = "retry_backoff"
    case resync
    case rejectItem = "reject_item"
    case pauseUntilQuota = "pause_until_quota"
    case retryBackoffIfRetryableElseSurface = "retry_backoff_if_retryable_else_surface"
  }

  public static func action(forCode code: String, retryable: Bool = false) -> Action {
    switch code {
    case "invalid_input", "csrf_failed": return .surfaceNoRetry
    case "unauthenticated", "token_revoked", "account_required": return .signInRequired
    case "token_expired": return .refreshThenRetryOnce
    case "scope_denied": return .featureUnavailableKeepLocal
    case "not_found", "conflict", "idempotency_conflict", "onboarding_required": return .reloadState
    case "account_mismatch": return .lockToOriginalAccount
    case "action_required": return .showLocalAction
    case "idempotency_in_progress", "rate_limited", "service_unavailable", "provider_unavailable", "internal":
      return .retryBackoff
    case "cursor_expired": return .resync
    case "payload_too_large", "unsupported_media", "duration_exceeded": return .rejectItem
    case "quota_exceeded": return .pauseUntilQuota
    default: return retryable ? .retryBackoff : .retryBackoffIfRetryableElseSurface
    }
  }

  /// On POST /v2/identity/switch only, these codes mean "already signed out".
  public static let switchTerminalCodes: Set<String> = ["token_revoked", "token_expired"]

  public static func isTerminalSignOut(code: String) -> Bool { switchTerminalCodes.contains(code) }
}

/// Exponential backoff without jitter (jitter is added by the caller):
/// 2 s doubling to a 300 s cap; a larger Retry-After wins.
public enum Backoff {
  public static let baseSeconds: Double = 2
  public static let factor: Double = 2
  public static let maxSeconds: Double = 300

  public static func delay(attempt: Int, retryAfter: TimeInterval? = nil) -> TimeInterval {
    let exponent = Double(max(attempt, 1) - 1)
    let computed = min(maxSeconds, baseSeconds * pow(factor, exponent))
    if let retryAfter, retryAfter > computed { return retryAfter }
    return computed
  }

  public static func jittered(attempt: Int, retryAfter: TimeInterval? = nil) -> TimeInterval {
    let base = delay(attempt: attempt, retryAfter: retryAfter)
    return base * Double.random(in: 0.8...1.0)
  }
}

/// Refresh-rotation rules (IDENTITY-CONTRACT native/refresh).
public enum RefreshPolicy {
  public enum Outcome: Equatable, Sendable {
    case success
    case networkError
    case http(Int)
  }

  public enum Action: String, Equatable, Sendable {
    case commitTokensThenClearPending = "commit_tokens_then_clear_pending"
    case retrySameRequestID = "retry_same_request_id"
    case signInRequired = "sign_in_required"
  }

  public static func action(outcome: Outcome, elapsed: TimeInterval) -> Action {
    switch outcome {
    case .success:
      return .commitTokensThenClearPending
    case .networkError:
      return elapsed <= AtlasContract.refreshRetryWindow ? .retrySameRequestID : .signInRequired
    case .http(let status):
      if status == 401 || status == 403 || status == 400 { return .signInRequired }
      return elapsed <= AtlasContract.refreshRetryWindow ? .retrySameRequestID : .signInRequired
    }
  }
}
