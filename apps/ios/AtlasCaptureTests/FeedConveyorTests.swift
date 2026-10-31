@testable import AtlasCapture
import UIKit
import XCTest

/// The living feed must flow, never stack cards on top of each other, and key
/// every card by its id (never a slot index).
final class FeedConveyorTests: XCTestCase {
  struct Card: ConveyorCard, Equatable {
    var id: Int
    var hasPicture: Bool
  }

  private func cards(_ range: ClosedRange<Int>, pictured: Bool = true) -> [Card] {
    range.map { Card(id: $0, hasPicture: pictured) }
  }

  private func feed(_ pool: [Card], fresh: Set<Int> = [], viewport: Double = 640) -> FeedConveyor<Card> {
    var conveyor = FeedConveyor<Card>(laneSpeeds: [14, 11], itemLength: 260, spacing: 12, viewport: viewport)
    conveyor.setPool(pool, fresh: fresh)
    return conveyor
  }

  /// No two cards in a lane ever occupy the same space, and no id is held twice.
  private func assertInvariants(_ c: FeedConveyor<Card>, file: StaticString = #filePath, line: UInt = #line) {
    var ids = Set<Int>()
    for lane in c.lanes {
      for (a, b) in zip(lane.entries, lane.entries.dropFirst()) {
        XCTAssertGreaterThanOrEqual(b.start - a.start, c.pitch - 1e-9, "cards overlap", file: file, line: line)
      }
      for e in lane.entries {
        XCTAssertTrue(ids.insert(e.id).inserted, "card \(e.id) held twice", file: file, line: line)
      }
    }
    // Placements (what the view draws) never intersect within a lane either.
    for lane in c.lanes.indices {
      let spans = c.placements.filter { $0.lane == lane }.map(\.offset).sorted()
      for (a, b) in zip(spans, spans.dropFirst()) {
        XCTAssertGreaterThanOrEqual(b - a, c.itemLength, "visible tiles intersect", file: file, line: line)
      }
    }
  }

  func testDriftsContinuouslyAndCardsFlowThrough() {
    var c = feed(cards(1...30))
    let firstVisible = c.onScreenIDs
    XCTAssertFalse(firstVisible.isEmpty)
    var seen = firstVisible
    // ~90 s at 60 fps.
    for _ in 0..<(90 * 60) {
      c.advance(seconds: 1.0 / 60)
      assertInvariants(c)
      seen.formUnion(c.onScreenIDs)
    }
    XCTAssertTrue(c.onScreenIDs.isDisjoint(with: firstVisible) || c.onScreenIDs != firstVisible, "feed must move on")
    XCTAssertGreaterThan(seen.count, firstVisible.count + 4, "new suggestions should float through")
    XCTAssertGreaterThan(c.lanes[0].scroll, 1000)
    XCTAssertNotEqual(c.lanes[0].speed, c.lanes[1].speed, "lanes must not move in lockstep")
  }

  func testHitTestFindsOnlyTheCardUnderThePoint() throws {
    var conveyor = FeedConveyor<Card>(laneSpeeds: [20, 14], itemLength: 100, spacing: 10, viewport: 400)
    conveyor.setPool((0..<12).map { Card(id: $0, hasPicture: true) }, fresh: [])
    let placement = try XCTUnwrap(conveyor.placements.first { $0.lane == 0 && $0.offset >= 0 })
    XCTAssertEqual(conveyor.cardID(lane: 0, at: placement.offset + 50), placement.id)
    XCTAssertNil(conveyor.cardID(lane: 0, at: placement.offset + 105), "the gap between cards opens nothing")
    XCTAssertNil(conveyor.cardID(lane: 9, at: placement.offset + 50))
  }

  func testDownsamplingBoundsTheDecodedSize() throws {
    let source = UIGraphicsImageRenderer(size: CGSize(width: 2000, height: 1000), format: {
      let format = UIGraphicsImageRendererFormat()
      format.scale = 1
      return format
    }()).image { $0.fill(CGRect(x: 0, y: 0, width: 2000, height: 1000)) }
    let image = try XCTUnwrap(ImageDownsampler.image(from: try XCTUnwrap(source.pngData()), maxPixelSize: 700))
    XCTAssertEqual(max(image.size.width, image.size.height), 700)
    XCTAssertNil(ImageDownsampler.image(from: Data("not an image".utf8), maxPixelSize: 700))
  }

  func testLanesAreStaggered() {
    let c = feed(cards(1...30))
    let lane0 = c.placements.filter { $0.lane == 0 }.map(\.offset).min()!
    let lane1 = c.placements.filter { $0.lane == 1 }.map(\.offset).min()!
    XCTAssertNotEqual(lane0, lane1)
  }

