@testable import AtlasCapture
import XCTest

/// Taste onboarding (amendment 2.2) against fixtures/native-contract/onboarding.json
/// and the onboarding examples in messages.json.
final class OnboardingTests: XCTestCase {
  let decoder = AtlasJSON.decoder()
  let encoder = AtlasJSON.encoder()

  private func fixture() throws -> [String: Any] { try Fixtures.json("onboarding.json") }

  func testDecodesEveryOnboardingResponseExample() throws {
    let catalog = try decoder.decode(OnboardingCatalog.self, from: Fixtures.message("onboarding_catalog_response"))
    XCTAssertEqual(catalog.minPicks, OnboardingPolicy.minPicks)
    XCTAssertEqual(catalog.images.first?.image?.resolved(against: URL(string: "https://app.cultureatlas.com")!)?.absoluteString,
                   "https://app.cultureatlas.com/samples/onboarding/tea.jpg")
    XCTAssertTrue(catalog.allEntries.contains { $0.picked && $0.pickID != nil })
    let search = try decoder.decode(OnboardingSearchResponse.self, from: Fixtures.message("onboarding_search_response"))
    XCTAssertEqual(search.status, .ok)
    XCTAssertEqual(search.results.first?.typeLabel, "Artist")
    let unavailable = try decoder.decode(OnboardingSearchResponse.self, from: Fixtures.message("onboarding_search_unavailable_response"))
    XCTAssertEqual(unavailable.status, .unavailable)
    let pick = try decoder.decode(CreatePickResponse.self, from: Fixtures.message("onboarding_pick_response"))
    XCTAssertEqual(pick.pick.savedItemIDs.count, 2, "a multi-tag image is one pick with several saves")
    XCTAssertEqual(pick.state.picksCount, 1)
    _ = try decoder.decode(DeletePickResponse.self, from: Fixtures.message("onboarding_delete_pick_response"))
    _ = try decoder.decode(FoodExclusionsBody.self, from: Fixtures.message("onboarding_exclusions_response"))
    let complete = try decoder.decode(CompleteOnboardingResponse.self, from: Fixtures.message("onboarding_complete_response"))
    XCTAssertFalse(complete.state.required)
    let state = try decoder.decode(OnboardingStateResponse.self, from: Fixtures.message("onboarding_state_response"))
    XCTAssertEqual(state.picks.count, state.state.picksCount)
    let partial = try decoder.decode(TasteSeedStatus.self, from: Fixtures.message("onboarding_seed_partial_response"))
    XCTAssertEqual(OnboardingPolicy.seed(partial, elapsed: 0), .advance)
    XCTAssertEqual(OnboardingPolicy.seedPollInterval(partial), 1.0)
    let retrying = try decoder.decode(TasteSeedStatus.self, from: Fixtures.message("onboarding_seed_retrying_response"))
    XCTAssertEqual(OnboardingPolicy.seed(retrying, elapsed: 0), .background)
    let taste = try decoder.decode(TastePicksResponse.self, from: Fixtures.message("taste_picks_response"))
    XCTAssertEqual(taste.picks.wear.count + taste.picks.play.count + taste.picks.watch.count + taste.picks.eat.count, taste.picksCount)
  }

  func testRequestsEncodeToTheExampleBodies() throws {
    try assertRoundTrip(CreatePickRequest.self, "onboarding_pick_catalog_request")
    try assertRoundTrip(CreatePickRequest.self, "onboarding_pick_search_request")
    try assertRoundTrip(FoodExclusionsBody.self, "onboarding_exclusions_request")
    try assertRoundTrip(EmptyBody.self, "onboarding_complete_request")
  }

  func testFlatV1ErrorBodyDecodesToAServerError() throws {
    let flat = try decoder.decode(FlatServerError.self, from: Fixtures.message("v1_error_body"))
    XCTAssertEqual(flat.code, "conflict")
    XCTAssertEqual(OnboardingPolicy.complete(picks: 3, error: .server(status: 409, code: flat.code, message: flat.message, retryable: false, retryAfter: nil)), .reloadState)
  }

