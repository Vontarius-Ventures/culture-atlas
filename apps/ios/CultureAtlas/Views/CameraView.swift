import AtlasCapture
import AVFoundation
import SwiftUI

/// Screen 03 (native camera): photo/video switch, explicit microphone state,
/// elapsed/limit with a countdown for the last 10 s, Stop, then a review step
/// (Retake/Keep for photos, Keep/Delete for videos) before any upload.
struct CameraView: View {
  @EnvironmentObject private var controller: CaptureController
  @ObservedObject private var camera = AppEnvironment.shared.controller.camera
  @State private var mode: MediaKind = .photo
  @State private var startedAt: Date?
  @State private var review: DraftRecord?
  @State private var saving = false
  @State private var error: String?
  @State private var showArming = false

  var body: some View {
    let allowed = CapabilityGate.phoneCamera(controller.capabilities)
    VStack(spacing: 16) {
      ZStack(alignment: .top) {
        CameraPreview(session: camera.session)
          .aspectRatio(3 / 4, contentMode: .fit)
          .accessibilityLabel("Camera preview")
        if let startedAt {
          TimelineView(.periodic(from: startedAt, by: 0.5)) { context in
            let display = ClipClock().display(elapsed: context.date.timeIntervalSince(startedAt))
            HStack {
              Image(systemName: "record.circle").accessibilityHidden(true)
              Text("Recording on this phone · \(display.elapsedText)")
              if let left = display.countdown { Text("\(left) s left").bold() }
            }
            .padding(8)
            .background(.thinMaterial, in: Capsule())
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(display.accessibilityText)
          }
          .padding(.top, 8)
        }
      }
      if let error { Text(error).foregroundStyle(.red).accessibilityAddTraits(.isStaticText) }
      if saving { Text("Saving on this phone…").accessibilityAddTraits(.updatesFrequently) }

      Picker("Mode", selection: $mode) {
        Text("Photo").tag(MediaKind.photo)
        Text("Video").tag(MediaKind.video).disabled(!allowed.video)
      }
      .pickerStyle(.segmented)
      .disabled(camera.isRecording)

      if mode == .video {
        Toggle(isOn: Binding(get: { camera.microphoneOn }, set: { on in Task { _ = await camera.setMicrophone(on) } })) {
          Label(camera.microphoneOn ? "Microphone on" : "Microphone off", systemImage: camera.microphoneOn ? "mic" : "mic.slash")
        }
        .disabled(camera.isRecording)
        if !camera.microphoneOn {
          Text("Video records without sound.").font(.footnote).foregroundStyle(AtlasTheme.muted)
        }
      }

      HStack(spacing: 24) {
        Button("Flip camera") { try? camera.flip() }.disabled(camera.isRecording)
        shutter
      }

      // Remote capture is off until allowed here, on this phone, with the camera open.
      Toggle("Allow remote capture", isOn: Binding(get: { controller.armed != nil }, set: { on in
        if on { showArming = true } else { Task { await controller.stopArming() } }
      }))
      .disabled(!camera.isRunning)
    }
    .padding(20)
    .navigationTitle("This camera")
    .toolbar(.hidden, for: .tabBar)
    .task {
      do { try await camera.start() } catch {
        self.error = (error as? LocalizedError)?.errorDescription
      }
    }
    .onDisappear { if !camera.isRecording { camera.stop() } }
    .sheet(item: $review) { draft in ReviewSheet(draft: draft) }
    .sheet(isPresented: $showArming) { RemoteArmSheet(source: .phoneCamera) }
  }

  @ViewBuilder private var shutter: some View {
    if mode == .photo {
      Button {
        Task {
          saving = true
          review = await controller.capturePhoto(source: .phoneCamera)
          saving = false
        }
      } label: {
        Text("Take photo").frame(minWidth: 140, minHeight: 44)
      }
      .buttonStyle(.borderedProminent)
      .disabled(!camera.isRunning || saving)
    } else if camera.isRecording {
      Button(role: .destructive) {
        controller.stopRecording()
      } label: {
        Text("Stop").frame(minWidth: 140, minHeight: 44)
      }
      .buttonStyle(.borderedProminent)
    } else {
      Button {
        Task {
          startedAt = Date()
          let (draft, _) = await controller.recordClip(source: .phoneCamera)
          startedAt = nil
          review = draft
        }
      } label: {
        Text("Record video").frame(minWidth: 140, minHeight: 44)
      }
      .buttonStyle(.borderedProminent)
      .disabled(!camera.isRunning)
    }
  }
}

/// Keep queues the draft for upload (auto-upload applies only after Keep).
struct ReviewSheet: View {
  @EnvironmentObject private var controller: CaptureController
  @Environment(\.dismiss) private var dismiss
  let draft: DraftRecord

  var body: some View {
    VStack(spacing: 16) {
      Text(keepTitle).font(.system(.title2, design: .serif))
      Text("Saved on this phone. Keeping it uploads it to your private library.")
        .foregroundStyle(AtlasTheme.muted)
      if draft.interrupted {
        Text("Recording was interrupted. The part before the interruption was kept.")
      }
      HStack {
        Button(draft.kind == .photo ? "Retake" : "Delete", role: .destructive) {
          Task {
            await controller.discard(draft)
            dismiss()
          }
        }
        Button("Keep") {
          Task {
            await controller.keep(draft)
            dismiss()
          }
        }
        .buttonStyle(.borderedProminent)
      }
    }
    .padding(24)
    .presentationDetents([.medium])
  }

  private var keepTitle: String {
    switch draft.kind {
    case .photo: return "Keep this photo?"
    case .video: return "Keep this video?"
    case .audio: return "Keep this recording?"
    }
  }
}

struct CameraPreview: UIViewRepresentable {
  let session: AVCaptureSession

  final class PreviewView: UIView {
    override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
    var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
  }

  func makeUIView(context: Context) -> PreviewView {
    let view = PreviewView()
    view.previewLayer.session = session
    view.previewLayer.videoGravity = .resizeAspectFill
    return view
  }

  func updateUIView(_ uiView: PreviewView, context: Context) {}
}
