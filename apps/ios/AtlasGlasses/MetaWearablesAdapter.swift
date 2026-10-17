// Experimental Meta glasses adapter (Meta Wearables Device Access Toolkit).
//
// Ported from World Observer (WorldCompilerSensor/Wearables/MetaWearablesService.swift).
// Kept: registration hand-off to Meta AI, camera permission through the SDK,
// device-session lifecycle, preview, glasses-side pause recovery and stream
// revival (with the 2 s camera stop/start floor from DAT issue #231), photo
// capture with timeout, bounded clip recording, frame-stall telemetry.
// Removed: the continuous observation stream and rolling evidence segments,
// the live-broadcast frame tap, the operator "Glasses" summary row, the mock
// device toggle and every relay/operator assumption. Device-state telemetry
// is reduced to non-identifying states (no device name).
//
// Lives in the AtlasGlasses framework, which only the CultureAtlasExperimental
// app target links; the public app target never contains the SDK and uses
// `UnavailableWearables`. Server capability policy still decides whether
// capture is allowed.

#if ATLAS_META_DAT && canImport(MWDATCore)
import AtlasCapture
import AVFoundation
import CryptoKit
import MWDATCamera
import MWDATCore
import Observation
import os
import UIKit

public enum GlassesCaptureError: LocalizedError, Equatable {
  case glassesUnavailable(String)
  case captureInProgress
  case captureFailed(String)
  case timeout

  public var errorDescription: String? {
    switch self {
    case .glassesUnavailable(let reason): return "Glasses unavailable: \(reason)"
    case .captureInProgress: return "A capture is already in progress"
    case .captureFailed(let reason): return "Capture failed: \(reason)"
    case .timeout: return "Photo capture timed out"
    }
  }
}

@Observable
@MainActor
public final class MetaWearablesAdapter: WearablesAdapter {
  static let photoTimeout: Duration = .seconds(5)
  static let streamRevivalAttempts = 4
  static let streamRevivalDelay: Duration = .seconds(1)
  /// Stop/start floor for camera restarts, per DAT issue #231.
  static let cameraRestartFloor: Duration = .seconds(2)

  public let buildIncludesSDK = true
  public private(set) var registrationState: RegistrationState
  public private(set) var hasActiveDevice = false
  public private(set) var wasConnected = false
  public private(set) var sessionState: DeviceSessionState = .idle
  public private(set) var streamState: StreamState = .stopped
  public private(set) var cameraPermission: CapabilityGate.Permission = .unknown
  public private(set) var lastError: String?
  public private(set) var glassesAppUpdateRequired = false
  /// True between our registration hand-off and the SDK reporting a new state.
  public private(set) var registrationInFlight = false

  @ObservationIgnored public let preview = PreviewFrameStore()
  @ObservationIgnored let clipRecorder = ClipRecorder()
  @ObservationIgnored let frameDecoder = H265FrameDecoder()
  /// Non-identifying diagnostic events ("stream.paused", "session.started").
  @ObservationIgnored public var onEvent: ((String) -> Void)?

  @ObservationIgnored private let wearables: WearablesInterface
  @ObservationIgnored private let deviceSelector: AutoDeviceSelector
  @ObservationIgnored private var deviceSession: DeviceSession?
  @ObservationIgnored private let sessionTokens = ListenerTokenBag()
  @ObservationIgnored private let streamTokens = ListenerTokenBag()
  @ObservationIgnored private var monitorTasks: [Task<Void, Never>] = []
  @ObservationIgnored private var pendingPhoto: CheckedContinuation<Data, Error>?
  @ObservationIgnored private var photoTimeoutTask: Task<Void, Never>?
  @ObservationIgnored private var streamStopWasIntended = false
  @ObservationIgnored private var cameraHasStarted = false
  @ObservationIgnored private var streamRevival: Task<Void, Never>?
  @ObservationIgnored private var pauseRecovery: Task<Void, Never>?
  @ObservationIgnored private var restartingStream = false
  @ObservationIgnored private var lastFrameAt: Date?
  @ObservationIgnored private var frameStallLogged = false
  @ObservationIgnored private var camera: MWDATCamera.Camera?
  @ObservationIgnored private var activeDeviceReference: String?

  /// Call `Wearables.configure()` once at launch before creating the adapter.
  public static func configureSDK() throws { try Wearables.configure() }

