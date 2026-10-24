import AtlasCapture
import SwiftUI

/// Living interest feed from `GET /v1/discoveries`. Visual-first: licensed
/// pictures when we have them, typographic posters otherwise — never a
/// stand-in portrait of a person or film. Example cards stay labeled.
///
/// Cards float through on a continuous conveyor (two columns drifting upward
/// at different speeds). Touching or scrolling pauses the drift; Reduce Motion
/// shows a still grid that rotates one card at a time.
struct FeedView: View {
  @EnvironmentObject private var controller: CaptureController
  @EnvironmentObject private var notices: ReadyNoticeCenter
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.scenePhase) private var scenePhase
  @Environment(\.accessibilityVoiceOverEnabled) private var voiceOver
  @StateObject private var driver = ConveyorDriver<DiscoveryCard>(laneSpeeds: [14, 11], spacing: FeedTileMetrics.spacing)
  @StateObject private var pause = DriftPause()
  @State private var pool: [DiscoveryCard] = []
  @State private var freshIDs: Set<UUID> = []
  @State private var staticModel = FeedConveyor<DiscoveryCard>(laneSpeeds: [0], itemLength: 1, spacing: 0, viewport: 0)
  @State private var staticSlots: [DiscoveryCard] = []
  @State private var hiddenID: UUID?
  @State private var exampleFeed = false
  @State private var message: String?
  @State private var loading = true
  @State private var adding: DiscoveryCard?
  @State private var boards: [CollectionSummary] = []
  @State private var newBoardName = ""
  @State private var opened: DiscoveryCard?

  private static let staticCount = 6

  /// Cards currently held on screen (conveyor or still grid).
  private var onScreen: [DiscoveryCard] {
    if reduceMotion { return staticSlots }
    let held = driver.conveyor.heldIDs
    return pool.filter { held.contains($0.id) }
  }

  /// VoiceOver holds the drift: its cursor must not chase (or lose) a moving card.
  private var paused: Bool {
    pause.held || scenePhase != .active || opened != nil || adding != nil || voiceOver
  }

  var body: some View {
    GeometryReader { outer in
      ScrollView {
        VStack(alignment: .leading, spacing: 12) {
          header
          feedBody(width: max(0, outer.size.width - 32), height: max(320, outer.size.height - 24))
        }
        .padding(.horizontal, 16)
        .padding(.top, 16)
      }
      .scrollBounceBehavior(.always, axes: .vertical)
      .pausesDrift(pause)
    }
    .background(AtlasTheme.ivory.ignoresSafeArea())
    .navigationTitle("Feed")
    .toolbar {
      ToolbarItem(placement: .topBarTrailing) {
        NavigationLink("Boards") { BoardsView() }
      }
    }
    .overlay { if loading && pool.isEmpty { ProgressView() } }
    .refreshable { await load(refresh: true) }
    .task {
      await load(refresh: false)
      if controller.openFeedDetail {
        opened = onScreen.first { $0.image != nil } ?? onScreen.first
        controller.openFeedDetail = false
      }
      while !Task.isCancelled {
        try? await Task.sleep(nanoseconds: 8_000_000_000)
        // Pull new cards into the pool; never rebuild. The conveyor (or the
        // Reduce Motion rotation) floats them in from there.
        await load(refresh: false)
      }
    }
    .task(id: reduceMotion) {
      guard reduceMotion else { return }
      fillStatic()
      while !Task.isCancelled {
        try? await Task.sleep(nanoseconds: 6_000_000_000)
        await rotateStatic()
      }
    }
    .sheet(item: $adding) { card in
      addToBoardSheet(card)
    }
    .navigationDestination(item: $opened) { card in
      FeedCardDetail(card: card, onAddToBoard: { adding = card })
    }
  }

  @ViewBuilder
  private var header: some View {
    Text("A feed of what you’re into. Pull down for more.")
      .font(.footnote)
      .foregroundStyle(AtlasTheme.muted)
    if exampleFeed {
      Text("These are example results until your personal feed is ready.")
        .font(.footnote)
        .foregroundStyle(AtlasTheme.muted)
    }
    if notices.exploring.isEmpty == false {
      AnalysisLookingBanner()
    } else if notices.toast != nil {
      AnalysisReadyBanner()
    }
    if let message {
      Text(message).foregroundStyle(AtlasTheme.muted)
    } else if pool.isEmpty && !loading {
      Text("No suggestions yet").font(.system(.title3, design: .serif))
      Text("Finish picking your interests, then pull to refresh.")
        .foregroundStyle(AtlasTheme.muted)
    }
  }

  @ViewBuilder
  private func feedBody(width: CGFloat, height: CGFloat) -> some View {
    if reduceMotion {
      FeedStaticGrid(slots: staticSlots, hiddenID: hiddenID, baseURL: controller.api.baseURL) { opened = $0 }
        // Floating tab bar sits over the last row; keep tap targets clear of it.
        .padding(.bottom, 108)
    } else {
      FeedConveyorColumns(
        driver: driver,
        paused: paused,
        width: width,
        height: height,
        baseURL: controller.api.baseURL
      ) { opened = $0 }
    }
  }

  @ViewBuilder
  private func addToBoardSheet(_ card: DiscoveryCard) -> some View {
    NavigationStack {
      List {
        Section("New board") {
          TextField("Board name", text: $newBoardName)
          Button("Create and add") {
            Task { await add(card, creating: newBoardName) }
          }
          .disabled(newBoardName.trimmingCharacters(in: .whitespaces).isEmpty)
        }
        Section("Your boards") {
          if boards.isEmpty {
            Text("No boards yet. Create one above.")
              .foregroundStyle(AtlasTheme.muted)
          }
          ForEach(boards) { board in
            Button(board.name) { Task { await add(card, to: board.id) } }
          }
        }
      }
      .navigationTitle("Add to a board")
      .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { adding = nil } } }
      .task { await loadBoards() }
    }
  }

  /// Pull-to-refresh and polling never wipe cards that are already on screen.
  private func load(refresh: Bool) async {
    loading = true
    defer { loading = false }
    do {
      let feed = try await controller.api.discoveries(refresh: refresh)
      apply(feed)
    } catch AtlasClientError.server(_, "onboarding_required", _, _, _) {
      pool = []
      staticSlots = []
      driver.removeAll()
      message = "Finish picking your interests to see suggestions."
    } catch {
      if pool.isEmpty {
        message = "Suggestions aren't available right now. Pull to try again."
      } else {
        message = "Couldn't refresh. Still showing what you had."
      }
    }
  }

  private func apply(_ feed: DiscoveriesResponse) {
    exampleFeed = feed.isExampleFeed
    if feed.items.isEmpty {
      if pool.isEmpty {
        message = "Still looking for things that match your interests. Pull to try again."
      } else {
        message = "Nothing new yet. Still showing what you had."
      }
      return
    }
    message = nil
    let incomingIDs = Set(feed.items.map(\.id))
    freshIDs = incomingIDs
    let keepOnScreen = Set(onScreen.map(\.id))
    // Keep the latest page plus whatever is on screen. Stale off-screen cards
    // buried new Qloo results in a 50-item shuffle. Posters stay in the pool
    // so a short picture supply never leaves holes; the conveyor still takes
    // pictured cards first and never passes a waiting photo for a poster.
    pool = feed.items + pool.filter { keepOnScreen.contains($0.id) && !incomingIDs.contains($0.id) }
    driver.setPool(pool, fresh: freshIDs)
    if reduceMotion { fillStatic() }
  }

  /// Reduce Motion: fill (never reset) the still grid, pictured cards first.
  private func fillStatic() {
    staticModel.setPool(pool, fresh: freshIDs)
    guard staticSlots.count < Self.staticCount else { return }
    let held = Set(staticSlots.map(\.id))
    let waiting = pool.filter { !held.contains($0.id) }
    let ordered = waiting.filter(\.hasPicture) + waiting.filter { !$0.hasPicture }
    staticSlots += ordered.prefix(Self.staticCount - staticSlots.count)
  }

  /// Fade the outgoing card fully out, swap by id, then fade the new one in,
  /// so two cards never share a cell.
  private func rotateStatic() async {
    staticModel.setPool(pool, fresh: freshIDs)
    guard let step = staticModel.staticRotation(of: staticSlots) else { return }
    let outgoing = staticSlots[step.index].id
    withAnimation(.easeInOut(duration: 0.35)) { hiddenID = outgoing }
    try? await Task.sleep(nanoseconds: 380_000_000)
    guard staticSlots.indices.contains(step.index), staticSlots[step.index].id == outgoing else {
      hiddenID = nil
      return
    }
    var transaction = Transaction()
    transaction.disablesAnimations = true
    withTransaction(transaction) {
      staticSlots[step.index] = step.card
      hiddenID = step.card.id
    }
    withAnimation(.easeInOut(duration: 0.35)) { hiddenID = nil }
  }

  private func loadBoards() async {
    boards = (try? await controller.api.collections())?.collections ?? []
  }

  private func add(_ card: DiscoveryCard, creating name: String) async {
    let trimmed = name.trimmingCharacters(in: .whitespaces)
    guard !trimmed.isEmpty else { return }
    do {
      let board = try await controller.api.createCollection(CreateCollectionRequest(name: trimmed))
      _ = try await controller.api.addCollectionItem(collectionID: board.id, itemID: card.id)
      newBoardName = ""
      adding = nil
    } catch {
      controller.message = "Couldn't add that to a board. Try again."
    }
  }

  private func add(_ card: DiscoveryCard, to boardID: UUID) async {
    do {
      _ = try await controller.api.addCollectionItem(collectionID: boardID, itemID: card.id)
      adding = nil
    } catch {
      controller.message = "Couldn't add that to a board. Try again."
    }
  }
}

