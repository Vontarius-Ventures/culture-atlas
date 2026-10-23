import AtlasCapture
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// Screen 02: big, tappable sources — This camera, Music, Upload and Meta
/// glasses (Experimental) — on the same paper as the rest of the app.
struct CaptureSourceView: View {
  @EnvironmentObject private var controller: CaptureController
  @State private var picked: [PhotosPickerItem] = []
  @State private var importing = 0

  private let columns = [
    GridItem(.flexible(), spacing: 12, alignment: .top),
    GridItem(.flexible(), spacing: 12, alignment: .top),
  ]

  var body: some View {
    let camera = CapabilityGate.phoneCamera(controller.capabilities)
    let music = CapabilityGate.phoneMicrophone(controller.capabilities)
    let cameraOn = camera.photo || camera.video
    let uploadSubtitle = importing > 0 ? "Adding \(importing)…" : "From your photos"
    ScrollView {
      VStack(alignment: .leading, spacing: 18) {
        VStack(alignment: .leading, spacing: 6) {
          Text("Keep what catches your eye.").font(.system(.title2, design: .serif))
          Text("Everything you keep is private. You choose what to explore.")
            .foregroundStyle(AtlasTheme.muted)
        }
        LazyVGrid(columns: columns, spacing: 12) {
          NavigationLink {
            CameraView()
          } label: {
            SourceCard(
              title: "This camera", subtitle: cameraOn ? "Photo or video" : "Paused on the server",
              systemImage: "camera.fill", tint: AtlasTheme.olive, prominent: true)
          }
          .buttonStyle(.pressableCard)
          .disabled(!cameraOn)
          .accessibilityIdentifier("capture.this-camera")

          NavigationLink {
            MusicView()
          } label: {
            SourceCard(
              title: "Music", subtitle: music ? "Find a song you hear" : "Paused on the server",
              systemImage: "waveform", tint: Color(red: 0.28, green: 0.32, blue: 0.38), prominent: true)
          }
          .buttonStyle(.pressableCard)
          .disabled(!music)
          .accessibilityIdentifier("capture.music")

          PhotosPicker(selection: $picked, maxSelectionCount: 20, matching: .any(of: [.images, .videos])) {
            SourceCard(
              title: "Upload", subtitle: uploadSubtitle,
              systemImage: "square.and.arrow.up", tint: Color(red: 0.42, green: 0.28, blue: 0.22))
          }
          .buttonStyle(.pressableCard)
          .accessibilityIdentifier("capture.upload")

          NavigationLink {
            GlassesView()
          } label: {
            SourceCard(
              title: "Meta glasses",
              subtitle: controller.wearables.buildIncludesSDK ? "Experimental" : "Experimental · needs the glasses build",
              systemImage: "eyeglasses", tint: AtlasTheme.ink)
          }
          .buttonStyle(.pressableCard)
          .accessibilityIdentifier("capture.glasses")
        }
        Label("Uploading does not start analysis. Explore from your library when you're ready.", systemImage: "lock")
          .font(.footnote)
          .foregroundStyle(AtlasTheme.muted)
      }
      .padding(16)
      .padding(.bottom, 24)
    }
    .background(AtlasTheme.ivory.ignoresSafeArea())
    .navigationTitle("Capture")
    .navigationDestination(isPresented: $controller.openCamera) {
      CameraView()
    }
    .navigationDestination(isPresented: $controller.openMusic) {
      MusicView()
    }
    .navigationDestination(isPresented: $controller.openGlasses) {
      GlassesView()
    }
    .onChange(of: picked) { _, items in
      guard !items.isEmpty else { return }
      Task {
        importing = items.count
        var added = 0
        for item in items {
          if await controller.importPicked(item) { added += 1 }
          importing -= 1
        }
        picked = []
        guard added > 0 else { return }
        controller.showFlash(
          Flash(text: added == 1 ? "Uploading to your library" : "Uploading \(added) files to your library",
                systemImage: "tray.and.arrow.down.fill"))
      }
    }
  }

}

/// One capture source: a tall card with a tinted icon tile.
private struct SourceCard: View {
  let title: String
  let subtitle: String
  let systemImage: String
  let tint: Color
  var prominent = false
  var badge: String?
  @Environment(\.isEnabled) private var isEnabled

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(alignment: .top) {
        Image(systemName: systemImage)
          .font(.title2)
          .foregroundStyle(.white)
          .frame(width: 52, height: 52)
          .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(tint))
        Spacer()
        if let badge {
          Text(badge)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(AtlasTheme.muted)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(Capsule().fill(AtlasTheme.ivory))
        }
      }
      Spacer(minLength: 28)
      Text(title)
        .font(.system(.title3, design: .serif).weight(.semibold))
        .foregroundStyle(AtlasTheme.ink)
      Text(subtitle)
        .font(.footnote)
        .foregroundStyle(AtlasTheme.muted)
        .lineLimit(2, reservesSpace: true)
    }
    .padding(16)
    .frame(maxWidth: .infinity, minHeight: 170, alignment: .topLeading)
    .background(
      RoundedRectangle(cornerRadius: 22, style: .continuous)
        .fill(prominent ? AtlasTheme.quiet : AtlasTheme.quiet.opacity(0.6)))
    .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).stroke(AtlasTheme.line))
    .opacity(isEnabled ? 1 : 0.5)
    .accessibilityElement(children: .combine)
  }
}

extension CaptureController {
  /// Each file becomes an independent draft; one failure does not block siblings.
  @discardableResult
  func importPicked(_ item: PhotosPickerItem) async -> Bool {
    let isVideo = item.supportedContentTypes.contains { $0.conforms(to: .movie) }
    let isAudio = item.supportedContentTypes.contains { $0.conforms(to: .audio) }
    guard var data = try? await item.loadTransferable(type: Data.self) else { return false }
    let type = item.supportedContentTypes.first
    let contentType: String
    let kind: MediaKind
    if isAudio, !isVideo {
      kind = .audio
      if type?.conforms(to: .mpeg4Audio) == true {
        contentType = "audio/mp4"
      } else if type?.conforms(to: .mp3) == true {
        contentType = "audio/mpeg"
      } else if type?.conforms(to: .wav) == true {
        contentType = "audio/wav"
      } else if type?.identifier == "org.xiph.flac" {
        contentType = "audio/flac"
      } else {
        message = "This audio format isn't supported yet."
        return false
      }
    } else if isVideo {
      kind = .video
      contentType = type?.conforms(to: .mpeg4Movie) == true ? "video/mp4" : "video/quicktime"
    } else if let photo = PhotoImport.payload(data: data, type: type) {
      kind = .photo
      contentType = photo.contentType
      data = photo.data
    } else {
      message = "This photo format isn't supported yet. Export it as JPEG and try again."
      return false
    }
    let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    do {
      try data.write(to: url, options: .completeFileProtectionUntilFirstUserAuthentication)
      await importFile(at: url, kind: kind, contentType: contentType)
      return true
    } catch {
      message = "That file couldn't be added."
      return false
    }
  }
}
