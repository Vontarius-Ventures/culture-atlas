import AtlasCapture
import SwiftUI

/// Local permission sheet: duration (max 10 minutes) and individually
/// selected agents. Nothing is preselected; arming needs this explicit tap.
struct RemoteArmSheet: View {
  @EnvironmentObject private var controller: CaptureController
  @Environment(\.dismiss) private var dismiss
  let source: MediaSource
  @State private var minutes = 10
  @State private var mode: MediaKind = .photo
  @State private var agents: [AgentConnectionList.Connection] = []
  @State private var selected: Set<UUID> = []
  @State private var loadFailed = false

  var body: some View {
    NavigationStack {
      Form {
        Section {
          Text("Request capture while I allow it").font(.headline)
          Text("Allow selected devices and agents to request capture for 10 minutes")
          Text("Capture also requires permission on your phone.").font(.footnote).foregroundStyle(AtlasTheme.muted)
        }
        Section("What can be requested") {
          Picker("Capture", selection: $mode) {
            Text("Photos").tag(MediaKind.photo)
            Text("Videos").tag(MediaKind.video)
          }
          Stepper("For \(minutes) minutes", value: $minutes, in: 1...10)
        }
        Section("Allowed agents") {
          if loadFailed {
            Text("Choose which agents can ask for capture in Settings → Agents on the web, then try again.")
              .font(.footnote)
          }
          ForEach(agents.filter { $0.scopes.contains("devices:command") }) { agent in
            Toggle(agent.clientName, isOn: Binding(
              get: { selected.contains(agent.id) },
              set: { on in if on { selected.insert(agent.id) } else { selected.remove(agent.id) } }))
          }
        }
      }
      .navigationTitle("Remote capture")
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
        ToolbarItem(placement: .confirmationAction) {
          Button("Allow") {
            Task {
              await controller.arm(source: source, mode: mode, minutes: minutes, agents: Array(selected))
              dismiss()
            }
          }
          .disabled(selected.isEmpty)
        }
      }
      .task {
        do { agents = try await controller.api.agentConnections().connections } catch { loadFailed = true }
      }
    }
  }
}

/// Always-visible local banner while armed: countdown and Stop.
struct RemoteArmBanner: View {
  @EnvironmentObject private var controller: CaptureController

  var body: some View {
    if let armed = controller.armed {
      TimelineView(.periodic(from: .now, by: 1)) { context in
        let left = max(0, Int(armed.expiresAt.timeIntervalSince(context.date)))
        HStack {
          Image(systemName: "dot.radiowaves.left.and.right").accessibilityHidden(true)
          Text("Remote capture allowed · \(ClipClock.clock(left)) left")
          Spacer()
          Button("Stop") { Task { await controller.stopArming() } }
            .buttonStyle(.borderedProminent)
        }
        .padding(12)
        .background(AtlasTheme.quiet)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Remote capture allowed, \(left) seconds left")
      }
    }
  }
}
