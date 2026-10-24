import AtlasCapture
import AVKit
import SwiftUI
import UIKit

/// The private library: everything in the account on the server (`GET
/// /v2/library`: captures from this phone, the web, glasses or agents) as a
/// photo grid, plus what is still only on this phone (drafts waiting to be
/// kept or uploading, and Music Mode recordings). Status is always written in
/// words, never colour alone.
struct LibraryView: View {
  @EnvironmentObject private var controller: CaptureController
  @EnvironmentObject private var notices: ReadyNoticeCenter
  @State private var items: [MediaLibraryItem] = []
  @State private var cursor: String?
  @State private var reachedEnd = false
  @State private var loadingMore = false
  @State private var initialLoading = true
  @State private var banner: String?
  @State private var openedMedia: MediaLibraryItem?

  private let columns = [
    GridItem(.flexible(), spacing: 4),
    GridItem(.flexible(), spacing: 4),
  ]

  /// Drafts that are not (yet) a server library item. Committed photos and
  /// videos show as grid tiles instead; recordings stay here (Music Mode).
  private var pendingDrafts: [DraftRecord] {
    let onServer = Set(items.map(\.id))
    return controller.drafts.filter { draft in
      if let asset = draft.assetID, onServer.contains(asset) { return false }
      if draft.status == .committed && draft.kind != .audio { return false }
      return true
    }
  }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 18) {
        Text("Private to you. Explore a photo or a song to grow your feed.")
          .font(.footnote)
          .foregroundStyle(AtlasTheme.muted)
        if let banner {
          InlineBanner(text: banner, systemImage: "wifi.exclamationmark")
        }
        if !pendingDrafts.isEmpty {
          VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: "On this phone")
            ForEach(pendingDrafts) { draft in
              DraftRow(draft: draft)
                .transition(.move(edge: .leading).combined(with: .opacity))
            }
          }
        }
        if items.isEmpty && pendingDrafts.isEmpty && !initialLoading {
          EmptyLibrary()
        }
        if !items.isEmpty {
          VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: "Captures")
            LazyVGrid(columns: columns, spacing: 4) {
              ForEach(items) { item in
                Button {
                  openedMedia = item
                } label: {
                  MediaTile(item: item, exploring: notices.exploring.contains(item.id))
                }
                .buttonStyle(.pressableCard)
                .accessibilityIdentifier("library.media.\(item.id.uuidString.lowercased())")
                .onAppear {
                  if item.id == items.last?.id { Task { await loadMore() } }
                }
              }
            }
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            if loadingMore {
              ProgressView().frame(maxWidth: .infinity).padding(.vertical, 12)
            }
          }
        }
        if controller.lockedDraftsExist {
          LockedDraftsNotice()
        }
      }
      .padding(16)
      .padding(.bottom, 24)
      .animation(AtlasMotion.spring, value: pendingDrafts.map(\.id))
      .animation(AtlasMotion.spring, value: items.map(\.id))
    }
    .background(AtlasTheme.ivory.ignoresSafeArea())
    .navigationTitle("Library")
    .overlay {
      if initialLoading && items.isEmpty && pendingDrafts.isEmpty { ProgressView().tint(AtlasTheme.olive) }
    }
    .refreshable {
      controller.reloadDrafts()
      await Task { await reload() }.value
    }
    .task { await reload() }
    // A draft that finished uploading appears as a server tile.
    .onChange(of: controller.drafts.filter { $0.status == .committed }.count) { _, _ in
      Task { await reload() }
    }
    // An exploration that finished updates its tile's status.
    .onChange(of: notices.exploring) { _, _ in Task { await reload() } }
    .navigationDestination(item: $openedMedia) { item in
      MediaDetailView(item: item)
    }
    .onChange(of: controller.openMediaID) { _, id in openDeepLinked(id) }
    .onAppear { openDeepLinked(controller.openMediaID) }
  }

  private func openDeepLinked(_ id: UUID?) {
    guard let id else { return }
    controller.openMediaID = nil
    Task {
      if let item = items.first(where: { $0.id == id }) {
        openedMedia = item
      } else if let item = try? await controller.api.mediaItem(id) {
        openedMedia = item
      }
    }
  }

  private func reload() async {
    do {
      let page = try await controller.api.mediaLibrary()
      withAnimation(AtlasMotion.spring) {
        items = page.items
        banner = nil
      }
      cursor = page.nextCursor
      reachedEnd = page.nextCursor == nil
    } catch where AtlasClientError.isCancellation(error) {
    } catch {
      banner = items.isEmpty
        ? "Your library isn't reachable right now. What's on this phone is still here."
        : "Couldn't refresh. Showing your library from before."
    }
    initialLoading = false
  }

  /// Never-ending grid: the next page loads as the last tile appears.
  private func loadMore() async {
    guard !reachedEnd, !loadingMore, let cursor else { return }
    loadingMore = true
    defer { loadingMore = false }
    guard let page = try? await controller.api.mediaLibrary(cursor: cursor) else { return }
    let known = Set(items.map(\.id))
    items += page.items.filter { !known.contains($0.id) }
    self.cursor = page.nextCursor
    reachedEnd = page.nextCursor == nil
  }
}

