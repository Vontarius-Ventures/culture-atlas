import Foundation

/// One multipart slice of a plaintext media file.
public struct PlannedPart: Equatable, Sendable {
  public let number: Int
  public let offset: Int64
  public let length: Int64
}

/// Pure multipart rules (fixtures/native-contract/upload-parts.json). The part
/// size always comes from the server's upload response.
public enum PartPlanner {
  public static func plan(byteSize: Int64, partSize: Int64) -> [PlannedPart] {
    precondition(partSize > 0, "part size must be positive")
    var parts: [PlannedPart] = []
    var offset: Int64 = 0
    var number = 1
    while offset < byteSize {
      parts.append(PlannedPart(number: number, offset: offset, length: min(partSize, byteSize - offset)))
      offset += partSize
      number += 1
    }
    return parts
  }

  /// Splits part numbers into `/parts` requests of at most `maxPerRequest`.
  public static func batches(_ missing: [Int], maxPerRequest: Int = AtlasContract.maxPartNumbersPerRequest) -> [[Int]] {
    stride(from: 0, to: missing.count, by: maxPerRequest).map {
      Array(missing[$0..<min($0 + maxPerRequest, missing.count)])
    }
  }

  /// Local receipts first, then server-verified parts, so the server's etag wins.
  public static func merge(server: [PartReceipt], local: [PartReceipt]) -> [Int: String] {
    var merged: [Int: String] = [:]
    for receipt in local { merged[receipt.partNumber] = receipt.etag }
    for receipt in server { merged[receipt.partNumber] = receipt.etag }
    return merged
  }

  public static func missing(partCount: Int, receipts: [Int: String]) -> [Int] {
    guard partCount > 0 else { return [] }
    return (1...partCount).filter { receipts[$0] == nil }
  }

  /// Completion payload: every part, ascending. Nil while any part is missing.
  public static func completion(partCount: Int, receipts: [Int: String]) -> [PartReceipt]? {
    guard missing(partCount: partCount, receipts: receipts).isEmpty, partCount > 0 else { return nil }
    return (1...partCount).map { PartReceipt(partNumber: $0, etag: receipts[$0]!) }
  }

  public enum NextStep: String, Equatable, Sendable {
    case markCommitted = "mark_committed"
    case awaitServer = "await_server"
    case sendMissingParts = "send_missing_parts"
    case lockUntilOriginalAccount = "lock_until_original_account"
    case surfaceRejection = "surface_rejection"
    case restartWithNewClientCaptureID = "restart_with_new_client_capture_id"
  }

  /// What a resumed draft does after asking `GET /v2/uploads/{id}`.
  public static func nextStep(for state: UploadState) -> NextStep {
    switch state {
    case .committed: return .markCommitted
    case .verifying: return .awaitServer
    case .created, .uploading: return .sendMissingParts
    case .paused: return .lockUntilOriginalAccount
    case .rejected: return .surfaceRejection
    case .expired, .aborted: return .restartWithNewClientCaptureID
    }
  }

  /// A signed instruction is reused only while it has more than the margin left.
  public static func isUsable(_ instruction: PartInstruction, now: Date) -> Bool {
    instruction.expiresAt.timeIntervalSince(now) > AtlasContract.partInstructionRefreshMargin
  }
}
