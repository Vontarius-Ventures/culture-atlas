import AtlasCapture
import SwiftUI

/// Holds a `FeedConveyor` and advances it from the display's frame clock
/// (`TimelineView(.animation)`). Frame-by-frame motion lives in a plain stored
/// property so drawing a frame never publishes a change; `revision` is
/// published only for pool, size, or scrub updates.
@MainActor
final class ConveyorDriver<Card: ConveyorCard>: ObservableObject {
  private(set) var conveyor: FeedConveyor<Card>
  private var lastTick: Date?
  @Published private(set) var revision = 0

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

  func scrub(by points: Double) {
    conveyor.scrub(by: points)
    lastTick = nil
    revision += 1
  }

  /// Advance to `date` and return the state to draw. Called from a
  /// TimelineView body; it mutates only unpublished storage.
  func frame(at date: Date, running: Bool) -> FeedConveyor<Card> {
    if running, let lastTick {
      let dt = date.timeIntervalSince(lastTick)
      // After a pause (touch, background), resume smoothly instead of jumping.
      conveyor.advance(seconds: dt > 0.1 ? 1.0 / 60 : dt)
    }
    lastTick = running ? date : nil
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
        if phase == .idle { pause.release() } else { pause.touch() }
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
  static let textBlock: CGFloat = 70

  static func height(forWidth width: CGFloat) -> CGFloat {
    (width * 5 / 4 + textBlock).rounded(.up)
  }
}

/// The feed: two columns that drift upward at different speeds. Cards enter
/// below the visible area and leave off the top; identity is the card id.
struct FeedConveyorColumns: View {
  @ObservedObject var driver: ConveyorDriver<DiscoveryCard>
  let paused: Bool
  let width: CGFloat
  let height: CGFloat
  let baseURL: URL
  let onOpen: (DiscoveryCard) -> Void

  private var columnWidth: CGFloat { max(1, (width - FeedTileMetrics.spacing) / 2) }
  private var tileHeight: CGFloat { FeedTileMetrics.height(forWidth: columnWidth) }

  var body: some View {
    TimelineView(.animation(minimumInterval: nil, paused: paused)) { context in
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
                .buttonStyle(.plain)
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
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("feed.conveyor")
    .onAppear { driver.resize(itemLength: Double(tileHeight), viewport: Double(height)) }
    .onChange(of: width) { _, _ in driver.resize(itemLength: Double(tileHeight), viewport: Double(height)) }
    .onChange(of: height) { _, _ in driver.resize(itemLength: Double(tileHeight), viewport: Double(height)) }
  }
}

/// Reduce Motion: a still two-column grid. One card rotates at a time: the
/// outgoing card fades out completely before the incoming one fades in, keyed
/// by id, so two cards never share a cell.
struct FeedStaticGrid: View {
  let slots: [DiscoveryCard]
  let hiddenID: UUID?
  let baseURL: URL
  let onOpen: (DiscoveryCard) -> Void

  private let columns = [
    GridItem(.flexible(), spacing: FeedTileMetrics.spacing),
    GridItem(.flexible(), spacing: FeedTileMetrics.spacing),
  ]

  var body: some View {
    LazyVGrid(columns: columns, alignment: .leading, spacing: FeedTileMetrics.spacing) {
      ForEach(slots) { card in
        Button { onOpen(card) } label: {
          FeedCardTile(card: card, baseURL: baseURL)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("feed.card.\(card.id.uuidString)")
        .opacity(card.id == hiddenID ? 0 : 1)
      }
    }
    .accessibilityIdentifier("feed.grid")
  }
}

/// Similar rail: one lane drifting left through the cached related cards.
/// Dragging scrubs it and pauses the drift; Reduce Motion shows it still.
struct SimilarConveyorRail: View {
  let cards: [DiscoveryCard]
  let baseURL: URL
  let reduceMotion: Bool
  let destination: (DiscoveryCard) -> FeedCardDetail
  @StateObject private var driver = ConveyorDriver<DiscoveryCard>(laneSpeeds: [16], spacing: FeedTileMetrics.spacing)
  @StateObject private var pause = DriftPause()
  @State private var lastDrag: CGFloat = 0
  @Environment(\.scenePhase) private var scenePhase

  private let tileWidth: CGFloat = 120
  private var tileHeight: CGFloat { FeedTileMetrics.height(forWidth: tileWidth) }

  var body: some View {
    Group {
      if reduceMotion {
        ScrollView(.horizontal, showsIndicators: false) {
          HStack(alignment: .top, spacing: FeedTileMetrics.spacing) {
            ForEach(cards) { card in tile(card) }
          }
          .padding(.vertical, 10)
        }
      } else {
        GeometryReader { geo in
          drifting(width: geo.size.width)
            .onAppear { driver.resize(itemLength: Double(tileWidth), viewport: Double(geo.size.width)) }
            .onChange(of: geo.size.width) { _, width in
              driver.resize(itemLength: Double(tileWidth), viewport: Double(width))
            }
        }
        .frame(height: tileHeight + 20)
      }
    }
    .accessibilityIdentifier("similar.rail")
    .onAppear { driver.setPool(cards, fresh: []) }
    .onChange(of: cards.map(\.id)) { _, _ in driver.setPool(cards, fresh: Set(cards.map(\.id))) }
  }

  private func drifting(width: CGFloat) -> some View {
    let paused = pause.held || scenePhase != .active
    return TimelineView(.animation(minimumInterval: nil, paused: paused)) { context in
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
          pause.touch()
          // Dragging left moves content left (toward the leading edge).
          driver.scrub(by: Double(lastDrag - value.translation.width))
          lastDrag = value.translation.width
        }
        .onEnded { _ in
          lastDrag = 0
          pause.release()
        }
    )
  }

  private func tile(_ card: DiscoveryCard) -> some View {
    NavigationLink {
      destination(card)
    } label: {
      FeedCardTile(card: card, baseURL: baseURL)
        .frame(width: tileWidth, height: tileHeight, alignment: .top)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityIdentifier("similar.card.\(card.id.uuidString)")
  }
}
