import CryptoKit
import Foundation

/// What the capture layer exposes to remote commands. Implementations save
/// the capture as a draft whose id is `captureID` (the command's
/// capture_client_id) BEFORE returning `.saved`.
public protocol RemoteCaptureExecutor: Sendable {
  @MainActor func localState() -> CommandLocalState
  @MainActor func draftSaved(captureID: UUID) -> Bool
  @MainActor func capturePhoto(captureID: UUID, commandID: UUID, sessionID: UUID) async -> CommandProcessor.Outcome
  @MainActor func startVideo(captureID: UUID, commandID: UUID, sessionID: UUID, durationSeconds: Int) async -> CommandProcessor.Outcome
  @MainActor func stopVideo() async
  /// Best effort: create the upload in the command's session to learn the asset id.
  func resultAssetID(captureID: UUID) async -> UUID?
}

/// Persisted command receipts (one JSON file per account).
public final class ReceiptStore: @unchecked Sendable {
  private let directory: URL
  private let lock = NSLock()

  public init(directory: URL) {
    self.directory = directory
  }

  private func file(_ account: UUID) -> URL {
    directory.appendingPathComponent("receipts-\(account.uuidString.lowercased()).json")
  }

  struct Stored: Codable {
    var afterSequence: Int
    var receipts: [UUID: CommandReceipt]
  }

  private func read(_ account: UUID) -> Stored {
    guard let data = try? Data(contentsOf: file(account)),
      let stored = try? AtlasJSON.decoder().decode(Stored.self, from: data)
    else { return Stored(afterSequence: 0, receipts: [:]) }
    return stored
  }

