import Foundation
import SwiftUI

/// The phone's post-acceptance account-deletion lifecycle (VAL-DELETE-001).
///
/// The acceptance revokes every credential — this phone's installation
/// included — so the one-time status token is the only thing that keeps
/// answering afterwards, on the public status route. The phone generates the
/// token itself before accepting (a lost response can then be retried and the
/// same token is echoed back), keeps it in its keychain, and reports the
/// cleanup exactly as the server does: pending, in progress, failed and
/// retrying, or complete. Never more: provider or backup unknowns are not
/// described as immediate erasure, and completion is claimed only when the
/// server claims it.
@MainActor
public final class AccountDeletionModel: ObservableObject {
  public enum Phase: Equatable {
    case idle
    /// The deletion's honest lifecycle snapshot and the disclosure to show.
    case accepted(AccountDeletionStatus, AccountDeletionDisclosure)
  }

  @Published public private(set) var phase: Phase = .idle
  @Published public private(set) var refreshing = false
  /// The last status check could not reach the server; the shown status is
  /// the last one this phone had.
  @Published public private(set) var refreshFailed = false

  /// The locally kept capability, on this phone only.
  public struct StoredDeletion: Codable, Equatable {
    public var accountID: UUID
    public var statusToken: String

    enum CodingKeys: String, CodingKey {
      case accountID = "account_id"
      case statusToken = "status_token"
    }

    public init(accountID: UUID, statusToken: String) {
      self.accountID = accountID
      self.statusToken = statusToken
    }
  }

  /// Where the capability token persists. The keychain in the app; tests use
  /// an in-memory store.
  public protocol TokenStore: Sendable {
    func save(_ record: StoredDeletion) throws
    func load() -> StoredDeletion?
    func clear()
  }

  /// Keychain-backed storage: the token lives only on this phone, like the
  /// other credentials.
  public struct KeychainTokenStore: TokenStore {
    private let keychain: KeychainStore
    private let key: String

    public init(keychain: KeychainStore = KeychainStore(), key: String = "atlas.account-deletion") {
      self.keychain = keychain
      self.key = key
    }

    public func save(_ record: StoredDeletion) throws {
      try keychain.setCodable(record, for: key)
    }

    public func load() -> StoredDeletion? {
      keychain.codable(StoredDeletion.self, for: key)
    }

    public func clear() {
      keychain.delete(key)
    }
  }

  private let service: any AccountDeletionService
  private let tokenStore: any TokenStore
  private var pollTask: Task<Void, Never>?
  /// While cleanup is owed, the status refreshes on this cadence.
  private static let pollInterval: UInt64 = 5_000_000_000

  public init(
    service: any AccountDeletionService,
    tokenStore: any TokenStore = KeychainTokenStore()
  ) {
    self.service = service
    self.tokenStore = tokenStore
  }

  public var stored: StoredDeletion? {
    tokenStore.load()
  }

  /// Accepts the deletion response: keeps the capability token (the only
  /// credential that keeps answering) and shows the honest status surface.
  public func accept(_ response: RequestAccountDeletionResponse, account: UUID) {
    if let token = response.statusToken {
      try? tokenStore.save(StoredDeletion(accountID: account, statusToken: token))
    }
    phase = .accepted(response.status, response.disclosure)
    refreshFailed = false
    startPolling()
  }

  /// Launch restore: while cleanup is still owed, the status screen returns
  /// (the server's durable record keeps answering through the token). Once
  /// complete, the record is quietly dropped and the sign-in flow shows.
  public func restoreIfNeeded() async {
    guard case .idle = phase, let stored else { return }
    do {
      let response = try await service.accountDeletionStatus(token: stored.statusToken)
      if response.status.state == .complete {
        forget()
      } else {
        phase = .accepted(response.status, response.disclosure)
        startPolling()
      }
    } catch {
      // Unreachable, or the token matches no deletion anymore: nothing to
      // show. The server's own durable cleanup runs regardless of this screen.
    }
  }

  /// One status refresh (manual retry and the polling loop both use it).
  public func refresh() async {
    guard case .accepted = phase, let stored else { return }
    refreshing = true
    defer { refreshing = false }
    do {
      let response = try await service.accountDeletionStatus(token: stored.statusToken)
      phase = .accepted(response.status, response.disclosure)
      refreshFailed = false
      if response.status.state == .complete { stopPolling() }
    } catch {
      // Offline or unreachable: keep the last honest snapshot, keep polling.
      refreshFailed = true
    }
  }

  /// The user leaves the status screen. Once complete the record is dropped;
  /// while cleanup is owed it stays, so the screen returns on the next launch
  /// until the server finishes — the cleanup itself never depends on this UI.
  public func dismiss() {
    stopPolling()
    if case .accepted(let status, _) = phase, status.state == .complete { forget() }
    phase = .idle
  }

  public func forget() {
    tokenStore.clear()
  }

  private func startPolling() {
    stopPolling()
    pollTask = Task { [weak self] in
      guard let self else { return }
      while !Task.isCancelled {
        try? await Task.sleep(nanoseconds: Self.pollInterval)
        if Task.isCancelled { return }
        await self.refresh()
        if case .accepted(let status, _) = self.phase, status.state == .complete { return }
      }
    }
  }

  private func stopPolling() {
    pollTask?.cancel()
    pollTask = nil
  }
}
