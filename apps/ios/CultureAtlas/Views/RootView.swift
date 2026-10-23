import AtlasCapture
import SwiftUI

struct RootView: View {
  @EnvironmentObject private var controller: CaptureController
  @EnvironmentObject private var onboarding: OnboardingController
  @EnvironmentObject private var notices: ReadyNoticeCenter
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  /// One value per top-level screen so changes between them crossfade.
  private var stage: String {
    switch controller.phase {
    case .signedOut, .awaitingEmail: return "signin"
    case .signedIn:
      switch onboarding.gate {
      case .checking: return "checking"
      case .onboarding: return "onboarding"
      case .building: return "building"
      case .retry: return "retry"
      case .done: return "tabs"
      }
    }
  }

  var body: some View {
    ZStack {
      switch controller.phase {
      case .signedOut, .awaitingEmail:
        SignInView()
          .transition(.opacity)
      case .signedIn:
        switch onboarding.gate {
        case .checking:
          LaunchMark()
            .transition(.opacity)
        case .onboarding:
          // Screen 14: required after sign-up, no tab bar.
          OnboardingFlowView()
            .transition(.opacity)
        case .building:
          BuildingFeedView()
            .transition(.opacity)
        case .retry:
          OnboardingRetryView()
            .transition(.opacity)
        case .done:
          tabs
            .transition(.asymmetric(insertion: .opacity.combined(with: .scale(scale: 0.985)), removal: .opacity))
        }
      }
    }
    .animation(reduceMotion ? .easeInOut(duration: 0.2) : .easeInOut(duration: 0.45), value: stage)
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
    .overlay(alignment: .bottom) {
      VStack(spacing: 8) {
        if let flash = controller.flash {
          FlashBanner(flash: flash, onAction: controller.perform, onDismiss: controller.dismissFlash)
            .transition(.move(edge: .bottom).combined(with: .opacity))
            .sensoryFeedback(.success, trigger: flash.id)
        }
        ReadyToast()
      }
      .padding(.bottom, stage == "tabs" ? 60 : 16)
      .animation(AtlasMotion.spring, value: controller.flash)
    }
    .tint(AtlasTheme.olive)
    .sheet(item: $notices.presented) { route in
      NavigationStack {
        AnalysisResultView(route: route)
      }
      .presentationDragIndicator(.visible)
      .presentationCornerRadius(24)
      .tint(AtlasTheme.olive)
    }
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
    TabView(selection: tabSelection) {
      // The feed keeps its living pool: a reset pops its detail instead of
      // rebuilding the stack (FeedView observes stackResets[.feed]).
      NavigationStack { FeedView() }
        .tabItem { Label("Feed", systemImage: "sparkles.rectangle.stack") }
        .tag(CaptureController.RootTab.feed)
      NavigationStack { BoardsView() }
        .id(controller.stackResets[.boards, default: 0])
        .tabItem { Label("Boards", systemImage: "square.grid.2x2") }
        .tag(CaptureController.RootTab.boards)
      NavigationStack { CaptureSourceView() }
        .id(controller.stackResets[.capture, default: 0])
        .tabItem { Label("Capture", systemImage: "camera.aperture") }
        .tag(CaptureController.RootTab.capture)
      NavigationStack { LibraryView() }
        .id(controller.stackResets[.library, default: 0])
        .tabItem { Label("Library", systemImage: "photo.on.rectangle.angled") }
        .tag(CaptureController.RootTab.library)
      NavigationStack { SettingsView() }
        .id(controller.stackResets[.settings, default: 0])
        .tabItem { Label("Settings", systemImage: "gearshape") }
        .tag(CaptureController.RootTab.settings)
    }
    .sensoryFeedback(.selection, trigger: controller.rootTab)
    .safeAreaInset(edge: .top) {
      if controller.armed != nil { RemoteArmBanner() }
    }
  }

  /// Re-tapping the selected tab pops it back to its root.
  private var tabSelection: Binding<CaptureController.RootTab> {
    Binding(
      get: { controller.rootTab },
      set: { tab in
        if tab == controller.rootTab { controller.popToRoot(tab) }
        controller.rootTab = tab
      })
  }
}

