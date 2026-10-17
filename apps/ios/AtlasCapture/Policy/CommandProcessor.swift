import Foundation

/// Durable record of a remote command on this phone. Persisted BEFORE the
/// shutter so a crash or duplicate delivery can never cause a second capture.
public struct CommandReceipt: Codable, Equatable, Sendable {
  public enum State: String, Codable, Sendable {
    case executing, succeeded, failed, unknown
  }

  public var commandID: UUID
  public var accountID: UUID
  public var state: State
  public var lastAckSequence: Int
  public var localCaptureID: UUID
  public var resultAssetID: UUID?
  /// The last ack this phone decided to send; resent verbatim on duplicates.
  public var lastAck: CommandAck?
  public var acknowledged: Bool
  public var receivedAt: Date
}

/// Local facts the processor needs; gathered on the main actor.
public struct CommandLocalState: Equatable, Sendable {
  public var armedSessionID: UUID?
  public var armedGeneration: Int?
  public var armExpiresAt: Date?
  public var sessionMode: MediaKind?
  public var sourceReady: Bool
  public var recordingCommandID: UUID?
  public var storageOK: Bool

  public init(
    armedSessionID: UUID?, armedGeneration: Int?, armExpiresAt: Date?, sessionMode: MediaKind?,
    sourceReady: Bool, recordingCommandID: UUID?, storageOK: Bool
  ) {
    self.armedSessionID = armedSessionID
    self.armedGeneration = armedGeneration
    self.armExpiresAt = armExpiresAt
    self.sessionMode = sessionMode
    self.sourceReady = sourceReady
    self.recordingCommandID = recordingCommandID
    self.storageOK = storageOK
  }
}

/// Snapshot of an existing receipt as the decision table sees it.
public struct ReceiptSnapshot: Equatable, Sendable {
  public var state: CommandReceipt.State
  public var lastAckSequence: Int
  public var draftSaved: Bool
  public var resultAssetID: UUID?
  /// The exact terminal ack sent before, when one was recorded.
  public var lastAck: CommandAck?

  public init(
    state: CommandReceipt.State, lastAckSequence: Int, draftSaved: Bool, resultAssetID: UUID?,
    lastAck: CommandAck? = nil
  ) {
    self.state = state
    self.lastAckSequence = lastAckSequence
    self.draftSaved = draftSaved
    self.resultAssetID = resultAssetID
    self.lastAck = lastAck
  }
}

public struct CommandDecision: Equatable, Sendable {
  public enum Kind: String, Equatable, Sendable {
    case execute
    case resendAck = "resend_ack"
    case skipExpired = "skip_expired"
    case refuse
    case acknowledgeNoOp = "acknowledge_no_op"
  }

  public var kind: Kind
  public var persistReceipt: CommandReceipt.State?
  public var acks: [CommandAck]
  /// For start_video: the bounded clip length to record.
  public var durationSeconds: Int?
}

