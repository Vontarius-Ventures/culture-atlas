import AtlasCapture
import SwiftUI

struct SettingsView: View {
  @EnvironmentObject private var controller: CaptureController
  @State private var confirmSignOut = false
  @State private var deletionSheet = false
  @State private var agents: [AgentConnectionList.Connection] = []
  @State private var agentsState = AgentsState.loading

  private enum AgentsState { case loading, loaded, unavailable }

  private var pendingCount: Int {
    controller.drafts.filter { ![DraftRecord.Status.committed, .keptLocal, .awaitingReview].contains($0.status) }.count
  }

  private var version: String {
    let info = Bundle.main.infoDictionary ?? [:]
    return "\(info["CFBundleShortVersionString"] as? String ?? "1.0") (\(info["CFBundleVersion"] as? String ?? "1"))"
  }

  var body: some View {
    List {
      Section {
        HStack(spacing: 14) {
          Text(initial)
            .font(.system(.title2, design: .serif).weight(.semibold))
            .foregroundStyle(.white)
            .frame(width: 52, height: 52)
            .background(Circle().fill(AtlasTheme.olive))
            .accessibilityHidden(true)
          VStack(alignment: .leading, spacing: 2) {
            Text(controller.signedInEmail ?? "Signed in")
              .font(.system(.body, design: .serif).weight(.medium))
              .lineLimit(1)
              .truncationMode(.middle)
            Text("Your library and boards are private to this account.")
              .font(.caption)
              .foregroundStyle(AtlasTheme.muted)
          }
        }
        .padding(.vertical, 4)
      }
      Section(OnboardingCopy.tasteTitle) {
        // Screen 18: picks grouped by category, add more, exclusions.
        NavigationLink {
          TasteSettingsView()
        } label: {
          Label(OnboardingCopy.tasteTitle, systemImage: "heart.text.square")
        }
      }
      Section {
        if agentsState == .loading {
          ProgressView()
        } else if agentsState == .unavailable {
          Text("Connected agents aren't reachable right now.")
            .font(.footnote)
            .foregroundStyle(AtlasTheme.muted)
        } else if agents.isEmpty {
          Text("No agents connected. Agents you connect on the web can ask this phone to capture only while you allow it.")
            .font(.footnote)
            .foregroundStyle(AtlasTheme.muted)
        } else {
          ForEach(agents) { agent in
            VStack(alignment: .leading, spacing: 2) {
              Label(agent.clientName, systemImage: "cpu")
              Text(agent.scopes.prefix(3).joined(separator: " · "))
                .font(.caption)
                .foregroundStyle(AtlasTheme.muted)
                .lineLimit(1)
            }
          }
        }
      } header: {
        Text("Connected agents")
      }
      Section("This phone") {
        NavigationLink {
          GlassesView()
        } label: {
          Label("Meta glasses (Experimental)", systemImage: "eyeglasses")
        }
        Label("Uploads use Wi-Fi unless you choose mobile data for an item.", systemImage: "wifi")
          .font(.footnote)
          .foregroundStyle(AtlasTheme.muted)
      }
      Section {
        Button(role: .destructive) {
          confirmSignOut = true
        } label: {
          Label("Sign out or switch account", systemImage: "rectangle.portrait.and.arrow.right")
        }
        // First-party deletion entry (VAL-DELETE-001): the sheet explains the
        // server's disclosure — private-data removal, authority revocation
        // and the real retention limits — before it asks to confirm.
        Button(role: .destructive) {
          deletionSheet = true
        } label: {
          Label("Delete account…", systemImage: "trash")
        }
      } footer: {
        Text("culture atlas \(version)")
          .frame(maxWidth: .infinity)
          .padding(.top, 12)
      }
    }
    .atlasListSurface()
    .navigationTitle("Settings")
    .navigationDestination(isPresented: $controller.openGlasses) {
      GlassesView()
    }
    .task { await loadAgents() }
    .refreshable { await Task { await loadAgents() }.value }
    .sheet(isPresented: $deletionSheet) {
      AccountDeletionConfirmSheet()
    }
    .confirmationDialog("Sign out", isPresented: $confirmSignOut, titleVisibility: .visible) {
      Button("Keep on this device") { Task { await controller.signOut(drafts: .keep) } }
      Button("Delete local drafts", role: .destructive) { Task { await controller.signOut(drafts: .delete) } }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text(pendingCount == 0
        ? "Capture and remote access stop on this phone."
        : "\(pendingCount) item(s) haven't finished uploading. Kept items stay encrypted on this phone and only appear again after you sign back in to this account.")
    }
  }

  private var initial: String {
    String((controller.signedInEmail ?? "c").prefix(1)).uppercased()
  }

  private func loadAgents() async {
    do {
      agents = try await controller.api.agentConnections().connections
      agentsState = .loaded
    } catch where AtlasClientError.isCancellation(error) {
    } catch {
      agentsState = agents.isEmpty ? .unavailable : .loaded
    }
  }
}
