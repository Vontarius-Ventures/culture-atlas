import AtlasCapture
import SwiftUI

/// Local drafts of the signed-in account with durable upload status
/// (screen 08 on phone). Status is always written in words, never colour alone.
struct LibraryView: View {
  @EnvironmentObject private var controller: CaptureController

  var body: some View {
    List {
      Section {
        Text("Your library is private. Choose what to explore.")
          .font(.footnote)
          .foregroundStyle(AtlasTheme.muted)
        Text("Uploading does not start analysis.")
          .font(.footnote)
          .foregroundStyle(AtlasTheme.muted)
      }
      if controller.drafts.isEmpty {
        Section {
          VStack(alignment: .leading, spacing: 8) {
            Text("Nothing here yet").font(.system(.title3, design: .serif))
            Text("Take a photo or video, or upload files from your phone.")
            NavigationLink("Capture") { CaptureSourceView() }
          }
        }
      }
      ForEach(controller.drafts) { draft in
        DraftRow(draft: draft)
      }
      if controller.lockedDraftsExist {
        Section { LockedDraftsNotice() }
      }
    }
    .navigationTitle("Library")
    .refreshable { controller.reloadDrafts() }
  }
}

struct DraftRow: View {
  @EnvironmentObject private var controller: CaptureController
  @EnvironmentObject private var notices: ReadyNoticeCenter
  let draft: DraftRecord

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack {
        Image(systemName: draft.kind == .photo ? "photo" : "video")
          .accessibilityHidden(true)
        Text(draft.kind == .photo ? "Photo" : "Video")
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

  private var sourceText: String {
    switch draft.source {
    case .phoneCamera: return "This camera"
    case .metaGlasses: return "Meta glasses (Experimental)"
    case .upload: return "Uploaded file"
    }
  }

  var statusText: String {
    switch draft.status {
    case .awaitingReview: return "Not kept yet"
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
      }
    case .queued where !draft.allowCellular:
      Button("Upload using mobile data") { Task { await controller.keep(draft, allowCellular: true) } }
    case .committed where draft.kind == .photo && draft.assetID != nil:
      // The user starts exploring; screen 17 tells them when it is ready.
      if let assetID = draft.assetID, notices.exploring.contains(assetID) {
        Text("Looking at your photo. This takes a few seconds.")
          .font(.footnote)
          .foregroundStyle(AtlasTheme.muted)
          .accessibilityAddTraits(.updatesFrequently)
      } else if let assetID = draft.assetID {
        Button("Explore this photo") {
          Task {
            let started = await notices.explore(assetID: assetID)
            if !started {
              controller.message = "Exploring isn't available right now. Your photo is safe in your library."
            }
          }
        }
      }
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