  func testCopyMatchesTheDesignCopy() throws {
    let copy = try XCTUnwrap(fixture()["copy"] as? [String: String])
    for (key, value) in OnboardingCopy.byKey {
      XCTAssertEqual(copy[key], value, key)
    }
    XCTAssertEqual(copy["onboarding.step"]?.replacingOccurrences(of: "{n}", with: "2"), OnboardingCopy.step(2))
    XCTAssertEqual(copy["settings_taste.remove"]?.replacingOccurrences(of: "{label}", with: "Japandi"), OnboardingCopy.tasteRemove("Japandi"))
    let groups = try XCTUnwrap(fixture()["category_copy_keys"] as? [String: String])
    for category in TasteCategory.allCases {
      XCTAssertEqual(copy[try XCTUnwrap(groups[category.rawValue])], OnboardingCopy.group(category))
    }
  }

  func testLimitsMatchTheFixture() throws {
    let limits = try XCTUnwrap(fixture()["limits"] as? [String: Int])
    XCTAssertEqual(limits["min_picks"], OnboardingPolicy.minPicks)
    XCTAssertEqual(limits["max_picks"], OnboardingPolicy.maxPicks)
    XCTAssertEqual(limits["search_query_min_chars"], OnboardingPolicy.searchMinChars)
    XCTAssertEqual(limits["search_query_max_chars"], OnboardingPolicy.searchMaxChars)
    XCTAssertEqual(limits["exclusions_max"], OnboardingPolicy.exclusionsMax)
    XCTAssertEqual(limits["exclusion_max_chars"], OnboardingPolicy.exclusionMaxChars)
    XCTAssertEqual(try XCTUnwrap(fixture()["categories"] as? [String]), TasteCategory.allCases.map(\.rawValue))
    let search = try XCTUnwrap(fixture()["search"] as? [String: Any])
    XCTAssertEqual(search["debounce_ms"] as? Double, OnboardingPolicy.searchDebounce * 1000)
    let seed = try XCTUnwrap(fixture()["seed"] as? [String: Any])
    XCTAssertEqual(seed["default_poll_ms"] as? Double, OnboardingPolicy.defaultSeedPoll * 1000)
    XCTAssertEqual(seed["max_wait_ms"] as? Double, OnboardingPolicy.seedMaxWait * 1000)
  }

  func testCounterTable() throws {
    for row in try XCTUnwrap(fixture()["counter"] as? [[String: Any]]) {
      let picks = try XCTUnwrap(row["picks"] as? Int)
      let counter = OnboardingPolicy.counter(picks: picks)
      XCTAssertEqual(counter.text, row["text"] as? String, "\(picks)")
      XCTAssertEqual(counter.progress, row["progress"] as? Int, "\(picks)")
      XCTAssertEqual(counter.canComplete, row["can_complete"] as? Bool, "\(picks)")
    }
  }

  func testSearchAndExclusionTables() throws {
    let search = try XCTUnwrap(fixture()["search"] as? [String: Any])
    for c in try XCTUnwrap(search["cases"] as? [[String: Any]]) {
      XCTAssertEqual(OnboardingPolicy.searchQuery(try XCTUnwrap(c["input"] as? String)), c["expect"] as? String, c["name"] as? String ?? "")
    }
    let exclusions = try XCTUnwrap(fixture()["exclusions"] as? [String: Any])
    for c in try XCTUnwrap(exclusions["cases"] as? [[String: Any]]) {
      let name = c["name"] as? String ?? ""
      let out = OnboardingPolicy.addExclusion(try XCTUnwrap(c["current"] as? [String]), try XCTUnwrap(c["input"] as? String))
      let expect = try XCTUnwrap(c["expect"] as? [String: Any])
      XCTAssertEqual(out.list, expect["list"] as? [String], name)
      XCTAssertEqual(out.rejected?.rawValue, expect["rejected"] as? String, name)
    }
    for c in try XCTUnwrap(exclusions["toggle_cases"] as? [[String: Any]]) {
      XCTAssertEqual(
        OnboardingPolicy.toggleExclusion(try XCTUnwrap(c["current"] as? [String]), try XCTUnwrap(c["term"] as? String)),
        c["expect"] as? [String], c["name"] as? String ?? "")
    }
    for c in try XCTUnwrap(exclusions["display_examples"] as? [[String: String]]) {
      XCTAssertEqual(OnboardingPolicy.label(try XCTUnwrap(c["term"])), c["label"])
    }
  }

