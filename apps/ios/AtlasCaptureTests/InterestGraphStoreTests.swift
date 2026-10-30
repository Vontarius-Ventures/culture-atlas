import Foundation
@testable import AtlasCapture
import XCTest

/// The owner-scoped graph store: server-truth controls, the shared revision's
/// conflict behavior, restart persistence, bounded pagination and — the
/// private-data rules — clearing on account switch/revocation and rejecting
/// late previous-owner responses (VAL-NATIVE-001).
@MainActor
final class InterestGraphStoreTests: XCTestCase {
  private var ownerA: UUID!
  private var ownerB: UUID!

  override func setUp() async throws {
    ownerA = UUID()
    ownerB = UUID()
  }

  // MARK: Fixtures

  private func makeItem() -> InterestSummaryItem {
    InterestSummaryItem(
      edgeID: UUID(), itemID: UUID(), canonicalKey: "play/nina-simone", kind: "artist", title: "Nina Simone",
      savedItemID: UUID(), pickIDs: [UUID()], captureID: nil, analysisID: nil)
  }

  private func makeTentative(_ edgeID: UUID = UUID(), name: String = "Auguste Rodin", state: TentativeInterestItem.State = .tentative) -> TentativeInterestItem {
    TentativeInterestItem(
      edgeID: edgeID, nodeID: UUID(), name: name, relation: .depicted, resolution: .resolved, isAnchor: true,
      state: state, captureID: UUID(), analysisID: nil, analysisVersion: nil,
      captureReferenceID: UUID(), referenceID: UUID())
  }

  private func makeSummary(
    owner: UUID, revision: Int = 3, paused: Bool = false,
    projection: InterestGraphProjection.State = .ready,
    interests: [InterestSummaryItem] = [], interestsCursor: String? = nil,
    tentative: [TentativeInterestItem] = [], tentativeCursor: String? = nil
  ) -> InterestGraphSummary {
    let confirmed = interests.isEmpty ? [makeItem()] : interests
    let tentativeRows = tentative.isEmpty ? [makeTentative()] : tentative
    return InterestGraphSummary(
      ownerAccountID: owner,
      settings: InterestGraphSettings(revision: revision, discoveryPaused: paused, pausedAt: paused ? Date() : nil),
      projection: InterestGraphProjection(
        state: projection, supportVersion: 7, targetTasteRevision: 7, appliedTasteRevision: 7,
        currentTasteRevision: 7, lagging: false, pendingEvents: 0, lastProjectedAt: Date()),
      counts: InterestGraphSummary.Counts(
        confirmed: confirmed.count, tentative: tentativeRows.filter { $0.state == .tentative }.count,
        suppressed: tentativeRows.filter { $0.state == .suppressed }.count),
      interests: InterestGraphPage(items: confirmed, nextCursor: interestsCursor),
      tentative: InterestGraphPage(items: tentativeRows, nextCursor: tentativeCursor))
  }

  private func makeConnection(state: RecommendationConnection.State = .connected) -> RecommendationConnection {
    RecommendationConnection(
      recommendationID: UUID(), origin: "research", provenance: .graphRun, state: state, intent: .personal,
      graphRunID: UUID(), reason: RecommendationConnection.Reason(text: "Also work on display.", template: nil),
      path: [], sources: [], support: nil, unavailableReason: state == .unavailable ? "support_withdrawn" : nil)
  }

  // MARK: Load phases

  func testReloadAppliesOnlyCurrentOwnerSummary() async {
    let service = ScriptedGraphService(summary: makeSummary(owner: ownerA))
    let store = InterestGraphStore(service: service)
    store.bind(account: ownerA)

    XCTAssertEqual(store.loadPhase, .idle)
    await store.reload()
    XCTAssertEqual(store.loadPhase, .loaded)
    XCTAssertEqual(store.summary?.ownerAccountID, ownerA)
    XCTAssertEqual(store.summary?.counts.confirmed, 1)

    // A later refresh follows the newest server truth.
    await service.setSummary(makeSummary(owner: ownerA, revision: 4, projection: .failed))
    await store.reload()
    XCTAssertEqual(store.summary?.settings.revision, 4)
    XCTAssertEqual(store.summary?.projection.state, .failed)
  }

