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
    let title: String
    var mediaID: UUID? = nil
    var kind: MediaKind? = nil
  }

  /// A finished analysis to show natively (sheet over whatever tab is open).
  struct ResultRoute: Equatable, Identifiable {
    let mediaID: UUID
    let analysisID: UUID?
    let kind: MediaKind?
    /// Web path, used only as a last resort when the native result can't load.
    let webPath: String?
    var id: String { "\(mediaID)-\(analysisID?.uuidString ?? "latest")" }
  }

  @Published private(set) var toast: Toast?
  @Published private(set) var exploring: Set<UUID> = []
  @Published var presented: ResultRoute?

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

  // MARK: Last analysis per item (ids only; lets the library reopen a result)

  private static let lastAnalysisKey = "atlas.last-analysis"

  func rememberAnalysis(_ analysisID: UUID, for mediaID: UUID) {
    var map = UserDefaults.standard.dictionary(forKey: Self.lastAnalysisKey) as? [String: String] ?? [:]
    map[mediaID.uuidString.lowercased()] = analysisID.uuidString.lowercased()
    UserDefaults.standard.set(map, forKey: Self.lastAnalysisKey)
  }

  func lastAnalysis(for mediaID: UUID) -> UUID? {
    let map = UserDefaults.standard.dictionary(forKey: Self.lastAnalysisKey) as? [String: String]
    return map?[mediaID.uuidString.lowercased()].flatMap(UUID.init(uuidString:))
  }

  // MARK: Starting an analysis ("Explore this photo")

  func explore(assetID: UUID) async -> Bool {
    guard let account = await sessions.currentAccountID else { return false }
    exploring.insert(assetID)
    do {
      let media = try await api.media(assetID)
      let status = try await api.startAnalysis(mediaID: assetID, generation: media.generation)
      rememberAnalysis(status.analysisID, for: assetID)
      await store.watch(
        WatchedAnalysis(mediaID: assetID, analysisID: status.analysisID, startedAt: Date(), kind: .photo),
        account: account)
      // Asked at the moment of use: the user just chose to explore a photo.
      _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])
      sceneActive()
      return true
    } catch {
      exploring.remove(assetID)
      return false
    }
  }

  /// Screen 20: Explore music. Speech is never requested. `recognized` is the
  /// song the phone already recognized on-device, if any: a hint the server
  /// still grounds through its own catalog.
  func exploreMusic(
    assetID: UUID, startMS: Int, endMS: Int, recognized: ClientRecognizedSong? = nil
  ) async -> Bool {
    guard let account = await sessions.currentAccountID else { return false }
    exploring.insert(assetID)
    do {
      let media = try await api.media(assetID)
      let status = try await api.startMusicAnalysis(
        mediaID: assetID, generation: media.generation, startMS: startMS, endMS: endMS,
        recognized: recognized)
      rememberAnalysis(status.analysisID, for: assetID)
      await store.watch(
        WatchedAnalysis(mediaID: assetID, analysisID: status.analysisID, startedAt: Date(), kind: .audio),
        account: account)
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
      let title = watch.kind == .audio ? "Your music is ready" : ReadyNoticeCopy.title
      switch decision.notice {
      case .notification: await postNotification(for: watch, resultPath: resultPath, title: title)
      case .toast:
        withAnimation(AtlasMotion.spring) {
          toast = Toast(id: watch.analysisID, resultPath: resultPath, title: title, mediaID: watch.mediaID, kind: watch.kind)
        }
        AccessibilityNotification.Announcement(title).post()
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

  private func postNotification(for watch: WatchedAnalysis, resultPath: String?, title: String) async {
    let content = UNMutableNotificationContent()
    content.title = title
    content.categoryIdentifier = ReadyNoticePolicy.notificationCategory
    content.sound = .default
    var info: [String: String] = [
      "media_id": watch.mediaID.uuidString.lowercased(),
      "analysis_id": watch.analysisID.uuidString.lowercased(),
      "kind": (watch.kind ?? .photo).rawValue,
    ]
    if let resultPath { info["result_path"] = resultPath }
    content.userInfo = info
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

  func dismissToast() {
    withAnimation(AtlasMotion.spring) { toast = nil }
  }

  /// Opens the native result screen. The web page is only a fallback offered
  /// inside that screen (the phone's session is not a browser cookie).
  func open(_ toast: Toast) {
    dismissToast()
    guard let mediaID = toast.mediaID else {
      openWeb(path: toast.resultPath)
      return
    }
    presented = ResultRoute(mediaID: mediaID, analysisID: toast.id, kind: toast.kind, webPath: toast.resultPath)
  }

  func open(mediaID: UUID, analysisID: UUID?, kind: MediaKind?, webPath: String? = nil) {
    dismissToast()
    presented = ResultRoute(mediaID: mediaID, analysisID: analysisID, kind: kind, webPath: webPath)
  }

  /// Last resort: the web result page (photo results only; never an API path).
  func openWeb(path: String?) {
    guard let path, path.hasPrefix("/"), !path.hasPrefix("/v2/"),
      let url = URL(string: path, relativeTo: api.baseURL)?.absoluteURL
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
    let info = response.notification.request.content.userInfo
    let path = info["result_path"] as? String
    let mediaID = (info["media_id"] as? String).flatMap(UUID.init(uuidString:))
    let analysisID = (info["analysis_id"] as? String).flatMap(UUID.init(uuidString:))
    let kind = (info["kind"] as? String).flatMap(MediaKind.init(rawValue:))
    guard response.actionIdentifier == ReadyNoticePolicy.openAction
      || response.actionIdentifier == UNNotificationDefaultActionIdentifier
    else { return }
    await MainActor.run {
      if let mediaID {
        self.open(mediaID: mediaID, analysisID: analysisID, kind: kind, webPath: path)
      } else {
        self.openWeb(path: path)
      }
    }
  }
}

/// Polite toast: "Your photo is ready" with Open and Dismiss. Slides up from
/// the bottom and can be swiped away.
struct ReadyToast: View {
  @EnvironmentObject private var notices: ReadyNoticeCenter

  var body: some View {
    ZStack {
      if let toast = notices.toast {
        HStack(spacing: 12) {
          Image(systemName: toast.kind == .audio ? "music.note" : "sparkles")
            .font(.title3)
            .foregroundStyle(AtlasTheme.olive)
            .symbolEffect(.bounce, value: toast.id)
            .accessibilityHidden(true)
          Text(toast.title)
            .font(.system(.callout, design: .serif).weight(.semibold))
            .foregroundStyle(AtlasTheme.ink)
          Spacer()
          Button(ReadyNoticeCopy.open) { notices.open(toast) }
            .buttonStyle(.borderedProminent)
            .accessibilityIdentifier("ready.open")
          Button {
            notices.dismissToast()
          } label: {
            Image(systemName: "xmark").frame(minWidth: 44, minHeight: 44)
          }
          .foregroundStyle(AtlasTheme.muted)
          .accessibilityLabel(ReadyNoticeCopy.dismiss)
        }
        .padding(.leading, 16)
        .padding(.trailing, 8)
        .padding(.vertical, 6)
        .background(
          RoundedRectangle(cornerRadius: 18, style: .continuous)
            .fill(AtlasTheme.ivory)
            .shadow(color: .black.opacity(0.14), radius: 18, y: 8))
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(AtlasTheme.line))
        .padding(.horizontal, 16)
        .gesture(DragGesture(minimumDistance: 10).onEnded { value in
          if value.translation.height > 12 { notices.dismissToast() }
        })
        .transition(.move(edge: .bottom).combined(with: .opacity))
        .sensoryFeedback(.success, trigger: toast.id)
        .accessibilityElement(children: .contain)
      }
    }
    .animation(AtlasMotion.spring, value: notices.toast)
  }
}
