import XCTest

/// The feed floats: tiles are keyed by card id, drift upward over time, and
/// two visible tiles never intersect at any sampled moment.
///
/// Needs a signed-in simulator with onboarding done (for example against the
/// local stack); otherwise it is skipped rather than failing.
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

    var history: [String: [CGFloat]] = [:]
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
