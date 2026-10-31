import Foundation

public enum AtlasClientError: Error, Equatable, Sendable {
  /// The server's `{error:{code,...}}` body with its HTTP status.
  case server(status: Int, code: String, message: String, retryable: Bool, retryAfter: TimeInterval?)
  case transport(String)
  case decoding(String)
  case notSignedIn
  /// A draft belongs to another account than the signed-in one; nothing was sent.
  case draftLocked
  case refreshRequired

  public var code: String? {
    if case .server(_, let code, _, _, _) = self { return code }
    return nil
  }

  public var policyAction: ErrorPolicy.Action {
    switch self {
    case .server(_, let code, _, let retryable, _): return ErrorPolicy.action(forCode: code, retryable: retryable)
    case .transport: return .retryBackoff
    case .decoding: return .surfaceNoRetry
    case .notSignedIn, .refreshRequired: return .signInRequired
    case .draftLocked: return .lockToOriginalAccount
    }
  }
}

/// Safe sign-in presentation only. Never surface provider messages or callback URLs.
public enum SignInFeedback {
  public static func normalizedEmail(_ value: String) -> String {
    value.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  public static func isValidEmail(_ value: String) -> Bool {
    let address = normalizedEmail(value)
    guard address.count <= 254, !address.contains(where: { $0.isWhitespace }) else { return false }
    let parts = address.split(separator: "@", omittingEmptySubsequences: false)
    guard parts.count == 2, !parts[0].isEmpty, parts[0].count <= 64 else { return false }
    let labels = parts[1].split(separator: ".", omittingEmptySubsequences: false)
    return labels.count >= 2 && labels.allSatisfy { label in
      !label.isEmpty && label.first != "-" && label.last != "-"
        && label.allSatisfy { $0.isLetter || $0.isNumber || $0 == "-" }
    }
  }

  public static func message(for error: Error, callback: Bool = false) -> String {
    if error is KeychainStore.KeychainError {
      return "This iPhone couldn't securely save your sign-in. Unlock it and try again. If this continues, contact support; don't delete the app."
    }
    if let callbackError = error as? AccountService.CallbackError {
      switch callbackError {
      case .noPendingSignIn:
        return "Request a new link from this iPhone, then open it here."
      case .stateMismatch:
        return "This link doesn't match the latest request on this iPhone. Open the newest link or request another."
      case .malformedCallback:
        return "That sign-in link is incomplete. Open the latest link from your email or request another."
      }
    }
    if let apiError = error as? AtlasClientError {
      switch apiError {
      case .transport(let reason):
        if reason == "NSURLErrorDomain:-1009" {
          return "You're offline. Connect to Wi-Fi or cellular, then try again."
        }
        return "We couldn't reach culture atlas. Check your connection and try again."
      case .server(let status, let code, _, _, _):
        if status == 429 { return "Too many requests. Wait a moment, then try again." }
        if callback && (status == 410 || code == "token_expired") {
          return "This sign-in link has expired. Request a new link and open the latest one on this iPhone."
        }
        if callback && (status == 400 || status == 401 || status == 403) {
          return "That sign-in link couldn't be verified. Open the latest link on this iPhone or request another."
        }
        if status == 503 {
          return "Email sign-in is temporarily unavailable. Try again shortly."
        }
        if status >= 500 { return "The sign-in server couldn't finish the request. Try again shortly." }
        if !callback && (code == "invalid_email" || status == 422) {
          return "Check your email address, then try again."
        }
        return callback
          ? "We couldn't finish sign-in. Try opening the latest link again, or request a new one."
          : "We couldn't request a sign-in link. Check the address and try again."
      case .decoding:
        return "The sign-in server returned an unexpected response. Try again shortly."
      default: break
      }
    }
    return callback
      ? "We couldn't finish sign-in. Open the latest link on this iPhone or request another."
      : "We couldn't request a sign-in link. Please try again."
  }

  public static func retryDelay(for error: Error) -> TimeInterval? {
    guard case AtlasClientError.server(429, _, _, _, let retryAfter) = error else { return nil }
    return max(30, retryAfter.flatMap { $0.isFinite ? $0 : nil } ?? 30)
  }

  /// Allowlisted diagnostics only: no addresses, codes, provider payloads, or URLs.
  public static func diagnostic(for error: Error) -> String {
    if case KeychainStore.KeychainError.writeFailed(let status) = error { return "keychain_status_\(status)" }
    if let apiError = error as? AtlasClientError {
      switch apiError {
      case .server(let status, _, _, _, _): return "http_status_\(status)"
      case .transport(let reason):
        let parts = reason.split(separator: ":")
        if parts.count == 2, parts[0] == "NSURLErrorDomain", let code = Int(parts[1]) {
          return "url_error_\(code)"
        }
        return "transport_failure"
      case .decoding: return "unexpected_response"
      default: return "client_failure"
      }
    }
    if error is AccountService.CallbackError { return "callback_validation_failed" }
    return "sign_in_failure"
  }
}