/// Pure decision table (fixtures/native-contract/command-lifecycle.json, DEV-02).
public enum CommandProcessor {
  public static func decide(
    command: DeviceCommand,
    receipt: ReceiptSnapshot?,
    local: CommandLocalState,
    now: Date,
    clipMaxSeconds: Int = AtlasContract.clipMaxSeconds
  ) -> CommandDecision {
    // A receipt means this phone already accepted the command: never re-execute.
    if let receipt {
      let next = receipt.lastAckSequence + 1
      switch receipt.state {
      case .succeeded:
        return CommandDecision(
          kind: .resendAck, persistReceipt: .succeeded,
          acks: [receipt.lastAck ?? CommandAck(sequence: receipt.lastAckSequence, state: .succeeded, resultAssetID: receipt.resultAssetID)],
          durationSeconds: nil)
      case .failed:
        return CommandDecision(
          kind: .resendAck, persistReceipt: .failed,
          acks: [receipt.lastAck ?? CommandAck(sequence: receipt.lastAckSequence, state: .failed, safeError: .deviceUnavailable)],
          durationSeconds: nil)
      case .unknown:
        return CommandDecision(
          kind: .resendAck, persistReceipt: .unknown,
          acks: [receipt.lastAck ?? CommandAck(sequence: receipt.lastAckSequence, state: .unknown, safeError: .outcomeUnknown)],
          durationSeconds: nil)
      case .executing:
        if command.action == .startVideo, local.recordingCommandID == command.commandID {
          // Still recording this command: nothing new to say yet.
          return CommandDecision(kind: .resendAck, persistReceipt: .executing,
            acks: [CommandAck(sequence: receipt.lastAckSequence, state: .executing)], durationSeconds: nil)
        }
        if receipt.draftSaved {
          return CommandDecision(
            kind: .resendAck, persistReceipt: .succeeded,
            acks: [CommandAck(sequence: next, state: .succeeded, resultAssetID: receipt.resultAssetID)],
            durationSeconds: nil)
        }
        // The shutter may or may not have fired: report unknown, never retake.
        return CommandDecision(
          kind: .resendAck, persistReceipt: .unknown,
          acks: [CommandAck(sequence: next, state: .unknown, safeError: .outcomeUnknown)],
          durationSeconds: nil)
      }
    }

    if command.expiresAt <= now {
      return CommandDecision(kind: .skipExpired, persistReceipt: nil, acks: [], durationSeconds: nil)
    }

    let sameSession = local.armedSessionID == command.sessionID && local.armedGeneration == command.generation

    if command.action == .stopVideo {
      // Stop stays available locally even after the arm window ends.
      guard sameSession else { return refuse(.permissionDenied) }
      if local.recordingCommandID != nil {
        return CommandDecision(kind: .execute, persistReceipt: .executing,
          acks: [CommandAck(sequence: 1, state: .executing)], durationSeconds: nil)
      }
      return CommandDecision(
        kind: .acknowledgeNoOp, persistReceipt: .succeeded,
        acks: [CommandAck(sequence: 1, state: .executing), CommandAck(sequence: 2, state: .succeeded)],
        durationSeconds: nil)
    }

    guard sameSession, let armExpiresAt = local.armExpiresAt, armExpiresAt > now else {
      return refuse(.permissionDenied)
    }
    let mode: MediaKind = command.action == .capturePhoto ? .photo : .video
    guard local.sessionMode == mode, local.sourceReady, local.recordingCommandID == nil else {
      return refuse(.deviceUnavailable)
    }
    guard local.storageOK else { return refuse(.storageFull) }
    let duration = command.action == .startVideo
      ? min(max(command.durationSeconds ?? clipMaxSeconds, 1), clipMaxSeconds)
      : nil
    return CommandDecision(kind: .execute, persistReceipt: .executing,
      acks: [CommandAck(sequence: 1, state: .executing)], durationSeconds: duration)
  }

  private static func refuse(_ error: SafeCommandError) -> CommandDecision {
    CommandDecision(kind: .refuse, persistReceipt: .failed,
      acks: [CommandAck(sequence: 1, state: .failed, safeError: error)], durationSeconds: nil)
  }

  public enum Outcome: String, Equatable, Sendable {
    case saved
    case interruptedWithFile = "interrupted_with_file"
    case interruptedWithoutFile = "interrupted_without_file"
    case storageFull = "storage_full"
    case permissionDenied = "permission_denied"
    case deviceUnavailable = "device_unavailable"
    case unknown
  }

  /// The ack that reports a finished execution. `succeeded` means the local
  /// file is durably recorded; cloud availability is reported by asset commit.
  public static func ack(for outcome: Outcome, sequence: Int, resultAssetID: UUID?) -> CommandAck {
    switch outcome {
    case .saved, .interruptedWithFile:
      return CommandAck(sequence: sequence, state: .succeeded, resultAssetID: resultAssetID)
    case .interruptedWithoutFile:
      return CommandAck(sequence: sequence, state: .failed, safeError: .interrupted)
    case .storageFull:
      return CommandAck(sequence: sequence, state: .failed, safeError: .storageFull)
    case .permissionDenied:
      return CommandAck(sequence: sequence, state: .failed, safeError: .permissionDenied)
    case .deviceUnavailable:
      return CommandAck(sequence: sequence, state: .failed, safeError: .deviceUnavailable)
    case .unknown:
      return CommandAck(sequence: sequence, state: .unknown, safeError: .outcomeUnknown)
    }
  }
}
