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