  public init(wearables: WearablesInterface = Wearables.shared) {
    self.wearables = wearables
    self.registrationState = wearables.registrationState
    self.deviceSelector = AutoDeviceSelector(wearables: wearables)

    monitorTasks.append(Task { [weak self] in
      for await state in wearables.registrationStateStream() {
        self?.registrationState = state
        self?.registrationInFlight = false
        self?.onEvent?("meta.registration.\(state)")
      }
    })
    monitorTasks.append(Task { [weak self] in
      guard let selector = self?.deviceSelector else { return }
      for await deviceID in selector.activeDeviceStream() {
        guard let self else { return }
        let available = deviceID != nil
        if available != self.hasActiveDevice {
          self.onEvent?(available ? "device.available" : "device.unavailable")
        }
        self.hasActiveDevice = available
        self.activeDeviceReference = deviceID.map { String(describing: $0) }
        if available { self.wasConnected = true }
      }
    })
    monitorTasks.append(Task { [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(for: .seconds(1.5))
        self?.checkFrameStall()
      }
    })
  }

  // MARK: Derived state

  public var isRegistered: Bool { registrationState == .registered }
  public var isStreaming: Bool { streamState == .streaming }
  public var isRecording: Bool { clipRecorder.isRecording }
  public var hasSession: Bool {
    switch sessionState {
    case .starting, .started, .paused, .stopping: return true
    default: return false
    }
  }

  /// Local SDK state for `CapabilityGate`.
  public var localState: CapabilityGate.Local {
    let registration: CapabilityGate.Registration =
      registrationState == .registered ? .registered : registrationInFlight ? .registering : .unregistered
    let stream: CapabilityGate.Stream
    switch streamState {
    case .streaming: stream = .streaming
    case .paused: stream = .paused
    case .starting, .waitingForDevice: stream = .starting
    default: stream = .stopped
    }
    return CapabilityGate.Local(
      registration: registration, permission: cameraPermission, deviceAvailable: hasActiveDevice, stream: stream,
      recording: isRecording, wasConnected: wasConnected,
      error: glassesAppUpdateRequired ? "glasses_app_update_required" : nil)
  }

  var notReadyReason: String? {
    if !isRegistered { return "not registered with Meta AI" }
    if !hasActiveDevice { return "glasses not connected" }
    if !hasSession { return "no session" }
    switch streamState {
    case .streaming: return nil
    case .paused: return "preview paused (tap the glasses to resume)"
    default: return "preview not started"
    }
  }

  // MARK: Registration (per-user Meta AI hand-off; never a founder device)

  public func startRegistration() async throws {
    registrationInFlight = true
    do {
      try await wearables.startRegistration()
    } catch {
      registrationInFlight = false
      throw error
    }
  }

  /// Checks and, if needed, requests camera permission through Meta AI.
  public func ensureCameraPermission() async throws -> Bool {
    if try await wearables.checkPermissionStatus(.camera) == .granted {
      cameraPermission = .granted
      return true
    }
    onEvent?("meta.permission.requesting camera")
    let granted = try await wearables.requestPermission(.camera) == .granted
    cameraPermission = granted ? .granted : .denied
    return granted
  }

  public func unregister() async {
    endSession()
    do {
      try await wearables.startUnregistration()
    } catch {
      report(error.localizedDescription)
    }
  }

  /// Forwards only Meta AI's registration return URL to the SDK; resuming a
  /// pending registration is safe to repeat.
  public func handleURL(_ url: URL) async -> Bool {
    guard
      let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
      components.queryItems?.contains(where: { $0.name == "metaWearablesAction" }) == true
    else { return false }
    do {
      _ = try await wearables.handleUrl(url)
    } catch {
      report(error.localizedDescription)
    }
    return true
  }

  /// Opaque, non-reversible reference for `/v2/device/wearables`: the SDK's
  /// device identifier never leaves the phone and is not a cloud credential.
  public func sdkReference(installationPublicID: UUID) -> String? {
    guard let device = activeDeviceReference else { return nil }
    let material = "\(installationPublicID.uuidString.lowercased()):\(device)"
    return "sha256:" + SHA256.hash(data: Data(material.utf8)).map { String(format: "%02x", $0) }.joined()
  }

  // MARK: Session lifecycle

  public func startSession() {
    guard !hasSession else { return }
    do {
      let session = try wearables.createSession(deviceSelector: deviceSelector)
      deviceSession = session
      session.statePublisher.listen { [weak self] state in
        Task { @MainActor in self?.handleSessionState(state) }
      }.store(in: sessionTokens)
      session.errorPublisher.listen { [weak self] error in
        Task { @MainActor in
          guard let self else { return }
          self.report(error.localizedDescription)
          // The on-glasses DAT app must be updated through Meta AI; never hide it.
          if case .datAppOnTheGlassesUpdateRequired = error {
            self.glassesAppUpdateRequired = true
            self.onEvent?("meta.session.glasses_app_update_required")
          }
        }
      }.store(in: sessionTokens)
      sessionState = .starting
      onEvent?("session.start_requested")
      try session.start()
    } catch {
      report(error.localizedDescription)
      sessionTokens.clear()
      deviceSession = nil
      sessionState = .idle
    }
  }