private struct EmptyLibrary: View {
  @EnvironmentObject private var controller: CaptureController

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Image(systemName: "camera.aperture")
        .font(.system(size: 36))
        .foregroundStyle(AtlasTheme.olive)
        .accessibilityHidden(true)
      Text("Nothing captured yet").font(.system(.title3, design: .serif))
      Text("Take a photo, record a song you hear, or upload from your phone.")
        .foregroundStyle(AtlasTheme.muted)
      Button {
        controller.rootTab = .capture
      } label: {
        Label("Capture something", systemImage: "camera")
          .frame(minHeight: 44)
      }
      .buttonStyle(.borderedProminent)
    }
    .padding(.vertical, 24)
  }
}

/// Square photo tile with a quiet status chip (written in words).
struct MediaTile: View {
  @EnvironmentObject private var controller: CaptureController
  let item: MediaLibraryItem
  var exploring = false

  var body: some View {
    Color.clear
      .aspectRatio(1, contentMode: .fit)
      .overlay {
        RemoteImage(
          url: item.thumbnailPath.flatMap { URL(string: $0, relativeTo: controller.api.baseURL)?.absoluteURL },
          authorize: controller.api.imageAuthorizer
        ) {
          ZStack {
            AtlasTheme.quiet
            Image(systemName: item.media.kind == "video" ? "video" : "photo")
              .foregroundStyle(AtlasTheme.muted)
          }
        }
      }
      .clipped()
      .overlay(alignment: .bottomLeading) {
        if let label = statusLabel {
          Text(label)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(.white)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(Capsule().fill(.black.opacity(0.45)))
            .padding(6)
        }
      }
      .overlay(alignment: .topTrailing) {
        if item.media.kind == "video" {
          Label(durationText, systemImage: "play.fill")
            .font(.caption2.weight(.semibold))
            .foregroundStyle(.white)
            .padding(.horizontal, 6)
            .padding(.vertical, 3)
            .background(Capsule().fill(.black.opacity(0.45)))
            .padding(6)
        }
      }
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(accessibilityText)
  }

  private var durationText: String {
    ClipClock.clock(Int((Double(item.media.durationMS ?? 0) / 1000).rounded()))
  }

  private var statusLabel: String? {
    if exploring || item.analyzing { return "Looking…" }
    if item.analyzed { return "Explored" }
    if !item.isReady { return item.media.status == "failed" ? "Couldn't prepare" : "Preparing" }
    return nil
  }

  private var accessibilityText: String {
    let kind = item.media.kind == "video" ? "Video" : "Photo"
    let date = item.media.createdAt.formatted(date: .abbreviated, time: .shortened)
    return [kind, date, statusLabel].compactMap { $0 }.joined(separator: ", ")
  }
}

/// One library item: the picture (or video), when and how it was captured,
/// and what exploring it found.
struct MediaDetailView: View {
  @EnvironmentObject private var controller: CaptureController
  @EnvironmentObject private var notices: ReadyNoticeCenter
  @State var item: MediaLibraryItem
  @State private var starting = false
  @State private var note: String?
  @State private var player: AVPlayer?

