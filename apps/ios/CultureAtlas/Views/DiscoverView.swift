import AtlasCapture
import SwiftUI

/// Living interest feed from `GET /v1/discoveries`. Visual-first: licensed
/// pictures when we have them, typographic posters otherwise — never a
/// stand-in portrait of a person or film. Example cards stay labeled.
///
/// Cards float through on a continuous conveyor (two columns drifting upward
/// at different speeds). Dragging scrubs the feed and a flick carries it with
/// momentum; the drift resumes about two seconds after release. Reduce Motion
/// shows a still grid that rotates one card at a time.
struct FeedView: View {
  @EnvironmentObject private var controller: CaptureController
  @EnvironmentObject private var notices: ReadyNoticeCenter
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.scenePhase) private var scenePhase
  @Environment(\.accessibilityVoiceOverEnabled) private var voiceOver
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize
  @StateObject private var driver = ConveyorDriver<DiscoveryCard>(
    laneSpeeds: FeedTileMetrics.laneSpeeds, spacing: FeedTileMetrics.spacing)
  /// Accessibility text sizes: one wide column so titles have room.
  @StateObject private var singleDriver = ConveyorDriver<DiscoveryCard>(
    laneSpeeds: [FeedTileMetrics.laneSpeeds[0]], spacing: FeedTileMetrics.spacing)
  @StateObject private var pause = DriftPause()
  @State private var pool: [DiscoveryCard] = []
  @State private var freshIDs: Set<UUID> = []
  @State private var staticModel = FeedConveyor<DiscoveryCard>(laneSpeeds: [0], itemLength: 1, spacing: 0, viewport: 0)
  @State private var staticSlots: [DiscoveryCard] = []
  @State private var hiddenID: UUID?
  @State private var exampleFeed = false
  @State private var banner: String?
  @State private var emptyMessage: String?
  /// Only the first load shows a spinner; polling and refresh never do.
  @State private var initialLoading = true
  @State private var refreshing = false
  @State private var refreshSpin = 0.0
  @State private var opened: DiscoveryCard?
  @Namespace private var zoom

  private static let staticCount = 6

  private var oneColumn: Bool { dynamicTypeSize.isAccessibilitySize }
  private var activeDriver: ConveyorDriver<DiscoveryCard> { oneColumn ? singleDriver : driver }

  /// Cards currently held on screen (conveyor or still grid).
  private var onScreen: [DiscoveryCard] {
    if reduceMotion { return staticSlots }
    let held = activeDriver.conveyor.heldIDs
    return pool.filter { held.contains($0.id) }
  }

  /// VoiceOver holds the drift: its cursor must not chase (or lose) a moving card.
  private var paused: Bool {
    pause.held || scenePhase != .active || opened != nil || voiceOver
  }

  var body: some View {
    GeometryReader { outer in
      ScrollView {
        VStack(alignment: .leading, spacing: 10) {
          header
          feedBody(width: max(0, outer.size.width - 32), height: max(320, outer.size.height - 40))
        }
        .padding(.horizontal, 16)
        .padding(.top, 4)
      }
      .scrollBounceBehavior(.always, axes: .vertical)
      .pausesDrift(pause)
    }
    .background(AtlasTheme.ivory.ignoresSafeArea())
    .navigationTitle("Feed")
    .toolbar {
      ToolbarItem(placement: .topBarTrailing) {
        Button {
          Task { await userRefresh() }
        } label: {
          Image(systemName: "arrow.triangle.2.circlepath")
            .rotationEffect(.degrees(refreshSpin))
        }
        .disabled(refreshing)
        .accessibilityLabel("Fresh picks")
        .accessibilityIdentifier("feed.refresh")
      }
    }
    .overlay {
      if initialLoading && pool.isEmpty { FeedSkeleton() }
    }
    // The pull runs detached: re-rendering while it is in flight must not
    // cancel the request (that showed "Couldn't refresh" with no request sent).
    .refreshable { await Task { await load(refresh: true) }.value }
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
    .onChange(of: oneColumn) { _, _ in activeDriver.setPool(pool, fresh: freshIDs) }
    .onChange(of: controller.stackResets[.feed, default: 0]) { _, _ in opened = nil }
    .onChange(of: controller.openFeedDetail) { _, open in
      guard open else { return }
      opened = onScreen.first { $0.image != nil } ?? onScreen.first
      controller.openFeedDetail = false
    }
    .navigationDestination(item: $opened) { card in
      FeedCardDetail(card: card)
        .atlasZoomDestination(id: card.id, in: zoom)
    }
  }

  @ViewBuilder
  private var header: some View {
    Text("Drag to browse. Pull down for fresh picks.")
      .font(.footnote)
      .foregroundStyle(AtlasTheme.muted)
    if exampleFeed {
      Label("Example results until your personal feed is ready.", systemImage: "sparkle")
        .font(.footnote)
        .foregroundStyle(AtlasTheme.muted)
    }
    if notices.exploring.isEmpty == false {
      AnalysisLookingBanner()
    }
    if let banner {
      InlineBanner(text: banner, systemImage: "arrow.triangle.2.circlepath")
        .transition(.move(edge: .top).combined(with: .opacity))
    } else if let emptyMessage, pool.isEmpty, !initialLoading {
      VStack(alignment: .leading, spacing: 6) {
        Text("No suggestions yet").font(.system(.title3, design: .serif))
        Text(emptyMessage).foregroundStyle(AtlasTheme.muted)
      }
    }
  }

  @ViewBuilder
  private func feedBody(width: CGFloat, height: CGFloat) -> some View {
    if reduceMotion {
      FeedStaticGrid(slots: staticSlots, hiddenID: hiddenID, baseURL: controller.api.baseURL, columns: oneColumn ? 1 : 2) {
        opened = $0
      }
      // Floating tab bar sits over the last row; keep tap targets clear of it.
      .padding(.bottom, 108)
    } else {
      FeedConveyorColumns(
        driver: activeDriver,
        pause: pause,
        paused: paused,
        width: width,
        height: height,
        baseURL: controller.api.baseURL,
        zoom: zoom,
        onPullToRefresh: { Task { await userRefresh() } }
      ) { card in
        opened = card
      }
    }
  }

  private func userRefresh() async {
    guard !refreshing else { return }
    withAnimation(.easeInOut(duration: 0.6)) { refreshSpin += 360 }
    await Task { await load(refresh: true) }.value
  }

  /// Pull-to-refresh and polling never wipe cards that are already on screen.
  private func load(refresh: Bool) async {
    if refresh { refreshing = true }
    defer {
      if refresh { refreshing = false }
      initialLoading = false
    }
    do {
      let feed = try await controller.api.discoveries(refresh: refresh)
      apply(feed, refresh: refresh)
    } catch AtlasClientError.server(_, "onboarding_required", _, _, _) {
      pool = []
      staticSlots = []
      driver.removeAll()
      singleDriver.removeAll()
      banner = nil
      emptyMessage = "Finish picking your interests to see suggestions."
    } catch where AtlasClientError.isCancellation(error) {
      // Cancelled by the system (view went away): not a failure.
    } catch {
      withAnimation(AtlasMotion.spring) {
        if pool.isEmpty {
          banner = "Suggestions aren't available right now. Pull to try again."
        } else if refresh {
          banner = "Couldn't refresh. Still showing what you had."
        }
      }
      if refresh, !pool.isEmpty { clearBanner(after: 4) }
    }
  }

  private func apply(_ feed: DiscoveriesResponse, refresh: Bool) {
    exampleFeed = feed.isExampleFeed
    if feed.items.isEmpty {
      if pool.isEmpty {
        emptyMessage = "Still looking for things that match your interests. Pull to try again."
      } else if refresh {
        withAnimation(AtlasMotion.spring) { banner = "Nothing new yet. Still showing what you had." }
        clearBanner(after: 3)
      }
      return
    }
    let known = Set(pool.map(\.id))
    let newCount = feed.items.filter { !known.contains($0.id) }.count
    withAnimation(AtlasMotion.spring) {
      banner = nil
      emptyMessage = nil
    }
    let incomingIDs = Set(feed.items.map(\.id))
    freshIDs = incomingIDs
    let keepOnScreen = Set(onScreen.map(\.id))
    // Keep the latest page plus whatever is on screen. Stale off-screen cards
    // buried new Qloo results in a 50-item shuffle. Posters stay in the pool
    // so a short picture supply never leaves holes; the conveyor still takes
    // pictured cards first and never passes a waiting photo for a poster.
    pool = feed.items + pool.filter { keepOnScreen.contains($0.id) && !incomingIDs.contains($0.id) }
    activeDriver.setPool(pool, fresh: freshIDs)
    if reduceMotion { fillStatic() }
    if refresh, !known.isEmpty {
      controller.showFlash(
        Flash(
          text: newCount > 0 ? "\(newCount) fresh \(newCount == 1 ? "pick" : "picks") floating in" : "Your feed is up to date",
          systemImage: newCount > 0 ? "sparkles" : "checkmark.circle.fill"))
    }
  }

  private func clearBanner(after seconds: Double) {
    Task {
      try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
      withAnimation(AtlasMotion.spring) { banner = nil }
    }
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
}