/// Quiet brand mark while the account state loads (instead of a bare spinner).
private struct LaunchMark: View {
  @State private var breathe = false
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    VStack(spacing: 14) {
      Text("culture atlas")
        .font(.system(.largeTitle, design: .serif))
        .foregroundStyle(AtlasTheme.ink)
        .opacity(breathe ? 1 : 0.55)
      ProgressView().tint(AtlasTheme.olive)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(AtlasTheme.ivory.ignoresSafeArea())
    .onAppear {
      guard !reduceMotion else { return }
      withAnimation(.easeInOut(duration: 1.2).repeatForever(autoreverses: true)) { breathe = true }
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("Loading culture atlas")
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

/// The app is designed on warm paper (light only, like Android's
/// lightColorScheme); `CultureAtlasApp` pins the light appearance so text
/// never turns white on ivory.
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
  @FocusState private var emailFocused: Bool

  private var sentTo: String? {
    if case .awaitingEmail(let address) = controller.phase { return address }
    return nil
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 20) {
      Spacer(minLength: 24)
      Text("culture atlas").font(.system(.largeTitle, design: .serif))
      Text("Keep what catches your eye.").font(.system(.title3, design: .serif))
      ZStack(alignment: .topLeading) {
        if let sentTo {
          sentState(sentTo)
            .transition(.asymmetric(insertion: .move(edge: .trailing).combined(with: .opacity), removal: .opacity))
        } else {
          form
            .transition(.asymmetric(insertion: .move(edge: .leading).combined(with: .opacity), removal: .opacity))
        }
      }
      .animation(AtlasMotion.spring, value: sentTo)
      if controller.lockedDraftsExist {
        LockedDraftsNotice()
      }
      Spacer()
    }
    .padding(20)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(AtlasTheme.ivory.ignoresSafeArea())
    .contentShape(Rectangle())
    .onTapGesture { emailFocused = false }
  }

  private var form: some View {
    VStack(alignment: .leading, spacing: 16) {
      Text("Sign in with your email to capture and keep photos, videos and music in your private library.")
        .foregroundStyle(AtlasTheme.muted)
      TextField("Email address", text: $email)
        .textContentType(.emailAddress)
        .keyboardType(.emailAddress)
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .focused($emailFocused)
        .submitLabel(.send)
        .onSubmit(send)
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(.white.opacity(0.6)))
        .overlay(
          RoundedRectangle(cornerRadius: 12, style: .continuous)
            .stroke(emailFocused ? AtlasTheme.olive : AtlasTheme.line, lineWidth: emailFocused ? 2 : 1))
        .animation(AtlasMotion.fade, value: emailFocused)
      Button(action: send) {
        HStack(spacing: 8) {
          if sending { ProgressView().tint(.white) }
          Text(sending ? "Sending…" : "Email me a sign-in link")
        }
        .frame(maxWidth: .infinity, minHeight: 48)
      }
      .buttonStyle(.borderedProminent)
      .disabled(sending || !email.contains("@"))
    }
  }

  private func sentState(_ address: String) -> some View {
    VStack(alignment: .leading, spacing: 14) {
      Image(systemName: "envelope.badge")
        .font(.system(size: 40))
        .foregroundStyle(AtlasTheme.olive)
        .symbolEffect(.bounce, value: address)
        .accessibilityHidden(true)
      Text("Check your email").font(.system(.title2, design: .serif))
      Text("We sent a link to \(address) if it can sign in. Open it on this phone.")
        .foregroundStyle(AtlasTheme.muted)
        .accessibilityAddTraits(.updatesFrequently)
      #if DEBUG
      // Debug builds talk to a development server whose mailbox is a local
      // folder (IDENTITY_MAIL_FILE_DIR); nothing opens the link automatically.
      Text("Test build: the link is written to the development server's mailbox folder, not emailed. Open it on this phone, for example with xcrun simctl openurl.")
        .font(.footnote)
        .foregroundStyle(AtlasTheme.muted)
      #endif
      Button("Use a different email") {
        controller.useDifferentEmail()
        emailFocused = true
      }
      .font(.callout.weight(.semibold))
      .frame(minHeight: 44)
    }
    .sensoryFeedback(.success, trigger: address)
  }

  private func send() {
    let address = email.trimmingCharacters(in: .whitespaces)
    guard address.contains("@"), !sending else { return }
    emailFocused = false
    sending = true
    Task {
      await controller.sendLink(email: address)
      sending = false
    }
  }
}

/// Another account's drafts are never listed; this generic notice is all that shows.
struct LockedDraftsNotice: View {
  var body: some View {
    Label("Some captures on this phone belong to another account. Sign in to that account to see and upload them.", systemImage: "lock")
      .font(.footnote)
      .foregroundStyle(AtlasTheme.muted)
  }
}
