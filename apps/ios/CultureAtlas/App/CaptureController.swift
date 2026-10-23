import AtlasCapture
import AVFoundation
import Foundation
import SwiftUI

/// App state for one signed-in account: capture, drafts, uploads, arming and
/// remote commands. Replaces Observer's AppModel without its relay, operator,
/// watch, monitor or continuous-observation responsibilities.
@MainActor
final class CaptureController: ObservableObject {
  enum Phase: Equatable {
    case signedOut
    case awaitingEmail(String)
    case signedIn(UUID)
  }

  @Published private(set) var phase: Phase = .signedOut
  @Published private(set) var drafts: [DraftRecord] = []
  @Published private(set) var lockedDraftsExist = false
  @Published private(set) var capabilities: Capabilities?
  @Published private(set) var armed: RemoteArming.Armed?
  @Published var message: String?
  @Published var rootTab: RootTab = .feed
  @Published var openCamera = false
  @Published var openMusic = false
  @Published var openGlasses = false
  @Published var openFeedDetail = false
  @Published private(set) var recordingDraftID: UUID?

  enum RootTab: Hashable {
    case feed, capture, library, settings
  }

  let api: AtlasAPI
  let accounts: AccountService
  let sessions: SessionStore
  let identities: InstallationIdentityStore
  let draftStore: DraftStore
  let uploads: UploadCoordinator
  let transfer: BackgroundTransfer
  let receipts: ReceiptStore
  let wearables: WearablesAdapter
  /// Created on first camera use so Music Mode never initializes a capture session.
  lazy var camera = PhoneCamera()
  let music = MusicCapture()
  /// Music Mode Explore: start analysis after the audio draft commits.
  var afterCommittedExplore: ((DraftRecord) async -> Void)?
  private var finishingExplores = false
  let arming: RemoteArming
  private(set) var commands: RemoteCommandRunner!
  private var recordingCommandID: UUID?
  private var armTimer: Task<Void, Never>?
  /// Runs while the session is still valid (clears the push token).
  var beforeSignOut: (@MainActor () async -> Void)?

  init(
    api: AtlasAPI, accounts: AccountService, sessions: SessionStore, identities: InstallationIdentityStore,
    drafts: DraftStore, uploads: UploadCoordinator, transfer: BackgroundTransfer, receipts: ReceiptStore,
    wearables: WearablesAdapter
  ) {
    self.api = api
    self.accounts = accounts
    self.sessions = sessions
    self.identities = identities
    self.draftStore = drafts
    self.uploads = uploads
    self.transfer = transfer
    self.receipts = receipts
    self.wearables = wearables
    self.arming = RemoteArming(api: api, identities: identities) {
      await MainActor.run {
        let cameraOK = PhoneCamera.cameraAuthorized
        let readiness: DeviceReadiness = cameraOK ? .ready : .userActionRequired
        return (caps: ["photo": cameraOK, "video": cameraOK, "microphone": MusicCapture.microphoneAuthorized], readiness: readiness)
      }
    }
    self.commands = RemoteCommandRunner(api: api, receipts: receipts, executor: CommandBridge(controller: self))
  }

  var signedInAccount: UUID? {
    if case .signedIn(let account) = phase { return account }
    return nil
  }

  // MARK: Launch / sign-in

  func launch() async {
    await uploads.start { [weak self] _ in Task { @MainActor in self?.reloadDrafts() } }
    if let account = await sessions.currentAccountID {
      await becomeSignedIn(account)
    } else {
      lockedDraftsExist = draftStore.hasLockedDrafts(otherThan: nil)
    }
  }

  func sendLink(email: String) async {
    do {
      try await accounts.startSignIn(email: email)
      phase = .awaitingEmail(email)
      message = "Check your email for a sign-in link. Open it on this phone."
    } catch {
      message = "We couldn't send the link. Check your connection and try again."
    }
  }