  func testNewCardsEnterFromBelowTheViewport() {
    var c = feed(cards(1...30))
    var previous = c.onScreenIDs
    for _ in 0..<(60 * 60) {
      c.advance(seconds: 1.0 / 60)
      for p in c.placements where !previous.contains(p.id) {
        XCTAssertGreaterThan(p.offset, c.viewport - 2, "card \(p.id) popped in mid-screen")
      }
      previous = c.onScreenIDs
    }
  }

  func testSmallPoolRecyclesWithoutShowingDuplicates() {
    var c = feed(cards(1...5))
    var seen = Set<Int>()
    for _ in 0..<(120 * 30) {
      c.advance(seconds: 1.0 / 30)
      assertInvariants(c)
      seen.formUnion(c.onScreenIDs)
    }
    XCTAssertEqual(seen, Set(1...5), "a small pool recycles cards that scrolled off")
  }

  func testPicturedCardsArePreferredOverPosters() {
    let pool = cards(1...4, pictured: false) + cards(10...25)
    let c = feed(pool)
    let held = c.heldIDs
    XCTAssertTrue(held.allSatisfy { $0 >= 10 }, "posters must wait while photos are waiting: \(held)")
  }

  func testFreshCardsJoinBeforeAlreadySeenOnes() {
    var c = feed(cards(1...30))
    c.setPool(cards(100...105) + cards(1...30), fresh: Set(100...105))
    var order: [Int] = []
    var held = c.heldIDs
    for _ in 0..<(120 * 60) {
      c.advance(seconds: 1.0 / 60)
      for id in c.heldIDs.subtracting(held) { order.append(id) }
      held = c.heldIDs
    }
    XCTAssertEqual(Array(order.prefix(6)).sorted(), Array(100...105))
  }

  func testRefreshJoinsTheConveyorInsteadOfResettingIt() {
    var c = feed(cards(1...30))
    for _ in 0..<120 { c.advance(seconds: 1.0 / 60) }
    let before = c.placements
    c.setPool(cards(200...220), fresh: Set(200...220))
    XCTAssertEqual(c.placements, before, "refresh must not reset or empty what is on screen")
    for _ in 0..<(40 * 60) { c.advance(seconds: 1.0 / 60); assertInvariants(c) }
    XCTAssertTrue(c.onScreenIDs.contains { $0 >= 200 })
  }

  func testEmptyRefreshNeverEmptiesTheFeed() {
    var c = feed(cards(1...30))
    let before = c.placements
    c.setPool([], fresh: [])
    XCTAssertEqual(c.placements, before)
    XCTAssertNotNil(c.card(before[0].id), "cards on screen stay renderable")
  }

  func testScrubbingBackwardBringsEarlierCardsBackWithoutOverlap() {
    var c = feed(cards(1...30))
    for _ in 0..<(20 * 60) { c.advance(seconds: 1.0 / 60) }
    for _ in 0..<200 { c.scrub(by: -6); assertInvariants(c) }
    for _ in 0..<200 { c.scrub(by: 9); assertInvariants(c) }
  }

  func testResizeKeepsOrderAndSpacing() {
    var c = feed(cards(1...30))
    for _ in 0..<300 { c.advance(seconds: 1.0 / 60) }
    let order = c.lanes[0].entries.map(\.id)
    c.resize(itemLength: 300, viewport: 700)
    assertInvariants(c)
    XCTAssertEqual(Array(c.lanes[0].entries.map(\.id).prefix(2)), Array(order.prefix(2)))
  }

  func testReduceMotionRotationNeverSwapsAPhotoForAPoster() {
    var c = feed(cards(1...4) + cards(50...60, pictured: false))
    var slots = c.staticSelection(count: 4)
    XCTAssertEqual(slots.map(\.id), [1, 2, 3, 4])
    // Only posters wait; every slot is a photo, so nothing rotates.
    XCTAssertNil(c.staticRotation(of: slots))
    c.setPool(cards(1...4) + cards(5...6), fresh: [])
    let step = c.staticRotation(of: slots)
    XCTAssertNotNil(step)
    if let step { slots[step.index] = step.card }
    XCTAssertEqual(Set(slots.map(\.id)).count, 4, "no duplicate on screen")
  }

  func testDiscoveryCardsAreKeyedByID() throws {
    let card = DiscoveryCard(
      id: UUID(), kind: "discovery", category: .watch, title: "A", subtitle: nil, image: nil,
      isExample: true, saved: false, savedItemID: nil, recommendationID: nil, evidenceAvailable: false)
    var c = FeedConveyor<DiscoveryCard>(laneSpeeds: [12], itemLength: 100, spacing: 10, viewport: 300)
    c.setPool([card, card])
    XCTAssertEqual(c.heldIDs, [card.id], "duplicate ids collapse to one card")
    XCTAssertFalse(card.hasPicture)
  }
}