  func testFailedFirstLoadShowsErrorThenRecoversAndFailedRefreshKeepsLoadedData() async {
    let service = ScriptedGraphService(summary: nil)
    let store = InterestGraphStore(service: service)
    store.bind(account: ownerA)

    await service.setSummaryError(.transport("offline"))
    await store.reload()
    XCTAssertEqual(store.loadPhase, .failed)
    XCTAssertNil(store.summary)

    // Once data is on screen, a failed refresh keeps it (latest success survives).
    await service.setSummaryError(nil)
    await service.setSummary(makeSummary(owner: ownerA))
    await store.reload()
    XCTAssertEqual(store.loadPhase, .loaded)
    let loaded = store.summary
    XCTAssertNotNil(loaded)
    await service.setSummaryError(.transport("offline"))
    await store.reload()
    XCTAssertEqual(store.loadPhase, .loaded)
    XCTAssertEqual(store.summary, loaded)
  }

  func testNoCallsWhileSignedOut() async {
    let service = ScriptedGraphService(summary: makeSummary(owner: ownerA))
    let store = InterestGraphStore(service: service)
    store.bind(account: nil)
    await store.reload()
    await store.togglePause()
    await store.setInterestState(UUID(), to: .suppressed)
    await store.connection(for: UUID())
    let calls = await service.totalCalls
    XCTAssertEqual(calls, 0, "a signed-out store must not touch the owner's graph")
  }

  // MARK: Account switch / revocation

  func testSwitchingAccountsClearsEverythingAndRejectsLatePreviousOwnerResponse() async throws {
    let service = ScriptedGraphService(summary: makeSummary(owner: ownerA))
    let store = InterestGraphStore(service: service)
    store.bind(account: ownerA)
    await store.reload()
    XCTAssertEqual(store.summary?.ownerAccountID, ownerA)
    await store.connection(for: makeConnection().recommendationID)
    XCTAssertEqual(store.connectionPhases.count, 1)

    // The summary for A is already in flight when the account switches.
    await service.setPark(true)
    let reload = Task { await store.reload() }
    try await waitForParked(service)

    store.bind(account: ownerB)
    XCTAssertNil(store.summary, "the previous owner's private summary is cleared")
    XCTAssertEqual(store.loadPhase, .idle)
    XCTAssertTrue(store.connectionPhases.isEmpty, "the previous owner's reasons are cleared")

    // The late A response arrives for the B-bound store: rejected, never applied.
    await service.resumeParked(with: .success(makeSummary(owner: ownerA, revision: 9)))
    await reload.value
    XCTAssertNil(store.summary)
    XCTAssertEqual(store.loadPhase, .idle)

    // The fresh owner loads only its own truth.
    await service.setPark(false)
    await service.setSummary(makeSummary(owner: ownerB, revision: 1))
    await store.reload()
    XCTAssertEqual(store.summary?.ownerAccountID, ownerB)
    XCTAssertEqual(store.summary?.settings.revision, 1)
  }

  func testSignOutClearsEverythingAndRejectsLateResponse() async throws {
    let service = ScriptedGraphService(summary: makeSummary(owner: ownerA))
    let store = InterestGraphStore(service: service)
    store.bind(account: ownerA)
    await store.reload()
    XCTAssertNotNil(store.summary)

    await service.setPark(true)
    let reload = Task { await store.reload() }
    try await waitForParked(service)

    store.bind(account: nil)
    XCTAssertNil(store.summary)
    XCTAssertEqual(store.loadPhase, .idle)

    await service.resumeParked(with: .success(makeSummary(owner: ownerA, revision: 9)))
    await reload.value
    XCTAssertNil(store.summary, "a late response after sign-out never renders")
  }

