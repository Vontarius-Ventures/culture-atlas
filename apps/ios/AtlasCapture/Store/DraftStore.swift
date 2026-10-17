import CryptoKit
import Foundation

/// One locally captured photo/video and its upload progress. Persisted as
/// `draft.json` beside the encrypted media; `clientCaptureID` is written
/// before any network call so retries never create a second asset.
public struct DraftRecord: Codable, Equatable, Identifiable, Sendable {
  public enum Status: String, Codable, Sendable {
    /// Shown for Retake/Keep (photo) or Keep/Delete (video); not uploaded.
    case awaitingReview = "awaiting_review"
    /// Kept; waits for network policy.
    case queued
    case uploading
    /// Bytes are complete; server verification/preparation is server work.
    case verifying
    case committed
    /// Owned by an account that is not signed in, or the server paused it.
    case locked
    case rejected
    case failed
  }

  public var id: UUID
  public var ownerAccountID: UUID
  public var clientCaptureID: UUID
  public var kind: MediaKind
  public var source: MediaSource
  public var contentType: String
  public var filename: String
  public var byteSize: Int64
  public var sha256: String
  public var capturedAt: Date
  public var durationSeconds: Double?
  public var audioPresent: Bool
  public var interrupted: Bool
  /// Set only for remote-command captures while the session is active.
  public var captureSessionID: UUID?
  public var commandID: UUID?
  public var status: Status
  public var allowCellular: Bool
  public var uploadID: UUID?
  public var assetID: UUID?
  public var partSize: Int64?
  public var partCount: Int?
  public var receipts: [PartReceipt]
  /// Persisted idempotency keys, so a retried create/complete replays.
  public var createKey: UUID
  public var completeKey: UUID?
  public var errorCode: String?
  public var attempts: Int
  public var nextAttemptAt: Date?

  public static func new(
    owner: UUID, kind: MediaKind, source: MediaSource, contentType: String, capturedAt: Date,
    commandCaptureID: UUID? = nil
  ) -> DraftRecord {
    let id = commandCaptureID ?? UUID()
    let ext = contentType == "image/jpeg" ? "jpg" : contentType == "video/mp4" ? "mp4" : "mov"
    return DraftRecord(
      id: id, ownerAccountID: owner, clientCaptureID: id, kind: kind, source: source, contentType: contentType,
      filename: "\(kind == .photo ? "IMG" : "VID")-\(id.uuidString.prefix(8)).\(ext)", byteSize: 0, sha256: "",
      capturedAt: capturedAt, durationSeconds: nil, audioPresent: false, interrupted: false,
      captureSessionID: nil, commandID: nil, status: .awaitingReview, allowCellular: false, uploadID: nil,
      assetID: nil, partSize: nil, partCount: nil, receipts: [], createKey: UUID(), completeKey: nil,
      errorCode: nil, attempts: 0, nextAttemptAt: nil)
  }
}

/// Account-scoped, encrypted local media library (ported from Observer's
/// `LibraryStore` photo/clip persistence, without relay links, retention
/// sweeps of evidence, or a global operator identity).
///
/// Layout: `Application Support/CultureAtlas/accounts/<account>/drafts/<id>/`
/// with `media.enc` (EncryptedFile) and `draft.json`. Each account has its
/// own AES key in the Keychain; a different signed-in account cannot list or
/// decrypt another account's drafts.
public final class DraftStore: @unchecked Sendable {
  public let root: URL
  private let keychain: KeychainStore
  private let fileManager = FileManager.default
  private let lock = NSLock()
  private let keyOverride: (@Sendable (UUID) -> SymmetricKey)?

  /// `keyOverride` exists for unit tests that run without Keychain entitlements.
  public init(root: URL? = nil, keychain: KeychainStore = KeychainStore(), keyOverride: (@Sendable (UUID) -> SymmetricKey)? = nil) {
    let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
    self.root = root ?? support.appendingPathComponent("CultureAtlas", isDirectory: true)
    self.keychain = keychain
    self.keyOverride = keyOverride
  }

  public func accountDirectory(_ account: UUID) -> URL {
    root.appendingPathComponent("accounts", isDirectory: true)
      .appendingPathComponent(account.uuidString.lowercased(), isDirectory: true)
  }

  public func draftDirectory(_ draft: DraftRecord) -> URL {
    accountDirectory(draft.ownerAccountID).appendingPathComponent("drafts", isDirectory: true)
      .appendingPathComponent(draft.id.uuidString.lowercased(), isDirectory: true)
  }

  public func mediaURL(_ draft: DraftRecord) -> URL { draftDirectory(draft).appendingPathComponent("media.enc") }

  /// Where an in-progress recording writes plaintext; recovered on relaunch.
  public func recordingURL(_ draft: DraftRecord) -> URL {
    draftDirectory(draft).appendingPathComponent(draft.contentType == "video/mp4" ? "recording.mp4" : "recording.mov")
  }

