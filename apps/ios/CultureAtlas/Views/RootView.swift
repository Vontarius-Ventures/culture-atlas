import AtlasCapture
import SwiftUI

struct RootView: View {
  @EnvironmentObject private var controller: CaptureController
  @EnvironmentObject private var onboarding: OnboardingController
  @EnvironmentObject private var notices: ReadyNoticeCenter

  var body: some View {
    Group {
      switch controller.phase {
      case .signedOut, .awaitingEmail:
        SignInView()
      case .signedIn:
        switch onboarding.gate {
        case .checking:
          ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity).background(AtlasTheme.ivory.ignoresSafeArea())
        case .onboarding:
          // Screen 14: required after sign-up, no tab bar.
          OnboardingFlowView()
        case .building:
          BuildingFeedView()
        case .retry:
          OnboardingRetryView()
        case .done:
          tabs
        }
      }
    }
    .task(id: controller.phase) {
      if controller.signedInAccount != nil {
        await onboarding.evaluate()
        notices.signedIn()
      } else {
        onboarding.reset()
      }
    }
    .onChange(of: onboarding.sessionEnded) { _, ended in
      if ended { Task { await controller.signOut(drafts: .keep) } }
    }
    .overlay(alignment: .bottom) { ReadyToast().padding(.bottom, 56) }
    .tint(AtlasTheme.olive)
    .alert(
      "culture atlas",
      isPresented: Binding(get: { controller.message != nil }, set: { if !$0 { controller.message = nil } })
    ) {
      Button("OK", role: .cancel) {}
    } message: {
      Text(controller.message ?? "")
    }
  }

  private var tabs: some View {
    TabView(selection: $controller.rootTab) {
      NavigationStack { FeedView() }
        .tabItem { Label("Feed", systemImage: "square.stack.fill") }
        .tag(CaptureController.RootTab.feed)
      NavigationStack { CaptureSourceView() }
        .tabItem { Label("Capture", systemImage: "camera") }
        .tag(CaptureController.RootTab.capture)
      NavigationStack { LibraryView() }
        .tabItem { Label("Library", systemImage: "photo.on.rectangle") }
        .tag(CaptureController.RootTab.library)
      NavigationStack { SettingsView() }
        .tabItem { Label("Settings", systemImage: "gearshape") }
        .tag(CaptureController.RootTab.settings)
    }
    .safeAreaInset(edge: .top) {
      if controller.armed != nil { RemoteArmBanner() }
    }
  }
}

/// The questionnaire is required, so a failed state check offers Retry, never a skip.
struct OnboardingRetryView: View {
  @EnvironmentObject private var onboarding: OnboardingController

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      Text(OnboardingCopy.imagesTitle).font(.system(.title, design: .serif))
      Text("We couldn't reach culture atlas. Check your connection and try again.")
        .foregroundStyle(AtlasTheme.muted)
      Button {
        Task { await onboarding.evaluate() }
      } label: {
        Text("Try again").frame(maxWidth: .infinity, minHeight: 48)
      }
      .buttonStyle(.borderedProminent)
      Spacer()
    }
    .padding(16)
    .background(AtlasTheme.ivory.ignoresSafeArea())
  }
}

enum AtlasTheme {
  // specs/capture-platform-v2/design/tokens.css: --paper #f8f6f1, --ink #252823,
  // --muted #606459, --olive #566347, --quiet #eeeae2, --line #dcddd3.
  static let ivory = Color(red: 0xF8 / 255, green: 0xF6 / 255, blue: 0xF1 / 255)
  static let ink = Color(red: 0x25 / 255, green: 0x28 / 255, blue: 0x23 / 255)
  static let muted = Color(red: 0x60 / 255, green: 0x64 / 255, blue: 0x59 / 255)
  static let olive = Color(red: 0x56 / 255, green: 0x63 / 255, blue: 0x47 / 255)
  static let quiet = Color(red: 0xEE / 255, green: 0xEA / 255, blue: 0xE2 / 255)
  static let line = Color(red: 0xDC / 255, green: 0xDD / 255, blue: 0xD3 / 255)
}

struct SignInView: View {
  @EnvironmentObject private var controller: CaptureController
  @State private var email = ""
  @State private var sending = false

  var body: some View {
    VStack(alignment: .leading, spacing: 20) {
      Text("culture atlas").font(.system(.largeTitle, design: .serif))
      Text("Keep what catches your eye.").font(.system(.title3, design: .serif))
      Text("Sign in with your email to capture and keep photos, videos and music in your private library.")
        .foregroundStyle(.secondary)
      Text("This test build doesn't send email. After you tap, the sign-in link opens on this phone.")
        .font(.footnote)
        .foregroundStyle(AtlasTheme.muted)
      TextField("Email address", text: $email)
        .textContentType(.emailAddress)
        .keyboardType(.emailAddress)
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 10).stroke(.secondary))
      Button {
        sending = true
        Task {
          await controller.sendLink(email: email.trimmingCharacters(in: .whitespaces))
          sending = false
        }
      } label: {
        Text(sending ? "Sending…" : "Email me a sign-in link").frame(maxWidth: .infinity, minHeight: 44)
      }
      .buttonStyle(.borderedProminent)
      .disabled(sending || !email.contains("@"))
      if case .awaitingEmail(let address) = controller.phase {
        Text("We sent a link to \(address) if it can sign in. Open it on this phone.")
          .font(.callout)
          .accessibilityAddTraits(.updatesFrequently)
      }
      if controller.lockedDraftsExist {
        LockedDraftsNotice()
      }
      Spacer()
    }
    .padding(20)
    .background(AtlasTheme.ivory.ignoresSafeArea())
  }
}

/// Another account's drafts are never listed; this generic notice is all that shows.
struct LockedDraftsNotice: View {
  var body: some View {
    Label("Some captures on this phone belong to another account. Sign in to that account to see and upload them.", systemImage: "lock")
      .font(.footnote)
      .foregroundStyle(.secondary)
  }
}