typealias DiscoverView = FeedView

/// First-load placeholder: two columns of softly shimmering paper cards, so
/// the feed never opens on a bare spinner.
private struct FeedSkeleton: View {
  @State private var phase = false
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    GeometryReader { geo in
      let width = (geo.size.width - 32 - FeedTileMetrics.spacing) / 2
      HStack(alignment: .top, spacing: FeedTileMetrics.spacing) {
        ForEach(0..<2, id: \.self) { lane in
          VStack(spacing: FeedTileMetrics.spacing) {
            ForEach(0..<3, id: \.self) { _ in
              RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(AtlasTheme.quiet)
                .frame(width: width, height: width * 5 / 4)
            }
          }
          .offset(y: lane == 1 ? width * 0.5 : 0)
        }
      }
      .padding(.horizontal, 16)
      .padding(.top, 60)
      .opacity(phase ? 0.55 : 1)
    }
    .allowsHitTesting(false)
    .onAppear {
      guard !reduceMotion else { return }
      withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) { phase = true }
    }
    .accessibilityLabel("Loading your feed")
  }
}

struct FeedCardTile: View {
  let card: DiscoveryCard
  let baseURL: URL
  /// Poster tiles already show their title inside the poster; small rails hide the caption.
  var captionForPosters = true
  /// Capture rails: the server's reason (14 pt secondary, at most 2 lines).
  var showsReason = false

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      FeedCardVisual(card: card, baseURL: baseURL)
        .frame(maxWidth: .infinity)
        // With a reason under it, the picture keeps its full 4:5 size and the
        // text truncates instead, so every tile on a rail lines up.
        .layoutPriority(showsReason ? 1 : 0)
        .id(card.id)
      if card.image != nil || captionForPosters {
        Text(card.title)
          .font(.system(.callout, design: .serif))
          .foregroundStyle(AtlasTheme.ink)
          .lineLimit(2)
          .multilineTextAlignment(.leading)
          .contentTransition(.identity)
      }
      if showsReason, let reason = card.reason {
        Text(reason)
          .font(.system(size: 14))
          .foregroundStyle(AtlasTheme.muted)
          .lineLimit(2)
          .multilineTextAlignment(.leading)
      }
      if card.isExample {
        Text("Example result").font(.caption2).foregroundStyle(AtlasTheme.muted)
      }
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel(accessibilityText)
  }

  private var accessibilityText: String {
    var parts = [card.title]
    if showsReason, let reason = card.reason { parts.append(reason) }
    if card.isExample { parts.append("Example result") }
    return parts.joined(separator: ". ")
  }
}

