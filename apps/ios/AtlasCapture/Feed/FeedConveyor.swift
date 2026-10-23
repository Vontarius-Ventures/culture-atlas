import Foundation

/// A card the conveyor can carry. Identity is the card id, never a slot index.
public protocol ConveyorCard: Identifiable where ID: Hashable {
  /// True when the card has a real (sourced or project-original) picture.
  var hasPicture: Bool { get }
}

extension DiscoveryCard: ConveyorCard {
  public var hasPicture: Bool { image != nil }
}

/// Pure model of the living feed: a few lanes that drift continuously, each a
/// stack of equally sized cards with fixed spacing. Cards enter past the far
/// edge of the viewport and leave off the near edge; when one leaves, the next
/// waiting card from the pool joins the end of that lane.
///
/// Positions are along one axis ("main axis"): vertical for the feed columns,
/// horizontal for the Similar rail. A positive `advance` moves content toward
/// the leading edge (up / left).
///
/// Invariants (unit tested):
/// - Within a lane, consecutive cards start at least `pitch` apart, so two
///   cards never overlap, including while cards are inserted or removed.
/// - A card id is on screen at most once across all lanes.
/// - Pictured cards are preferred; fresh cards before already-seen ones; the
///   least recently shown card is recycled first when the pool is small.
public struct FeedConveyor<Card: ConveyorCard> {
  public struct Entry: Equatable {
    public var id: Card.ID
    /// Start of the card in lane content coordinates.
    public var start: Double
  }

  public struct Lane: Equatable {
    public var entries: [Entry] = []
    /// How far this lane's content has moved toward the leading edge.
    public var scroll: Double = 0
    /// Points per second.
    public var speed: Double
  }

  /// A card's on-screen placement: `offset` is measured from the viewport's
  /// leading edge along the main axis.
  public struct Placement: Equatable {
    public var lane: Int
    public var id: Card.ID
    public var offset: Double
  }

  public private(set) var lanes: [Lane]
  public private(set) var pool: [Card] = []
  public private(set) var fresh: Set<Card.ID> = []
  /// Size of one card along the main axis.
  public private(set) var itemLength: Double
  public let spacing: Double
  /// Visible length of a lane along the main axis.
  public private(set) var viewport: Double

  private var lastShown: [Card.ID: Int] = [:]
  /// When each card last left off the leading edge (for scrubbing back).
  private var departed: [Card.ID: Int] = [:]
  private var clock = 0

  public var pitch: Double { itemLength + spacing }

  public init(laneSpeeds: [Double], itemLength: Double, spacing: Double, viewport: Double) {
    precondition(laneSpeeds.isEmpty == false)
    lanes = laneSpeeds.map { Lane(speed: $0) }
    self.itemLength = max(1, itemLength)
    self.spacing = max(0, spacing)
    self.viewport = max(0, viewport)
  }

  // MARK: Pool

  /// Replace the pool (newest first). Cards already on screen stay where they
  /// are; new cards join as others leave. Never resets the lanes.
  public mutating func setPool(_ cards: [Card], fresh: Set<Card.ID> = []) {
    var seen = Set<Card.ID>()
    let next = cards.filter { seen.insert($0.id).inserted }
    // Cards that left the pool drift off naturally but never re-enter (they
    // are no longer candidates). Keep them renderable until they leave.
    let held = heldIDs
    for card in pool where held.contains(card.id) && !seen.contains(card.id) {
      retired[card.id] = card
    }
    for id in seen { retired[id] = nil }
    pool = next
    self.fresh = fresh
    if lanes.allSatisfy({ $0.entries.isEmpty }) {
      fillInitially()
    } else {
      topUp()
    }
  }

  /// Only for `onboarding_required`: the account has no feed at all.
  public mutating func removeAll() {
    for index in lanes.indices { lanes[index].entries = []; lanes[index].scroll = 0 }
    pool = []
    fresh = []
    retired = [:]
  }

  public func card(_ id: Card.ID) -> Card? { pool.first { $0.id == id } ?? retired[id] }

  /// Cards that left the pool while still on screen; kept so they can render
  /// until they drift off.
  private var retired: [Card.ID: Card] = [:]

