import AtlasCapture
import SwiftUI
import UIKit

/// UIApplicationDelegate is main-actor isolated.
final class AppDelegate: NSObject, UIApplicationDelegate {
  func application(
    _ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    AppEnvironment.shared.notices.configure()
    return true
  }

  func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
    Task { @MainActor in await AppEnvironment.shared.notices.didRegister(deviceToken: deviceToken) }
  }

  func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
    // Ready notices then appear only while the app is open (in-app toast).
    NSLog("[atlas] remote notifications unavailable")
  }

  /// Silent wake-up (screen 17): the payload carries only an opaque reference.
  func application(
    _ application: UIApplication, didReceiveRemoteNotification userInfo: [AnyHashable: Any]
  ) async -> UIBackgroundFetchResult {
    await AppEnvironment.shared.notices.handleWake(ref: userInfo["ref"] as? String)
  }

  /// Background part transfers finished while the app was suspended or not running.
  func application(
    _ application: UIApplication, handleEventsForBackgroundURLSession identifier: String,
    completionHandler: @escaping () -> Void
  ) {
    Task { @MainActor in
      AppEnvironment.shared.transfer.setBackgroundCompletionHandler(completionHandler, for: identifier)
    }
  }
}

@main
struct CultureAtlasApp: App {
  @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
  @StateObject private var controller = AppEnvironment.shared.controller
  @StateObject private var onboarding = AppEnvironment.shared.onboarding
  @StateObject private var notices = AppEnvironment.shared.notices
  @Environment(\.scenePhase) private var scenePhase

  var body: some Scene {
    WindowGroup {
      #if DEBUG
      if StyleFixture.isRequested {
        StyleFixtureScreen()
          .environmentObject(controller)
          .environmentObject(onboarding)
          .environmentObject(notices)
          .preferredColorScheme(.light)
      } else {
        app
      }
      #else
      app
      #endif
    }
  }

  private var app: some View {
    RootView()
      .environmentObject(controller)
      .environmentObject(onboarding)
      .environmentObject(notices)
      // Designed on warm paper only (Android uses lightColorScheme too):
      // pinning light keeps ink text on ivory in system dark mode.
      .preferredColorScheme(.light)
      .task {
        do {
          try await AppEnvironment.shared.prepareUITestSession()
          await controller.launch()
        } catch {
          controller.message = "Native UI fixture setup failed: \(error.localizedDescription)"
        }
      }
      // Email sign-in callback and Meta AI registration return both arrive here.
      .onOpenURL { url in Task { await controller.handle(url: url) } }
      .onChange(of: scenePhase) { _, phase in
        Task { await controller.scenePhaseChanged(phase) }
        if controller.signedInAccount != nil {
          if phase == .active { notices.sceneActive() } else if phase == .background { notices.sceneBackground() }
        }
      }
  }
}
