import AtlasCapture
import SwiftUI

/// Screens 04 (connect), 05 (ready) and 09 (unavailable) for the Experimental
/// Meta glasses path. State comes from `CapabilityGate`: server policy AND
/// local SDK state. A connected radio is never shown as Ready without camera
/// permission and a streaming preview; distribution blocks offer no reconnect.
struct GlassesView: View {
  @EnvironmentObject private var controller: CaptureController
  @State private var busy = false
  @State private var startedAt: Date?
  @State private var review: DraftRecord?
  @State private var showArming = false

  private var gate: CapabilityGate.Result {
    CapabilityGate.evaluate(
      buildIncludesSDK: controller.wearables.buildIncludesSDK,
      serverReasons: controller.capabilities?.availability["meta_glasses"]?.reasons ?? ["temporarily_disabled"],
      local: controller.wearables.localState)
  }

  var body: some View {
    let result = gate
    List {
      Section {
        HStack {
          Text("Meta glasses").font(.system(.title2, design: .serif))
          Text("Experimental").font(.caption).padding(.horizontal, 8).padding(.vertical, 2)
            .background(Capsule().fill(AtlasTheme.quiet))
        }
        Text(stateText(result.state)).accessibilityAddTraits(.updatesFrequently)
        DisclosureGroup("About Experimental") {
          Text("Glasses capture is tested on a limited set of devices and app releases. Some glasses models may not support every function. Your camera and uploads always work without glasses.")
            .font(.footnote)
        }
      }
      switch result.state {
      case .unavailable:
        Section {
          Text("Glasses capture is not enabled for this app release. Your camera and uploads are ready to use.")
          ForEach(result.reasons, id: \.self) { reason in
            Label(reasonText(reason), systemImage: "info.circle")
          }
          NavigationLink("Use this camera") { CameraView() }
        }
      case .notConnected, .disconnected, .error:
        Section {
          Button("Connect with Meta AI") { run { try await controller.wearables.startRegistration() } }
          if result.state == .disconnected {
            Text("Your glasses disconnected. Recordings in progress were saved up to the disconnection.")
              .font(.footnote)
          }
        }
      case .registering:
        Section { Text("Finish connecting in the Meta AI app, then return here.") }
      case .awaitingPermission:
        Section {
          Text("Connected glasses still need camera permission in Meta AI.")
          Button("Allow camera in Meta AI") { run { _ = try await controller.wearables.ensureCameraPermission() } }
        }
      case .connecting:
        Section {
          Text("Starting the glasses camera…")
          Button("Start preview") { controller.wearables.startSession() }
        }
      case .ready, .recording:
        Section {
          if let image = controller.wearables.preview.image {
            Image(uiImage: image).resizable().scaledToFit().accessibilityLabel("Glasses preview")
          }
          Text("Audio is off for glasses capture.").font(.footnote).foregroundStyle(AtlasTheme.muted)
          Button("Take test photo") {
            run { review = await controller.capturePhoto(source: .metaGlasses) }
          }
          .disabled(!result.allowCapture || controller.wearables.isRecording)
          if controller.wearables.isRecording {
            Button("Stop", role: .destructive) { controller.stopRecording() }
          } else {
            Button("Record video") {
              run {
                startedAt = Date()
                let (draft, _) = await controller.recordClip(source: .metaGlasses)
                startedAt = nil
                review = draft
              }
            }
          }
          if let startedAt {
            TimelineView(.periodic(from: startedAt, by: 0.5)) { context in
              let display = ClipClock().display(elapsed: context.date.timeIntervalSince(startedAt))
              Text("Recording on this phone · \(display.elapsedText)").accessibilityLabel(display.accessibilityText)
            }
          }
        }
        Section {
          Toggle("Allow remote capture", isOn: Binding(get: { controller.armed != nil }, set: { on in
            if on { showArming = true } else { Task { await controller.stopArming() } }
          }))
          Text("Allow selected devices and agents to request capture for 10 minutes").font(.footnote)
        }
        Section {
          Button("Disconnect glasses", role: .destructive) { run { await controller.wearables.unregister() } }
        }
      }
    }
    .navigationTitle("Meta glasses")
    .disabled(busy)
    .sheet(item: $review) { draft in ReviewSheet(draft: draft) }
    .sheet(isPresented: $showArming) { RemoteArmSheet(source: .metaGlasses) }
  }

  private func run(_ work: @escaping () async throws -> Void) {
    Task {
      busy = true
      defer { busy = false }
      do { try await work() } catch {
        controller.message = "That didn't work. Check that Meta AI is installed and your glasses are nearby, then try again."
      }
    }
  }

  private func stateText(_ state: CapabilityGate.GlassesState) -> String {
    switch state {
    case .unavailable: return "Unavailable"
    case .notConnected: return "Not connected"
    case .registering: return "Connecting with Meta AI"
    case .awaitingPermission: return "Waiting for camera permission"
    case .connecting: return "Connecting"
    case .ready: return "Ready"
    case .recording: return "Recording"
    case .disconnected: return "Disconnected"
    case .error: return "Needs attention: update the glasses software in Meta AI"
    }
  }

  /// Screen 09: each reason explained separately.
  private func reasonText(_ reason: String) -> String {
    switch reason {
    case "build_unsupported": return "This version of the app doesn't include glasses support."
    case "release_channel_ineligible": return "Glasses capture isn't permitted in this app release yet."
    case "rollout_unavailable": return "Glasses capture isn't available for your account yet."
    case "device_unsupported": return "This phone or glasses model isn't supported yet."
    case "temporarily_disabled": return "Glasses capture is temporarily turned off."
    default: return "Glasses capture is unavailable."
    }
  }
}