  public var onScreenIDs: Set<Card.ID> {
    Set(lanes.flatMap { lane in visibleEntries(lane).map(\.id) })
  }

  /// Every id currently held by a lane (visible or just beyond the edges).
  public var heldIDs: Set<Card.ID> { Set(lanes.flatMap { $0.entries.map(\.id) }) }

  // MARK: Geometry

  /// Re-measure (first layout, rotation, Dynamic Type). Keeps card order and
  /// each lane's first card position, restacks the rest at the new pitch.
  public mutating func resize(itemLength: Double, viewport: Double) {
    let newLength = max(1, itemLength)
    let newViewport = max(0, viewport)
    guard newLength != self.itemLength || newViewport != self.viewport else { return }
    let ratio = (newLength + spacing) / pitch
    self.itemLength = newLength
    self.viewport = newViewport
    for index in lanes.indices {
      guard let first = lanes[index].entries.first else { continue }
      let firstOffset = (first.start - lanes[index].scroll) * ratio
      lanes[index].scroll = 0
      for e in lanes[index].entries.indices {
        lanes[index].entries[e].start = firstOffset + Double(e) * pitch
      }
    }
    trim()
    topUp()
  }

  // MARK: Motion

  /// Drift every lane by its own speed for `seconds`.
  public mutating func advance(seconds: Double) {
    let dt = min(max(0, seconds), 0.25)
    guard dt > 0 else { return }
    for index in lanes.indices { lanes[index].scroll += lanes[index].speed * dt }
    trim()
    topUp()
  }

  /// Move every lane by `points` (positive toward the leading edge). Used for
  /// touch scrubbing; negative values bring earlier cards back at the leading edge.
  public mutating func scrub(by points: Double) {
    guard points != 0 else { return }
    for index in lanes.indices { lanes[index].scroll += points }
    trim()
    topUp()
  }

  public var placements: [Placement] {
    lanes.enumerated().flatMap { lane, value in
      visibleEntries(value).map { Placement(lane: lane, id: $0.id, offset: $0.start - value.scroll) }
    }
  }

  private func visibleEntries(_ lane: Lane) -> [Entry] {
    lane.entries.filter { e in
      let offset = e.start - lane.scroll
      return offset + itemLength > 0 && offset < viewport
    }
  }

  // MARK: Lane maintenance

  /// Drop cards that are fully past either edge (beyond one waiting slot).
  private mutating func trim() {
    for index in lanes.indices {
      let scroll = lanes[index].scroll
      while let first = lanes[index].entries.first, first.start - scroll + itemLength <= 0 {
        lanes[index].entries.removeFirst()
        clock += 1
        departed[first.id] = clock
        release(first.id)
      }
      while let last = lanes[index].entries.last, last.start - scroll > viewport + pitch {
        lanes[index].entries.removeLast()
        release(last.id)
      }
    }
  }

  private mutating func release(_ id: Card.ID) {
    if heldIDs.contains(id) == false { retired[id] = nil }
  }

  private mutating func fillInitially() {
    for index in lanes.indices {
      // Stagger lanes by a fraction of a card so they never read as one row.
      lanes[index].scroll = Double(index % 2) * pitch * 0.42
    }
    // Round-robin so pictured cards spread across lanes.
    var appended = true
    while appended {
      appended = false
      for index in lanes.indices where needsMore(index) {
        if append(to: index, initial: true) { appended = true }
      }
    }
  }

  private func needsMore(_ index: Int) -> Bool {
    let lane = lanes[index]
    guard let last = lane.entries.last else { return true }
    // Keep one card waiting beyond the trailing edge.
    return last.start - lane.scroll + pitch < viewport + pitch
  }

  private mutating func topUp() {
    var appended = true
    while appended {
      appended = false
      for index in lanes.indices {
        if needsLeading(index), prepend(to: index) { appended = true }
        if needsMore(index), append(to: index, initial: false) { appended = true }
      }
    }
  }

  private func needsLeading(_ index: Int) -> Bool {
    let lane = lanes[index]
    guard let first = lane.entries.first else { return false }
    return first.start - lane.scroll > spacing
  }

