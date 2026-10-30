import Foundation
@testable import AtlasCapture
import XCTest

/// The post-acceptance deletion lifecycle on the phone (VAL-DELETE-001): the
/// acceptance response is shown honestly, the one-time status token is kept so
/// the public status route keeps answering after every authority is revoked,
/// pending/failed/completed are reported exactly as the server says, and
/// nothing is invented — an unreachable server keeps the last snapshot, and
/// completion drops the record only when the server claims it.
@MainActor
final class AccountDeletionModelTests: XCTestCase {
  private var tokenStore: MemoryDeletionTokenStore!
  private var account: UUID!

  override func setUp() {
    tokenStore = MemoryDeletionTokenStore()
    account = UUID()
  }

  // MARK: Fixtures

  private func makeDisclosure() -> AccountDeletionDisclosure {
    AccountDeletionDisclosure(
      summary: "Deleting your account revokes every credential immediately.",
      immediate: ["Every browser session and phone installation is revoked."],
      cleanupSteps: ["Your media objects are deleted.", "Every private record is deleted."],
      retained: ["Independently sourced cultural facts stay."])
  }

  private func makeStatus(
    _ state: AccountDeletionStatus.State, completed: [String] = [], error code: String? = nil
  ) -> AccountDeletionStatus {
    let all = ["media_objects", "private_rows"]
    return AccountDeletionStatus(
      state: state, requestedAt: Date(), acceptedAt: Date(),
      completedAt: state == .complete ? Date() : nil,
      completedSteps: completed,
      pendingSteps: all.filter { !completed.contains($0) },
      attempts: 1, lastErrorCode: code, retrying: state != .complete)
  }

  private func makeResponse(
    _ state: AccountDeletionStatus.State = .pending, token: String? = "tok_\(UUID().uuidString)"
  ) -> RequestAccountDeletionResponse {
    RequestAccountDeletionResponse(status: makeStatus(state), statusToken: token, disclosure: makeDisclosure())
  }

  // MARK: Acceptance

  func testAcceptKeepsTheTokenAndShowsTheHonestState() {
    let service = ScriptedDeletionService()
    let model = AccountDeletionModel(service: service, tokenStore: tokenStore)
    XCTAssertEqual(model.phase, .idle)
    XCTAssertNil(model.stored)

    let response = makeResponse(.pending)
    model.accept(response, account: account)

    XCTAssertEqual(model.stored?.statusToken, response.statusToken)
    XCTAssertEqual(model.stored?.accountID, account)
    guard case .accepted(let status, let disclosure) = model.phase else {
      return XCTFail("acceptance shows the honest status surface")
    }
    XCTAssertEqual(status.state, .pending)
    XCTAssertEqual(disclosure.retained, makeDisclosure().retained)
  }

  func testRefreshReportsServerTruthOnly() async {
    let service = ScriptedDeletionService()
    await service.setStatusOutcome(.success(AccountDeletionStatusResponse(status: makeStatus(.purging, completed: ["media_objects"]), disclosure: makeDisclosure())))
    let model = AccountDeletionModel(service: service, tokenStore: tokenStore)
    model.accept(makeResponse(.pending), account: account)

    await model.refresh()
    guard case .accepted(let status, _) = model.phase else { return XCTFail() }
    XCTAssertEqual(status.state, .purging)
    XCTAssertEqual(status.completedSteps, ["media_objects"])
    let calls = await service.statusCalls
    XCTAssertEqual(calls, 1)
    let lastToken = await service.lastStatusToken
    XCTAssertEqual(lastToken, model.stored?.statusToken)
    XCTAssertFalse(model.refreshFailed)

    // Complete only when the server says complete.
    await service.setStatusOutcome(.success(AccountDeletionStatusResponse(status: makeStatus(.complete, completed: ["media_objects", "private_rows"]), disclosure: makeDisclosure())))
    await model.refresh()
    guard case .accepted(let done, _) = model.phase else { return XCTFail() }
    XCTAssertEqual(done.state, .complete)
  }

  func testAFailedStatusCheckKeepsTheLastHonestSnapshot() async {
    let service = ScriptedDeletionService()
    let model = AccountDeletionModel(service: service, tokenStore: tokenStore)
    model.accept(makeResponse(.pending), account: account)
    await service.setStatusOutcome(.failure(.transport("offline")))
    await model.refresh()
    XCTAssertTrue(model.refreshFailed)
    guard case .accepted(let status, _) = model.phase else { return XCTFail() }
    XCTAssertEqual(status.state, .pending)
  }