  func testLateResponseClaimingAnotherOwnerIsRejected() async throws {
    let service = ScriptedGraphService(summary: makeSummary(owner: ownerB))
    let store = InterestGraphStore(service: service)
    store.bind(account: ownerB)

    await service.setPark(true)
    let reload = Task { await store.reload() }
    try await waitForParked(service)

    // Same epoch, but the payload belongs to another account: never applied.
    await service.resumeParked(with: .success(makeSummary(owner: ownerA, revision: 9)))
    await reload.value
    XCTAssertNil(store.summary)
    XCTAssertEqual(store.loadPhase, .loading, "the owner-guarded store neither shows data nor errors")
  }

  // MARK: Pause and conflict

  func testTogglePauseAppliesEchoedSettingsAndSurvivesRestart() async {
    let service = ScriptedGraphService(summary: makeSummary(owner: ownerA, revision: 3, paused: false))
    let store = InterestGraphStore(service: service)
    store.bind(account: ownerA)
    await store.reload()

    await store.togglePause()
    XCTAssertEqual(store.summary?.settings.discoveryPaused, true)
    XCTAssertEqual(store.summary?.settings.revision, 4)
    XCTAssertNil(store.notice)
    let (expectedRevision, expectedPause) = await service.lastSettingsRequest
    XCTAssertEqual(expectedRevision, 3)
    XCTAssertEqual(expectedPause, true)

    // Restart: the pause is server truth, so a fresh store shows it unchanged.
    let restarted = InterestGraphStore(service: service)
    restarted.bind(account: ownerA)
    await restarted.reload()
    XCTAssertEqual(restarted.summary?.settings.discoveryPaused, true)
    XCTAssertEqual(restarted.summary?.settings.revision, 4)
  }

  func testPauseConflictRefreshesToTheOtherClientsState() async {
    let service = ScriptedGraphService(summary: makeSummary(owner: ownerA, revision: 3, paused: false))
    let store = InterestGraphStore(service: service)
    store.bind(account: ownerA)
    await store.reload()

    // Another client changed a different graph control first, so the shared
    // revision moved on while this client still read 3.
    await service.setSummary(makeSummary(owner: ownerA, revision: 8, paused: false))
    await store.togglePause()

    XCTAssertEqual(store.notice, .conflictRefreshed)
    XCTAssertEqual(store.summary?.settings.discoveryPaused, false, "the other client's revision is shown, not a guessed pause")
    XCTAssertEqual(store.summary?.settings.revision, 8)
  }

  func testFailedPauseLeavesTheServerStateUntouched() async {
    let service = ScriptedGraphService(summary: makeSummary(owner: ownerA, revision: 3, paused: false))
    let store = InterestGraphStore(service: service)
    store.bind(account: ownerA)
    await store.reload()

    await service.setSettingsOutcome(.failure(.transport("offline")))
    await store.togglePause()
    XCTAssertEqual(store.notice, .updateFailed)
    XCTAssertEqual(store.summary?.settings.discoveryPaused, false, "a failed control never shows a saved setting")
    XCTAssertEqual(store.summary?.settings.revision, 3)
  }

  // MARK: Suppress / restore

  func testSuppressAndRestoreApplyRowStateCountsAndRevision() async {
    let edgeID = UUID()
    let service = ScriptedGraphService(summary: makeSummary(owner: ownerA, tentative: [makeTentative(edgeID)]))
    let store = InterestGraphStore(service: service)
    store.bind(account: ownerA)
    await store.reload()

    await store.setInterestState(edgeID, to: .suppressed)
    XCTAssertEqual(store.summary?.tentative.items.first?.state, .suppressed)
    XCTAssertEqual(store.summary?.counts.tentative, 0)
    XCTAssertEqual(store.summary?.counts.suppressed, 1)
    XCTAssertEqual(store.summary?.settings.revision, 4)
    XCTAssertNil(store.notice)

    await store.setInterestState(edgeID, to: .tentative)
    XCTAssertEqual(store.summary?.tentative.items.first?.state, .tentative)
    XCTAssertEqual(store.summary?.counts.tentative, 1)
    XCTAssertEqual(store.summary?.counts.suppressed, 0)
    XCTAssertEqual(store.summary?.settings.revision, 5)

    // Suppression is server truth: a restarted store shows the same state.
    await store.setInterestState(edgeID, to: .suppressed)
    let restarted = InterestGraphStore(service: service)
    restarted.bind(account: ownerA)
    await restarted.reload()
    XCTAssertEqual(restarted.summary?.tentative.items.first?.state, .suppressed)
  }