  @discardableResult
  private mutating func append(to index: Int, initial: Bool) -> Bool {
    guard let card = nextCandidate(preferRecent: false) else { return false }
    let lane = lanes[index]
    let start: Double
    if let last = lane.entries.last {
      // Never closer than one pitch; never pop into view mid-screen.
      let stacked = last.start + pitch
      start = initial ? stacked : max(stacked, lane.scroll + viewport)
    } else {
      // Initial fill starts at content 0, so a staggered lane begins part-way up.
      start = initial ? 0 : lane.scroll + viewport
    }
    lanes[index].entries.append(Entry(id: card.id, start: start))
    mark(card)
    return true
  }

  @discardableResult
  private mutating func prepend(to index: Int) -> Bool {
    guard let first = lanes[index].entries.first,
          let card = nextCandidate(preferRecent: true) else { return false }
    let start = first.start - pitch
    lanes[index].entries.insert(Entry(id: card.id, start: start), at: 0)
    mark(card)
    return true
  }

  private mutating func mark(_ card: Card) {
    clock += 1
    lastShown[card.id] = clock
  }

  /// Waiting = in the pool and not held by any lane. Pictured first (a real
  /// photo is never passed over for a poster while photos wait), then fresh
  /// never-shown, then never-shown, then least recently shown.
  private func nextCandidate(preferRecent: Bool) -> Card? {
    let held = heldIDs
    let waiting = pool.filter { !held.contains($0.id) }
    guard waiting.isEmpty == false else { return nil }
    let pictured = waiting.filter(\.hasPicture)
    let candidates = pictured.isEmpty ? waiting : pictured
    if preferRecent {
      return candidates.max { (departed[$0.id] ?? 0) < (departed[$1.id] ?? 0) }
    }
    let unseen = candidates.filter { lastShown[$0.id] == nil }
    if let freshCard = unseen.first(where: { fresh.contains($0.id) }) { return freshCard }
    if let first = unseen.first { return first }
    if let freshCard = candidates.filter({ fresh.contains($0.id) })
      .min(by: { (lastShown[$0.id] ?? 0) < (lastShown[$1.id] ?? 0) }) {
      return freshCard
    }
    return candidates.min { (lastShown[$0.id] ?? 0) < (lastShown[$1.id] ?? 0) }
  }

  // MARK: Reduce Motion

  /// Static grid for Reduce Motion: the first `count` cards, pictured first.
  public mutating func staticSelection(count: Int) -> [Card] {
    var picked: [Card] = []
    var held = Set<Card.ID>()
    for _ in 0..<max(0, count) {
      let waiting = pool.filter { !held.contains($0.id) }
      let pictured = waiting.filter(\.hasPicture)
      guard let card = (pictured.isEmpty ? waiting : pictured).first else { break }
      picked.append(card)
      held.insert(card.id)
      mark(card)
    }
    return picked
  }

  /// One Reduce Motion rotation step: which slot to replace and with what.
  /// Posters are replaced before photos; a photo is never replaced by a poster.
  public mutating func staticRotation(of slots: [Card]) -> (index: Int, card: Card)? {
    let held = Set(slots.map(\.id))
    let waiting = pool.filter { !held.contains($0.id) }
    let pictured = waiting.filter(\.hasPicture)
    let candidates = pictured.isEmpty ? waiting : pictured
    let unseen = candidates.filter { lastShown[$0.id] == nil }
    guard let incoming = unseen.first(where: { fresh.contains($0.id) }) ?? unseen.first
      ?? candidates.min(by: { (lastShown[$0.id] ?? 0) < (lastShown[$1.id] ?? 0) }) else { return nil }
    let posters = slots.indices.filter { !slots[$0].hasPicture }
    let outgoing: Int?
    if incoming.hasPicture == false && slots.contains(where: \.hasPicture) {
      outgoing = posters.min { (lastShown[slots[$0].id] ?? 0) < (lastShown[slots[$1].id] ?? 0) }
    } else {
      outgoing = posters.first ?? slots.indices.min { (lastShown[slots[$0].id] ?? 0) < (lastShown[slots[$1].id] ?? 0) }
    }
    guard let index = outgoing else { return nil }
    mark(incoming)
    return (index, incoming)
  }
}