  // MARK: Restore / dismissal

  func testRestoreShowsOwedCleanupAndQuietlyDropsACompletedOne() async {
    let service = ScriptedDeletionService()
    let model = AccountDeletionModel(service: service, tokenStore: tokenStore)
    model.accept(makeResponse(.pending), account: account)
    guard let token = model.stored?.statusToken else { return XCTFail() }

    // Still owed: the launch restore brings the screen back through the token.
    await service.setStatusOutcome(.success(AccountDeletionStatusResponse(status: makeStatus(.purging, completed: ["media_objects"]), disclosure: makeDisclosure())))
    model.dismiss()
    XCTAssertEqual(model.phase, .idle)
    XCTAssertNotNil(model.stored, "an owed cleanup keeps the record so the status returns")
    await model.restoreIfNeeded()
    guard case .accepted(let status, _) = model.phase else { return XCTFail() }
    XCTAssertEqual(status.state, .purging)
    let restoreToken = await service.lastStatusToken
    XCTAssertEqual(restoreToken, token)

    // Complete at launch: nothing to show, and the record is dropped.
    model.dismiss()
    await service.setStatusOutcome(.success(AccountDeletionStatusResponse(status: makeStatus(.complete, completed: ["media_objects", "private_rows"]), disclosure: makeDisclosure())))
    await model.restoreIfNeeded()
    XCTAssertEqual(model.phase, .idle)
    XCTAssertNil(model.stored)
  }

  func testDismissAfterCompletionForgetsTheRecord() async {
    let service = ScriptedDeletionService()
    await service.setStatusOutcome(.success(AccountDeletionStatusResponse(status: makeStatus(.complete, completed: ["media_objects", "private_rows"]), disclosure: makeDisclosure())))
    let model = AccountDeletionModel(service: service, tokenStore: tokenStore)
    model.accept(makeResponse(.pending), account: account)
    await model.refresh()
    model.dismiss()
    XCTAssertNil(model.stored, "a completed cleanup's record is dropped on dismissal")
  }

  func testNoStoredRecordMeansNoCallsAndNoSurface() async {
    let service = ScriptedDeletionService()
    let model = AccountDeletionModel(service: service, tokenStore: tokenStore)
    await model.restoreIfNeeded()
    await model.refresh()
    XCTAssertEqual(model.phase, .idle)
    let total = await service.totalCalls
    XCTAssertEqual(total, 0, "nothing is fetched without an accepted deletion")
  }
}

/// In-memory token storage so the model tests stay hermetic (the app's real
/// store is the keychain).
private final class MemoryDeletionTokenStore: AccountDeletionModel.TokenStore, @unchecked Sendable {
  private let lock = NSLock()
  private var record: AccountDeletionModel.StoredDeletion?

  func save(_ record: AccountDeletionModel.StoredDeletion) throws {
    lock.lock()
    defer { lock.unlock() }
    self.record = record
  }

  func load() -> AccountDeletionModel.StoredDeletion? {
    lock.lock()
    defer { lock.unlock() }
    return record
  }

  func clear() {
    lock.lock()
    defer { lock.unlock() }
    record = nil
  }
}

/// A scripted stand-in for the typed deletion service: the overview and
/// acceptance are only reached through the real UI flow, so tests script the
/// status answers (and their failures) the model polls for.
private actor ScriptedDeletionService: AccountDeletionService {
  private(set) var statusCalls = 0
  private(set) var lastStatusToken: String?
  private var statusOutcome: Result<AccountDeletionStatusResponse, AtlasClientError>?

  func setStatusOutcome(_ outcome: Result<AccountDeletionStatusResponse, AtlasClientError>?) {
    statusOutcome = outcome
  }

  var totalCalls: Int { statusCalls }

  func accountDeletionOverview() async throws -> AccountDeletionOverview {
    AccountDeletionOverview(
      requested: false, state: .none, status: nil,
      disclosure: AccountDeletionDisclosure(
        summary: "", immediate: [], cleanupSteps: [], retained: []))
  }

  func requestAccountDeletion(statusToken: String) async throws -> RequestAccountDeletionResponse {
    throw AtlasClientError.notSignedIn
  }

  func accountDeletionStatus(token: String) async throws -> AccountDeletionStatusResponse {
    statusCalls += 1
    lastStatusToken = token
    guard let outcome = statusOutcome else {
      throw AtlasClientError.transport("no scripted outcome")
    }
    switch outcome {
    case .success(let response): return response
    case .failure(let error): throw error
    }
  }
}
