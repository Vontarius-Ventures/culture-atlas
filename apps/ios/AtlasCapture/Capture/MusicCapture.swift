#if os(iOS)
import AVFoundation

/// Music Mode microphone recorder (screens 19–20).
///
/// AUD01: camera permission can be denied and this flow still works. Capture
/// uses `AVAudioSession` + `AVAudioRecorder` only — no camera session, photo
/// output, or capture-device initialization. Microphone permission is
/// requested on Record, not at launch. Speech analysis stays off.
@MainActor
public final class MusicCapture: NSObject, ObservableObject {
  public enum CaptureError: LocalizedError, Equatable {
    case permissionDenied, noMicrophone, glassesUnavailable, routeMismatch, configurationFailed, busy, storageFull, nothingSaved

    public var errorDescription: String? {
      switch self {
      case .permissionDenied:
        return "Microphone access is off. Turn it on in Settings to record in Music Mode."
      case .noMicrophone:
        return "This phone's microphone is not available."
      case .glassesUnavailable:
        return "Glasses microphone unavailable. Choose this phone to record here."
      case .routeMismatch:
        return "The microphone changed. Recording stopped. The part before the change was kept."
      case .configurationFailed:
        return "The microphone could not start. Try again."
      case .busy:
        return "A recording is already in progress."
      case .storageFull:
        return "Your phone is out of space. Free some space to keep recording."
      case .nothingSaved:
        return "Recording could not be saved."
      }
    }
  }

  public struct RecordingResult: Sendable {
    public let url: URL
    public let duration: Double
    public let interrupted: Bool
    public let inputRoute: AudioInputRoute
  }

  /// AUD01 instrumentation: Music Mode never initializes a camera.
  public static let initializesCamera = false
  public static let usesCaptureSession = false
  public static let usesPhotoOutput = false
  public static let speechAnalysisEnabled = AudioRoutePolicy.speechAnalysisEnabled

  @Published public private(set) var isRecording = false
  @Published public private(set) var level: Float = 0
  @Published public private(set) var interruption: String?
  @Published public private(set) var options: [AudioRoutePolicy.Option] = AudioRoutePolicy.options(inputs: [])
  @Published public private(set) var activeRoute: AudioInputRoute?

  private var recorder: AVAudioRecorder?
  private var selectedRoute: AudioInputRoute?
  private var recordedRoute: AudioInputRoute?
  private var interrupted = false
  private var stopContinuation: CheckedContinuation<RecordingResult, Error>?
  private var meterTask: Task<Void, Never>?
  private var observers: [NSObjectProtocol] = []

