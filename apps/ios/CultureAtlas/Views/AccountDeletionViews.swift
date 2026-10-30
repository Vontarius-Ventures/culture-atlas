import AtlasCapture
import SwiftUI

/// Settings → Delete account: the confirmation sheet (VAL-DELETE-001).
///
/// The server's own disclosure is shown before anything is asked — what the
/// acceptance revokes immediately, what the durable cleanup removes, and what
/// is actually retained (never described as immediate erasure). Cancel
/// changes nothing; confirming accepts through the owner bridge and hands
/// the honest status surface to `AccountDeletionModel`.
struct AccountDeletionConfirmSheet: View {
  @EnvironmentObject private var controller: CaptureController
  @EnvironmentObject private var deletion: AccountDeletionModel
  @Environment(\.dismiss) private var dismiss

  @State private var overview: AccountDeletionOverview?
  @State private var loadFailed = false
  @State private var busy = false
  @State private var error: String?
  @State private var confirmChoice = false

  private var pendingCount: Int {
    controller.drafts.filter { ![DraftRecord.Status.committed, .keptLocal, .awaitingReview].contains($0.status) }.count
  }

  var body: some View {
    NavigationStack {
      Group {
        if let overview {
          AccountDeletionDisclosureList(
            overview: overview,
            error: error,
            busy: busy,
            onConfirm: { confirmChoice = true })
        } else if loadFailed {
          DeletionLoadFailedState(onRetry: { Task { await load() } })
        } else {
          DeletionLoadingState()
        }
      }
      .navigationTitle("Delete your account")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }
        }
      }
      .task { await load() }
    }
    .presentationDetents([.large])
    .confirmationDialog("Delete your account", isPresented: $confirmChoice, titleVisibility: .visible) {
      if pendingCount > 0 {
        Button("Delete account, keep local drafts", role: .destructive) { confirm(keepDrafts: true) }
        Button("Delete account and local drafts", role: .destructive) { confirm(keepDrafts: false) }
      } else {
        Button("Delete account", role: .destructive) { confirm(keepDrafts: true) }
      }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text(pendingCount == 0
        ? "This permanently deletes your account and everything in it. This cannot be undone."
        : "\(pendingCount) item(s) haven't finished uploading. Kept items stay encrypted on this phone, but they can never be uploaded once the account is deleted.")
    }
  }

  // MARK: Actions

  private func load() async {
    loadFailed = false
    do {
      overview = try await controller.api.accountDeletionOverview()
    } catch {
      loadFailed = true
    }
  }

  /// Accepts the deletion through the owner bridge, then signs this phone out
  /// (its authority is revoked by the acceptance itself). A request error is
  /// shown as an error here — never as an accepted deletion.
  private func confirm(keepDrafts: Bool) {
    guard !busy else { return }
    busy = true
    error = nil
    Task {
      do {
        guard let account = controller.signedInAccount else { throw AtlasClientError.notSignedIn }
        let token = AccountService.randomURLSafe(bytes: 32)
        let response = try await controller.api.requestAccountDeletion(statusToken: token)
        deletion.accept(response, account: account)
        // The acceptance ended every server authority; the phone leaves its
        // signed-in surfaces and clears its private caches the same way a
        // sign-out does.
        await controller.signOut(drafts: keepDrafts ? .keep : .delete)
        dismiss()
      } catch let failure {
        error = Self.errorText(failure)
        busy = false
      }
    }
  }

  /// Honest error copy: nothing is phrased as success.
  static func errorText(_ error: Error) -> String {
    switch error {
    case AtlasClientError.notSignedIn:
      return "This phone is no longer signed in. Nothing was deleted."
    case let AtlasClientError.server(_, code, _, _, _):
      switch code {
      case "token_revoked":
        return "This phone's access to the account already ended. Nothing was accepted from here."
      case "account_mismatch":
        return "This phone is signed in to a different account. Nothing was deleted."
      default:
        return "The deletion request didn't go through. Your account is unchanged. Check your connection and try again."
      }
    default:
      return "The deletion request didn't go through. Your account is unchanged. Check your connection and try again."
    }
  }
}

