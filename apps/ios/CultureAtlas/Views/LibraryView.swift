import AtlasCapture
import SwiftUI
import UIKit

/// Local drafts of the signed-in account with durable upload status
/// (screen 08 on phone). Status is always written in words, never colour alone.
struct LibraryView: View {
  @EnvironmentObject private var controller: CaptureController
  @State private var boards: [CollectionSummary] = []

  private let columns = [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)]

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        Text("Your library is private. Choose what to explore.")
          .font(.footnote)
          .foregroundStyle(AtlasTheme.muted)
        Text("Uploading does not start analysis.")
          .font(.footnote)
          .foregroundStyle(AtlasTheme.muted)
        HStack {
          Text("Boards").font(.system(.title3, design: .serif))
          Spacer()
          NavigationLink("See all") { BoardsView() }
        }
        if boards.isEmpty {
          Text("Boards you build from Feed show up here.")
            .font(.footnote)
            .foregroundStyle(AtlasTheme.muted)
        } else {
          LazyVGrid(columns: columns, spacing: 12) {
            ForEach(boards.prefix(4)) { board in
              NavigationLink {
                BoardDetailView(boardID: board.id, title: board.name)
              } label: {
                BoardCoverTile(board: board, baseURL: controller.api.baseURL)
              }
              .buttonStyle(.plain)
            }
          }
        }
        if controller.drafts.isEmpty {
          Text("Nothing captured yet").font(.system(.title3, design: .serif))
          Text("Take a photo, record music, or upload files from your phone.")
            .foregroundStyle(AtlasTheme.muted)
          NavigationLink("Capture") { CaptureSourceView() }
        }
        ForEach(controller.drafts) { draft in
          DraftRow(draft: draft)
        }
        if controller.lockedDraftsExist {
          LockedDraftsNotice()
        }
      }
      .padding(16)
    }
    .background(AtlasTheme.ivory.ignoresSafeArea())
    .navigationTitle("Library")
    .refreshable {
      controller.reloadDrafts()
      await loadBoards()
    }
    .task { await loadBoards() }
  }

  private func loadBoards() async {
    boards = (try? await controller.api.collections())?.collections ?? []
  }
}

struct DraftRow: View {
  @EnvironmentObject private var controller: CaptureController
  @EnvironmentObject private var notices: ReadyNoticeCenter
  let draft: DraftRecord

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack(alignment: .center, spacing: 12) {
        if draft.kind == .photo {
          DraftPhotoThumb(draft: draft)
        } else {
          Image(systemName: kindIcon)
            .accessibilityHidden(true)
        }
        Text(kindLabel)
        if let duration = draft.durationSeconds {
          Text(ClipClock.clock(Int(duration))).foregroundStyle(AtlasTheme.muted)
        }
        Spacer()
        Text(statusText).font(.footnote).foregroundStyle(AtlasTheme.muted)
      }
      Text("\(draft.capturedAt.formatted(date: .abbreviated, time: .shortened)) · \(sourceText)")
        .font(.footnote)
        .foregroundStyle(AtlasTheme.muted)
      if draft.interrupted {
        Text("Recording was interrupted. The part before the interruption was kept.").font(.footnote)
      }
      actions
    }
    .accessibilityElement(children: .combine)
  }

  private var kindIcon: String {
    switch draft.kind {
    case .photo: return "photo"
    case .video: return "video"
    case .audio: return "music.note"
    }
  }

  private var kindLabel: String {
    switch draft.kind {
    case .photo: return "Photo"
    case .video: return "Video"
    case .audio: return "Audio"
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
    case .keptLocal: return "Saved on this phone"
    case .queued: return draft.allowCellular ? "Waiting to upload" : "Waiting for Wi-Fi"
    case .uploading: return "Uploading"
    case .verifying: return "Checking on the server"
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
        NavigationLink("Explore music") { AudioDetailView(draft: draft) }
        Button("Delete from this phone", role: .destructive) { Task { await controller.discard(draft) } }
      }
    case .queued where !draft.allowCellular:
      Button("Upload using mobile data") { Task { await controller.keep(draft, allowCellular: true) } }
    case .committed where draft.kind == .photo && draft.assetID != nil:
      // The user starts exploring; screen 17 tells them when it is ready.
      let analysis = CapabilityGate.photoAnalysis(controller.capabilities)
      if let assetID = draft.assetID, notices.exploring.contains(assetID) {
        Text("Looking at your photo. This takes a few seconds.")
          .font(.footnote)
          .foregroundStyle(AtlasTheme.muted)
          .accessibilityAddTraits(.updatesFrequently)
      } else if !analysis.available {
        Text(analysis.message)
          .font(.footnote)
          .foregroundStyle(AtlasTheme.muted)
      } else if let assetID = draft.assetID {
        Button("Explore this photo") {
          Task {
            let started = await notices.explore(assetID: assetID)
            if !started {
              controller.message = CapabilityGate.photoAnalysisMessage(
                reasons: controller.capabilities?.availability["analysis"]?.reasons ?? [])
            }
          }
        }
      }
    case .committed where draft.kind == .audio && draft.assetID != nil:
      NavigationLink("Explore music") { AudioDetailView(draft: draft) }
    case .failed, .rejected:
      HStack {
        if draft.status == .failed { Button("Retry") { Task { await controller.retry(draft) } } }
        Button("Delete from this phone", role: .destructive) { Task { await controller.discard(draft) } }
      }
    default:
      EmptyView()
    }
  }
}

/// Local JPEG from the encrypted draft — the real capture, not a placeholder.
private struct DraftPhotoThumb: View {
  @EnvironmentObject private var controller: CaptureController
  let draft: DraftRecord
  @State private var image: UIImage?

  var body: some View {
    Group {
      if let image {
        Image(uiImage: image)
          .resizable()
          .scaledToFill()
      } else {
        Image(systemName: "photo")
          .foregroundStyle(AtlasTheme.muted)
      }
    }
    .frame(width: 56, height: 56)
    .clipped()
    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    .accessibilityHidden(true)
    .task { await load() }
  }

  @MainActor
  private func load() async {
    guard draft.kind == .photo else { return }
    let url = try? controller.draftStore.openForPlayback(draft)
    defer { if let url { try? FileManager.default.removeItem(at: url) } }
    guard let url else { return }
    image = UIImage(contentsOfFile: url.path)
  }
}
