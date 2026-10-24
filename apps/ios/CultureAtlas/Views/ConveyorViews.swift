import AtlasCapture
import SwiftUI

/// Holds a `FeedConveyor` and advances it from the display's frame clock
/// (`TimelineView(.animation)`). Frame-by-frame motion lives in a plain stored
/// property so drawing a frame never publishes a change; `revision` is
/// published only for pool, size, or scrub updates.
///
/// A flick hands the conveyor a momentum velocity that decays frame by frame
/// (independent of the drift, which stays paused until the finger has been
/// off the screen for a moment).
@MainActor
final class ConveyorDriver<Card: ConveyorCard>: ObservableObject {
  private(set) var conveyor: FeedConveyor<Card>
  private var lastTick: Date?
  /// Points per second toward the leading edge; decays to zero.
  private var momentum: Double = 0
  @Published private(set) var revision = 0
  /// True while a flick is still coasting (keeps the frame clock running).
  @Published private(set) var coasting = false

  /// Exponential decay rate of a flick (per second). ~0.35 s half-life.
  static var momentumDecay: Double { 2.0 }

  init(laneSpeeds: [Double], spacing: Double) {
    conveyor = FeedConveyor(laneSpeeds: laneSpeeds, itemLength: 1, spacing: spacing, viewport: 0)
  }

  func setPool(_ cards: [Card], fresh: Set<Card.ID>) {
    conveyor.setPool(cards, fresh: fresh)
    revision += 1
  }

  func removeAll() {
    conveyor.removeAll()
    revision += 1
  }

  func resize(itemLength: Double, viewport: Double) {
    guard itemLength > 1, viewport > 0 else { return }
    conveyor.resize(itemLength: itemLength, viewport: viewport)
    revision += 1
  }

  /// Finger down: any coasting flick stops where it is.
  func grab() {
    momentum = 0
    if coasting { coasting = false }
  }

  func scrub(by points: Double) {
    conveyor.scrub(by: points)
    lastTick = nil
    revision += 1
  }

  /// Release with a velocity (points per second toward the leading edge).
  func fling(velocity: Double) {
    let capped = max(-3200, min(3200, velocity))
    guard abs(capped) > 60 else { return }
    momentum = capped
    lastTick = nil
    coasting = true
  }

  /// Advance to `date` and return the state to draw. Called from a
  /// TimelineView body; it mutates only unpublished storage.
  func frame(at date: Date, running: Bool) -> FeedConveyor<Card> {
    let active = running || momentum != 0
    if active, let lastTick {
      let raw = date.timeIntervalSince(lastTick)
      // After a pause (touch, background), resume smoothly instead of jumping.
      // A slow frame still advances by real time (the model caps a step).
      let dt = raw > 0.5 ? 1.0 / 60 : raw
      if running { conveyor.advance(seconds: dt) }
      if momentum != 0 {
        conveyor.scrub(by: momentum * dt)
        momentum *= exp(-Self.momentumDecay * dt)
        if abs(momentum) < 12 {
          momentum = 0
          // Publishing from a view update is not allowed; flip on the next turn.
          DispatchQueue.main.async { [weak self] in self?.coasting = false }
        }
      }
    }
    lastTick = active ? date : nil
    return conveyor
  }
}

/// Pauses auto-drift while the user touches or scrolls, resuming ~2 s after
/// release. Shared by the feed columns and the Similar rail.
@MainActor
final class DriftPause: ObservableObject {
  @Published private(set) var held = false
  private var resumeTask: Task<Void, Never>?

  func touch() {
    resumeTask?.cancel()
    resumeTask = nil
    if held == false { held = true }
  }

  func release(after seconds: Double = 2) {
    resumeTask?.cancel()
    resumeTask = Task { [weak self] in
      try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
      guard Task.isCancelled == false else { return }
      self?.held = false
    }
  }
}

extension View {
  /// Report user scrolling of the enclosing ScrollView to `pause`.
  @ViewBuilder
  func pausesDrift(_ pause: DriftPause) -> some View {
    if #available(iOS 18.0, *) {
      onScrollPhaseChange { _, phase in
        // Only a finger on the scroll view holds the drift. Programmatic
        // scrolls (tab re-tap scrolls to top) can stay in .animating without
        // reporting .idle, so they must never pause it.
        switch phase {
        case .tracking, .interacting: pause.touch()
        default: pause.release()
        }
      }
    } else {
      simultaneousGesture(
        DragGesture(minimumDistance: 4)
          .onChanged { _ in pause.touch() }
          .onEnded { _ in pause.release() }
      )
    }
  }
}

/// Fixed tile geometry so every card in a lane is the same length: a 4:5
/// picture plus a two-line title and room for the example label.
enum FeedTileMetrics {
  static let spacing: CGFloat = 12
  /// Default text block under the picture (scaled with Dynamic Type by the view).
  static let textBlock: CGFloat = 70
  /// Points per second, per lane. Different speeds keep the columns from reading as rows.
  static let laneSpeeds: [Double] = [22, 17]

  static func height(forWidth width: CGFloat, textBlock: CGFloat = textBlock) -> CGFloat {
    (width * 5 / 4 + textBlock).rounded(.up)
  }
}