/// "Loading what deletion does…" while the disclosure loads.
private struct DeletionLoadingState: View {
  var body: some View {
    HStack(spacing: 10) {
      ProgressView().controlSize(.small)
      Text("Loading what deletion does…")
        .font(.footnote)
        .foregroundStyle(AtlasTheme.muted)
    }
    .padding(.vertical, 8)
  }
}

/// The disclosure could not load: nothing is offered to confirm until it does.
private struct DeletionLoadFailedState: View {
  let onRetry: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("The explanation of what deletion removes could not load. Nothing has changed on your account.")
        .foregroundStyle(AtlasTheme.muted)
      Button("Try again", action: onRetry)
        .font(.callout.weight(.medium))
    }
    .padding(.vertical, 8)
  }
}

/// The server's disclosure as a list: the summary, the immediate revocation,
/// the durable cleanup and the real retention limits — plus the confirm row.
private struct AccountDeletionDisclosureList: View {
  let overview: AccountDeletionOverview
  let error: String?
  let busy: Bool
  let onConfirm: () -> Void

  var body: some View {
    List {
      // A deletion already accepted elsewhere: show its honest state instead.
      if overview.requested, let status = overview.status {
        Section {
          Label("Your account deletion is already accepted.", systemImage: "checkmark.seal")
          DeletionStateLine(state: status.state)
        } footer: {
          Text("This screen can no longer accept or change it.")
        }
      } else {
        Section {
          Text(overview.disclosure.summary)
            .font(.system(.body, design: .serif))
        }
        DeletionDisclosureSection(
          title: "What happens right away", lines: overview.disclosure.immediate, icon: "bolt.badge.clock",
          muted: false)
        DeletionDisclosureSection(
          title: "What is permanently deleted", lines: overview.disclosure.cleanupSteps, icon: "trash",
          muted: false)
        DeletionDisclosureSection(
          title: "What is kept, and why", lines: overview.disclosure.retained, icon: "lock.shield", muted: true)
        Section {
          if let error {
            Text(error)
              .font(.footnote)
              .foregroundStyle(.red)
          }
          Button(role: .destructive, action: onConfirm) {
            HStack(spacing: 8) {
              if busy { ProgressView().controlSize(.small) }
              Text(busy ? "Deleting…" : "Delete my account…")
            }
            .frame(maxWidth: .infinity, minHeight: 44)
          }
          .disabled(busy)
        } footer: {
          Text("This cannot be undone.")
        }
      }
    }
    .atlasListSurface()
  }
}

/// One disclosure list (immediate / cleanup / retained), with its own rows.
private struct DeletionDisclosureSection: View {
  let title: String
  let lines: [String]
  let icon: String
  let muted: Bool

  var body: some View {
    Section(title) {
      ForEach(lines, id: \.self) { line in
        Label(line, systemImage: icon)
          .font(.footnote)
          .foregroundStyle(muted ? AtlasTheme.muted : AtlasTheme.ink)
      }
    }
  }
}

/// One line of the server's own honest lifecycle copy.
private struct DeletionStateLine: View {
  let state: AccountDeletionStatus.State

  var body: some View {
    Text(text)
      .font(.footnote)
      .foregroundStyle(AtlasTheme.muted)
  }

  private var text: String {
    switch state {
    case .complete: return "All of your private data has been removed."
    case .failed: return "The cleanup hit a problem and will keep retrying automatically."
    case .purging: return "Cleanup is in progress."
    case .pending: return "Cleanup is queued. We are still removing your private data."
    }
  }
}

/// The full-screen status surface after acceptance (VAL-DELETE-001/004): the
/// server's honest lifecycle — revoked credentials, the cleanup steps that
/// finished, what is still owed and what is retained — refreshed by
/// `AccountDeletionModel` until the server claims completion.
struct AccountDeletionStatusScreen: View {
  @EnvironmentObject private var deletion: AccountDeletionModel

