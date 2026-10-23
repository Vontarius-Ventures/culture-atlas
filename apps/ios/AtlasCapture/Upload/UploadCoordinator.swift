import Foundation
import Network

/// Drives kept drafts of the signed-in account through `/v2/uploads`
/// (BACKEND-CONTRACTS "Upload state and consistency", MED-01, MED-04).
///
/// Replaces Observer's `LibraryUploader` relay pipeline and its in-memory
/// upload identity: everything needed to resume (client capture id, upload id,
/// receipts, idempotency keys) is persisted in the draft before each step,
/// and a resumed draft asks the server for its state before sending bytes.
public actor UploadCoordinator {
  private let api: AtlasAPI
  private let store: DraftStore
  private let transfer: BackgroundTransfer
  private let network = NWPathMonitor()
  private var path: NWPath?
  private var running: Set<UUID> = []
  private var instructions: [UUID: [Int: PartInstruction]] = [:]
  public private(set) var signedInAccount: UUID?
  /// Observer for UI refresh (called with the changed draft).
  private var onChange: (@Sendable (DraftRecord) -> Void)?

  public init(api: AtlasAPI, store: DraftStore, transfer: BackgroundTransfer) {
    self.api = api
    self.store = store
    self.transfer = transfer
  }

  public func start(onChange: @escaping @Sendable (DraftRecord) -> Void) {
    self.onChange = onChange
    transfer.onPartFinished = { [weak self] info, outcome in
      Task { await self?.partFinished(info, outcome: outcome) }
    }
    network.pathUpdateHandler = { [weak self] path in
      Task { await self?.pathChanged(path) }
    }
    network.start(queue: DispatchQueue(label: "com.cultureatlas.app.network"))
  }

  public func setSignedInAccount(_ account: UUID?) {
    signedInAccount = account
    instructions.removeAll()
  }

  private func pathChanged(_ newPath: NWPath) async {
    path = newPath
    await resumeAll()
  }

  /// Wi-Fi only by default; a per-draft explicit cellular override.
  /// Before the first NWPath callback, `path` is nil — still try. Blocking
  /// here left Keep photos queued forever until the network next changed.
  func networkAllows(_ draft: DraftRecord) -> Bool {
    guard let path else { return true }
    guard path.status == .satisfied else { return false }
    return draft.allowCellular || (!path.isExpensive && !path.isConstrained)
  }

  /// Called on launch, after sign-in, on connectivity changes and after Keep.
  public func resumeAll() async {
    guard let account = signedInAccount else { return }
    for draft in store.drafts(owner: account) where [.queued, .uploading, .verifying].contains(draft.status) {
      await drive(draft.id)
    }
  }

  /// Sign-out: stop transfers of `owner` and lock its pending drafts.
  public func lockAll(owner: UUID) async {
    await transfer.cancelAll(owner: owner)
    for draft in store.drafts(owner: owner) where [.queued, .uploading, .verifying].contains(draft.status) {
      _ = try? store.update(draft.id, owner: owner) { $0.status = .locked }
    }
    running.removeAll()
    instructions.removeAll()
  }

  /// Owner signed back in: locked drafts become queued again.
  public func unlockAll(owner: UUID) async {
    for draft in store.drafts(owner: owner) where draft.status == .locked {
      _ = try? store.update(draft.id, owner: owner) { $0.status = $0.uploadID == nil ? .queued : .uploading }
    }
    await resumeAll()
  }

  public func drive(_ draftID: UUID) async {
    guard let account = signedInAccount, !running.contains(draftID),
      var draft = store.drafts(owner: account).first(where: { $0.id == draftID })
    else { return }
    // DraftLockPolicy: only the owner's session may move these bytes.
    guard DraftLockPolicy.visibility(draftOwner: draft.ownerAccountID, signedIn: account).uploadable else { return }
    if let next = draft.nextAttemptAt, next > Date() { return }
    guard networkAllows(draft) else { return }
    running.insert(draftID)
    defer { running.remove(draftID) }
    do {
      var current = draft
      for _ in 0..<24 {
        current = try await step(current)
        current.attempts = 0
        current.nextAttemptAt = nil
        current.errorCode = nil
        try persist(current)
        if ![.queued, .uploading, .verifying].contains(current.status) { break }
      }
    } catch let error as AtlasClientError {
      await handle(error, draft: draft)
    } catch {
      await handle(.transport(String(describing: error)), draft: draft)
    }
  }

  /// One pass: create → status → parts → complete.
  private func step(_ input: DraftRecord) async throws -> DraftRecord {
    var draft = input
    if draft.uploadID == nil {
      let request = CreateUploadRequest(
        clientCaptureID: draft.clientCaptureID, kind: draft.kind, source: draft.source, filename: draft.filename,
        contentType: draft.contentType, byteSize: draft.byteSize, sha256: draft.sha256,
        capturedAt: draft.capturedAt, captureSessionID: draft.captureSessionID, sourceRoute: draft.sourceRoute)
      let created: UploadResponse = try await api.call(
        "POST", "/v2/uploads", body: request, idempotencyKey: draft.createKey, expectedAccount: draft.ownerAccountID)
      draft.uploadID = created.uploadID
      draft.assetID = created.assetID
      draft.partSize = created.partSize
      draft.partCount = created.partCount
      draft.status = .uploading
      cache(created.parts, for: draft.id)
      try persist(draft)
    }
    guard let uploadID = draft.uploadID else { return draft }
    let status: UploadResponse = try await api.get("/v2/uploads/\(uploadID.uuidString.lowercased())")
    switch PartPlanner.nextStep(for: status.state) {
    case .markCommitted:
      draft.status = .committed
      return draft
    case .awaitServer:
      draft.status = .verifying
      return draft
    case .lockUntilOriginalAccount:
      draft.status = .locked
      return draft
    case .surfaceRejection:
      draft.status = .rejected
      draft.errorCode = status.errorCode
      return draft
    case .restartWithNewClientCaptureID:
      // The server keeps the expired/aborted upload under the old client id;
      // the bytes were never committed, so a new id cannot duplicate an asset.
      draft.clientCaptureID = UUID()
      draft.createKey = UUID()
      draft.completeKey = nil
      draft.uploadID = nil
      draft.assetID = nil
      draft.receipts = []
      draft.status = .queued
      return draft
    case .sendMissingParts:
      break
    }
    draft.partSize = status.partSize
    draft.partCount = status.partCount
    let merged = PartPlanner.merge(server: status.verifiedParts, local: draft.receipts)
    draft.receipts = merged.map { PartReceipt(partNumber: $0.key, etag: $0.value) }.sorted { $0.partNumber < $1.partNumber }
    if let parts = PartPlanner.completion(partCount: status.partCount, receipts: merged) {
      if draft.completeKey == nil {
        draft.completeKey = UUID()
        try persist(draft)
      }
      let completed: UploadResponse = try await api.call(
        "POST", "/v2/uploads/\(uploadID.uuidString.lowercased())/complete", body: CompleteUploadRequest(parts: parts),
        idempotencyKey: draft.completeKey, expectedAccount: draft.ownerAccountID)
      draft.status = completed.state == .committed ? .committed : .verifying
      return draft
    }
    let plan = PartPlanner.plan(byteSize: draft.byteSize, partSize: status.partSize)
    let active = await transfer.activeParts(draftID: draft.id)
    let missing = PartPlanner.missing(partCount: status.partCount, receipts: merged).filter { !active.contains($0) }
    let now = Date()
    let stale = missing.filter { number in
      guard let cached = instructions[draft.id]?[number] else { return true }
      return !PartPlanner.isUsable(cached, now: now)
    }
    for batch in PartPlanner.batches(stale) {
      let fresh: UploadPartsResponse = try await api.call(
        "POST", "/v2/uploads/\(uploadID.uuidString.lowercased())/parts", body: UploadPartsRequest(partNumbers: batch),
        expectedAccount: draft.ownerAccountID)
      cache(fresh.parts, for: draft.id)
    }
    // Bounded concurrency: at most two parts in flight per draft.
    for number in missing.prefix(max(0, 2 - active.count)) {
      guard let instruction = instructions[draft.id]?[number], let part = plan.first(where: { $0.number == number })
      else { continue }
      let file = try store.preparePart(draft, part: part)
      let info = BackgroundTransfer.TaskInfo(
        draftID: draft.id, ownerAccountID: draft.ownerAccountID, uploadID: uploadID, partNumber: number, partFile: file)
      switch await transfer.uploadForeground(info, instruction: instruction) {
      case .uploaded(let etag):
        draft.receipts.removeAll { $0.partNumber == number }
        draft.receipts.append(PartReceipt(partNumber: number, etag: etag))
      case .expiredInstruction:
        instructions[draft.id]?[number] = nil
      case .failed:
        break
      }
    }
    let uploaded = PartPlanner.merge(server: status.verifiedParts, local: draft.receipts)
    draft.receipts = uploaded.map { PartReceipt(partNumber: $0.key, etag: $0.value) }.sorted { $0.partNumber < $1.partNumber }
    if let parts = PartPlanner.completion(partCount: status.partCount, receipts: uploaded) {
      if draft.completeKey == nil {
        draft.completeKey = UUID()
        try persist(draft)
      }
      let completed: UploadResponse = try await api.call(
        "POST", "/v2/uploads/\(uploadID.uuidString.lowercased())/complete", body: CompleteUploadRequest(parts: parts),
        idempotencyKey: draft.completeKey, expectedAccount: draft.ownerAccountID)
      draft.status = completed.state == .committed ? .committed : .verifying
      return draft
    }
    draft.status = .uploading
    return draft
  }

  private func cache(_ parts: [PartInstruction], for draftID: UUID) {
    var map = instructions[draftID] ?? [:]
    for part in parts { map[part.partNumber] = part }
    instructions[draftID] = map
  }

  private func partFinished(_ info: BackgroundTransfer.TaskInfo, outcome: BackgroundTransfer.Outcome) async {
    switch outcome {
    case .uploaded(let etag):
      // Receipts are only recorded for the draft's owner and current upload.
      _ = try? store.update(info.draftID, owner: info.ownerAccountID) { draft in
        guard draft.uploadID == info.uploadID else { return }
        draft.receipts.removeAll { $0.partNumber == info.partNumber }
        draft.receipts.append(PartReceipt(partNumber: info.partNumber, etag: etag))
      }
    case .expiredInstruction:
      instructions[info.draftID]?[info.partNumber] = nil
    case .failed:
      break
    }
    if info.ownerAccountID == signedInAccount { await drive(info.draftID) }
  }

  private func handle(_ error: AtlasClientError, draft input: DraftRecord) async {
    var draft = input
    draft.errorCode = error.code
    switch error.policyAction {
    case .lockToOriginalAccount, .signInRequired:
      draft.status = .locked
    case .rejectItem, .surfaceNoRetry:
      // Audio may not yet be on this contract: keep the local recording.
      draft.status = draft.kind == .audio ? .failed : .rejected
    case .featureUnavailableKeepLocal:
      // e.g. glasses uploads not enabled for this account: keep the bytes local.
      draft.status = .failed
    case .reloadState:
      // A stale cached instruction or a changed upload: re-read next pass.
      instructions[draft.id] = nil
      if error.code == "not_found", draft.uploadID == nil, draft.captureSessionID != nil {
        // The remote-capture session ended before upload: upload without it.
        draft.captureSessionID = nil
        draft.createKey = UUID()
      }
      draft.attempts += 1
      draft.nextAttemptAt = Date().addingTimeInterval(Backoff.jittered(attempt: draft.attempts))
      if draft.attempts >= 8 { draft.status = .failed }
    case .pauseUntilQuota:
      draft.status = .failed
    default:
      if case .server(_, _, _, _, let retryAfter) = error {
        draft.attempts += 1
        draft.nextAttemptAt = Date().addingTimeInterval(Backoff.jittered(attempt: draft.attempts, retryAfter: retryAfter))
      } else {
        draft.attempts += 1
        draft.nextAttemptAt = Date().addingTimeInterval(Backoff.jittered(attempt: draft.attempts))
      }
    }
    try? persist(draft)
  }

  private func persist(_ draft: DraftRecord) throws {
    try store.save(draft)
    onChange?(draft)
  }
}
