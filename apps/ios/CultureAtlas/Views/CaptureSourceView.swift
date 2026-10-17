import AtlasCapture
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// Screen 02: This camera, Meta glasses (Experimental), Upload files.
struct CaptureSourceView: View {
  @EnvironmentObject private var controller: CaptureController
  @State private var picked: [PhotosPickerItem] = []

  var body: some View {
    let camera = CapabilityGate.phoneCamera(controller.capabilities)
    List {
      Section {
        Text("Keep what catches your eye.").font(.system(.title2, design: .serif))
        Text("Your library is private. Choose what to explore.").foregroundStyle(AtlasTheme.muted)
      }
      Section {
        NavigationLink {
          CameraView()
        } label: {
          Label("This camera", systemImage: "camera")
        }
        .disabled(!camera.photo && !camera.video)
        NavigationLink {
          GlassesView()
        } label: {
          HStack {
            Label("Meta glasses", systemImage: "eyeglasses")
            Text("Experimental").font(.caption).padding(.horizontal, 8).padding(.vertical, 2)
              .background(Capsule().fill(AtlasTheme.quiet))
          }
        }
        PhotosPicker(selection: $picked, maxSelectionCount: 20, matching: .any(of: [.images, .videos])) {
          Label("Upload files", systemImage: "square.and.arrow.up")
        }
      } footer: {
        Text("Uploading does not start analysis.")
      }
    }
    .navigationTitle("Capture")
    .onChange(of: picked) { _, items in
      Task {
        for item in items { await importItem(item) }
        picked = []
      }
    }
  }

  /// Each file becomes an independent draft; one failure does not block siblings.
  private func importItem(_ item: PhotosPickerItem) async {
    let isVideo = item.supportedContentTypes.contains { $0.conforms(to: .movie) }
    guard let data = try? await item.loadTransferable(type: Data.self) else { return }
    let type = item.supportedContentTypes.first
    let contentType: String
    if isVideo {
      contentType = type?.conforms(to: .mpeg4Movie) == true ? "video/mp4" : "video/quicktime"
    } else if type?.conforms(to: .png) == true {
      contentType = "image/png"
    } else if type?.conforms(to: .jpeg) == true {
      contentType = "image/jpeg"
    } else if type?.conforms(to: .webP) == true {
      contentType = "image/webp"
    } else {
      // HEIC/HEIF is not accepted until the server qualifies a decoder.
      controller.message = "This photo format isn't supported yet. Export it as JPEG and try again."
      return
    }
    let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    do {
      try data.write(to: url, options: .completeFileProtectionUntilFirstUserAuthentication)
      await controller.importFile(at: url, kind: isVideo ? .video : .photo, contentType: contentType)
    } catch {
      controller.message = "That file couldn't be added."
    }
  }
}