typealias DiscoverView = FeedView

struct FeedCardTile: View {
  let card: DiscoveryCard
  let baseURL: URL

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      FeedCardVisual(card: card, baseURL: baseURL)
        .id(card.id)
      Text(card.title)
        .font(.system(.callout, design: .serif))
        .foregroundStyle(AtlasTheme.ink)
        .lineLimit(2)
        .contentTransition(.identity)
      if card.isExample {
        Text("Example result").font(.caption2).foregroundStyle(AtlasTheme.muted)
      }
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel(card.isExample ? "\(card.title). Example result" : card.title)
  }
}

struct FeedCardVisual: View {
  let card: DiscoveryCard
  let baseURL: URL

  var body: some View {
    Color.clear
      .aspectRatio(4 / 5, contentMode: .fit)
      .overlay {
        Group {
          if let url = card.image?.resolved(against: baseURL) {
            AsyncImage(url: url) { phase in
              switch phase {
              case .success(let image):
                image.resizable().scaledToFill()
              case .failure:
                posterFallback
              default:
                posterFill
              }
            }
            .accessibilityLabel(card.image?.alt ?? card.title)
          } else {
            posterFallback
              .accessibilityLabel(card.title)
          }
        }
      }
      .clipped()
      .clipShape(RoundedRectangle(cornerRadius: 14))
  }