  func testSuppressConflictReloadsAndKeepsServerTruth() async {
    let edgeID = UUID()
    let service = ScriptedGraphService(summary: makeSummary(owner: ownerA, tentative: [makeTentative(edgeID)]))
    let store = InterestGraphStore(service: service)
    store.bind(account: ownerA)
    await store.reload()

    // Another client moved the shared revision first (they paused discovery),
    // leaving the affinity exactly as it is on the server.
    await service.setSummary(makeSummary(owner: ownerA, revision: 6, paused: true, tentative: [makeTentative(edgeID)]))
    await store.setInterestState(edgeID, to: .suppressed)

    XCTAssertEqual(store.notice, .conflictRefreshed)
    XCTAssertEqual(store.summary?.tentative.items.first?.state, .tentative, "the server's truth is shown, not this client's stale edit")
    XCTAssertEqual(store.summary?.settings.revision, 6)
    XCTAssertEqual(store.summary?.settings.discoveryPaused, true)
  }

  func testExplicitEdgeAnswersActionRequiredWithControlsNotice() async {
    let edgeID = UUID()
    let service = ScriptedGraphService(summary: makeSummary(owner: ownerA, tentative: [makeTentative(edgeID)]))
    let store = InterestGraphStore(service: service)
    store.bind(account: ownerA)
    await store.reload()

    await service.setInterestOutcome(.failure(.server(status: 409, code: "action_required", message: "", retryable: false, retryAfter: nil)))
    await store.setInterestState(edgeID, to: .suppressed)
    XCTAssertEqual(store.notice, .confirmedNeedsControls)
    XCTAssertEqual(store.summary?.tentative.items.first?.state, .tentative, "nothing changed")
    XCTAssertEqual(store.summary?.settings.revision, 3)
  }

  // MARK: Pagination

  func testLoadMoreMergesOnlyTheRequestedList() async {
    let item1 = makeItem()
    let item2 = makeItem()
    let edge1 = makeTentative(UUID(), name: "Bentwood chair")
    let page2Cursor = "eyJ2IjoxLCJvIjoyNX0"
    let service = ScriptedGraphService(summary: makeSummary(owner: ownerA, interests: [item1], interestsCursor: page2Cursor, tentative: [edge1]))
    let store = InterestGraphStore(service: service)
    store.bind(account: ownerA)
    await store.reload()

    // The response's tentative page is the FIRST page again; it must not
    // overwrite the already-loaded rows (only the requested list merges).
    await service.setSummary(makeSummary(owner: ownerA, revision: 4, interests: [item1, item2], interestsCursor: nil, tentative: [makeTentative(UUID(), name: "Japandi")]))
    await store.loadMore(.interests)

    XCTAssertEqual(store.summary?.interests.items.map(\.itemID), [item1.itemID, item2.itemID], "merged and deduped by item id")
    XCTAssertNil(store.summary?.interests.nextCursor)
    XCTAssertEqual(store.summary?.tentative.items.map(\.name), ["Bentwood chair"], "the echoed other-list page is discarded")
    XCTAssertEqual(store.summary?.settings.revision, 4)
    let (interestsCursor, tentativeCursor) = await service.lastSummaryCursors
    XCTAssertEqual(interestsCursor, page2Cursor)
    XCTAssertNil(tentativeCursor)
  }

  func testExpiredCursorResyncsTheWholeSummary() async {
    let service = ScriptedGraphService(summary: makeSummary(owner: ownerA, interestsCursor: "expired"))
    let store = InterestGraphStore(service: service)
    store.bind(account: ownerA)
    await store.reload()

    let summaryCallsBefore = await service.summaryCalls
    await service.setSummaryOutcome(.failure(.server(status: 410, code: "cursor_expired", message: "", retryable: false, retryAfter: nil)))
    await store.loadMore(.interests)
    let summaryCallsAfter = await service.summaryCalls
    XCTAssertEqual(summaryCallsAfter, summaryCallsBefore + 2, "an expired cursor triggers a full resync reload")
  }

