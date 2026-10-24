import AtlasCapture
import AVFoundation
import PhotosUI
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
  @State private var unavailable: PhoneCamera.CameraError?
  @State private var picked: [PhotosPickerItem] = []
  @State private var shutterFlash = false
  @State private var shots = 0

  var body: some View {
    Group {
      if let unavailable {
        unavailableState(unavailable)
          .transition(.opacity)
      } else {
        cameraBody
      }
    }
    .background(AtlasTheme.ivory.ignoresSafeArea())
    .navigationTitle("This camera")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar(.hidden, for: .tabBar)
    .task {
      do { try await camera.start() } catch {
        let cameraError = error as? PhoneCamera.CameraError
        if cameraError == .noDevice || cameraError == .permissionDenied || cameraError == .configurationFailed {
          withAnimation(AtlasMotion.fade) { unavailable = cameraError }
        } else {
          self.error = (error as? LocalizedError)?.errorDescription
        }
      }
    }
    .onDisappear { if !camera.isRecording { camera.stop() } }
    .sheet(item: $review) { draft in ReviewSheet(draft: draft) }
    .sheet(isPresented: $showArming) { RemoteArmSheet(source: .phoneCamera).tint(AtlasTheme.olive) }
    .onChange(of: picked) { _, items in
      guard !items.isEmpty else { return }
      Task {
        var added = 0
        for item in items {
          if await controller.importPicked(item) { added += 1 }
        }
        picked = []
        if added > 0 {
          controller.showFlash(Flash(text: added == 1 ? "Uploading to your library" : "Uploading \(added) files to your library",
                                     systemImage: "tray.and.arrow.down.fill"))
        }
      }
    }
  }

  /// No camera (simulator, restricted device) or no permission: a calm paper
  /// screen with a way forward instead of a blank preview.
  private func unavailableState(_ reason: PhoneCamera.CameraError) -> some View {
    VStack(spacing: 18) {
      Spacer()
      Image(systemName: reason == .permissionDenied ? "camera.badge.ellipsis" : "camera.metering.unknown")
        .font(.system(size: 54, weight: .light))
        .foregroundStyle(AtlasTheme.olive)
        .accessibilityHidden(true)
      Text(reason == .permissionDenied ? "Camera access is off" : "No camera here")
        .font(.system(.title2, design: .serif))
      Text(reason == .permissionDenied
        ? "Turn on camera access in Settings, or add photos and videos you already have."
        : "This phone can't use its camera right now. You can still add photos and videos you already have.")
        .multilineTextAlignment(.center)
        .foregroundStyle(AtlasTheme.muted)
        .padding(.horizontal, 12)
      PhotosPicker(selection: $picked, maxSelectionCount: 20, matching: .any(of: [.images, .videos])) {
        Label("Choose from Photos", systemImage: "photo.on.rectangle")
          .frame(maxWidth: .infinity, minHeight: 50)
      }
      .buttonStyle(.borderedProminent)
      .accessibilityIdentifier("camera.choose-photos")
      if reason == .permissionDenied {
        Button {
          if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
        } label: {
          Label("Open Settings", systemImage: "gear")
            .frame(maxWidth: .infinity, minHeight: 50)
        }
        .buttonStyle(.bordered)
      }
      Spacer()
      Spacer()
    }
    .padding(24)
  }

  private var cameraBody: some View {
    let allowed = CapabilityGate.phoneCamera(controller.capabilities)
    return VStack(spacing: 16) {
      ZStack(alignment: .top) {
        CameraPreview(session: camera.session)
          .aspectRatio(3 / 4, contentMode: .fit)
          .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
          .overlay {
            // Shutter blink: a quick white flash when a photo is taken.
            RoundedRectangle(cornerRadius: 22, style: .continuous)
              .fill(.white)
              .opacity(shutterFlash ? 0.85 : 0)
              .allowsHitTesting(false)
          }
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
      .disabled(camera.isRecording || !camera.isRunning)

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
        Button("Flip camera") { try? camera.flip() }.disabled(camera.isRecording || !camera.isRunning || saving)
        shutter
      }
      // Photo and video readings run as experimental: the label sits under the capture button.
      let analysis = CapabilityGate.photoAnalysis(controller.capabilities)
      if analysis.experimental {
        ExperimentalBadge(label: analysis.label ?? StyleCopy.experimentalBadge, note: analysis.note ?? StyleCopy.experimentalNote)
      }

      // Remote capture is off until allowed here, on this phone, with the camera open.
      if camera.isRunning {
        Toggle("Allow remote capture", isOn: Binding(get: { controller.armed != nil }, set: { on in
          if on { showArming = true } else { Task { await controller.stopArming() } }
        }))
      }
    }
    .padding(20)
    .sensoryFeedback(.impact(weight: .medium), trigger: shots)
  }

  @ViewBuilder private var shutter: some View {
    if mode == .photo {
      Button {
        Task {
          saving = true
          error = nil
          shots += 1
          withAnimation(.easeOut(duration: 0.05)) { shutterFlash = true }
          withAnimation(.easeIn(duration: 0.3).delay(0.08)) { shutterFlash = false }
          review = await controller.capturePhoto(source: .phoneCamera)
          saving = false
          if review == nil {
            // Report once: inline here, not also as an alert.
            error = controller.message ?? "The photo wasn't saved. Try again."
            controller.message = nil
          }
        }
      } label: {
        Text("Take photo").frame(minWidth: 140, minHeight: 44)
      }
      .buttonStyle(.borderedProminent)
      .accessibilityIdentifier("capture.take-photo")
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
        .accessibilityIdentifier("capture.keep")
      }
    }
    .padding(24)
    .presentationDetents([.medium])
    .presentationCornerRadius(24)
    .tint(AtlasTheme.olive)
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
