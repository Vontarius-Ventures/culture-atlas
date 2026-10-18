import AtlasCapture
import Foundation
import SwiftUI
import UIKit
import UserNotifications

/// Screen 17 on iOS: "Your photo is ready" with Open, for analyses the user
/// started from this phone ("Explore this photo" in the library).
///
/// - Pushes are silent APNs wake-ups that carry only an opaque reference
///   (`ReadyNoticePolicy.isValidWake`); nothing in them is shown or trusted.
///   On a wake the app asks the server about the analyses it watches and
///   posts a local notification for each one that completed.
/// - In the foreground the same check runs every few seconds and shows an
///   in-app toast instead of a system notification.
/// - Notification permission is asked when the user first explores a photo,
///   never at launch. The device token is registered with
///   PUT /v2/device/push-token and cleared before sign-out.
@MainActor
final class ReadyNoticeCenter: NSObject, ObservableObject {
  struct Toast: Equatable, Identifiable {
    let id: UUID
    let resultPath: String?
  }

  @Published private(set) var toast: Toast?
  @Published private(set) var exploring: Set<UUID> = []

  private let api: AtlasAPI
  private let sessions: SessionStore
  private let store: ReadyNoticeStore
  private var foregroundTask: Task<Void, Never>?
  private var presence: ReadyNoticePolicy.AppPresence = .foreground

  init(api: AtlasAPI, sessions: SessionStore, directory: URL) {
    self.api = api
    self.sessions = sessions
    self.store = ReadyNoticeStore(directory: directory)
    super.init()
  }

  // MARK: Registration

  func configure() {
    let center = UNUserNotificationCenter.current()
    center.delegate = self
    let open = UNNotificationAction(
      identifier: ReadyNoticePolicy.openAction, title: ReadyNoticeCopy.open, options: [.foreground])
    center.setNotificationCategories([
      UNNotificationCategory(
        identifier: ReadyNoticePolicy.notificationCategory, actions: [open], intentIdentifiers: [])
    ])
  }

  /// Silent pushes need no permission; the token is registered once signed in.
  func signedIn() {
    UIApplication.shared.registerForRemoteNotifications()
    sceneActive()
  }

  func didRegister(deviceToken: Data) async {
    let environment: PushTokenRequest.Environment =
      (Bundle.main.object(forInfoDictionaryKey: "AtlasPushEnvironment") as? String) == "sandbox" ? .sandbox : .production
    _ = try? await api.registerPushToken(
      PushTokenRequest(provider: .apns, token: ReadyNoticePolicy.apnsTokenHex(deviceToken), environment: environment))
  }

  /// Before sign-out: stop wake-ups for this phone and forget its watches.
  func signingOut() async {
    foregroundTask?.cancel()
    toast = nil
    exploring = []
    try? await api.clearPushToken()
    if let account = await sessions.currentAccountID { await store.clear(account: account) }
  }

  // MARK: Starting an analysis ("Explore this photo")