  private var mediaURL: (String?) -> URL? {
    { path in path.flatMap { URL(string: $0, relativeTo: controller.api.baseURL)?.absoluteURL } }
  }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 18) {
        visual
        VStack(alignment: .leading, spacing: 6) {
          Text(item.media.title ?? (item.media.kind == "video" ? "A video" : "A photo"))
            .font(.system(.title, design: .serif))
          Text("\(item.media.createdAt.formatted(date: .abbreviated, time: .shortened)) · \(sourceText)")
            .font(.callout)
            .foregroundStyle(AtlasTheme.muted)
        }
        exploreSection
        if let note {
          InlineBanner(text: note)
        }
      }
      .padding(16)
      .padding(.bottom, 32)
      .animation(AtlasMotion.spring, value: item)
    }
    .background(AtlasTheme.ivory.ignoresSafeArea())
    .navigationBarTitleDisplayMode(.inline)
    .toolbar(.hidden, for: .tabBar)
    .task { await refresh() }
    .onChange(of: notices.exploring) { _, _ in Task { await refresh() } }
    .onDisappear { player?.pause() }
  }

  @ViewBuilder private var visual: some View {
    let ratio = CGFloat(item.media.width ?? 4) / CGFloat(max(1, item.media.height ?? 5))
    if item.media.kind == "video", let player {
      VideoPlayer(player: player)
        .aspectRatio(max(0.5, min(2, ratio)), contentMode: .fit)
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
    } else {
      Color.clear
        .aspectRatio(max(0.5, min(2, ratio)), contentMode: .fit)
        .overlay {
          RemoteImage(url: mediaURL(item.media.kind == "photo" ? (item.links.playback ?? item.links.original) : item.links.poster),
                      authorize: controller.api.imageAuthorizer) {
            AtlasTheme.quiet
          }
        }
        .overlay {
          if item.media.kind == "video", item.links.playback != nil {
            Button {
              startVideo()
            } label: {
              Image(systemName: "play.fill")
                .font(.title)
                .foregroundStyle(.white)
                .padding(22)
                .background(Circle().fill(.black.opacity(0.4)))
            }
            .accessibilityLabel("Play video")
          }
        }
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .shadow(color: .black.opacity(0.08), radius: 14, y: 6)
    }
  }

  @ViewBuilder private var exploreSection: some View {
    let analysis = CapabilityGate.photoAnalysis(controller.capabilities)
    VStack(alignment: .leading, spacing: 12) {
      if notices.exploring.contains(item.id) || item.analyzing {
        AnalysisLookingBanner()
        Text("Looking at your \(item.media.kind == "video" ? "video" : "photo"). We'll let you know when it's ready.")
          .font(.footnote)
          .foregroundStyle(AtlasTheme.muted)
      } else if item.analyzed {
        Button {
          notices.open(mediaID: item.id, analysisID: nil, kind: item.media.kind == "video" ? .video : .photo,
                       webPath: item.links.analysis)
        } label: {
          Label("See what we found", systemImage: "sparkles")
            .frame(maxWidth: .infinity, minHeight: 48)
        }
        .buttonStyle(.borderedProminent)
      } else if !item.isReady {
        Label(item.media.status == "failed" ? "This file couldn't be prepared." : "Getting this ready…",
              systemImage: "hourglass")
          .foregroundStyle(AtlasTheme.muted)
      } else if item.media.kind != "photo" {
        Text("Exploring videos from the phone is coming soon. Your video is saved privately.")
          .font(.footnote)
          .foregroundStyle(AtlasTheme.muted)
      } else if !analysis.available {
        InlineBanner(text: analysis.message, systemImage: "lock")
      } else {
        Button {
          Task { await explore() }
        } label: {
          HStack {
            if starting { ProgressView().tint(.white) }
            Label("Explore this photo", systemImage: "sparkle.magnifyingglass")
          }
          .frame(maxWidth: .infinity, minHeight: 48)
        }
        .buttonStyle(.borderedProminent)
        .disabled(starting)
        .accessibilityIdentifier("media.explore")
        Text("We look for what's in the photo and use it to grow your feed. Nothing is invented.")
          .font(.footnote)
          .foregroundStyle(AtlasTheme.muted)
      }
    }
  }

  private var sourceText: String {
    switch item.media.source {
    case "phone_camera": return "This camera"
    case "meta_glasses": return "Meta glasses"
    case "browser_camera": return "Web camera"
    case "upload": return "Uploaded"
    default: return "Captured"
    }
  }

  private func startVideo() {
    guard let url = mediaURL(item.links.playback) else { return }
    Task {
      guard let token = await controller.api.imageAuthorizer() else { return }
      let asset = AVURLAsset(url: url, options: ["AVURLAssetHTTPHeaderFieldsKey": ["Authorization": "Bearer \(token)"]])
      let player = AVPlayer(playerItem: AVPlayerItem(asset: asset))
      withAnimation(AtlasMotion.spring) { self.player = player }
      player.play()
    }
  }

  private func refresh() async {
    if let fresh = try? await controller.api.mediaItem(item.id) { item = fresh }
  }

  private func explore() async {
    starting = true
    defer { starting = false }
    let started = await notices.explore(assetID: item.id)
    if started {
      note = nil
      await refresh()
    } else {
      note = CapabilityGate.photoAnalysisMessage(
        reasons: controller.capabilities?.availability["analysis"]?.reasons ?? [])
    }
  }
}