  func handle(url: URL) async {
    if await wearables.handleURL(url) { return }
    if url.scheme == "cultureatlas" {
      switch url.host {
      case "feed":
        rootTab = .feed
        openFeedDetail = url.path.lowercased().contains("detail")
        return
      case "library":
        rootTab = .library
        return
      case "settings":
        rootTab = .settings
        openGlasses = url.path.lowercased().contains("glasses")
        return
      case "capture":
        rootTab = .capture
        openCamera = url.path.lowercased().contains("camera")
        openMusic = url.path.lowercased().contains("music")
        openGlasses = url.path.lowercased().contains("glasses")
        return
      default:
        break
      }
    }
    guard AccountService.parseCallback(url) != nil else { return }
    do {
      let account = try await accounts.completeSignIn(callback: url)
      await becomeSignedIn(account)
    } catch {
      message = "That sign-in link didn't work. Request a new one."
    }
  }

  private func becomeSignedIn(_ account: UUID) async {
    phase = .signedIn(account)
    await uploads.setSignedInAccount(account)
    // Drafts that wait for this account (and only this account) resume.
    await uploads.unlockAll(owner: account)
    reloadDrafts()
    capabilities = try? await api.capabilities()
    await arming.setAppState(.foreground)
    await commands.reconcileAfterLaunch(account: account)
    recoverInterruptedRecordings(account)
  }

  func reloadDrafts() {
    guard let account = signedInAccount else {
      drafts = []
      lockedDraftsExist = draftStore.hasLockedDrafts(otherThan: nil)
      return
    }
    drafts = draftStore.drafts(owner: account)
    lockedDraftsExist = draftStore.hasLockedDrafts(otherThan: account)
    let pending = drafts.filter { $0.exploreAfterUpload == true && $0.status == .committed && $0.assetID != nil }
    if !pending.isEmpty, !finishingExplores {
      Task { await finishExplores(pending) }
    }
  }

  func finishExplores(_ pending: [DraftRecord]) async {
    guard let account = signedInAccount else { return }
    finishingExplores = true
    defer { finishingExplores = false }
    for draft in pending {
      _ = try? draftStore.update(draft.id, owner: account) { $0.exploreAfterUpload = false }
      await afterCommittedExplore?(draft)
    }
    drafts = draftStore.drafts(owner: account)
  }

  // MARK: Sign-out / switch (DraftLockPolicy.signOutOrder)

  enum LocalDraftChoice { case keep, delete }

  func signOut(drafts choice: LocalDraftChoice) async {
    guard let account = signedInAccount else { return }
    camera.stopRecording()
    wearables.stopClip()
    music.stop()
    camera.stop()
    wearables.endSession()
    armTimer?.cancel()
    await arming.shutdown()
    armed = nil
    await commands.stop()
    await uploads.lockAll(owner: account)
    if choice == .delete { draftStore.deleteAll(owner: account) }
    await beforeSignOut?()
    await accounts.signOut()
    await uploads.setSignedInAccount(nil)
    phase = .signedOut
    reloadDrafts()
  }

  // MARK: Local capture

  func capturePhoto(source: MediaSource) async -> DraftRecord? {
    guard let account = signedInAccount else { return nil }
    guard draftStore.hasRoom(forBytes: 20_000_000) else {
      message = PhoneCamera.CameraError.storageFull.errorDescription
      return nil
    }
    do {
      let data = source == .metaGlasses ? try await wearables.capturePhoto() : try await camera.capturePhoto()
      return try saveDraft(data: data, owner: account, kind: .photo, source: source, contentType: "image/jpeg")
    } catch {
      message = (error as? LocalizedError)?.errorDescription ?? "The photo wasn't saved. Try again."
      return nil
    }
  }