  func testEntryCompleteAndSeedTables() throws {
    let entry = try XCTUnwrap(fixture()["entry"] as? [String: Any])
    for c in try XCTUnwrap(entry["cases"] as? [[String: Any]]) {
      let name = c["name"] as? String ?? ""
      let state = (c["state"] as? [String: Any]).map {
        OnboardingState(
          required: $0["required"] as! Bool, picksCount: $0["picks_count"] as! Int, minPicks: 3,
          startedAt: nil, completedAt: nil, catalogVersion: nil)
      }
      let error = (c["error"] as? String).map(Self.error)
      XCTAssertEqual(
        OnboardingPolicy.entry(onboardingFlag: try XCTUnwrap(c["onboarding_flag"] as? Bool), state: state, error: error).rawValue,
        c["expect"] as? String, name)
    }
    let complete = try XCTUnwrap(fixture()["complete"] as? [String: Any])
    for c in try XCTUnwrap(complete["cases"] as? [[String: Any]]) {
      XCTAssertEqual(
        OnboardingPolicy.complete(picks: try XCTUnwrap(c["picks"] as? Int), error: (c["error"] as? String).map(Self.error)).rawValue,
        c["expect"] as? String, c["name"] as? String ?? "")
    }
    let seed = try XCTUnwrap(fixture()["seed"] as? [String: Any])
    for c in try XCTUnwrap(seed["cases"] as? [[String: Any]]) {
      let action = OnboardingPolicy.seed(
        state: try XCTUnwrap(SeedState(rawValue: XCTUnwrap(c["state"] as? String))),
        categories: try XCTUnwrap(c["categories"] as? [String]).map { try XCTUnwrap(SeedCategoryState(rawValue: $0)) },
        elapsed: try XCTUnwrap(c["elapsed_ms"] as? Double) / 1000)
      XCTAssertEqual(action.rawValue, c["expect"] as? String, c["name"] as? String ?? "")
    }
  }

  /// The client error a fixture code stands for ("transport" is a network failure).
  static func error(_ code: String) -> AtlasClientError {
    code == "transport"
      ? .transport("NSURLErrorDomain:-1009")
      : .server(status: 400, code: code, message: "", retryable: false, retryAfter: nil)
  }

  private func assertRoundTrip<T: Codable>(_ type: T.Type, _ key: String, file: StaticString = #filePath, line: UInt = #line) throws {
    let example = try Fixtures.messageObject(key)
    let model = try decoder.decode(T.self, from: Fixtures.message(key))
    let encoded = try XCTUnwrap(JSONSerialization.jsonObject(with: encoder.encode(model)) as? NSDictionary)
    XCTAssertEqual(encoded, example, "\(key) does not encode to its example", file: file, line: line)
  }
}

/// Ready notices (screen 17) against fixtures/native-contract/ready-notice.json.
final class ReadyNoticeTests: XCTestCase {
  let decoder = AtlasJSON.decoder()

  private func fixture() throws -> [String: Any] { try Fixtures.json("ready-notice.json") }

  func testDecisionTable() throws {
    for c in try XCTUnwrap(fixture()["decisions"] as? [[String: Any]]) {
      let name = c["name"] as? String ?? ""
      let decision = ReadyNoticePolicy.decide(
        state: try XCTUnwrap(AnalysisState(rawValue: XCTUnwrap(c["state"] as? String))),
        app: try XCTUnwrap(ReadyNoticePolicy.AppPresence(rawValue: XCTUnwrap(c["app"] as? String))),
        watched: try XCTUnwrap(c["watched"] as? Bool), notified: try XCTUnwrap(c["notified"] as? Bool),
        ageHours: try XCTUnwrap(c["age_hours"] as? Double))
      let expect = try XCTUnwrap(c["expect"] as? [String: Any])
      XCTAssertEqual(decision.notice.rawValue, expect["notice"] as? String, name)
      XCTAssertEqual(decision.keepWatching, expect["keep_watching"] as? Bool, name)
    }
    let watch = try XCTUnwrap(fixture()["watch"] as? [String: Any])
    XCTAssertEqual(watch["max_watched"] as? Int, ReadyNoticePolicy.maxWatched)
    XCTAssertEqual(watch["expire_after_hours"] as? Double, ReadyNoticePolicy.expireAfterHours)
    XCTAssertEqual(watch["foreground_poll_seconds"] as? Double, ReadyNoticePolicy.foregroundPollSeconds)
    let copy = try XCTUnwrap(fixture()["copy"] as? [String: String])
    for (key, value) in ReadyNoticeCopy.byKey { XCTAssertEqual(copy[key], value, key) }
  }