  func explore(assetID: UUID) async -> Bool {
    guard let account = await sessions.currentAccountID else { return false }
    exploring.insert(assetID)
    do {
      let media = try await api.media(assetID)
      let status = try await api.startAnalysis(mediaID: assetID, generation: media.generation)
      await store.watch(WatchedAnalysis(mediaID: assetID, analysisID: status.analysisID, startedAt: Date()), account: account)
      // Asked at the moment of use: the user just chose to explore a photo.
      _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])
      sceneActive()
      return true
    } catch {
      exploring.remove(assetID)
      return false
    }
  }

  // MARK: Checking watched analyses

  /// One pass over the watched analyses; returns whether anything changed.
  @discardableResult
  func check() async -> Bool {
    guard let account = await sessions.currentAccountID else { return false }
    var changed = false
    let now = Date()
    for watch in await store.watched(account: account) {
      let state: AnalysisState
      var resultPath: String?
      if watch.ageHours(now: now) >= ReadyNoticePolicy.expireAfterHours {
        state = .cancelled
      } else {
        guard let status = try? await api.analysis(mediaID: watch.mediaID, analysisID: watch.analysisID) else { continue }
        state = status.state
        resultPath = status.resultURL
      }
      let decision = ReadyNoticePolicy.decide(
        state: state, app: presence, watched: true, notified: watch.notified, ageHours: watch.ageHours(now: now))
      switch decision.notice {
      case .notification: await postNotification(for: watch, resultPath: resultPath)
      case .toast:
        toast = Toast(id: watch.analysisID, resultPath: resultPath)
        AccessibilityNotification.Announcement(ReadyNoticeCopy.title).post()
      case .none: break
      }
      if !decision.keepWatching {
        await store.stop(watch.analysisID, account: account)
        exploring.remove(watch.mediaID)
        changed = true
      }
    }
    return changed
  }

  private func postNotification(for watch: WatchedAnalysis, resultPath: String?) async {
    let content = UNMutableNotificationContent()
    content.title = ReadyNoticeCopy.title
    content.categoryIdentifier = ReadyNoticePolicy.notificationCategory
    content.sound = .default
    if let resultPath { content.userInfo = ["result_path": resultPath] }
    let request = UNNotificationRequest(
      identifier: watch.analysisID.uuidString.lowercased(), content: content, trigger: nil)
    try? await UNUserNotificationCenter.current().add(request)
  }

  /// A silent push arrived. Invalid payloads are ignored.
  func handleWake(ref: String?) async -> UIBackgroundFetchResult {
    guard let ref, ReadyNoticePolicy.isValidWake(["ref": ref]) else { return .noData }
    presence = UIApplication.shared.applicationState == .active ? .foreground : .background
    return await check() ? .newData : .noData
  }

  // MARK: App lifecycle

  func sceneActive() {
    presence = .foreground
    foregroundTask?.cancel()
    foregroundTask = Task { [weak self] in
      while !Task.isCancelled {
        guard let self else { return }
        await self.check()
        guard let account = await self.sessions.currentAccountID else { return }
        let remaining = await self.store.watched(account: account)
        if remaining.isEmpty { return }
        try? await Task.sleep(nanoseconds: UInt64(ReadyNoticePolicy.foregroundPollSeconds * 1_000_000_000))
      }
    }
  }

  func sceneBackground() {
    presence = .background
    foregroundTask?.cancel()
  }

  // MARK: Open / Dismiss

  func dismissToast() { toast = nil }

  func open(resultPath: String?) {
    toast = nil
    // The result page lives in the web app; the path comes from our own API.
    guard let resultPath, resultPath.hasPrefix("/"),
      let url = URL(string: resultPath, relativeTo: api.baseURL)?.absoluteURL
    else { return }
    UIApplication.shared.open(url)
  }
}

extension ReadyNoticeCenter: UNUserNotificationCenterDelegate {
  /// In the foreground the in-app toast is shown instead of a banner.
  nonisolated func userNotificationCenter(
    _ center: UNUserNotificationCenter, willPresent notification: UNNotification
  ) async -> UNNotificationPresentationOptions {
    []
  }

  nonisolated func userNotificationCenter(
    _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse
  ) async {
    let path = response.notification.request.content.userInfo["result_path"] as? String
    guard response.actionIdentifier == ReadyNoticePolicy.openAction
      || response.actionIdentifier == UNNotificationDefaultActionIdentifier
    else { return }
    await MainActor.run { self.open(resultPath: path) }
  }
}

/// Polite toast: "Your photo is ready" with Open and Dismiss.
struct ReadyToast: View {
  @EnvironmentObject private var notices: ReadyNoticeCenter

  var body: some View {
    if let toast = notices.toast {
      HStack(spacing: 12) {
        Text(ReadyNoticeCopy.title).font(.callout.weight(.medium))
        Spacer()
        Button(ReadyNoticeCopy.open) { notices.open(resultPath: toast.resultPath) }
          .buttonStyle(.borderedProminent)
        Button {
          notices.dismissToast()
        } label: {
          Image(systemName: "xmark").frame(minWidth: 44, minHeight: 44)
        }
        .accessibilityLabel(ReadyNoticeCopy.dismiss)
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 8)
      .background(RoundedRectangle(cornerRadius: 14).fill(AtlasTheme.ivory).shadow(radius: 4))
      .padding(.horizontal, 16)
      .accessibilityElement(children: .contain)
    }
  }
}
