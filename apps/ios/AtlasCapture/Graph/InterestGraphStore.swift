import Foundation
import SwiftUI

/// The phone's owner-scoped copy of the typed graph state (VAL-NATIVE-001):
/// the Settings → Taste summary and controls, and the Why-this connections
/// opened from feed and photo cards. Everything is server truth — controls
/// are desired-state PATCHes carrying the revision they read, a conflict
/// reloads the latest instead of faking a saved setting, and a failed
/// control leaves the row exactly as the server has it.
///
/// Account identity comes from the signed-in installation session, never a
/// caller-supplied account id. `bind(account:)` is the single owner switch:
/// signing out or switching accounts clears every private row here and
/// rejects any in-flight previous-owner response on arrival (the epoch check
/// below), so a late response can never render for the wrong owner.
@MainActor
public final class InterestGraphStore: ObservableObject {
  public enum LoadPhase: Equatable {
    /// Not bound or not loaded yet (nothing shown).
    case idle
    /// First load in flight (pending state).
    case loading
    case loaded
    /// The first load failed and nothing is on screen (error state).
    case failed
  }

  public enum List: String, Sendable { case interests, tentative }

  public enum Notice: Equatable {
    /// A control hit a revision conflict; the latest server state is shown.
    case conflictRefreshed
    /// The control could not be updated; nothing was changed locally.
    case updateFailed
    /// An explicit edge answered action_required: it changes through the
    /// ordinary save/pick controls, not the graph.
    case confirmedNeedsControls
  }

  public enum ConnectionPhase: Equatable {
    case idle
    case loading
    /// The pinned proof (or its honest unavailable record) is on screen.
    case shown(RecommendationConnection)
    /// The record could not load; the disclosure offers a retry.
    case failed
    /// The recommendation is not the owner's to disclose; the surface hides.
    case quiet
  }

  /// Page size for both lists (server bounds: 1–100).
  private static let pageLimit = 25

  @Published public private(set) var loadPhase: LoadPhase = .idle
  @Published public private(set) var summary: InterestGraphSummary?
  @Published public private(set) var notice: Notice?
  @Published public private(set) var busyPause = false
  @Published public private(set) var busyEdges: Set<UUID> = []
  @Published public private(set) var busyMore: Set<List> = []
  @Published public private(set) var connectionPhases: [UUID: ConnectionPhase] = [:]

  private let service: any InterestGraphService
  private var ownerAccount: UUID?
  /// Bumped on every owner change; in-flight work from an earlier epoch is
  /// discarded when it arrives.
  private var epoch = 0

  public init(service: any InterestGraphService) {
    self.service = service
  }

  /// Binds the store to the signed-in account. A nil (signed out) or
  /// different account clears the private summary, lists and cached reasons.
  public func bind(account: UUID?) {
    guard account != ownerAccount else { return }
    epoch += 1
    ownerAccount = account
    summary = nil
    loadPhase = .idle
    notice = nil
    busyPause = false
    busyEdges = []
    busyMore = []
    connectionPhases = [:]
  }

  /// Reloads the summary from the server. A failed refresh keeps the loaded
  /// state (the latest compatible success survives); only a failed FIRST
  /// load shows the error state.
  public func reload() async {
    guard ownerAccount != nil else { return }
    let epoch = self.epoch
    if summary == nil { loadPhase = .loading }
    do {
      let loaded = try await service.interestGraph(interestsCursor: nil, tentativeCursor: nil, limit: Self.pageLimit)
      // Late previous-owner responses (account switched or signed out while
      // the call was in flight) are rejected here, never applied.
      guard epoch == self.epoch, loaded.ownerAccountID == ownerAccount else { return }
      summary = loaded
      loadPhase = .loaded
    } catch {
      guard epoch == self.epoch else { return }
      if summary == nil { loadPhase = .failed }
    }
  }