  func saveDraft(
    data: Data, owner: UUID, kind: MediaKind, source: MediaSource, contentType: String, captureID: UUID? = nil
  ) throws -> DraftRecord {
    var draft = DraftRecord.new(owner: owner, kind: kind, source: source, contentType: contentType, capturedAt: Date(), commandCaptureID: captureID)
    try draftStore.save(draft)
    let plain = draftStore.draftDirectory(draft).appendingPathComponent("capture.tmp")
    try data.write(to: plain, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    try draftStore.ingest(plaintext: plain, into: &draft)
    reloadDrafts()
    return draft
  }

  /// Bounded clip from the phone or glasses. The draft exists (and its
  /// recording path is known) before the first frame, so a crash is recoverable.
  func recordClip(source: MediaSource, captureID: UUID? = nil, maxSeconds: Int = AtlasContract.clipMaxSeconds) async -> (DraftRecord?, CommandProcessor.Outcome) {
    guard let account = signedInAccount else { return (nil, .deviceUnavailable) }
    guard draftStore.hasRoom(forBytes: 300_000_000) else {
      message = PhoneCamera.CameraError.storageFull.errorDescription
      return (nil, .storageFull)
    }
    let contentType = source == .metaGlasses ? "video/mp4" : "video/quicktime"
    var draft = DraftRecord.new(owner: account, kind: .video, source: source, contentType: contentType, capturedAt: Date(), commandCaptureID: captureID)
    do { try draftStore.save(draft) } catch { return (nil, .storageFull) }
    let url = draftStore.recordingURL(draft)
    recordingDraftID = draft.id
    defer { recordingDraftID = nil }
    do {
      let duration: Double
      let interrupted: Bool
      if source == .metaGlasses {
        let clip = try await wearables.recordClip(to: url, maxDuration: Double(maxSeconds))
        (duration, interrupted) = (clip.duration, clip.interrupted)
        draft.audioPresent = false  // Glasses audio is off by default and capability-gated.
      } else {
        let clip = try await camera.recordClip(to: url, maxSeconds: maxSeconds)
        (duration, interrupted) = (clip.duration, clip.interrupted)
        draft.audioPresent = clip.audioPresent
      }
      draft.durationSeconds = duration
      draft.interrupted = interrupted
      try draftStore.ingest(plaintext: url, into: &draft)
      reloadDrafts()
      return (draft, interrupted ? .interruptedWithFile : .saved)
    } catch PhoneCamera.CameraError.storageFull {
      try? draftStore.delete(draft)
      return (nil, .storageFull)
    } catch {
      try? draftStore.delete(draft)
      message = "The recording stopped before anything was saved."
      return (nil, .interruptedWithoutFile)
    }
  }

  func stopRecording() {
    camera.stopRecording()
    wearables.stopClip()
    music.stop()
  }

  /// Music Mode: audio-only capture. Never starts the camera.
  func recordAudio(route: AudioInputRoute) async -> DraftRecord? {
    guard let account = signedInAccount else { return nil }
    guard draftStore.hasRoom(forBytes: 40_000_000) else {
      message = MusicCapture.CaptureError.storageFull.errorDescription
      return nil
    }
    let source: MediaSource = route == .glassesMicrophone ? .glassesMicrophone : .phoneMicrophone
    var draft = DraftRecord.new(
      owner: account, kind: .audio, source: source, contentType: "audio/mp4", capturedAt: Date())
    draft.sourceRoute = route.rawValue
    draft.audioPresent = true
    do { try draftStore.save(draft) } catch {
      message = MusicCapture.CaptureError.storageFull.errorDescription
      return nil
    }
    let url = draftStore.recordingURL(draft)
    recordingDraftID = draft.id
    defer { recordingDraftID = nil }
    do {
      let result = try await music.record(to: url, route: route, maxSeconds: AtlasContract.audioMaxSeconds)
      draft.durationSeconds = result.duration
      draft.interrupted = result.interrupted
      draft.sourceRoute = result.inputRoute.rawValue
      draft.source = result.inputRoute == .glassesMicrophone ? .glassesMicrophone : .phoneMicrophone
      try draftStore.ingest(plaintext: url, into: &draft)
      reloadDrafts()
      return draft
    } catch {
      try? draftStore.delete(draft)
      message = (error as? LocalizedError)?.errorDescription ?? "Recording could not be saved."
      return nil
    }
  }

  /// After a crash mid-recording: a fragment-written file is kept as an
  /// interrupted clip; an empty one is removed. Never silently restarted.
  private func recoverInterruptedRecordings(_ account: UUID) {
    for draft in draftStore.drafts(owner: account) where (draft.kind == .video || draft.kind == .audio) && draft.byteSize == 0 {
      let url = draftStore.recordingURL(draft)
      let size = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int64) ?? 0
      if size > 0 {
        var recovered = draft
        recovered.interrupted = true
        try? draftStore.ingest(plaintext: url, into: &recovered)
      } else {
        try? draftStore.delete(draft)
      }
    }
    reloadDrafts()
  }

  // MARK: Review (Retake/Keep, Keep/Delete)

