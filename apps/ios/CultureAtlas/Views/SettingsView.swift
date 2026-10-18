import AtlasCapture
import SwiftUI

struct SettingsView: View {
  @EnvironmentObject private var controller: CaptureController
  @State private var confirmSignOut = false

  private var pendingCount: Int { controller.drafts.filter { $0.status != .committed }.count }

  var body: some View {
    List {
      Section("This phone") {
        NavigationLink("Meta glasses (Experimental)") { GlassesView() }
        Text("Uploads use Wi-Fi unless you choose mobile data for an item.")
          .font(.footnote).foregroundStyle(AtlasTheme.muted)
      }
      Section(OnboardingCopy.tasteTitle) {
        // Screen 18: picks grouped by category, add more, exclusions.
        NavigationLink(OnboardingCopy.tasteTitle) { TasteSettingsView() }
      }
      Section("Account") {
        Button("Sign out or switch account", role: .destructive) { confirmSignOut = true }
      }
    }
    .navigationTitle("Settings")
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
}