  public func endSession() {
    guard let session = deviceSession else { return }
    streamStopWasIntended = true
    sessionState = .stopping
    session.stop()
  }

  private func handleSessionState(_ state: DeviceSessionState) {
    sessionState = state
    onEvent?("session.\(state.description)")
    switch state {
    case .started:
      if camera == nil { Task { await startPreview() } }
    case .stopped:
      streamStopWasIntended = true
      sessionTokens.clear()
      deviceSession = nil
      clearStream(reason: "session stopped")
    default:
      break
    }
  }

  // MARK: Preview

  public func startPreview() async {
    guard let session = deviceSession, session.state == .started else {
      report("Start a session before previewing.")
      return
    }
    guard camera == nil else { return }
    do {
      guard try await ensureCameraPermission() else {
        report("Camera permission denied in Meta AI")
        return
      }
    } catch {
      report(error.localizedDescription)
      return
    }
    guard camera == nil, session.state == .started else { return }
    // Observer's validated configuration: hvc1 at low resolution and 24 fps
    // leaves the adaptive-bitrate floor headroom so Bluetooth dips degrade
    // instead of pausing; no audio track on the glasses link.
    let config = StreamConfiguration(videoCodec: .hvc1, resolution: .low, frameRate: 24)
    do {
      guard let newCamera = try session.addCamera(config: config) else {
        report("Couldn't create the camera. Try again.")
        return
      }
      camera = newCamera
      streamStopWasIntended = false
      cameraHasStarted = false
      observe(newCamera)
      streamState = .starting
      onEvent?("stream.start_requested")
      newCamera.stream.start()
    } catch {
      camera = nil
      report(error.localizedDescription)
    }
  }

  public func stopPreview() {
    guard let activeCamera = camera else { return }
    streamStopWasIntended = true
    streamState = .stopping
    activeCamera.stop()
  }

  private func observe(_ camera: MWDATCamera.Camera) {
    camera.statePublisher.listen { [weak self] state in
      Task { @MainActor in
        guard let self else { return }
        switch state {
        case .started:
          self.cameraHasStarted = true
        case .stopped, .stopping:
          if self.cameraHasStarted, !self.streamStopWasIntended { self.reviveStream() }
        default:
          break
        }
      }
    }.store(in: streamTokens)

    let stream = camera.stream
    stream.statePublisher.listen { [weak self] state in
      Task { @MainActor in self?.handleStreamState(state) }
    }.store(in: streamTokens)

    let preview = self.preview
    let recorder = self.clipRecorder
    let decoder = self.frameDecoder
    stream.videoFramePublisher.listen { [weak self] frame in
      let sampleBuffer = frame.sampleBuffer
      // The recorder takes the compressed frame directly on the SDK thread.
      recorder.append(sampleBuffer)
      let image = decoder.decode(sampleBuffer)
      Task { @MainActor in
        if UIApplication.shared.applicationState != .background, let image {
          preview.image = image
          preview.latestFrameAt = Date()
        }
        self?.lastFrameAt = Date()
        self?.frameStallLogged = false
      }
    }.store(in: streamTokens)

    stream.errorPublisher.listen { [weak self] error in
      Task { @MainActor in self?.report(error.localizedDescription) }
    }.store(in: streamTokens)

    stream.photoDataPublisher.listen { [weak self] photo in
      let data = photo.data
      let isJPEG = photo.format == .jpeg
      Task { @MainActor in self?.handlePhoto(data: data, isJPEG: isJPEG) }
    }.store(in: streamTokens)
  }

  private func handleStreamState(_ state: StreamState) {
    streamState = state
    onEvent?("stream.\(state)")
    if state == .streaming {
      lastError = nil
      cameraHasStarted = true
      lastFrameAt = Date()
    }
    if state == .paused { handlePauseRecovery() }
    if state == .stopped {
      if streamStopWasIntended {
        if restartingStream {
          // Fresh-camera swap: drop this camera without ending in-flight work.
          restartingStream = false
          streamTokens.clear()
          camera = nil
          streamState = .stopped
          Task { [weak self] in
            try? await Task.sleep(for: Self.cameraRestartFloor)
            await self?.startPreview()
          }
        } else {
          clearStream(reason: "stream stopped")
        }
      } else {
        reviveStream()
      }
    }
  }