/// A finished (or running) analysis, shown natively: what the photo reading
/// published, or the music match and the artists it resolved, then where the
/// suggestions went. Everything comes from the server; nothing is invented.
struct AnalysisResultView: View {
  @EnvironmentObject private var controller: CaptureController
  @EnvironmentObject private var notices: ReadyNoticeCenter
  @Environment(\.dismiss) private var dismiss
  let route: ReadyNoticeCenter.ResultRoute

  @State private var result: AnalysisResultResponse?
  @State private var media: MediaLibraryItem?
  @State private var failed = false
  @State private var revealed = false
  /// The compiled capture (`GET /v1/captures/{id}`): references + Qloo cards.
  @State private var capture: CaptureResultResponse?
  @State private var openedCard: DiscoveryCard?

  private var isAudio: Bool { route.kind == .audio }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        header
        if let result {
          if result.stillWorking {
            AnalysisLookingBanner()
            Text(result.waitingReason == "ai_paused"
              ? "Exploring is paused for a moment. It will pick up again on its own."
              : "Still looking. This usually takes a few seconds.")
              .font(.footnote)
              .foregroundStyle(AtlasTheme.muted)
          } else if result.state == .failed || result.state == .cancelled {
            InlineBanner(text: "We couldn't finish exploring this one. It's still saved privately.", systemImage: "exclamationmark.circle")
          } else if isAudio {
            musicResult(result.result ?? AnalysisResult())
          } else {
            photoResult(result.result ?? AnalysisResult())
            if let capture { captureSuggestions(capture) }
          }
          if result.finished {
            nextSteps
          }
        } else if failed {
          InlineBanner(text: "This result isn't reachable right now. Try again in a moment.", systemImage: "wifi.exclamationmark")
          if let web = route.webPath, !isAudio {
            Button("Open the full result on the web") { notices.openWeb(path: web) }
              .font(.footnote)
          }
        } else {
          ProgressView().tint(AtlasTheme.olive).frame(maxWidth: .infinity, minHeight: 120)
        }
      }
      .padding(20)
      .animation(AtlasMotion.spring, value: result)
      .animation(AtlasMotion.spring, value: capture)
    }
    .background(AtlasTheme.ivory.ignoresSafeArea())
    .navigationDestination(item: $openedCard) { card in FeedCardDetail(card: card) }
    .navigationTitle(isAudio ? "Your music" : "Your photo")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
    }
    .task { await load() }
  }

  @ViewBuilder private var header: some View {
    if isAudio {
      HStack(spacing: 14) {
        Image(systemName: "waveform")
          .font(.system(size: 30))
          .foregroundStyle(.white)
          .frame(width: 64, height: 64)
          .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(AtlasTheme.olive))
          .symbolEffect(.variableColor.iterative, isActive: result?.stillWorking ?? true)
        VStack(alignment: .leading, spacing: 2) {
          Text("Music Mode").font(.caption.weight(.semibold)).foregroundStyle(AtlasTheme.olive)
          Text(result?.result?.musicHeadline ?? "Listening…").font(.system(.title2, design: .serif))
        }
      }
    } else {
      let path = media.flatMap { $0.links.playback ?? $0.links.original ?? $0.links.poster }
      let ratio = media.map { CGFloat($0.media.width ?? 4) / CGFloat(max(1, $0.media.height ?? 5)) } ?? 4 / 5
      Color.clear
        .aspectRatio(max(0.6, min(1.8, ratio)), contentMode: .fit)
        .overlay {
          RemoteImage(url: path.flatMap { URL(string: $0, relativeTo: controller.api.baseURL)?.absoluteURL },
                      authorize: controller.api.imageAuthorizer) {
            AtlasTheme.quiet
          }
        }
        .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
        .shadow(color: .black.opacity(0.08), radius: 14, y: 6)
    }
  }

  private func photoResult(_ reading: AnalysisResult) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("What we noticed").font(.system(.title3, design: .serif))
      if reading.candidates.isEmpty {
        Text("Nothing we could name with confidence. Your photo still helps your feed learn what you like.")
          .foregroundStyle(AtlasTheme.muted)
      } else {
        FlowLayout(spacing: 8) {
          ForEach(Array(reading.candidates.enumerated()), id: \.element.id) { index, candidate in
            VStack(alignment: .leading, spacing: 2) {
              if candidate.isResemblance {
                Text("Resembles").font(.caption2).foregroundStyle(AtlasTheme.muted)
              }
              Text(candidate.name).font(.callout.weight(.medium))
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(AtlasTheme.quiet))
            .opacity(revealed ? 1 : 0)
            .offset(y: revealed ? 0 : 8)
            .animation(AtlasMotion.spring.delay(Double(index) * 0.06), value: revealed)
          }
        }
        if reading.reading == "quick" {
          Text("A quick first read. More detail is still on the way.")
            .font(.footnote)
            .foregroundStyle(AtlasTheme.muted)
        }
      }
    }
    .onAppear { revealed = true }
  }

  /// Sourced references and the recommendations made from them, exactly as
  /// the server compiled them (never filled in on the phone).
  @ViewBuilder private func captureSuggestions(_ capture: CaptureResultResponse) -> some View {
    if capture.references.isEmpty == false {
      VStack(alignment: .leading, spacing: 8) {
        Text("References").font(.footnote.weight(.semibold)).foregroundStyle(AtlasTheme.muted)
        FlowLayout(spacing: 6) {
          ForEach(capture.references) { ref in
            Text(ref.phrase)
              .font(.footnote)
              .padding(.horizontal, 10)
              .padding(.vertical, 6)
              .background(Capsule().fill(AtlasTheme.quiet))
              .accessibilityHint(ref.attribution ?? "")
          }
        }
      }
      .transition(.opacity.combined(with: .move(edge: .bottom)))
    }
    if capture.recommendations.isEmpty == false {
      VStack(alignment: .leading, spacing: 10) {
        Text("Suggestions from this photo").font(.system(.title3, design: .serif))
        ScrollView(.horizontal, showsIndicators: false) {
          LazyHStack(alignment: .top, spacing: 12) {
            ForEach(capture.recommendations) { card in
              Button { openedCard = card } label: {
                FeedCardTile(card: card, baseURL: controller.api.baseURL)
                  .frame(width: 140)
              }
              .buttonStyle(.plain)
            }
          }
        }
      }
      .transition(.opacity.combined(with: .move(edge: .bottom)))
    }
  }

  private func musicResult(_ reading: AnalysisResult) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      if reading.seeds.isEmpty {
        Text(reading.music == "provider_unavailable"
          ? "Music matching isn't available right now. Your recording is saved privately."
          : "We didn't find a reliable match in this part. Try a clearer 10–20 seconds of the song.")
          .foregroundStyle(AtlasTheme.muted)
      } else {
        Text("Sounds like").font(.system(.title3, design: .serif))
        ForEach(Array(reading.seeds.enumerated()), id: \.element.id) { index, seed in
          HStack(spacing: 12) {
            Image(systemName: "music.mic")
              .foregroundStyle(AtlasTheme.olive)
              .frame(width: 36, height: 36)
              .background(Circle().fill(AtlasTheme.quiet))
            Text(seed.name).font(.system(.body, design: .serif).weight(.medium))
            Spacer()
          }
          .opacity(revealed ? 1 : 0)
          .offset(x: revealed ? 0 : -10)
          .animation(AtlasMotion.spring.delay(Double(index) * 0.08), value: revealed)
        }
      }
    }
    .onAppear { revealed = true }
  }

  private var nextSteps: some View {
    VStack(alignment: .leading, spacing: 10) {
      Divider()
      Text("Suggestions from this float into your feed as they're found.")
        .font(.callout)
        .foregroundStyle(AtlasTheme.muted)
      Button {
        dismiss()
        controller.popToRoot(.feed)
        controller.rootTab = .feed
      } label: {
        Label("See your feed", systemImage: "sparkles.rectangle.stack")
          .frame(maxWidth: .infinity, minHeight: 48)
      }
      .buttonStyle(.borderedProminent)
      if let web = route.webPath ?? result?.resultURL, !isAudio, result?.captureID != nil {
        Button("Open the full result on the web") { notices.openWeb(path: web) }
          .font(.footnote)
          .foregroundStyle(AtlasTheme.muted)
          .frame(maxWidth: .infinity)
      }
    }
  }

  private func load() async {
    if !isAudio { media = try? await controller.api.mediaItem(route.mediaID) }
    var analysisID = route.analysisID ?? notices.lastAnalysis(for: route.mediaID)
    if analysisID == nil, let media, ["queued", "running", "complete"].contains(media.media.analysisStatus) {
      // Re-requesting the same exploration returns the existing one (no new work).
      analysisID = try? await controller.api.photoAnalysis(mediaID: media.id, generation: media.generation).analysisID
    }
    guard let analysisID else {
      failed = true
      return
    }
    for attempt in 0..<40 {
      guard !Task.isCancelled else { return }
      do {
        let loaded = try await controller.api.analysisResult(mediaID: route.mediaID, analysisID: analysisID)
        result = loaded
        failed = false
        if !loaded.stillWorking {
          if loaded.finished, !isAudio, let captureID = loaded.captureID { await loadCapture(captureID) }
          return
        }
      } catch where AtlasClientError.isCancellation(error) {
        return
      } catch {
        if result == nil { failed = true }
      }
      try? await Task.sleep(nanoseconds: UInt64(min(5, 2 + attempt / 4) * 1_000_000_000))
    }
  }
}