  func testOnlyOpaqueWakesAreAccepted() throws {
    let push = try XCTUnwrap(fixture()["push"] as? [String: Any])
    let apns = try XCTUnwrap(push["apns"] as? [String: Any])
    XCTAssertTrue(ReadyNoticePolicy.isValidWake(try XCTUnwrap(apns["body"] as? [String: Any])))
    for wake in try XCTUnwrap(push["invalid_wakes"] as? [[String: Any]]) {
      XCTAssertFalse(ReadyNoticePolicy.isValidWake(try XCTUnwrap(wake["apns_body"] as? [String: Any])), wake["name"] as? String ?? "")
    }
  }

  func testPushRegistrationAndAnalysisMessages() throws {
    let token = Data((0..<32).map { UInt8($0 * 7 & 0xff) })
    let hex = ReadyNoticePolicy.apnsTokenHex(token)
    XCTAssertEqual(hex.count, 64)
    XCTAssertEqual(hex, hex.lowercased())
    let example = try Fixtures.messageObject("push_token_ios_request")
    let model = try decoder.decode(PushTokenRequest.self, from: Fixtures.message("push_token_ios_request"))
    XCTAssertEqual(model.provider, .apns)
    let encoded = try XCTUnwrap(JSONSerialization.jsonObject(with: AtlasJSON.encoder().encode(model)) as? NSDictionary)
    XCTAssertEqual(encoded, example)
    _ = try decoder.decode(PushTokenResponse.self, from: Fixtures.message("push_token_response"))
    let media = try decoder.decode(MediaDetail.self, from: Fixtures.message("media_detail_response"))
    let request = AnalyzeMediaRequest(expectedGeneration: media.generation)
    let requestJSON = try XCTUnwrap(JSONSerialization.jsonObject(with: AtlasJSON.encoder().encode(request)) as? NSDictionary)
    XCTAssertEqual(requestJSON, try Fixtures.messageObject("analyze_photo_request"))
    XCTAssertEqual(try decoder.decode(AnalysisStatus.self, from: Fixtures.message("analysis_queued_response")).state, .queued)
    let done = try decoder.decode(AnalysisStatus.self, from: Fixtures.message("analysis_complete_response"))
    XCTAssertEqual(done.state, .complete)
    XCTAssertNotNil(done.resultURL)
  }

  func testStoreKeepsAtMostTheNewestWatches() async throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let store = ReadyNoticeStore(directory: dir)
    let account = UUID()
    let start = Date(timeIntervalSince1970: 1_800_000_000)
    for i in 0..<(ReadyNoticePolicy.maxWatched + 3) {
      await store.watch(WatchedAnalysis(mediaID: UUID(), analysisID: UUID(), startedAt: start.addingTimeInterval(Double(i))), account: account)
    }
    let list = await store.watched(account: account)
    XCTAssertEqual(list.count, ReadyNoticePolicy.maxWatched)
    XCTAssertEqual(list.first?.startedAt, start.addingTimeInterval(3))
    let otherAccount = await store.watched(account: UUID())
    XCTAssertTrue(otherAccount.isEmpty, "watches are per account")
    await store.stop(try XCTUnwrap(list.first).analysisID, account: account)
    let remaining = await store.watched(account: account)
    XCTAssertEqual(remaining.count, ReadyNoticePolicy.maxWatched - 1)
    try? FileManager.default.removeItem(at: dir)
  }
}
