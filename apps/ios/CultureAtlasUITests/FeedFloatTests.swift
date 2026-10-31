import XCTest

/// The feed floats: tiles are keyed by card id, drift upward over time, and
/// two visible tiles never intersect at any sampled moment.
///
/// The live test requires a signed-in account with completed onboarding.
/// Separate simulator fixtures cover the normal shell without server authority.
final class FeedFloatTests: XCTestCase {
  private struct Tile {
    let id: String
    let frame: CGRect
  }

  private func tiles(in app: XCUIApplication) throws -> [Tile] {
    // One snapshot per sample, so every frame comes from the same moment.
    let root = try app.snapshot()
    var found: [Tile] = []
    func walk(_ node: XCUIElementSnapshot) {
      if node.identifier.hasPrefix("feed.card."), node.frame.isEmpty == false {
        found.append(Tile(id: node.identifier, frame: node.frame))
        return
      }
      node.children.forEach(walk)
    }
    walk(root)
    return found
  }

  func testFeedCardsFloatByIdentityAndNeverOverlap() throws {
    let app = XCUIApplication()
    app.launch()
    let feedTab = app.tabBars.buttons["Feed"]
    guard feedTab.waitForExistence(timeout: 25) else {
      throw XCTSkip("Not signed in with a finished onboarding on this simulator")
    }
    feedTab.tap()
    let conveyor = app.descendants(matching: .any)["feed.conveyor"]
    guard conveyor.waitForExistence(timeout: 20) else {
      throw XCTSkip("Feed is in Reduce Motion (still grid) or has no cards")
    }
    let firstCard = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'feed.card.'")).firstMatch
    XCTAssertTrue(firstCard.waitForExistence(timeout: 30), "feed should show cards")

    try assertFloatingCards(in: app)
  }

  /// A scroll that stays inside one tall card must not open it; a tap must.
  func testFixtureScrollNeverOpensACardButATapDoes() throws {
    #if targetEnvironment(simulator)
    let app = XCUIApplication()
    app.launchArguments = ["-AtlasNativeUITestFixture"]
    app.launch()
    let feedTab = app.tabBars.buttons["Feed"]
    XCTAssertTrue(feedTab.waitForExistence(timeout: 15))
    feedTab.tap()
    let conveyor = app.descendants(matching: .any)["feed.conveyor"]
    XCTAssertTrue(conveyor.waitForExistence(timeout: 10))
    let start = conveyor.coordinate(withNormalizedOffset: CGVector(dx: 0.25, dy: 0.5))
    let detail = app.descendants(matching: .any)["detail.hero"]
    for _ in 0..<4 {
      start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: 0, dy: -60)))
      XCTAssertTrue(feedTab.isHittable && conveyor.exists)
      XCTAssertFalse(detail.waitForExistence(timeout: 1), "scrolling opened a card")
    }
    sleep(1)
    start.tap()
    XCTAssertTrue(detail.waitForExistence(timeout: 6), "a tap should open the card")
    #else
    throw XCTSkip("The isolated native UI fixture is simulator-only")
    #endif
  }

  /// Deterministic UI coverage through the normal session/onboarding/feed path.
  /// Synthetic owner data only; this does not qualify live authentication.
  func testFixtureFeedCardsFloatByIdentityAndNeverOverlap() throws {
    #if targetEnvironment(simulator)
    let app = XCUIApplication()
    app.launchArguments = ["-AtlasNativeUITestFixture"]
    app.launch()
    let feedTab = app.tabBars.buttons["Feed"]
    XCTAssertTrue(feedTab.waitForExistence(timeout: 15), "Fixture session and completed onboarding must reach the real tabs")
    feedTab.tap()
    XCTAssertTrue(app.staticTexts["Example results until your personal feed is ready."].waitForExistence(timeout: 10))
    let conveyor = app.descendants(matching: .any)["feed.conveyor"]
    XCTAssertTrue(conveyor.waitForExistence(timeout: 10), "Motion must be enabled for the floating-feed test")
    try assertFloatingCards(in: app)
    #else
    throw XCTSkip("The isolated native UI fixture is simulator-only; use the live test on devices")
    #endif
  }

  func testFixtureWithoutSessionStillRequiresSignIn() throws {
    #if targetEnvironment(simulator)
    let app = XCUIApplication()
    app.launchArguments = ["-AtlasNativeUITestFixture", "-AtlasNativeUITestSignedOut"]
    app.launch()
    XCTAssertTrue(app.buttons["Email me a sign-in link"].waitForExistence(timeout: 10))
    XCTAssertFalse(app.tabBars.buttons["Feed"].exists)
    XCTAssertFalse(app.tabBars.buttons["Capture"].exists)
    #else
    throw XCTSkip("The isolated native UI fixture is simulator-only")
    #endif
  }

  func testFixtureWithIncompleteOnboardingCannotReachTabs() throws {
    #if targetEnvironment(simulator)
    let app = XCUIApplication()
    app.launchArguments = ["-AtlasNativeUITestFixture", "-AtlasNativeUITestOnboardingRequired"]
    app.launch()
    XCTAssertTrue(app.staticTexts["Pick what catches your eye."].waitForExistence(timeout: 15))
    XCTAssertFalse(app.tabBars.buttons["Feed"].exists)
    XCTAssertFalse(app.tabBars.buttons["Capture"].exists)
    #else
    throw XCTSkip("The isolated native UI fixture is simulator-only")
    #endif
  }

  private func assertFloatingCards(in app: XCUIApplication) throws {    var history: [String: [CGFloat]] = [:]
    var everSeen = Set<String>()
    let samples = 16
    for sample in 0..<samples {
      let current = try tiles(in: app)
      XCTAssertFalse(current.isEmpty, "feed went empty at sample \(sample)")
      XCTAssertEqual(Set(current.map(\.id)).count, current.count, "a card is on screen twice at sample \(sample)")
      for (i, a) in current.enumerated() {
        for b in current[(i + 1)...] {
          let overlap = a.frame.insetBy(dx: 1, dy: 1).intersects(b.frame.insetBy(dx: 1, dy: 1))
          XCTAssertFalse(overlap, "\(a.id) overlaps \(b.id) at sample \(sample): \(a.frame) vs \(b.frame)")
        }
        history[a.id, default: []].append(a.frame.minY)
      }
      everSeen.formUnion(current.map(\.id))
      Thread.sleep(forTimeInterval: 0.6)
    }

    // Identity-keyed motion: the same card id moves steadily upward.
    let tracked = history.filter { $0.value.count >= 4 }
    XCTAssertFalse(tracked.isEmpty, "cards should stay identifiable while they move")
    for (id, ys) in tracked {
      XCTAssertLessThan(ys.last!, ys.first! - 20, "\(id) did not drift upward: \(ys)")
      for (earlier, later) in zip(ys, ys.dropFirst()) {
        XCTAssertLessThanOrEqual(later, earlier + 0.5, "\(id) jumped down: \(ys)")
      }
    }
    XCTAssertGreaterThan(everSeen.count, 2)
  }
}