  /// Glasses-side pauses self-heal while recording: ask the paused stream to
  /// resume, then swap in a fresh camera (never the session).
  private func handlePauseRecovery() {
    guard pauseRecovery == nil, isRecording else { return }
    pauseRecovery = Task { [weak self] in
      defer { self?.pauseRecovery = nil }
      try? await Task.sleep(for: .seconds(2))
      guard let self, self.isRecording, self.hasSession, let camera = self.camera, camera.stream.state == .paused
      else { return }
      self.onEvent?("stream.pause.resume_attempt")
      camera.stream.start()
      try? await Task.sleep(for: .seconds(3))
      guard self.isRecording, self.hasSession, self.camera?.stream.state == .paused, !self.streamStopWasIntended
      else { return }
      self.onEvent?("stream.pause.camera_restart")
      self.restartingStream = true
      self.streamStopWasIntended = true
      self.camera?.stop()
    }
  }

  /// An unrequested stream stop is an interruption: retry a few times so a
  /// bounded recording survives a transient link drop.
  private func reviveStream() {
    guard streamRevival == nil, hasSession else { return }
    onEvent?("stream.revive.begin")
    streamRevival = Task { [weak self] in
      defer { self?.streamRevival = nil }
      for attempt in 1...Self.streamRevivalAttempts {
        guard let self, let camera = self.camera, self.hasSession, !self.streamStopWasIntended else { return }
        guard camera.stream.state == .stopped else {
          self.onEvent?("stream.revive.recovered")
          return
        }
        self.onEvent?("stream.revive.attempt\(attempt)")
        self.streamTokens.clear()
        self.observe(camera)
        camera.stream.start()
        try? await Task.sleep(for: Self.streamRevivalDelay)
        if Task.isCancelled { return }
      }
      guard let self, self.camera?.stream.state == .stopped, !self.streamStopWasIntended else { return }
      self.onEvent?("stream.revive.gave_up")
      self.clearStream(reason: "stream lost")
    }
  }

  /// A lost stream finalizes any recording with what was captured (marked
  /// interrupted); there is no silent restart.
  private func clearStream(reason: String) {
    streamTokens.clear()
    camera?.stop()
    camera = nil
    streamState = .stopped
    preview.image = nil
    preview.latestFrameAt = nil
    if pendingPhoto != nil { finishPhoto(.failure(GlassesCaptureError.captureFailed(reason))) }
    clipRecorder.cancel(reason: reason)
  }

  private func checkFrameStall() {
    guard streamState == .streaming, let lastFrameAt, !frameStallLogged else { return }
    if Date().timeIntervalSince(lastFrameAt) > 2 {
      frameStallLogged = true
      onEvent?("stream.frames.stalled")
    }
  }

  // MARK: Capture

  /// Bounded clip from the live stream, at most `maxDuration` seconds from the
  /// first written keyframe.
  public func recordClip(to url: URL, maxDuration: Double) async throws -> RecordedClip {
    if let reason = notReadyReason { throw GlassesCaptureError.glassesUnavailable(reason) }
    let recorder = clipRecorder
    return try await withCheckedThrowingContinuation { continuation in
      recorder.start(url: url, maxDuration: maxDuration) { result in
        continuation.resume(with: result)
      }
    }
  }

  public func stopClip() { clipRecorder.stop() }

  public func capturePhoto() async throws -> Data {
    if let reason = notReadyReason { throw GlassesCaptureError.glassesUnavailable(reason) }
    guard pendingPhoto == nil, let stream = camera?.stream else { throw GlassesCaptureError.captureInProgress }
    return try await withCheckedThrowingContinuation { continuation in
      pendingPhoto = continuation
      guard stream.capturePhoto(format: .jpeg) else {
        finishPhoto(.failure(GlassesCaptureError.captureFailed("the glasses did not start the capture")))
        return
      }
      photoTimeoutTask = Task { [weak self] in
        try? await Task.sleep(for: Self.photoTimeout)
        guard !Task.isCancelled else { return }
        self?.finishPhoto(.failure(GlassesCaptureError.timeout))
      }
    }
  }

  private func handlePhoto(data: Data, isJPEG: Bool) {
    guard pendingPhoto != nil else { return }
    if isJPEG {
      finishPhoto(.success(data))
    } else if let jpeg = UIImage(data: data)?.jpegData(compressionQuality: 0.9) {
      finishPhoto(.success(jpeg))
    } else {
      finishPhoto(.failure(GlassesCaptureError.captureFailed("unreadable photo data")))
    }
  }

  private func finishPhoto(_ result: Result<Data, Error>) {
    photoTimeoutTask?.cancel()
    photoTimeoutTask = nil
    guard let continuation = pendingPhoto else { return }
    pendingPhoto = nil
    continuation.resume(with: result)
  }

  private func report(_ message: String) {
    lastError = message
    onEvent?("error")
  }
}
#endif