struct FeedCardVisual: View {
  let card: DiscoveryCard
  let baseURL: URL
  var cornerRadius: CGFloat = 14

  var body: some View {
    Color.clear
      .aspectRatio(4 / 5, contentMode: .fit)
      .overlay {
        if let url = card.image?.resolved(against: baseURL) {
          // While the photo loads, the typographic poster holds the space,
          // then the picture crossfades in (never a bare colour block).
          RemoteImage(url: url) { posterFallback }
            .accessibilityLabel(card.image?.alt ?? card.title)
        } else {
          posterFallback
            .accessibilityLabel(card.title)
        }
      }
      .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
  }

  private var posterFallback: some View {
    // The gradient sets the size; the oversized symbol and the text are
    // overlays, so a small tile never grows wider than its frame (which
    // clipped the title's leading edge on narrow rails).
    LinearGradient(
      colors: [posterFill.opacity(0.92), posterFill],
      startPoint: .topLeading, endPoint: .bottomTrailing)
    .overlay(alignment: .topTrailing) {
      Image(systemName: categorySymbol)
        .font(.system(size: 120, weight: .ultraLight))
        .foregroundStyle(.white.opacity(0.07))
        .offset(x: 40, y: -40)
        .accessibilityHidden(true)
    }
    .overlay(alignment: .bottomLeading) {
      VStack(alignment: .leading, spacing: 6) {
        if let category = card.category {
          Text(OnboardingCopy.group(category).uppercased())
            .font(.caption2.weight(.semibold))
            .tracking(1.2)
            .foregroundStyle(.white.opacity(0.75))
        }
        Text(card.title)
          .font(.system(.title3, design: .serif))
          .foregroundStyle(.white)
          .lineLimit(4)
          .minimumScaleFactor(0.7)
        if let subtitle = card.subtitle {
          Text(subtitle).font(.caption).foregroundStyle(.white.opacity(0.75)).lineLimit(2)
        }
      }
      .padding(14)
    }
    .clipped()
  }