  // MARK: Why-this connections

  func testConnectionCachesShownRecordsAndClearsOnSwitch() async {
    let connection = makeConnection()
    let service = ScriptedGraphService(summary: makeSummary(owner: ownerA))
    await service.setConnectionOutcome(.success(connection))
    let store = InterestGraphStore(service: service)
    store.bind(account: ownerA)

    await store.connection(for: connection.recommendationID)
    XCTAssertEqual(store.connectionPhases[connection.recommendationID], .shown(connection))
    // Cached: a second open does not hit the server again.
    await store.connection(for: connection.recommendationID)
    let calls = await service.connectionCalls
    XCTAssertEqual(calls, 1)

    store.bind(account: ownerB)
    XCTAssertTrue(store.connectionPhases.isEmpty, "reasons are private per account")

    await service.setConnectionOutcome(.failure(.server(status: 404, code: "not_found", message: "", retryable: false, retryAfter: nil)))
    await store.connection(for: connection.recommendationID)
    XCTAssertEqual(store.connectionPhases[connection.recommendationID], .quiet)

    await service.setConnectionOutcome(.failure(.transport("offline")))
    let failedID = UUID()
    await store.connection(for: failedID, refresh: true)
    guard case .failed = store.connectionPhases[failedID] else {
      return XCTFail("a transport failure offers an honest retry state")
    }
  }

  // MARK: Helpers

  /// Waits (bounded) until the service has parked an in-flight summary call.
  private func waitForParked(_ service: ScriptedGraphService) async throws {
    for _ in 0..<200 {
      if await service.parkedCount > 0 { return }
      try await Task.sleep(nanoseconds: 10_000_000)
    }
    XCTFail("the in-flight summary call never parked")
  }
}