extension AnalysisResultView {
  /// References and recommendations compile after the vision read, so poll
  /// briefly. A refusal (an older server without the bridged read) keeps
  /// what `/v2` already showed.
  fileprivate func loadCapture(_ captureID: UUID) async {
    for _ in 0..<8 {
      guard !Task.isCancelled else { return }
      do {
        let loaded = try await controller.api.captureResult(captureID)
        capture = loaded
        if loaded.settled { return }
      } catch {
        return
      }
      try? await Task.sleep(nanoseconds: 3_000_000_000)
    }
  }
}

struct DraftRow: View {
  @EnvironmentObject private var controller: CaptureController
  @EnvironmentObject private var notices: ReadyNoticeCenter
  let draft: DraftRecord

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(alignment: .center, spacing: 12) {
        thumb
        VStack(alignment: .leading, spacing: 3) {
          HStack(spacing: 6) {
            Text(kindLabel).font(.system(.body, design: .serif).weight(.medium))
            if let duration = draft.durationSeconds {
              Text(ClipClock.clock(Int(duration))).foregroundStyle(AtlasTheme.muted)
            }
          }
          Text("\(draft.capturedAt.formatted(date: .abbreviated, time: .shortened)) · \(sourceText)")
            .font(.caption)
            .foregroundStyle(AtlasTheme.muted)
        }
        Spacer()
        StatusPill(text: statusText, active: [.uploading, .verifying, .queued].contains(draft.status))
      }
      if draft.interrupted {
        Text("Recording was interrupted. The part before the interruption was kept.").font(.footnote)
      }
      actions
    }
    .padding(12)
    .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(AtlasTheme.quiet.opacity(0.7)))
    .accessibilityElement(children: .contain)
  }

  @ViewBuilder private var thumb: some View {
    if draft.kind == .photo {
      DraftPhotoThumb(draft: draft)
    } else {
      Image(systemName: kindIcon)
        .font(.title3)
        .foregroundStyle(.white)
        .frame(width: 56, height: 56)
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(AtlasTheme.olive))
        .accessibilityHidden(true)
    }
  }

  private var kindIcon: String {
    switch draft.kind {
    case .photo: return "photo"
    case .video: return "video"
    case .audio: return "waveform"
    }
  }

  private var kindLabel: String {
    switch draft.kind {
    case .photo: return "Photo"
    case .video: return "Video"
    case .audio: return "Recording"
    }
  }

  private var sourceText: String {
    switch draft.source {
    case .phoneCamera: return "This camera"
    case .metaGlasses: return "Meta glasses (Experimental)"
    case .upload: return "Uploaded file"
    case .phoneMicrophone: return "Phone microphone"
    case .glassesMicrophone: return "Glasses microphone"
    }
  }

  var statusText: String {
    switch draft.status {
    case .awaitingReview: return "Not kept yet"
    case .keptLocal: return "On this phone"
    case .queued: return draft.allowCellular ? "Waiting to upload" : "Waiting for Wi-Fi"
    case .uploading: return "Uploading"
    case .verifying: return "Checking"
    case .committed: return "In your library"
    case .locked: return "Waiting for its account"
    case .rejected: return "Not accepted"
    case .failed: return "Upload paused"
    }
  }

  @ViewBuilder private var actions: some View {
    switch draft.status {
    case .awaitingReview:
      HStack {
        Button("Keep") { Task { await controller.keep(draft) } }.buttonStyle(.borderedProminent)
        Button(draft.kind == .photo ? "Retake" : "Delete", role: .destructive) { Task { await controller.discard(draft) } }
        if draft.kind == .audio {
          NavigationLink("Review recording") { AudioDetailView(draft: draft) }
        }
      }
    case .keptLocal:
      HStack {
        NavigationLink {
          AudioDetailView(draft: draft)
        } label: {
          Label("Explore music", systemImage: "sparkles")
        }
        .buttonStyle(.borderedProminent)
        Button("Delete", role: .destructive) { Task { await controller.discard(draft) } }
      }
    case .queued where !draft.allowCellular:
      Button("Upload using mobile data") { Task { await controller.keep(draft, allowCellular: true) } }
        .buttonStyle(.bordered)
    case .committed where draft.kind == .audio && draft.assetID != nil:
      if let assetID = draft.assetID, notices.exploring.contains(assetID) {
        AnalysisLookingBanner()
      } else {
        NavigationLink {
          AudioDetailView(draft: draft)
        } label: {
          Label("Explore music", systemImage: "sparkles")
        }
        .buttonStyle(.borderedProminent)
      }
    case .failed, .rejected:
      HStack {
        if draft.status == .failed { Button("Retry") { Task { await controller.retry(draft) } }.buttonStyle(.bordered) }
        Button("Delete from this phone", role: .destructive) { Task { await controller.discard(draft) } }
      }
    default:
      EmptyView()
    }
  }
}