  private var posterFallback: some View {
    ZStack(alignment: .bottomLeading) {
      posterFill
      VStack(alignment: .leading, spacing: 6) {
        if let category = card.category {
          Text(OnboardingCopy.group(category))
            .font(.caption.weight(.semibold))
            .foregroundStyle(.white.opacity(0.8))
        }
        Text(card.title)
          .font(.system(.title3, design: .serif))
          .foregroundStyle(.white)
          .lineLimit(4)
        if let subtitle = card.subtitle {
          Text(subtitle).font(.caption).foregroundStyle(.white.opacity(0.75)).lineLimit(2)
        }
      }
      .padding(14)
    }
  }

  private var posterFill: Color {
    switch card.category {
    case .wear: return AtlasTheme.olive
    case .play: return Color(red: 0.28, green: 0.32, blue: 0.38)
    case .watch: return Color(red: 0.22, green: 0.20, blue: 0.18)
    case .eat: return Color(red: 0.42, green: 0.28, blue: 0.22)
    case .none: return AtlasTheme.ink
    }
  }
}

/// Pinch to zoom. Focus is a separate tool: arm it, drag a box, then confirm.
/// Analysis runs only on the owner's own captures — suggestion cards fail closed.
struct FeedCardDetail: View {
  @EnvironmentObject private var controller: CaptureController
  @EnvironmentObject private var notices: ReadyNoticeCenter
  let card: DiscoveryCard
  var onAddToBoard: () -> Void
  @State private var scale: CGFloat = 1
  @State private var highlight: CGRect?
  @State private var dragStart: CGPoint?
  @State private var focusArmed = false
  @State private var showFocusHint = false
  @State private var looking = false
  @State private var finished = false
  @State private var analysisNote: String?
  @State private var detail: ItemDetailResponse?
  @State private var detailNote: String?
  @State private var related: [DiscoveryCard] = []
  @State private var relatedState = "none"
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        GeometryReader { geo in
          ZStack(alignment: .topLeading) {
            FeedCardVisual(card: detail?.item ?? card, baseURL: controller.api.baseURL)
              .scaleEffect(scale)
              .frame(width: geo.size.width, height: geo.size.height)
              .clipped()
              .gesture(
                MagnifyGesture()
                  .onChanged { value in scale = min(4, max(1, value.magnification)) }
                  .onEnded { _ in
                    if scale < 1.05 { scale = 1 }
                  }
              )
              .simultaneousGesture(highlightGesture(in: geo.size), including: focusArmed ? .all : .none)
            if let highlight {
              RoundedRectangle(cornerRadius: 4)
                .stroke(AtlasTheme.olive, lineWidth: 2)
                .background(AtlasTheme.olive.opacity(0.18))
                .frame(width: highlight.width, height: highlight.height)
                .offset(x: highlight.minX, y: highlight.minY)
                .allowsHitTesting(false)
            }
          }
        }
        .aspectRatio(5 / 4, contentMode: .fit)
        .clipShape(RoundedRectangle(cornerRadius: 16))
        Text((detail?.item ?? card).title).font(.system(.title2, design: .serif))
        if let subtitle = (detail?.item ?? card).subtitle {
          Text(subtitle).foregroundStyle(AtlasTheme.muted)
        }
        if let detailLine = detail?.detail {
          Text(detailLine).foregroundStyle(AtlasTheme.muted)
        }
        if card.isExample {
          Text("Example result").font(.caption).foregroundStyle(AtlasTheme.muted)
        }
        if let description = detail?.description {
          Text(description)
        }
        if let reason = detail?.reason ?? detail?.whyThis?.text {
          Text(reason).font(.footnote).foregroundStyle(AtlasTheme.muted)
        }
        if let destination = detail?.destinationURL, let url = URL(string: destination) {
          Link("Open source", destination: url)
            .font(.footnote.weight(.semibold))
        }
        if let refs = detail?.references, refs.isEmpty == false {
          VStack(alignment: .leading, spacing: 4) {
            Text("References").font(.footnote.weight(.semibold))
            ForEach(refs) { ref in
              Text(ref.qualified ? ref.name : "Resembles \(ref.name)")
                .font(.footnote)
                .foregroundStyle(AtlasTheme.muted)
            }
          }
        }
        relatedRail
        if looking {
          AnalysisLookingBanner()
        } else if finished {
          AnalysisReadyBanner()
        }
        if let analysisNote {
          Text(analysisNote).font(.footnote).foregroundStyle(AtlasTheme.muted)
        }
        if let detailNote {
          Text(detailNote).font(.footnote).foregroundStyle(AtlasTheme.muted)
        }
        focusTool
        Button("Add to a board") { onAddToBoard() }
          .buttonStyle(.borderedProminent)
      }
      .padding(16)
      .padding(.bottom, 24)
    }
    .background(AtlasTheme.ivory.ignoresSafeArea())
    .navigationTitle(card.title)
    .navigationBarTitleDisplayMode(.inline)
    .toolbar(.hidden, for: .tabBar)
    .task { await loadDetail() }
  }

  @ViewBuilder
  private var focusTool: some View {
    VStack(alignment: .leading, spacing: 8) {
      if focusArmed {
        Text("Focus is on. Drag a box on the picture, then confirm. Pinch still zooms.")
          .font(.footnote)
          .foregroundStyle(AtlasTheme.muted)
        HStack {
          Button("Cancel focus") {
            focusArmed = false
            highlight = nil
            showFocusHint = false
          }
          .buttonStyle(.bordered)
          if highlight != nil {
            Button("Look at this area") { Task { await analyzeHighlight() } }
              .buttonStyle(.borderedProminent)
          }
        }
      } else {
        Button("Focus on an area") {
          focusArmed = true
          showFocusHint = true
        }
        .buttonStyle(.bordered)
        if showFocusHint {
          Text("This looks at a region of a photo you captured. Suggestion cards are not analyzed.")
            .font(.footnote)
            .foregroundStyle(AtlasTheme.muted)
        } else {
          Text("Pinch to zoom. Use Focus on an area when you want to look at part of a picture.")
            .font(.footnote)
            .foregroundStyle(AtlasTheme.muted)
        }
      }
    }
  }

  @ViewBuilder
  private var relatedRail: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text("Similar")
        .font(.system(.title3, design: .serif))
      if relatedState == "pending" && related.isEmpty {
        AnalysisLookingBanner()
        Text("Looking for similar suggestions.")
          .font(.footnote)
          .foregroundStyle(AtlasTheme.muted)
      } else if related.isEmpty {
        Text("No similar suggestions yet.")
          .font(.footnote)
          .foregroundStyle(AtlasTheme.muted)
      } else {
        VStack(alignment: .leading, spacing: 8) {
          if relatedState == "pending" {
            Text("Looking for more like this.")
              .font(.footnote)
              .foregroundStyle(AtlasTheme.muted)
          }
          picturedRelatedRail
        }
      }
    }
  }

  /// Cached related cards, pictured first; drifts left continuously.
  private var picturedRelatedRail: some View {
    let pictured = related.filter { $0.image != nil }
    let rail = pictured.isEmpty ? related : pictured
    return SimilarConveyorRail(
      cards: rail,
      baseURL: controller.api.baseURL,
      reduceMotion: reduceMotion
    ) { relatedCard in
      FeedCardDetail(card: relatedCard, onAddToBoard: onAddToBoard)
    }
  }

  private func highlightGesture(in size: CGSize) -> some Gesture {
    DragGesture(minimumDistance: 8)
      .onChanged { value in
        if dragStart == nil { dragStart = value.startLocation }
        guard let start = dragStart else { return }
        let origin = CGPoint(x: min(start.x, value.location.x), y: min(start.y, value.location.y))
        let width = abs(value.location.x - start.x)
        let height = abs(value.location.y - start.y)
        highlight = CGRect(x: origin.x, y: origin.y, width: max(24, width), height: max(24, height))
          .intersection(CGRect(origin: .zero, size: size))
      }
      .onEnded { _ in dragStart = nil }
  }

  private func loadDetail() async {
    do {
      let loaded = try await controller.api.item(card.id)
      detail = loaded
      related = loaded.related
      relatedState = loaded.relatedState
      detailNote = nil
      if loaded.relatedState == "none" {
        await startRelated()
      } else if loaded.relatedState == "pending" {
        await pollRelated()
      }
    } catch {
      if detail == nil {
        detailNote = "Couldn't load details right now. The card you opened is still here."
      }
    }
  }

  private func startRelated() async {
    do {
      _ = try await controller.api.discoverRelated(card.id)
      relatedState = "pending"
      await pollRelated()
    } catch {
      if related.isEmpty {
        relatedState = "none"
      }
    }
  }

  private func pollRelated() async {
    for _ in 0..<12 {
      try? await Task.sleep(nanoseconds: 2_500_000_000)
      guard !Task.isCancelled else { return }
      do {
        let loaded = try await controller.api.item(card.id)
        detail = loaded
        related = loaded.related
        relatedState = loaded.relatedState
        if loaded.relatedState != "pending" { return }
      } catch {
        return
      }
    }
    if related.isEmpty { relatedState = "none" }
  }

  private func analyzeHighlight() async {
    looking = true
    finished = false
    analysisNote = nil
    defer { looking = false }
    // Suggestion cards have no capture to analyze. Fail closed — never invent a reading.
    if card.kind != "capture" {
      try? await Task.sleep(nanoseconds: 900_000_000)
      finished = false
      analysisNote = "Analysis looks at photos you capture. This card is a suggestion, so nothing was sent."
      focusArmed = false
      return
    }
    looking = false
    let started = await notices.explore(assetID: card.id)
    if started {
      finished = false
      looking = true
    } else {
      analysisNote = "Exploring isn't available right now. The picture is still on this phone."
    }
    focusArmed = false
  }
}