  public override init() {
    super.init()
    let center = NotificationCenter.default
    observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
      let type = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
      MainActor.assumeIsolated {
        guard type == AVAudioSession.InterruptionType.began.rawValue else { return }
        self?.interruption = "interrupted"
        self?.interrupted = true
        self?.recorder?.stop()
      }
    })
    observers.append(center.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.routeChanged() }
    })
  }

  public static var microphoneAuthorized: Bool {
    AVAudioApplication.shared.recordPermission == .granted
  }

  /// Requested when the person taps Record, not at launch.
  public func requestMicrophoneAccess() async -> Bool {
    switch AVAudioApplication.shared.recordPermission {
    case .granted: return true
    case .undetermined: return await AVAudioApplication.requestRecordPermission()
    default: return false
    }
  }

  /// Activates the audio session so the route picker can list real inputs.
  /// Does not request microphone permission and does not start recording.
  public func refreshRoutes() {
    let session = AVAudioSession.sharedInstance()
    try? session.setCategory(.playAndRecord, mode: .default, options: Self.routePickerOptions)
    try? session.setActive(true)
    publishRoutes()
  }

  public func record(to url: URL, route: AudioInputRoute, maxSeconds: Int = AtlasContract.audioMaxSeconds) async throws -> RecordingResult {
    guard !isRecording, stopContinuation == nil else { throw CaptureError.busy }
    guard await requestMicrophoneAccess() else { throw CaptureError.permissionDenied }
    try configureSession(for: route)
    publishRoutes()
    guard AudioRoutePolicy.matches(expected: route, inputs: currentInputPorts()) else {
      throw route == .glassesMicrophone ? CaptureError.glassesUnavailable : CaptureError.routeMismatch
    }
    try? FileManager.default.removeItem(at: url)
    let recorder = try makeRecorder(url: url)
    recorder.delegate = self
    recorder.isMeteringEnabled = true
    guard recorder.record(forDuration: TimeInterval(maxSeconds)) else {
      // Device qualification aid: which input the session had when the recorder refused.
      let session = AVAudioSession.sharedInstance()
      NSLog(
        "[atlas] music record refused: inputs=%@ available=%d sampleRate=%.0f",
        session.currentRoute.inputs.map { "\($0.portType.rawValue)" }.joined(separator: ","),
        session.isInputAvailable ? 1 : 0, session.sampleRate)
      throw CaptureError.configurationFailed
    }
    self.recorder = recorder
    selectedRoute = route
    recordedRoute = route
    interrupted = false
    interruption = nil
    isRecording = true
    startMetering()
    return try await withCheckedThrowingContinuation { continuation in
      stopContinuation = continuation
    }
  }

  public func stop() {
    recorder?.stop()
  }

  /// iOS 17 has `.allowBluetooth`; iOS 18 renamed the HFP input option.
  private static var glassesInputOptions: AVAudioSession.CategoryOptions {
    if #available(iOS 18.0, *) { return [.allowBluetoothHFP] }
    return [.allowBluetooth]
  }

  private static var routePickerOptions: AVAudioSession.CategoryOptions {
    glassesInputOptions.union(.defaultToSpeaker)
  }

  private func configureSession(for route: AudioInputRoute) throws {
    let session = AVAudioSession.sharedInstance()
    switch route {
    case .phoneMicrophone:
      // Do not allow HFP to steal a phone-microphone capture.
      try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker])
    case .glassesMicrophone:
      try session.setCategory(.playAndRecord, mode: .default, options: Self.glassesInputOptions)
    }
    try session.setActive(true)
    switch route {
    case .phoneMicrophone:
      guard let builtin = session.availableInputs?.first(where: { $0.portType == .builtInMic }) else {
        throw CaptureError.noMicrophone
      }
      try session.setPreferredInput(builtin)
    case .glassesMicrophone:
      let glasses = session.availableInputs?.first {
        AudioRoutePolicy.isVerifiedGlassesInput(name: $0.portName, type: $0.portType.rawValue)
      }
      guard let glasses else { throw CaptureError.glassesUnavailable }
      try session.setPreferredInput(glasses)
    }
  }

  private func makeRecorder(url: URL) throws -> AVAudioRecorder {
    let stereo: [String: Any] = [
      AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
      AVSampleRateKey: 44_100,
      AVNumberOfChannelsKey: 2,
      AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue,
    ]
    if let recorder = try? AVAudioRecorder(url: url, settings: stereo), recorder.prepareToRecord() {
      return recorder
    }
    let mono: [String: Any] = [
      AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
      AVSampleRateKey: 44_100,
      AVNumberOfChannelsKey: 1,
      AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue,
    ]
    let recorder = try AVAudioRecorder(url: url, settings: mono)
    guard recorder.prepareToRecord() else {
      NSLog("[atlas] music recorder could not prepare (mono AAC 44.1 kHz)")
      throw CaptureError.configurationFailed
    }
    return recorder
  }

  private func currentInputPorts() -> [AudioRoutePolicy.Port] {
    AVAudioSession.sharedInstance().currentRoute.inputs.map {
      AudioRoutePolicy.Port(uid: $0.uid, name: $0.portName, type: $0.portType.rawValue)
    }
  }

  private func availableInputPorts() -> [AudioRoutePolicy.Port] {
    (AVAudioSession.sharedInstance().availableInputs ?? []).map {
      AudioRoutePolicy.Port(uid: $0.uid, name: $0.portName, type: $0.portType.rawValue)
    }
  }

  private func publishRoutes() {
    let inputs = availableInputPorts()
    options = AudioRoutePolicy.options(inputs: inputs)
    activeRoute = AudioRoutePolicy.activeRoute(inputs: currentInputPorts())
  }

  private func routeChanged() {
    publishRoutes()
    guard isRecording, let selectedRoute else { return }
    // Route loss stops the recording. Never continue on a different mic.
    if !AudioRoutePolicy.matches(expected: selectedRoute, inputs: currentInputPorts()) {
      interrupted = true
      interruption = "route"
      recorder?.stop()
    }
  }

  private func startMetering() {
    meterTask?.cancel()
    meterTask = Task { [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(nanoseconds: 100_000_000)
        self?.refreshMeters()
      }
    }
  }

  private func refreshMeters() {
    guard let recorder, isRecording else { return }
    recorder.updateMeters()
    let power = recorder.averagePower(forChannel: 0)
    level = max(0, min(1, (power + 50) / 50))
  }

  private func finish(successfully: Bool) {
    meterTask?.cancel()
    meterTask = nil
    isRecording = false
    level = 0
    let url = recorder?.url
    let duration = recorder?.currentTime ?? 0
    recorder = nil
    let route = recordedRoute ?? selectedRoute ?? .phoneMicrophone
    selectedRoute = nil
    guard let continuation = stopContinuation else { return }
    stopContinuation = nil
    let fileExists = url.map { FileManager.default.fileExists(atPath: $0.path) } ?? false
    let size = (url.flatMap { try? FileManager.default.attributesOfItem(atPath: $0.path)[.size] as? Int64 }) ?? 0
    if let url, fileExists, size > 0, duration > 0 {
      continuation.resume(returning: RecordingResult(
        url: url, duration: duration, interrupted: interrupted || !successfully, inputRoute: route))
    } else {
      continuation.resume(throwing: CaptureError.nothingSaved)
    }
  }
}

extension MusicCapture: AVAudioRecorderDelegate {
  nonisolated public func audioRecorderDidFinishRecording(_ recorder: AVAudioRecorder, successfully flag: Bool) {
    Task { @MainActor in self.finish(successfully: flag) }
  }

  nonisolated public func audioRecorderEncodeErrorDidOccur(_ recorder: AVAudioRecorder, error: Error?) {
    Task { @MainActor in
      self.interrupted = true
      self.finish(successfully: false)
    }
  }
}
#endif
