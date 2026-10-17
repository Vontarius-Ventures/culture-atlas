import AtlasCapture
import SwiftUI
import UIKit

final class AppDelegate: NSObject, UIApplicationDelegate {
  /// Background part transfers finished while the app was suspended or not running.
  func application(
    _ application: UIApplication, handleEventsForBackgroundURLSession identifier: String,
    completionHandler: @escaping () -> Void
  ) {
    Task { @MainActor in
      AppEnvironment.shared.transfer.backgroundCompletionHandlers[identifier] = completionHandler
    }
  }
}

@main
struct CultureAtlasApp: App {
  @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
  @StateObject private var controller = AppEnvironment.shared.controller
  @Environment(\.scenePhase) private var scenePhase

  var body: some Scene {
    WindowGroup {
      RootView()
        .environmentObject(controller)
        .task { await controller.launch() }
        // Email sign-in callback and Meta AI registration return both arrive here.
        .onOpenURL { url in Task { await controller.handle(url: url) } }
        .onChange(of: scenePhase) { _, phase in Task { await controller.scenePhaseChanged(phase) } }
    }
  }
}