/// A scripted stand-in for the typed graph service that mirrors the server's
/// own semantics: desired-state idempotency, the shared revision, honest
/// `revision_conflict`, and parking so a test can deliver a late response
/// after the bound account changed.
private actor ScriptedGraphService: InterestGraphService {
  private(set) var summaryCalls = 0
  private(set) var settingsCalls = 0
  private(set) var interestCalls = 0
  private(set) var connectionCalls = 0
  private(set) var parkedCount = 0
  private(set) var lastSummaryCursors: (String?, String?) = (nil, nil)
  private(set) var lastSettingsRequest: (Int, Bool) = (0, false)

  private(set) var summary: InterestGraphSummary?
  private var summaryError: AtlasClientError?
  private var summaryOutcome: Result<InterestGraphSummary, AtlasClientError>?
  private var park = false
  private var parked: [CheckedContinuation<InterestGraphSummary, Error>] = []
  private var settingsOutcome: Result<InterestGraphSettings, AtlasClientError>?
  private var interestOutcome: Result<UpdateInterestGraphInterestResponse, AtlasClientError>?
  private var connectionOutcome: Result<RecommendationConnection, AtlasClientError>?

  init(summary: InterestGraphSummary?) {
    self.summary = summary
  }

  var totalCalls: Int { summaryCalls + settingsCalls + interestCalls + connectionCalls }

  func setSummary(_ summary: InterestGraphSummary?) { self.summary = summary }
  func setSummaryError(_ error: AtlasClientError?) { summaryError = error }
  func setSummaryOutcome(_ outcome: Result<InterestGraphSummary, AtlasClientError>?) { summaryOutcome = outcome }
  func setSettingsOutcome(_ outcome: Result<InterestGraphSettings, AtlasClientError>?) { settingsOutcome = outcome }
  func setInterestOutcome(_ outcome: Result<UpdateInterestGraphInterestResponse, AtlasClientError>?) { interestOutcome = outcome }
  func setConnectionOutcome(_ outcome: Result<RecommendationConnection, AtlasClientError>?) { connectionOutcome = outcome }
  func setPark(_ on: Bool) { park = on }

  func resumeParked(with result: Result<InterestGraphSummary, AtlasClientError>) {
    let waiters = parked
    parked = []
    for continuation in waiters {
      switch result {
      case .success(let summary): continuation.resume(returning: summary)
      case .failure(let error): continuation.resume(throwing: error)
      }
    }
  }

  func interestGraph(interestsCursor: String?, tentativeCursor: String?, limit: Int) async throws -> InterestGraphSummary {
    summaryCalls += 1
    lastSummaryCursors = (interestsCursor, tentativeCursor)
    if park {
      park = false
      return try await withCheckedThrowingContinuation { continuation in
        parked.append(continuation)
        parkedCount += 1
      }
    }
    if let summaryOutcome {
      switch summaryOutcome {
      case .success(let summary): return summary
      case .failure(let error): throw error
      }
    }
    if let summaryError { throw summaryError }
    guard let summary else { throw AtlasClientError.transport("no summary scripted") }
    return summary
  }

  func updateInterestGraphSettings(expectedRevision: Int, discoveryPaused: Bool) async throws -> InterestGraphSettings {
    settingsCalls += 1
    lastSettingsRequest = (expectedRevision, discoveryPaused)
    if let settingsOutcome {
      switch settingsOutcome {
      case .success(let settings): return settings
      case .failure(let error): throw error
      }
    }
    guard var summary else { throw AtlasClientError.notSignedIn }
    // Desired-state idempotency, like the server.
    if summary.settings.discoveryPaused == discoveryPaused { return summary.settings }
    guard expectedRevision == summary.settings.revision else {
      throw AtlasClientError.server(status: 409, code: "revision_conflict", message: "", retryable: false, retryAfter: nil)
    }
    summary.settings = InterestGraphSettings(revision: summary.settings.revision + 1, discoveryPaused: discoveryPaused, pausedAt: discoveryPaused ? Date() : nil)
    self.summary = summary
    return summary.settings
  }

  func updateInterestGraphInterest(edgeID: UUID, expectedRevision: Int, state: TentativeInterestItem.State) async throws -> UpdateInterestGraphInterestResponse {
    interestCalls += 1
    if let interestOutcome {
      switch interestOutcome {
      case .success(let update): return update
      case .failure(let error): throw error
      }
    }
    guard var summary else { throw AtlasClientError.notSignedIn }
    guard let index = summary.tentative.items.firstIndex(where: { $0.edgeID == edgeID }) else {
      throw AtlasClientError.server(status: 404, code: "not_found", message: "", retryable: false, retryAfter: nil)
    }
    if summary.tentative.items[index].state == state {
      return UpdateInterestGraphInterestResponse(edgeID: edgeID, nodeID: summary.tentative.items[index].nodeID, state: state, settings: summary.settings)
    }
    guard expectedRevision == summary.settings.revision else {
      throw AtlasClientError.server(status: 409, code: "revision_conflict", message: "", retryable: false, retryAfter: nil)
    }
    summary.tentative.items[index].state = state
    summary.counts.tentative += state == .suppressed ? -1 : 1
    summary.counts.suppressed += state == .suppressed ? 1 : -1
    summary.settings.revision += 1
    self.summary = summary
    return UpdateInterestGraphInterestResponse(edgeID: edgeID, nodeID: summary.tentative.items[index].nodeID, state: state, settings: summary.settings)
  }

  func recommendationConnection(recommendationID: UUID) async throws -> RecommendationConnection {
    connectionCalls += 1
    if let connectionOutcome {
      switch connectionOutcome {
      case .success(let connection): return connection
      case .failure(let error): throw error
      }
    }
    return RecommendationConnection(
      recommendationID: recommendationID, origin: "research", provenance: .graphRun, state: .connected,
      intent: .personal, graphRunID: UUID(), reason: RecommendationConnection.Reason(text: nil, template: nil),
      path: nil, sources: [], support: nil, unavailableReason: nil)
  }
}