  func keep(_ draft: DraftRecord, allowCellular: Bool = false) async {
    guard let account = signedInAccount else { return }
    if draft.kind == .audio, !allowCellular, draft.status == .awaitingReview || draft.status == .keptLocal {
      _ = try? draftStore.update(draft.id, owner: account) { $0.status = .keptLocal }
      reloadDrafts()
      return
    }
    _ = try? draftStore.update(draft.id, owner: account) {
      $0.status = .queued
      $0.allowCellular = allowCellular
    }
    reloadDrafts()
    await uploads.drive(draft.id)
  }

  /// Explore music: keep WAV on `/v2/media/audio`, then start music_match.
  /// AAC drafts stay on the phone; Explore converts them because keep is WAV-only.
  func queueAudioExplore(_ draft: DraftRecord, startMS: Int, endMS: Int) async {
    guard let account = signedInAccount else { return }
    _ = try? draftStore.update(draft.id, owner: account) {
      $0.exploreAfterUpload = true
      $0.exploreStartMS = startMS
      $0.exploreEndMS = endMS
      if $0.status == .awaitingReview || $0.status == .keptLocal { $0.status = .queued }
    }
    reloadDrafts()
    if let latest = draftStore.drafts(owner: account).first(where: { $0.id == draft.id }),
      latest.status == .committed, latest.assetID != nil {
      await finishExplores([latest])
      return
    }
    do {
      let preview = try draftStore.openForPlayback(draft)
      defer { try? FileManager.default.removeItem(at: preview) }
      let wav = try AudioWav.pcmS16le(fromFile: preview)
      let kept = try await api.keepAudioRecording(
        KeepAudioRecordingRequest(
          clientCaptureID: draft.clientCaptureID, source: draft.source,
          filename: "music-mode.wav", contentType: "audio/wav",
          capturedAt: draft.capturedAt, captureSessionID: draft.captureSessionID,
          sourceRoute: draft.sourceRoute ?? AudioInputRoute.phoneMicrophone.rawValue),
        wav: wav, expectedAccount: account)
      guard let assetID = kept.resolvedAssetID else {
        message = "Exploring isn't available right now. Your recording is safe on this phone."
        return
      }
      _ = try? draftStore.update(draft.id, owner: account) {
        $0.status = .committed
        $0.assetID = assetID
      }
      reloadDrafts()
    } catch {
      message = "Exploring isn't available right now. Your recording is safe on this phone."
    }
  }

  func discard(_ draft: DraftRecord) async {
    await transfer.cancel(draftID: draft.id)
    try? draftStore.delete(draft)
    reloadDrafts()
  }

  func retry(_ draft: DraftRecord) async {
    guard let account = signedInAccount else { return }
    _ = try? draftStore.update(draft.id, owner: account) {
      $0.status = $0.uploadID == nil ? .queued : .uploading
      $0.attempts = 0
      $0.nextAttemptAt = nil
    }
    await uploads.drive(draft.id)
  }

  /// Imported photos/videos from the system picker become drafts too.
  func importFile(at url: URL, kind: MediaKind, contentType: String) async {
    guard let account = signedInAccount else { return }
    var draft = DraftRecord.new(owner: account, kind: kind, source: .upload, contentType: contentType, capturedAt: Date())
    draft.status = .queued
    do {
      try draftStore.save(draft)
      try draftStore.ingest(plaintext: url, into: &draft)
      reloadDrafts()
      await uploads.drive(draft.id)
    } catch {
      message = "That file couldn't be added."
    }
  }

  // MARK: Remote arming

  func arm(source: MediaSource, mode: MediaKind, minutes: Int, agents: [UUID]) async {
    do {
      let state = try await arming.arm(
        source: source, mode: mode, wearableConnectionID: nil, durationSeconds: minutes * 60, allowedAgents: agents)
      armed = state
      if let account = signedInAccount { await commands.start(account: account) }
      armTimer?.cancel()
      armTimer = Task { [weak self] in
        while !Task.isCancelled {
          try? await Task.sleep(nanoseconds: 1_000_000_000)
          guard let self, let armed = self.armed else { return }
          if armed.expiresAt <= Date() { await self.stopArming() }
        }
      }
    } catch {
      message = "This phone couldn't be armed. Open the camera, check permissions and try again."
    }
  }

