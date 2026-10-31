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
  @FocusState private var emailFocused: Bool

  private var requestedAddress: String? {
    if case .awaitingEmail(let address) = controller.phase { return address }
    return nil
  }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 24) {
        VStack(alignment: .leading, spacing: 12) {
          Text("culture atlas").font(.system(.largeTitle, design: .serif))
          Text("Keep what catches your eye.").font(.system(.title3, design: .serif))
        }
        .foregroundStyle(AtlasTheme.ink)

        if let address = requestedAddress {
          SignInRequestedState(address: address)
        } else {
          VStack(alignment: .leading, spacing: 16) {
            Text("Sign in with your email to capture and keep photos, videos and music in your private library.")
              .foregroundStyle(AtlasTheme.muted)
            TextField("Email address", text: $controller.signInEmail,
                      prompt: Text("Email address").foregroundStyle(AtlasTheme.muted))
              .foregroundStyle(AtlasTheme.ink)
              .textContentType(.emailAddress)
              .keyboardType(.emailAddress)
              .textInputAutocapitalization(.never)
              .autocorrectionDisabled()
              .focused($emailFocused)
              .submitLabel(.send)
              .onSubmit { send(controller.signInEmail) }
              .disabled(controller.signInSending)
              .padding(14)
              .background(.white.opacity(0.6), in: RoundedRectangle(cornerRadius: 12))
              .overlay(RoundedRectangle(cornerRadius: 12).stroke(emailFocused ? AtlasTheme.olive : AtlasTheme.line))
              .accessibilityIdentifier("signInEmail")
          }
        }

        if let error = controller.signInError {
          Label(error, systemImage: "exclamationmark.circle")
            .font(.callout)
            .foregroundStyle(AtlasTheme.ink)
            .fixedSize(horizontal: false, vertical: true)
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(AtlasTheme.quiet, in: RoundedRectangle(cornerRadius: 12))
            .accessibilityAddTraits(.updatesFrequently)
            .accessibilityIdentifier("signInError")
        }

        SignInRequestButton(
          sending: controller.signInSending,
          retryAt: controller.signInRetryAt,
          isResend: requestedAddress != nil,
          validAddress: SignInFeedback.isValidEmail(requestedAddress ?? controller.signInEmail)
        ) { send(requestedAddress ?? controller.signInEmail) }

        if requestedAddress != nil {
          Button("Use a different email") {
            controller.useDifferentEmail()
            emailFocused = true
          }
          .font(.callout.weight(.semibold))
          .foregroundStyle(AtlasTheme.olive)
          .frame(minHeight: 44)
          .disabled(controller.signInSending)
        }
        if controller.lockedDraftsExist { LockedDraftsNotice() }
      }
      .padding(20)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .scrollDismissesKeyboard(.interactively)
    .background(AtlasTheme.ivory.ignoresSafeArea())
  }

  private func send(_ address: String) {
    emailFocused = false
    Task { await controller.sendLink(email: address) }
  }
}

private struct SignInRequestedState: View {
  let address: String

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      Image(systemName: "envelope")
        .font(.title)
        .foregroundStyle(AtlasTheme.olive)
        .accessibilityHidden(true)
      Text("Check your email")
        .font(.system(.title2, design: .serif))
        .foregroundStyle(AtlasTheme.ink)
        .accessibilityAddTraits(.isHeader)
      Text("A sign-in link was requested for \(address). Check your inbox and spam folder, then open the latest link on this iPhone.")
        .foregroundStyle(AtlasTheme.muted)
      Text("If it hasn't arrived, you can request another link below.")
        .font(.footnote)
        .foregroundStyle(AtlasTheme.muted)
    }
    .fixedSize(horizontal: false, vertical: true)
    .accessibilityIdentifier("signInRequested")
  }
}

private struct SignInRequestButton: View {
  let sending: Bool
  let retryAt: Date
  let isResend: Bool
  let validAddress: Bool
  let send: () -> Void

  var body: some View {
    TimelineView(.periodic(from: .now, by: 1)) { context in
      let remaining = max(0, Int(ceil(retryAt.timeIntervalSince(context.date))))
      VStack(alignment: .leading, spacing: 8) {
        Button(action: send) {
          HStack(spacing: 8) {
            if sending { ProgressView().tint(.white) }
            if sending {
              Text("Requesting link…")
            } else if isResend {
              Text("Request another link")
            } else {
              Text("Email me a sign-in link")
            }
          }
          .frame(maxWidth: .infinity, minHeight: 48)
        }
        .buttonStyle(.borderedProminent)
        .disabled(sending || !validAddress || remaining > 0)
        .accessibilityIdentifier("signInRequest")
        if remaining > 0 {
          Text("You can request another link in \(remaining) seconds.")
            .font(.footnote)
            .foregroundStyle(AtlasTheme.muted)
        }
      }
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