struct AnalysisLookingBanner: View {
  var body: some View {
    TimelineView(.animation) { context in
      let pulse = 0.55 + 0.45 * sin(context.date.timeIntervalSinceReferenceDate * 3)
      HStack(spacing: 10) {
        Circle()
          .fill(AtlasTheme.olive.opacity(pulse))
          .frame(width: 14, height: 14)
        Text("Looking…")
          .font(.system(.callout, design: .serif))
          .foregroundStyle(AtlasTheme.olive)
      }
      .padding(10)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(RoundedRectangle(cornerRadius: 12).fill(AtlasTheme.quiet))
      .accessibilityAddTraits(.updatesFrequently)
    }
  }
}

struct AnalysisReadyBanner: View {
  @State private var shown = false

  var body: some View {
    HStack(spacing: 10) {
      Image(systemName: "checkmark.circle.fill")
        .foregroundStyle(AtlasTheme.olive)
        .scaleEffect(shown ? 1 : 0.4)
      Text("Ready")
        .font(.system(.callout, design: .serif))
        .foregroundStyle(AtlasTheme.olive)
    }
    .padding(10)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(RoundedRectangle(cornerRadius: 12).fill(AtlasTheme.quiet))
    .onAppear {
      withAnimation(.spring(response: 0.45, dampingFraction: 0.65)) { shown = true }
    }
  }
}