  var body: some View {
    if case .accepted(let status, let disclosure) = deletion.phase {
      List {
        DeletionStateSection(status: status, refreshing: deletion.refreshing, refreshFailed: deletion.refreshFailed)
        DeletionDisclosureSection(
          title: "What already happened", lines: disclosure.immediate, icon: "checkmark", muted: false)
        DeletionCleanupSection(status: status, disclosure: disclosure)
        DeletionDisclosureSection(
          title: "What is kept, and why", lines: disclosure.retained, icon: "lock.shield", muted: true)
        DeletionDoneSection(complete: status.state == .complete)
      }
      .atlasListSurface()
      .navigationTitle("Account deleted")
      .navigationBarTitleDisplayMode(.inline)
      .refreshable { await deletion.refresh() }
    }
  }
}

/// The headline state: deleted, with the honest cleanup line and a retry when
/// the latest status check could not reach the server.
private struct DeletionStateSection: View {
  @EnvironmentObject private var deletion: AccountDeletionModel
  let status: AccountDeletionStatus
  let refreshing: Bool
  let refreshFailed: Bool

  var body: some View {
    Section {
      Label("Your account is deleted", systemImage: "checkmark.seal")
        .font(.system(.title3, design: .serif).weight(.semibold))
        .accessibilityIdentifier("deletion.state")
      DeletionStateLine(state: status.state)
      if refreshFailed {
        VStack(alignment: .leading, spacing: 8) {
          Text("The latest status check didn't reach culture atlas. This is the last status we had.")
            .font(.footnote)
            .foregroundStyle(AtlasTheme.muted)
          Button("Try again") { Task { await deletion.refresh() } }
            .font(.callout.weight(.medium))
        }
      }
    }
  }
}

/// The cleanup steps with their honest done/owed state.
private struct DeletionCleanupSection: View {
  let status: AccountDeletionStatus
  let disclosure: AccountDeletionDisclosure

  private struct Step: Identifiable {
    let id = UUID()
    let text: String
    let done: Bool
  }

  var body: some View {
    Section("Cleanup") {
      ForEach(steps) { step in
        HStack(alignment: .top, spacing: 10) {
          Image(systemName: step.done ? "checkmark.circle.fill" : "ellipsis.circle")
            .foregroundStyle(step.done ? AtlasTheme.olive : AtlasTheme.muted)
            .accessibilityHidden(true)
          Text(step.text)
            .font(.footnote)
        }
        .accessibilityLabel("\(step.done ? "Done" : "In progress"): \(step.text)")
      }
    }
  }

  /// The status reports step ids in run order; the disclosure lists the same
  /// steps, in the same order, as their human labels — so the first
  /// `completed.count` labels are done. If the shapes ever disagree, generic
  /// step rows are shown rather than guessing which label is which.
  private var steps: [Step] {
    let doneCount = status.completedSteps.count
    let total = status.completedSteps.count + status.pendingSteps.count
    if disclosure.cleanupSteps.count == total, total > 0 {
      return disclosure.cleanupSteps.enumerated().map { index, text in
        Step(text: text, done: index < doneCount)
      }
    }
    return (0..<max(total, 0)).map { index in
      Step(text: "Cleanup step \(index + 1)", done: index < doneCount)
    }
  }
}

/// The dismissal row and its honest footnote.
private struct DeletionDoneSection: View {
  @EnvironmentObject private var deletion: AccountDeletionModel
  let complete: Bool

  var body: some View {
    Section {
      Button {
        deletion.dismiss()
      } label: {
        Text("Done")
          .frame(maxWidth: .infinity, minHeight: 44)
      }
      .buttonStyle(.bordered)
    } footer: {
      Text(complete
        ? "The server's durable cleanup finished. This record is now forgotten on this phone."
        : "The server's durable cleanup keeps running and retries on its own. This screen returns on the next launch until it finishes.")
    }
  }
}