  /// Loads the next page of one list. The response echoes the other list's
  /// first page, so only the requested list is merged (deduped by its stable
  /// row id); settings and projection still follow the response.
  public func loadMore(_ list: List) async {
    guard let current = summary, !busyMore.contains(list) else { return }
    let cursor = list == .interests ? current.interests.nextCursor : current.tentative.nextCursor
    guard let cursor else { return }
    let epoch = self.epoch
    busyMore.insert(list)
    defer { if epoch == self.epoch { busyMore.remove(list) } }
    do {
      let page = try await service.interestGraph(
        interestsCursor: list == .interests ? cursor : nil,
        tentativeCursor: list == .tentative ? cursor : nil,
        limit: Self.pageLimit)
      guard epoch == self.epoch, page.ownerAccountID == ownerAccount, var latest = summary else { return }
      latest.settings = page.settings
      latest.projection = page.projection
      switch list {
      case .interests:
        latest.interests = InterestGraphPage(
          items: Self.merged(latest.interests.items, page.interests.items) { $0.itemID == $1.itemID },
          nextCursor: page.interests.nextCursor)
      case .tentative:
        latest.tentative = InterestGraphPage(
          items: Self.merged(latest.tentative.items, page.tentative.items) { $0.edgeID == $1.edgeID },
          nextCursor: page.tentative.nextCursor)
      }
      summary = latest
    } catch let error as AtlasClientError where error.code == "cursor_expired" {
      guard epoch == self.epoch else { return }
      await reload()
    } catch {
      // The loaded page stays exactly as it was.
    }
  }

  /// Pause/resume background discovery (desired state; server truth only).
  public func togglePause() async {
    guard let current = summary, !busyPause else { return }
    let epoch = self.epoch
    busyPause = true
    defer { if epoch == self.epoch { busyPause = false } }
    do {
      let settings = try await service.updateInterestGraphSettings(
        expectedRevision: current.settings.revision,
        discoveryPaused: !current.settings.discoveryPaused)
      guard epoch == self.epoch else { return }
      summary?.settings = settings
      notice = nil
    } catch let error as AtlasClientError where error.code == "revision_conflict" {
      // Another client changed the shared revision: show the latest, never
      // silently overwrite it with this client's guess.
      guard epoch == self.epoch else { return }
      notice = .conflictRefreshed
      await reload()
    } catch {
      guard epoch == self.epoch else { return }
      notice = .updateFailed
    }
  }

  /// Suppress/restore one tentative affinity (desired state). The response's
  /// echoed settings and row state are applied; the counts follow the move.
  public func setInterestState(_ edgeID: UUID, to state: TentativeInterestItem.State) async {
    guard let current = summary, !busyEdges.contains(edgeID) else { return }
    let epoch = self.epoch
    busyEdges.insert(edgeID)
    defer { if epoch == self.epoch { busyEdges.remove(edgeID) } }
    do {
      let update = try await service.updateInterestGraphInterest(
        edgeID: edgeID, expectedRevision: current.settings.revision, state: state)
      guard epoch == self.epoch else { return }
      summary?.settings = update.settings
      if let index = summary?.tentative.items.firstIndex(where: { $0.edgeID == update.edgeID }) {
        summary?.tentative.items[index].state = update.state
      }
      summary?.counts.tentative += update.state == .suppressed ? -1 : 1
      summary?.counts.suppressed += update.state == .suppressed ? 1 : -1
      notice = nil
    } catch let error as AtlasClientError where error.code == "revision_conflict" {
      guard epoch == self.epoch else { return }
      notice = .conflictRefreshed
      await reload()
    } catch let error as AtlasClientError where error.code == "action_required" {
      guard epoch == self.epoch else { return }
      notice = .confirmedNeedsControls
    } catch {
      guard epoch == self.epoch else { return }
      notice = .updateFailed
    }
  }

  /// The pinned Why-this record for a recommendation the owner already saw.
  /// Cached per recommendation while the account stays bound; a 404/scope
  /// denial hides the disclosure (the context is not ours to disclose).
  public func connection(for recommendationID: UUID, refresh: Bool = false) async {
    guard ownerAccount != nil else { return }
    if !refresh {
      if case .shown = connectionPhases[recommendationID] { return }
      if case .loading = connectionPhases[recommendationID] { return }
    }
    let epoch = self.epoch
    connectionPhases[recommendationID] = .loading
    do {
      let connection = try await service.recommendationConnection(recommendationID: recommendationID)
      guard epoch == self.epoch else { return }
      connectionPhases[recommendationID] = .shown(connection)
    } catch let error as AtlasClientError where error.code == "not_found" || error.code == "scope_denied" {
      guard epoch == self.epoch else { return }
      connectionPhases[recommendationID] = .quiet
    } catch {
      guard epoch == self.epoch else { return }
      connectionPhases[recommendationID] = .failed
    }
  }

  private static func merged<Item: Equatable>(_ base: [Item], _ page: [Item], same: (Item, Item) -> Bool) -> [Item] {
    var items = base
    for item in page where !items.contains(where: { same($0, item) }) {
      items.append(item)
    }
    return items
  }
}