/// The feed: columns that drift upward at different speeds. Cards enter
/// below the visible area and leave off the top; identity is the card id.
/// Drag to scrub through the feed; a flick coasts with momentum.
struct FeedConveyorColumns: View {
  @ObservedObject var driver: ConveyorDriver<DiscoveryCard>
  @ObservedObject var pause: DriftPause
  let paused: Bool
  let width: CGFloat
  let height: CGFloat
  let baseURL: URL
  let zoom: Namespace.ID
  /// A long downward pull asks for fresh picks (the conveyor owns vertical
  /// drags, so this stands in for the scroll view's pull-to-refresh).
  var onPullToRefresh: () -> Void = {}
  let onOpen: (DiscoveryCard) -> Void

  @ScaledMetric(relativeTo: .callout) private var textBlock: CGFloat = FeedTileMetrics.textBlock
  @State private var lastDrag: CGFloat = 0
  @State private var dragging = false
  @State private var pullArmed = false

  static var pullThreshold: CGFloat { 150 }

  private var laneCount: Int { max(1, driver.conveyor.lanes.count) }
  private var columnWidth: CGFloat {
    max(1, (width - FeedTileMetrics.spacing * CGFloat(laneCount - 1)) / CGFloat(laneCount))
  }
  private var tileHeight: CGFloat { FeedTileMetrics.height(forWidth: columnWidth, textBlock: textBlock) }

  var body: some View {
    TimelineView(.animation(minimumInterval: nil, paused: paused && !driver.coasting)) { context in
      let state = driver.frame(at: context.date, running: !paused)
      let placements = state.placements
      HStack(alignment: .top, spacing: FeedTileMetrics.spacing) {
        ForEach(0..<state.lanes.count, id: \.self) { lane in
          ZStack(alignment: .top) {
            ForEach(placements.filter { $0.lane == lane }, id: \.id) { placement in
              if let card = state.card(placement.id) {
                Button { onOpen(card) } label: {
                  FeedCardTile(card: card, baseURL: baseURL)
                    .frame(width: columnWidth, height: tileHeight, alignment: .top)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.pressableCard)
                .atlasZoomSource(id: card.id, in: zoom)
                .accessibilityIdentifier("feed.card.\(card.id.uuidString)")
                .offset(y: placement.offset)
              }
            }
          }
          .frame(width: columnWidth, height: height, alignment: .top)
          .clipped()
          .contentShape(Rectangle())
        }
      }
      .frame(width: width, height: height, alignment: .topLeading)
    }
    // Cards dissolve into the paper at the top and bottom instead of being cut.
    .edgeFade(.vertical, length: 28)
    .overlay(alignment: .top) {
      if pullArmed {
        Label("Release for fresh picks", systemImage: "arrow.down.circle.fill")
          .font(.footnote.weight(.semibold))
          .foregroundStyle(AtlasTheme.olive)
          .padding(.horizontal, 14)
          .padding(.vertical, 8)
          .background(Capsule().fill(AtlasTheme.ivory).shadow(color: .black.opacity(0.1), radius: 8, y: 3))
          .padding(.top, 8)
          .transition(.move(edge: .top).combined(with: .opacity))
      }
    }
    .animation(AtlasMotion.spring, value: pullArmed)
    .sensoryFeedback(.impact(weight: .light), trigger: pullArmed) { _, armed in armed }
    .gesture(scrubGesture)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("feed.conveyor")
    .onAppear { resize() }
    .onChange(of: width) { _, _ in resize() }
    .onChange(of: height) { _, _ in resize() }
    .onChange(of: textBlock) { _, _ in resize() }
    .onChange(of: laneCount) { _, _ in resize() }
  }

  private func resize() {
    driver.resize(itemLength: Double(tileHeight), viewport: Double(height))
  }

  /// Vertical drag scrubs every lane; release with velocity coasts.
  private var scrubGesture: some Gesture {
    DragGesture(minimumDistance: 10)
      .onChanged { value in
        if !dragging {
          dragging = true
          lastDrag = 0
          driver.grab()
          pause.touch()
        }
        // Dragging up moves content up (toward the leading edge).
        driver.scrub(by: Double(lastDrag - value.translation.height))
        lastDrag = value.translation.height
        let armed = value.translation.height > Self.pullThreshold
        if armed != pullArmed { pullArmed = armed }
      }
      .onEnded { value in
        dragging = false
        lastDrag = 0
        if pullArmed {
          pullArmed = false
          onPullToRefresh()
        } else {
          driver.fling(velocity: Double(-value.velocity.height))
        }
        pause.release(after: 2)
      }
  }
}

/// Reduce Motion: a still grid. One card rotates at a time: the outgoing card
/// fades out completely before the incoming one fades in, keyed by id, so two
/// cards never share a cell.
struct FeedStaticGrid: View {
  let slots: [DiscoveryCard]
  let hiddenID: UUID?
  let baseURL: URL
  var columns: Int = 2
  let onOpen: (DiscoveryCard) -> Void