  private var categorySymbol: String {
    switch card.category {
    case .wear: return "tshirt"
    case .play: return "music.note"
    case .watch: return "film"
    case .eat: return "fork.knife"
    case .none: return "sparkle"
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

/// Item detail: full-bleed 4:5 hero, one serif title (the nav bar shows it
/// only after it scrolls away), why-this, references, Similar, and actions.
/// Focus (drag a box and analyze a region) appears only on the owner's own
/// captures; suggestion cards get Open source, Share and More like this.
struct FeedCardDetail: View {
  @EnvironmentObject private var controller: CaptureController
  @EnvironmentObject private var notices: ReadyNoticeCenter
  let card: DiscoveryCard
  @State private var scale: CGFloat = 1
  @State private var highlight: CGRect?
  @State private var dragStart: CGPoint?
  @State private var focusArmed = false
  @State private var looking = false
  @State private var analysisNote: String?
  @State private var detail: ItemDetailResponse?
  @State private var detailNote: String?
  @State private var related: [DiscoveryCard] = []
  @State private var relatedState = "none"
  @State private var titleVisible = true
  @State private var adding = false
  @State private var savedIn: Set<UUID> = []
  @State private var relatedPulse = 0
  @State private var styleModel: CaptureStyleViewModel?
  @State private var styleHighlight: StyleRegion?
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  private var shown: DiscoveryCard { detail?.item ?? card }

  private var heroAspect: Double? {
    guard let w = shown.image?.width, let h = shown.image?.height, w > 0, h > 0 else { return styleModel?.imageAspect }
    return Double(w) / Double(h)
  }
  private var isCapture: Bool { card.kind == "capture" }

  var body: some View {
    ScrollViewReader { reader in
      ScrollView {
        VStack(alignment: .leading, spacing: 0) {
          hero
          VStack(alignment: .leading, spacing: 16) {
            titleBlock
            actionRow(reader)
            if isCapture, let styleModel {
              CaptureStyleSection(
                model: styleModel, highlight: $styleHighlight, baseURL: controller.api.baseURL,
                scrollProxy: reader, setCity: { [api = controller.api] city in try await api.setCity(city) })
            }
            let why = StylePresentation.whyThis(styleMatch: detail?.styleMatch ?? shown.styleMatch, experimentalLine: detail?.experimentalLine)
            if let reason = detail?.reason ?? detail?.whyThis?.text ?? shown.reason {
              WhyThisCard(text: reason, attributes: why.attributes, experimentalLine: why.line)
            } else if !why.attributes.isEmpty || why.line != nil {
              WhyThisCard(text: nil, attributes: why.attributes, experimentalLine: why.line)
            }
            if let description = detail?.description {
              Text(description)
                .font(.body)
                .foregroundStyle(AtlasTheme.ink)
                .lineSpacing(3)
            }
            if let refs = detail?.references, refs.isEmpty == false {
              VStack(alignment: .leading, spacing: 8) {
                Text("References").font(.footnote.weight(.semibold)).foregroundStyle(AtlasTheme.muted)
                FlowLayout(spacing: 6) {
                  ForEach(refs) { ref in
                    Text(ref.displayName)
                      .font(.footnote)
                      .padding(.horizontal, 10)
                      .padding(.vertical, 6)
                      .background(Capsule().fill(AtlasTheme.quiet))
                  }
                }
              }
            }
            if let detailNote {
              InlineBanner(text: detailNote)
            }
            relatedRail
              .id("similar")
            if isCapture { focusTool }
            if looking {
              AnalysisLookingBanner()
            }
            if let analysisNote {
              Text(analysisNote).font(.footnote).foregroundStyle(AtlasTheme.muted)
            }
          }
          .padding(16)
          .padding(.bottom, 32)
          .animation(AtlasMotion.spring, value: detail)
        }
      }
      .coordinateSpace(name: "detail")
    }
    .background(AtlasTheme.ivory.ignoresSafeArea())
    .navigationTitle(titleVisible ? "" : shown.title)
    .navigationBarTitleDisplayMode(.inline)
    .toolbarBackground(titleVisible ? .hidden : .visible, for: .navigationBar)
    .toolbarBackground(AtlasTheme.ivory, for: .navigationBar)
    .toolbar(.hidden, for: .tabBar)
    .sheet(isPresented: $adding) {
      AddToBoardSheet(card: shown, savedIn: savedIn) { boardID in
        withAnimation(AtlasMotion.spring) { _ = savedIn.insert(boardID) }
      }
    }
    .task { await loadDetail() }
    .task(id: detail?.captureID) { await loadStyle() }
  }

  /// The owner's own capture: load its style reading and rails, polling while they finish.
  private func loadStyle() async {
    guard isCapture, let captureID = detail?.captureID else { return }
    let api = controller.api
    let model = styleModel ?? CaptureStyleViewModel(
      load: { try await api.capture(captureID) },
      retry: { try await api.retryStyle(captureID: captureID) })
    if styleModel == nil { styleModel = model }
    await model.run()
  }

  // MARK: Hero

  private var hero: some View {
    GeometryReader { geo in
      ZStack(alignment: .topLeading) {
        FeedCardVisual(card: shown, baseURL: controller.api.baseURL, cornerRadius: 0)
          .frame(width: geo.size.width, height: geo.size.height)
          .scaleEffect(scale)
          .clipped()
          .gesture(
            MagnifyGesture()
              .onChanged { value in scale = min(4, max(1, value.magnification)) }
              .onEnded { _ in withAnimation(AtlasMotion.spring) { scale = 1 } }
          )
          .simultaneousGesture(highlightGesture(in: geo.size), including: focusArmed ? .all : .none)
        StyleRegionOverlay(region: styleHighlight, imageAspect: heroAspect) { styleHighlight = nil }
          .frame(width: geo.size.width, height: geo.size.height)
        if let highlight {
          RoundedRectangle(cornerRadius: 6)
            .stroke(AtlasTheme.olive, lineWidth: 2)
            .background(AtlasTheme.olive.opacity(0.18))
            .frame(width: highlight.width, height: highlight.height)
            .offset(x: highlight.minX, y: highlight.minY)
            .allowsHitTesting(false)
        }
      }
    }
    .aspectRatio(4 / 5, contentMode: .fit)
    .accessibilityIdentifier("detail.hero")
  }

  private var titleBlock: some View {
    VStack(alignment: .leading, spacing: 6) {
      if let category = shown.category {
        Text(OnboardingCopy.group(category).uppercased())
          .font(.caption.weight(.semibold))
          .tracking(1.2)
          .foregroundStyle(AtlasTheme.olive)
      }
      Text(shown.title)
        .font(.system(.title, design: .serif))
        .foregroundStyle(AtlasTheme.ink)
        .fixedSize(horizontal: false, vertical: true)
        .background(
          GeometryReader { geo in
            Color.clear
              .onChange(of: geo.frame(in: .named("detail")).maxY < 0) { _, hidden in
                withAnimation(AtlasMotion.fade) { titleVisible = !hidden }
              }
          })
      if let subtitle = shown.subtitle {
        Text(subtitle).foregroundStyle(AtlasTheme.muted)
      }
      if let detailLine = detail?.detail {
        Text(detailLine).font(.callout).foregroundStyle(AtlasTheme.muted)
      }
      if card.isExample {
        Text("Example result").font(.caption).foregroundStyle(AtlasTheme.muted)
      }
    }
  }

  // MARK: Actions

  private func actionRow(_ reader: ScrollViewProxy) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      Button {
        adding = true
      } label: {
        Label(
          savedIn.isEmpty ? "Add to a board" : "Saved to \(savedIn.count) \(savedIn.count == 1 ? "board" : "boards")",
          systemImage: savedIn.isEmpty ? "plus.square.on.square" : "checkmark.square.fill")
          .contentTransition(.symbolEffect(.replace))
          .frame(maxWidth: .infinity, minHeight: 46)
      }
      .buttonStyle(.borderedProminent)
      .accessibilityIdentifier("detail.add-to-board")
      .sensoryFeedback(.success, trigger: savedIn.count)

      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: 8) {
          if let destination = detail?.destinationURL, let url = URL(string: destination) {
            Link(destination: url) {
              ActionChip(title: "Open source", systemImage: "arrow.up.right.square")
            }
          }
          ShareLink(item: shareText) {
            ActionChip(title: "Share", systemImage: "square.and.arrow.up")
          }
          Button {
            relatedPulse += 1
            withAnimation(AtlasMotion.spring) { reader.scrollTo("similar", anchor: .top) }
            if related.isEmpty, relatedState != "pending" { Task { await startRelated() } }
          } label: {
            ActionChip(title: "More like this", systemImage: "sparkles")
          }
          .sensoryFeedback(.selection, trigger: relatedPulse)
        }
      }
      .scrollClipDisabled()
    }
  }

  private var shareText: String {
    if let destination = detail?.destinationURL { return "\(shown.title) — \(destination)" }
    if let subtitle = shown.subtitle { return "\(shown.title) — \(subtitle) (via culture atlas)" }
    return "\(shown.title) (via culture atlas)"
  }

  @ViewBuilder
  private var focusTool: some View {
    VStack(alignment: .leading, spacing: 8) {
      if focusArmed {
        Text("Drag a box on your photo, then confirm. Pinch still zooms.")
          .font(.footnote)
          .foregroundStyle(AtlasTheme.muted)
        HStack {
          Button("Cancel") {
            withAnimation(AtlasMotion.spring) {
              focusArmed = false
              highlight = nil
            }
          }
          .buttonStyle(.bordered)
          if highlight != nil {
            Button("Look at this area") { Task { await analyzeHighlight() } }
              .buttonStyle(.borderedProminent)
              .transition(.scale.combined(with: .opacity))
          }
        }
      } else {
        Button {
          withAnimation(AtlasMotion.spring) { focusArmed = true }
        } label: {
          Label("Focus on part of your photo", systemImage: "viewfinder")
        }
        .buttonStyle(.bordered)
      }
    }
    .animation(AtlasMotion.spring, value: highlight != nil)
  }

  @ViewBuilder
  private var relatedRail: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(alignment: .firstTextBaseline) {
        Text("Similar")
          .font(.system(.title3, design: .serif))
          .foregroundStyle(AtlasTheme.ink)
        if relatedState == "pending" {
          Text("Looking for more…").font(.footnote).foregroundStyle(AtlasTheme.muted)
        }
      }
      if relatedState == "pending" && related.isEmpty {
        AnalysisLookingBanner()
      } else if related.isEmpty {
        Text("No similar suggestions yet.")
          .font(.footnote)
          .foregroundStyle(AtlasTheme.muted)
      } else {
        picturedRelatedRail
          .transition(.opacity)
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
      FeedCardDetail(card: relatedCard)
    }
    // Bleed past the 16 pt content inset so tiles slide off the screen edge.
    .padding(.horizontal, -16)
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
      withAnimation(AtlasMotion.spring) {
        detail = loaded
        related = loaded.related
        relatedState = loaded.relatedState
        savedIn = Set(loaded.collectionIDs)
      }
      detailNote = nil
      if loaded.relatedState == "none" {
        await startRelated()
      } else if loaded.relatedState == "pending" {
        await pollRelated()
      }
    } catch where AtlasClientError.isCancellation(error) {
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
        withAnimation(AtlasMotion.spring) {
          detail = loaded
          related = loaded.related
          relatedState = loaded.relatedState
        }
        if loaded.relatedState != "pending" { return }
      } catch {
        return
      }
    }
    if related.isEmpty { relatedState = "none" }
  }

  /// Only the owner's own capture is ever sent; the tool is hidden on suggestions.
  private func analyzeHighlight() async {
    guard isCapture else { return }
    analysisNote = nil
    let started = await notices.explore(assetID: card.id)
    withAnimation(AtlasMotion.spring) {
      if started {
        looking = true
      } else {
        analysisNote = "We can't look at photos right now. Your photo is saved privately."
      }
      focusArmed = false
      highlight = nil
    }
  }
}