  func key(for account: UUID) throws -> SymmetricKey {
    if let keyOverride { return keyOverride(account) }
    let name = "draftkey.\(account.uuidString.lowercased())"
    if let data = keychain.data(for: name) { return SymmetricKey(data: data) }
    let key = SymmetricKey(size: .bits256)
    try keychain.set(key.withUnsafeBytes { Data($0) }, for: name)
    return key
  }

  // MARK: Records

  public func save(_ draft: DraftRecord) throws {
    try lock.withLock {
      let directory = draftDirectory(draft)
      try fileManager.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [
        .protectionKey: FileProtectionType.completeUntilFirstUserAuthentication
      ])
      let data = try AtlasJSON.encoder().encode(draft)
      try data.write(to: directory.appendingPathComponent("draft.json"), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
  }

  public func update(_ id: UUID, owner: UUID, _ change: (inout DraftRecord) -> Void) throws -> DraftRecord? {
    guard var draft = drafts(owner: owner).first(where: { $0.id == id }) else { return nil }
    change(&draft)
    try save(draft)
    return draft
  }

  /// Drafts of `owner` only. Callers pass the signed-in account; another
  /// account's drafts are never enumerated (DraftLockPolicy).
  public func drafts(owner: UUID) -> [DraftRecord] {
    lock.withLock {
      let directory = accountDirectory(owner).appendingPathComponent("drafts", isDirectory: true)
      guard let entries = try? fileManager.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil) else { return [] }
      return entries.compactMap { entry in
        guard let data = try? Data(contentsOf: entry.appendingPathComponent("draft.json")),
          let draft = try? AtlasJSON.decoder().decode(DraftRecord.self, from: data), draft.ownerAccountID == owner
        else { return nil }
        return draft
      }.sorted { $0.capturedAt > $1.capturedAt }
    }
  }

  /// True when any account other than `signedIn` has local drafts (shown as a
  /// generic notice, never with titles, counts or thumbnails).
  public func hasLockedDrafts(otherThan signedIn: UUID?) -> Bool {
    let accounts = (try? fileManager.contentsOfDirectory(at: root.appendingPathComponent("accounts"), includingPropertiesForKeys: nil)) ?? []
    return accounts.contains { url in
      guard let account = UUID(uuidString: url.lastPathComponent), account != signedIn else { return false }
      return !drafts(owner: account).filter { $0.status != .committed }.isEmpty
    }
  }

  // MARK: Media

  /// Encrypts a finished plaintext capture into the draft and removes the plaintext.
  public func ingest(plaintext: URL, into draft: inout DraftRecord) throws {
    try save(draft)
    let sealed = try EncryptedFile.seal(source: plaintext, destination: mediaURL(draft), key: key(for: draft.ownerAccountID))
    draft.byteSize = sealed.byteSize
    draft.sha256 = sealed.sha256Hex
    try save(draft)
    try? fileManager.removeItem(at: plaintext)
  }

  /// Plaintext bytes of one part in a short-lived protected temp file.
  public func preparePart(_ draft: DraftRecord, part: PlannedPart) throws -> URL {
    let directory = fileManager.temporaryDirectory.appendingPathComponent("atlas-parts", isDirectory: true)
    try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
    let url = directory.appendingPathComponent("\(draft.id.uuidString.lowercased())-\(part.number).part")
    try? fileManager.removeItem(at: url)
    try EncryptedFile.decryptRange(
      source: mediaURL(draft), offset: part.offset, length: part.length, destination: url,
      key: key(for: draft.ownerAccountID))
    return url
  }

  /// Decrypted copy for local playback/preview; caller deletes it after use.
  public func openForPlayback(_ draft: DraftRecord) throws -> URL {
    let url = fileManager.temporaryDirectory.appendingPathComponent("atlas-preview-\(draft.id.uuidString).\(draft.filename.split(separator: ".").last ?? "bin")")
    try? fileManager.removeItem(at: url)
    try EncryptedFile.open(source: mediaURL(draft), destination: url, key: key(for: draft.ownerAccountID))
    return url
  }

  public func delete(_ draft: DraftRecord) throws {
    try lock.withLock { try fileManager.removeItem(at: draftDirectory(draft)) }
  }

  /// "Delete local drafts" on sign-out: removes this account's bytes and key.
  public func deleteAll(owner: UUID) {
    lock.withLock {
      try? fileManager.removeItem(at: accountDirectory(owner))
      keychain.delete("draftkey.\(owner.uuidString.lowercased())")
    }
  }

  /// Free space check before recording/capture (storage_full otherwise).
  public func hasRoom(forBytes bytes: Int64) -> Bool {
    let values = try? root.deletingLastPathComponent().resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
    guard let available = values?.volumeAvailableCapacityForImportantUsage else { return true }
    return available > bytes * 2 + 200_000_000
  }
}