  private var gridItems: [GridItem] {
    Array(repeating: GridItem(.flexible(), spacing: FeedTileMetrics.spacing, alignment: .top), count: max(1, columns))
  }

  var body: some View {
    LazyVGrid(columns: gridItems, alignment: .leading, spacing: FeedTileMetrics.spacing) {
      ForEach(slots) { card in
        Button { onOpen(card) } label: {
          FeedCardTile(card: card, baseURL: baseURL)
        }
        .buttonStyle(.pressableCard)
        .accessibilityIdentifier("feed.card.\(card.id.uuidString)")
        .opacity(card.id == hiddenID ? 0 : 1)
      }
    }
    .accessibilityIdentifier("feed.grid")
  }
}

/// Similar rail: one lane drifting left through the cached related cards.
/// Dragging scrubs it and pauses the drift; a flick coasts. Reduce Motion
/// shows it still. The rail bleeds to the screen edges with soft fades.
struct SimilarConveyorRail: View {
  let cards: [DiscoveryCard]
  let baseURL: URL
  let reduceMotion: Bool
  /// Capture rails show each card's server reason under its title.
  var showsReason = false
  var identifier = "similar.rail"
  var cardPrefix = "similar.card."
  let destination: (DiscoveryCard) -> FeedCardDetail
  @StateObject private var driver = ConveyorDriver<DiscoveryCard>(laneSpeeds: [16], spacing: FeedTileMetrics.spacing)
  @StateObject private var pause = DriftPause()
  @State private var lastDrag: CGFloat = 0
  @State private var dragging = false
  @Environment(\.scenePhase) private var scenePhase
  @Environment(\.accessibilityVoiceOverEnabled) private var voiceOver

  private let tileWidth: CGFloat = 132
  private var tileHeight: CGFloat { (tileWidth * 5 / 4 + (showsReason ? 112 : 46)).rounded(.up) }

  var body: some View {
    Group {
      if reduceMotion {
        ScrollView(.horizontal, showsIndicators: false) {
          HStack(alignment: .top, spacing: FeedTileMetrics.spacing) {
            ForEach(cards) { card in tile(card) }
          }
          .padding(.horizontal, 16)
          .padding(.vertical, 10)
        }
      } else {
        GeometryReader { geo in
          if fitsWithoutDrift(width: geo.size.width) {
            // Too few cards to fill the width: a looping drift would show a
            // large gap, so they sit still in a row instead.
            HStack(alignment: .top, spacing: FeedTileMetrics.spacing) {
              ForEach(cards) { card in tile(card) }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
          } else {
          drifting(width: geo.size.width)
            .onAppear { driver.resize(itemLength: Double(tileWidth), viewport: Double(geo.size.width)) }
            .onChange(of: geo.size.width) { _, width in
              driver.resize(itemLength: Double(tileWidth), viewport: Double(width))
            }
          }
        }
        .frame(height: tileHeight + 20)
        .edgeFade(.horizontal, length: 20)
      }
    }
    // Container identifier on a wrapper that keeps each card addressable.
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier(identifier)
    .onAppear { driver.setPool(cards, fresh: []) }
    .onChange(of: cards.map(\.id)) { _, _ in driver.setPool(cards, fresh: Set(cards.map(\.id))) }
  }

  private func fitsWithoutDrift(width: CGFloat) -> Bool {
    CGFloat(cards.count) * (tileWidth + FeedTileMetrics.spacing) + 32 <= width
  }

  private func drifting(width: CGFloat) -> some View {
    // VoiceOver holds the drift so its cursor never chases a moving card.
    let paused = pause.held || scenePhase != .active || voiceOver
    return TimelineView(.animation(minimumInterval: nil, paused: paused && !driver.coasting)) { context in
      let state = driver.frame(at: context.date, running: !paused)
      ZStack(alignment: .leading) {
        ForEach(state.placements, id: \.id) { placement in
          if let card = state.card(placement.id) {
            tile(card).offset(x: placement.offset)
          }
        }
      }
      .frame(width: width, height: tileHeight, alignment: .leading)
      .padding(.vertical, 10)
      .clipped()
      .contentShape(Rectangle())
    }
    .simultaneousGesture(
      DragGesture(minimumDistance: 8)
        .onChanged { value in
          if !dragging {
            dragging = true
            lastDrag = 0
            driver.grab()
            pause.touch()
          }
          // Dragging left moves content left (toward the leading edge).
          driver.scrub(by: Double(lastDrag - value.translation.width))
          lastDrag = value.translation.width
        }
        .onEnded { value in
          dragging = false
          lastDrag = 0
          driver.fling(velocity: Double(-value.velocity.width))
          pause.release()
        }
    )
  }

  private func tile(_ card: DiscoveryCard) -> some View {
    NavigationLink {
      destination(card)
    } label: {
      FeedCardTile(card: card, baseURL: baseURL, captionForPosters: showsReason, showsReason: showsReason)
        .frame(width: tileWidth, height: tileHeight, alignment: .top)
        .contentShape(Rectangle())
    }
    .buttonStyle(.pressableCard)
    .accessibilityIdentifier("\(cardPrefix)\(card.id.uuidString)")
  }
}