private struct StatusPill: View {
  let text: String
  var active = false

  var body: some View {
    HStack(spacing: 5) {
      if active {
        ProgressView().controlSize(.mini).tint(AtlasTheme.olive)
      }
      Text(text)
    }
    .font(.caption.weight(.medium))
    .foregroundStyle(AtlasTheme.muted)
    .padding(.horizontal, 10)
    .padding(.vertical, 5)
    .background(Capsule().fill(AtlasTheme.ivory))
    .overlay(Capsule().stroke(AtlasTheme.line))
    .contentTransition(.opacity)
    .animation(AtlasMotion.fade, value: text)
  }
}

/// Local JPEG from the encrypted draft — the real capture, not a placeholder.
private struct DraftPhotoThumb: View {
  @EnvironmentObject private var controller: CaptureController
  let draft: DraftRecord
  @State private var image: UIImage?

  var body: some View {
    ZStack {
      AtlasTheme.quiet
      if let image {
        Image(uiImage: image)
          .resizable()
          .scaledToFill()
          .transition(.opacity)
      } else {
        Image(systemName: "photo")
          .foregroundStyle(AtlasTheme.muted)
      }
    }
    .frame(width: 56, height: 56)
    .clipped()
    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    .accessibilityHidden(true)
    .task { await load() }
  }

  @MainActor
  private func load() async {
    guard draft.kind == .photo else { return }
    let url = try? controller.draftStore.openForPlayback(draft)
    defer { if let url { try? FileManager.default.removeItem(at: url) } }
    guard let url else { return }
    let loaded = UIImage(contentsOfFile: url.path)?.preparingThumbnail(of: CGSize(width: 168, height: 168))
    withAnimation(AtlasMotion.fade) { image = loaded }
  }
}