  func stopArming() async {
    armTimer?.cancel()
    armed = nil
    await commands.stop()
    await arming.disarm()
  }

  func scenePhaseChanged(_ phase: ScenePhase) async {
    guard signedInAccount != nil else { return }
    switch phase {
    case .active:
      await arming.setAppState(.foreground)
      await uploads.resumeAll()
    case .background:
      // Backgrounding disarms (server and local); recording stops safely.
      stopRecording()
      armed = nil
      await commands.stop()
      await arming.setAppState(.background)
    default:
      break
    }
  }

  // MARK: Remote command execution

  func localCommandState() -> CommandLocalState {
    CommandLocalState(
      armedSessionID: armed?.sessionID, armedGeneration: armed?.generation, armExpiresAt: armed?.expiresAt,
      sessionMode: armed?.mode,
      sourceReady: armed?.source == .metaGlasses ? wearables.localState.stream == .streaming : camera.isRunning,
      recordingCommandID: recordingCommandID, storageOK: draftStore.hasRoom(forBytes: 300_000_000))
  }

  func remotePhoto(captureID: UUID, commandID: UUID, sessionID: UUID) async -> CommandProcessor.Outcome {
    guard let account = signedInAccount, let source = armed?.source else { return .deviceUnavailable }
    do {
      let data = source == .metaGlasses ? try await wearables.capturePhoto() : try await camera.capturePhoto()
      let draft = try saveDraft(data: data, owner: account, kind: .photo, source: source, contentType: "image/jpeg", captureID: captureID)
      // Remote captures were requested while armed: they upload after save.
      _ = try? draftStore.update(draft.id, owner: account) {
        $0.status = .queued
        $0.captureSessionID = sessionID
        $0.commandID = commandID
      }
      return .saved
    } catch {
      return .deviceUnavailable
    }
  }

  func remoteVideo(captureID: UUID, commandID: UUID, sessionID: UUID, seconds: Int) async -> CommandProcessor.Outcome {
    guard let source = armed?.source, let account = signedInAccount else { return .deviceUnavailable }
    recordingCommandID = commandID
    defer { recordingCommandID = nil }
    let (draft, outcome) = await recordClip(source: source, captureID: captureID, maxSeconds: seconds)
    if let draft {
      _ = try? draftStore.update(draft.id, owner: account) {
        $0.status = .queued
        $0.captureSessionID = sessionID
        $0.commandID = commandID
      }
    }
    return outcome
  }

  func remoteAssetID(captureID: UUID) async -> UUID? {
    guard let account = signedInAccount else { return nil }
    await uploads.drive(captureID)
    return draftStore.drafts(owner: account).first { $0.id == captureID }?.assetID
  }
}

/// Bridges the main-actor controller to the command runner.
struct CommandBridge: RemoteCaptureExecutor {
  weak var controller: CaptureController?

  @MainActor func localState() -> CommandLocalState {
    controller?.localCommandState()
      ?? CommandLocalState(armedSessionID: nil, armedGeneration: nil, armExpiresAt: nil, sessionMode: nil, sourceReady: false, recordingCommandID: nil, storageOK: false)
  }

  @MainActor func draftSaved(captureID: UUID) -> Bool {
    guard let controller, let account = controller.signedInAccount else { return false }
    return controller.draftStore.drafts(owner: account).contains { $0.id == captureID && $0.byteSize > 0 }
  }

  @MainActor func capturePhoto(captureID: UUID, commandID: UUID, sessionID: UUID) async -> CommandProcessor.Outcome {
    await controller?.remotePhoto(captureID: captureID, commandID: commandID, sessionID: sessionID) ?? .deviceUnavailable
  }

  @MainActor func startVideo(captureID: UUID, commandID: UUID, sessionID: UUID, durationSeconds: Int) async -> CommandProcessor.Outcome {
    await controller?.remoteVideo(captureID: captureID, commandID: commandID, sessionID: sessionID, seconds: durationSeconds) ?? .deviceUnavailable
  }

  @MainActor func stopVideo() async { controller?.stopRecording() }

  func resultAssetID(captureID: UUID) async -> UUID? {
    await controller?.remoteAssetID(captureID: captureID)
  }
}