  private func write(_ stored: Stored, _ account: UUID) throws {
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    try AtlasJSON.encoder().encode(stored).write(
      to: file(account), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
  }

  public func receipt(_ commandID: UUID, account: UUID) -> CommandReceipt? {
    lock.withLock { read(account).receipts[commandID] }
  }

  public func put(_ receipt: CommandReceipt) throws {
    try lock.withLock {
      var stored = read(receipt.accountID)
      stored.receipts[receipt.commandID] = receipt
      // Bounded retention: keep the most recent 200 receipts.
      if stored.receipts.count > 200 {
        let oldest = stored.receipts.values.sorted { $0.receivedAt < $1.receivedAt }.prefix(stored.receipts.count - 200)
        for receipt in oldest { stored.receipts[receipt.commandID] = nil }
      }
      try write(stored, receipt.accountID)
    }
  }

  public func afterSequence(account: UUID) -> Int { lock.withLock { read(account).afterSequence } }

  public func setAfterSequence(_ value: Int, account: UUID) throws {
    try lock.withLock {
      var stored = read(account)
      stored.afterSequence = max(stored.afterSequence, value)
      try write(stored, account)
    }
  }

  /// Receipts left `executing` by a crash; reported on next launch.
  public func unfinished(account: UUID) -> [CommandReceipt] {
    lock.withLock { read(account).receipts.values.filter { $0.state == .executing } }
  }
}

/// Polls `GET /v2/device/commands` only while this phone is explicitly armed
/// and in the foreground, and runs each command through `CommandProcessor`.
/// Sign-out cancels it; nothing re-arms it automatically.
public actor RemoteCommandRunner {
  private let api: AtlasAPI
  private let receipts: ReceiptStore
  private let executor: RemoteCaptureExecutor
  private var loop: Task<Void, Never>?
  private var account: UUID?

  public init(api: AtlasAPI, receipts: ReceiptStore, executor: RemoteCaptureExecutor) {
    self.api = api
    self.receipts = receipts
    self.executor = executor
  }

  public var isPolling: Bool { loop != nil }

  public func start(account: UUID) {
    guard loop == nil else { return }
    self.account = account
    loop = Task { [weak self] in await self?.run(account: account) }
  }

  public func stop() {
    loop?.cancel()
    loop = nil
    account = nil
  }

  /// After relaunch: commands left `executing` report succeeded or unknown.
  public func reconcileAfterLaunch(account: UUID) async {
    for receipt in receipts.unfinished(account: account) {
      let saved = await executor.draftSaved(captureID: receipt.localCaptureID)
      let ack = saved
        ? CommandAck(sequence: receipt.lastAckSequence + 1, state: .succeeded, resultAssetID: receipt.resultAssetID)
        : CommandAck(sequence: receipt.lastAckSequence + 1, state: .unknown, safeError: .outcomeUnknown)
      var updated = receipt
      updated.state = saved ? .succeeded : .unknown
      updated.lastAckSequence = ack.sequence
      updated.lastAck = ack
      updated.acknowledged = false
      try? receipts.put(updated)
      await send(ack, commandID: receipt.commandID, account: account)
    }
  }

  private func run(account: UUID) async {
    var attempt = 0
    while !Task.isCancelled {
      do {
        let batch = try await api.pollCommands(afterSequence: receipts.afterSequence(account: account))
        attempt = 0
        for command in batch.items { await process(command, account: account) }
        try? receipts.setAfterSequence(batch.nextSequence, account: account)
      } catch {
        if case AtlasClientError.server(_, let code, _, _, _) = error,
          ErrorPolicy.action(forCode: code) == .signInRequired
        {
          return
        }
        attempt += 1
        try? await Task.sleep(nanoseconds: UInt64(Backoff.jittered(attempt: attempt) * 1_000_000_000))
      }
    }
  }

  func process(_ command: DeviceCommand, account: UUID) async {
    let existing = receipts.receipt(command.commandID, account: account)
    let snapshot: ReceiptSnapshot?
    if let existing {
      snapshot = ReceiptSnapshot(
        state: existing.state, lastAckSequence: existing.lastAckSequence,
        draftSaved: await executor.draftSaved(captureID: existing.localCaptureID),
        resultAssetID: existing.resultAssetID, lastAck: existing.lastAck)
    } else {
      snapshot = nil
    }
    let local = await executor.localState()
    let decision = CommandProcessor.decide(command: command, receipt: snapshot, local: local, now: Date())
    guard decision.kind != .skipExpired else { return }

    // Persist the receipt BEFORE any hardware effect or ack.
    var receipt = existing ?? CommandReceipt(
      commandID: command.commandID, accountID: account, state: .executing, lastAckSequence: 0,
      localCaptureID: command.captureClientID, resultAssetID: nil, lastAck: nil, acknowledged: false,
      receivedAt: Date())
    if let state = decision.persistReceipt { receipt.state = state }
    if let last = decision.acks.last {
      receipt.lastAckSequence = last.sequence
      receipt.lastAck = last
    }
    do { try receipts.put(receipt) } catch { return }
    for ack in decision.acks { await send(ack, commandID: command.commandID, account: account) }
    guard decision.kind == .execute else { return }
    if command.action == .startVideo {
      // Recording can last a minute; keep polling so a Stop command is seen.
      Task { await self.execute(command, decision: decision, receipt: receipt, account: account) }
    } else {
      await execute(command, decision: decision, receipt: receipt, account: account)
    }
  }

  private func execute(_ command: DeviceCommand, decision: CommandDecision, receipt input: CommandReceipt, account: UUID) async {
    var receipt = input
    let outcome: CommandProcessor.Outcome
    switch command.action {
    case .capturePhoto:
      outcome = await executor.capturePhoto(
        captureID: command.captureClientID, commandID: command.commandID, sessionID: command.sessionID)
    case .startVideo:
      outcome = await executor.startVideo(
        captureID: command.captureClientID, commandID: command.commandID, sessionID: command.sessionID,
        durationSeconds: decision.durationSeconds ?? AtlasContract.clipMaxSeconds)
    case .stopVideo:
      await executor.stopVideo()
      outcome = .saved
    }
    var assetID: UUID?
    if command.action != .stopVideo, outcome == .saved || outcome == .interruptedWithFile {
      assetID = await executor.resultAssetID(captureID: command.captureClientID)
    }
    let final = CommandProcessor.ack(for: outcome, sequence: receipt.lastAckSequence + 1, resultAssetID: assetID)
    switch final.state {
    case .succeeded: receipt.state = .succeeded
    case .unknown: receipt.state = .unknown
    default: receipt.state = .failed
    }
    receipt.lastAckSequence = final.sequence
    receipt.lastAck = final
    receipt.resultAssetID = assetID
    try? receipts.put(receipt)
    await send(final, commandID: command.commandID, account: account)
  }

  /// Acks are retried a few times; the server treats a repeated sequence as a no-op.
  private func send(_ ack: CommandAck, commandID: UUID, account: UUID) async {
    let key = Self.ackKey(commandID: commandID, sequence: ack.sequence)
    for attempt in 1...4 {
      do {
        _ = try await api.acknowledge(commandID: commandID, ack: ack, key: key)
        return
      } catch let error as AtlasClientError where error.policyAction == .retryBackoff {
        try? await Task.sleep(nanoseconds: UInt64(Backoff.jittered(attempt: attempt) * 1_000_000_000))
      } catch {
        return
      }
    }
  }

  /// Deterministic Idempotency-Key per (command, sequence): a resent ack replays.
  static func ackKey(commandID: UUID, sequence: Int) -> UUID {
    var bytes = Array(SHA256.hash(data: Data("\(commandID.uuidString.lowercased()):\(sequence)".utf8)).prefix(16))
    bytes[6] = (bytes[6] & 0x0F) | 0x80  // version 8 (custom)
    bytes[8] = (bytes[8] & 0x3F) | 0x80  // RFC 4122 variant
    return UUID(uuid: (bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
      bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]))
  }
}
