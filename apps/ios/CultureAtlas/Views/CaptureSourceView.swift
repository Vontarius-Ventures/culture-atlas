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
    let music = CapabilityGate.phoneMicrophone(controller.capabilities)
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
        .accessibilityIdentifier("capture.this-camera")
        .disabled(!camera.photo && !camera.video)
        if !camera.photo && !camera.video {
          Text("This camera is paused on the server. You can still keep files already on this phone.")
            .font(.footnote)
            .foregroundStyle(AtlasTheme.muted)
        }
        NavigationLink {
          MusicView()
        } label: {
          Label("Music", systemImage: "music.note")
        }
        .disabled(!music)
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
      Task {
        for item in items { await importItem(item) }
        picked = []
      }
    }
  }

  /// Each file becomes an independent draft; one failure does not block siblings.
  private func importItem(_ item: PhotosPickerItem) async {
    let isVideo = item.supportedContentTypes.contains { $0.conforms(to: .movie) }
    let isAudio = item.supportedContentTypes.contains { $0.conforms(to: .audio) }
    guard var data = try? await item.loadTransferable(type: Data.self) else { return }
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
        controller.message = "This audio format isn't supported yet."
        return
      }
    } else if isVideo {
      kind = .video
      contentType = type?.conforms(to: .mpeg4Movie) == true ? "video/mp4" : "video/quicktime"
    } else if let photo = PhotoImport.payload(data: data, type: type) {
      kind = .photo
      contentType = photo.contentType
      data = photo.data
    } else {
      controller.message = "This photo format isn't supported yet. Export it as JPEG and try again."
      return
    }
    let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    do {
      try data.write(to: url, options: .completeFileProtectionUntilFirstUserAuthentication)
      await controller.importFile(at: url, kind: kind, contentType: contentType)
    } catch {
      controller.message = "That file couldn't be added."
    }
  }
}