private struct ActionChip: View {
  let title: String
  let systemImage: String

  var body: some View {
    Label(title, systemImage: systemImage)
      .font(.callout.weight(.medium))
      .foregroundStyle(AtlasTheme.ink)
      .padding(.horizontal, 14)
      .frame(minHeight: 40)
      .background(Capsule().fill(AtlasTheme.quiet))
      .overlay(Capsule().stroke(AtlasTheme.line))
  }
}

/// "Why this" — the server's reason, set apart as a quiet card, with the
/// style attributes that connected it (non-interactive) and, for a card from
/// an experimental reading, the experimental line.
private struct WhyThisCard: View {
  let text: String?
  var attributes: [String] = []
  var experimentalLine: String?

  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      Image(systemName: "quote.opening")
        .font(.footnote)
        .foregroundStyle(AtlasTheme.olive)
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 6) {
        Text("Why this").font(.caption.weight(.semibold)).foregroundStyle(AtlasTheme.olive)
        if let text {
          Text(text).font(.callout).foregroundStyle(AtlasTheme.ink)
        }
        if !attributes.isEmpty {
          FlowLayout(spacing: 6) {
            ForEach(attributes, id: \.self) { attribute in
              Text(attribute)
                .font(.footnote)
                .foregroundStyle(AtlasTheme.ink)
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .background(Capsule().fill(AtlasTheme.ivory))
                .overlay(Capsule().stroke(AtlasTheme.line))
            }
          }
          .accessibilityElement(children: .combine)
        }
        if let experimentalLine {
          HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(StyleCopy.experimentalBadge)
              .font(.caption2.weight(.semibold))
              .foregroundStyle(AtlasTheme.muted)
            Text(experimentalLine).font(.footnote).foregroundStyle(AtlasTheme.muted)
          }
          .accessibilityIdentifier("why.experimental-line")
        }
      }
    }
    .padding(14)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(AtlasTheme.quiet))
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
          .scaleEffect(0.85 + 0.15 * pulse)
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

// MARK: - iOS 18 zoom transitions (no-ops on iOS 17)

extension View {
  @ViewBuilder
  func atlasZoomSource(id: UUID, in namespace: Namespace.ID) -> some View {
    if #available(iOS 18.0, *) {
      matchedTransitionSource(id: id, in: namespace) { config in
        config.clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
      }
    } else {
      self
    }
  }

  @ViewBuilder
  func atlasZoomDestination(id: UUID, in namespace: Namespace.ID) -> some View {
    if #available(iOS 18.0, *) {
      navigationTransition(.zoom(sourceID: id, in: namespace))
    } else {
      self
    }
  }
}
