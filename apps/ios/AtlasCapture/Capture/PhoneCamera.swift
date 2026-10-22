#if os(iOS)
import AVFoundation
import UIKit

/// Built-in phone camera: live preview, photo and bounded video, front/back,
/// and an explicit microphone state (SCREEN-CONTRACT reference 03).
///
/// - Permissions are requested when the person acts, not at launch.
/// - The microphone is added only when the person turned it on AND granted
///   permission; silent video stays silent and is never blocked by a missing mic.
/// - Movies are written with a 2 s fragment interval so an interruption
///   (call, background, low storage) leaves a playable file up to the last
///   fragment; such clips are kept and marked interrupted.
@MainActor
public final class PhoneCamera: NSObject, ObservableObject {
  public enum Position: String, Sendable { case back, front }

  public enum CameraError: LocalizedError, Equatable {
    case permissionDenied, noDevice, configurationFailed, busy, storageFull

    public var errorDescription: String? {
      switch self {
      case .permissionDenied: return "Camera access is off. Turn it on in Settings, or upload files instead."
      case .noDevice: return "This camera is not available on this phone."
      case .configurationFailed: return "The camera could not start. Try again."
      case .busy: return "The camera is already capturing."
      case .storageFull: return "Your phone is out of space. Free some space to keep recording."
      }
    }
  }

  public struct ClipResult: Sendable {
    public let url: URL
    public let duration: Double
    public let interrupted: Bool
    public let audioPresent: Bool
  }

  @Published public private(set) var isRunning = false
  @Published public private(set) var isRecording = false
  @Published public private(set) var position: Position = .back
  @Published public private(set) var microphoneOn = false
  @Published public private(set) var interruption: String?

  /// Created only when the photo/video camera path starts. Music Mode must
  /// never touch this (AUD01).
  private var captureSession: AVCaptureSession?
  public var session: AVCaptureSession { ensureSession() }
  /// True only after the camera path has constructed an AVCaptureSession.
  public var hasCaptureSession: Bool { captureSession != nil }
  private let photoOutput = AVCapturePhotoOutput()
  private let movieOutput = AVCaptureMovieFileOutput()
  private var videoInput: AVCaptureDeviceInput?
  private var audioInput: AVCaptureDeviceInput?
  private var photoContinuation: CheckedContinuation<Data, Error>?
  private var movieContinuation: CheckedContinuation<ClipResult, Error>?
  private var observers: [NSObjectProtocol] = []

  public override init() {
    super.init()
  }

  @discardableResult
  private func ensureSession() -> AVCaptureSession {
    if let captureSession { return captureSession }
    let session = AVCaptureSession()
    captureSession = session
    observers.append(NotificationCenter.default.addObserver(
      forName: AVCaptureSession.wasInterruptedNotification, object: session, queue: .main
    ) { [weak self] note in
      let reason = (note.userInfo?[AVCaptureSessionInterruptionReasonKey] as? Int)
        .flatMap(AVCaptureSession.InterruptionReason.init(rawValue:))
      MainActor.assumeIsolated {
        self?.interruption = reason.map { "\($0.rawValue)" } ?? "interrupted"
        // Stop safely: the fragment-written file stays valid.
        if self?.movieOutput.isRecording == true { self?.movieOutput.stopRecording() }
      }
    })
    observers.append(NotificationCenter.default.addObserver(
      forName: AVCaptureSession.interruptionEndedNotification, object: session, queue: .main
    ) { [weak self] _ in
      MainActor.assumeIsolated { self?.interruption = nil }
    })
    return session
  }

  public static var cameraAuthorized: Bool { AVCaptureDevice.authorizationStatus(for: .video) == .authorized }
  public static var microphoneAuthorized: Bool { AVCaptureDevice.authorizationStatus(for: .audio) == .authorized }

  /// Requests camera access on the person's action.
  public func requestCameraAccess() async -> Bool {
    switch AVCaptureDevice.authorizationStatus(for: .video) {
    case .authorized: return true
    case .notDetermined: return await AVCaptureDevice.requestAccess(for: .video)
    default: return false
    }
  }

  public func start(position: Position = .back) async throws {
    guard await requestCameraAccess() else { throw CameraError.permissionDenied }
    try configure(position: position)
    let session = self.session
    await Task.detached { session.startRunning() }.value
    isRunning = session.isRunning
  }

  public func stop() {
    if movieOutput.isRecording { movieOutput.stopRecording() }
    guard let session = captureSession else {
      isRunning = false
      return
    }
    Task.detached { session.stopRunning() }
    isRunning = false
  }

  private func configure(position: Position) throws {
    session.beginConfiguration()
    defer { session.commitConfiguration() }
    session.sessionPreset = .high
    if let videoInput { session.removeInput(videoInput) }
    guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: position == .back ? .back : .front)
    else { throw CameraError.noDevice }
    let input = try AVCaptureDeviceInput(device: device)
    guard session.canAddInput(input) else { throw CameraError.configurationFailed }
    session.addInput(input)
    videoInput = input
    self.position = position
    if !session.outputs.contains(photoOutput) {
      guard session.canAddOutput(photoOutput) else { throw CameraError.configurationFailed }
      session.addOutput(photoOutput)
    }
    if !session.outputs.contains(movieOutput) {
      guard session.canAddOutput(movieOutput) else { throw CameraError.configurationFailed }
      session.addOutput(movieOutput)
      movieOutput.movieFragmentInterval = CMTime(seconds: 2, preferredTimescale: 600)
    }
  }

  public func flip() throws {
    guard !isRecording else { throw CameraError.busy }
    try configure(position: position == .back ? .front : .back)
  }

  /// Turns the microphone on only after explicit permission; off removes the input.
  public func setMicrophone(_ on: Bool) async -> Bool {
    guard !isRecording else { return microphoneOn }
    if on {
      let granted: Bool
      switch AVCaptureDevice.authorizationStatus(for: .audio) {
      case .authorized: granted = true
      case .notDetermined: granted = await AVCaptureDevice.requestAccess(for: .audio)
      default: granted = false
      }
      guard granted, let mic = AVCaptureDevice.default(for: .audio), let input = try? AVCaptureDeviceInput(device: mic)
      else { microphoneOn = false; return false }
      session.beginConfiguration()
      if session.canAddInput(input) {
        session.addInput(input)
        audioInput = input
      }
      session.commitConfiguration()
      microphoneOn = audioInput != nil
    } else {
      if let audioInput {
        session.beginConfiguration()
        session.removeInput(audioInput)
        session.commitConfiguration()
      }
      audioInput = nil
      microphoneOn = false
    }
    return microphoneOn
  }

  public func capturePhoto() async throws -> Data {
    guard photoContinuation == nil, isRunning else { throw CameraError.busy }
    return try await withCheckedThrowingContinuation { continuation in
      photoContinuation = continuation
      let settings = AVCapturePhotoSettings(format: [AVVideoCodecKey: AVVideoCodecType.jpeg])
      photoOutput.capturePhoto(with: settings, delegate: self)
    }
  }

  /// Records to `url` until `stopRecording()` or `maxSeconds`, whichever first.
  public func recordClip(to url: URL, maxSeconds: Int) async throws -> ClipResult {
    guard !movieOutput.isRecording, movieContinuation == nil, isRunning else { throw CameraError.busy }
    try? FileManager.default.removeItem(at: url)
    return try await withCheckedThrowingContinuation { continuation in
      movieContinuation = continuation
      isRecording = true
      movieOutput.maxRecordedDuration = CMTime(seconds: Double(maxSeconds), preferredTimescale: 600)
      movieOutput.startRecording(to: url, recordingDelegate: self)
    }
  }

  public func stopRecording() {
    if movieOutput.isRecording { movieOutput.stopRecording() }
  }
}

extension PhoneCamera: AVCapturePhotoCaptureDelegate {
  nonisolated public func photoOutput(_ output: AVCapturePhotoOutput, didFinishProcessingPhoto photo: AVCapturePhoto, error: Error?) {
    let data = photo.fileDataRepresentation()
    Task { @MainActor in
      guard let continuation = self.photoContinuation else { return }
      self.photoContinuation = nil
      if let data, error == nil { continuation.resume(returning: data) } else {
        continuation.resume(throwing: error ?? CameraError.configurationFailed)
      }
    }
  }
}

extension PhoneCamera: AVCaptureFileOutputRecordingDelegate {
  nonisolated public func fileOutput(
    _ output: AVCaptureFileOutput, didFinishRecordingTo outputFileURL: URL, from connections: [AVCaptureConnection],
    error: Error?
  ) {
    let duration = output.recordedDuration.seconds
    let nsError = error as NSError?
    // Max duration / file size reached and interruptions still finish a usable file.
    let finished = (nsError?.userInfo[AVErrorRecordingSuccessfullyFinishedKey] as? Bool) ?? (error == nil)
    let reachedLimit = nsError?.code == AVError.maximumDurationReached.rawValue
    let diskFull = nsError?.code == AVError.diskFull.rawValue
    Task { @MainActor in
      self.isRecording = false
      guard let continuation = self.movieContinuation else { return }
      self.movieContinuation = nil
      let fileExists = FileManager.default.fileExists(atPath: outputFileURL.path)
      if fileExists, duration > 0, finished || diskFull || self.interruption != nil {
        continuation.resume(returning: ClipResult(
          url: outputFileURL, duration: duration,
          interrupted: !(error == nil || reachedLimit), audioPresent: self.microphoneOn))
      } else if diskFull {
        continuation.resume(throwing: CameraError.storageFull)
      } else {
        continuation.resume(throwing: error ?? CameraError.configurationFailed)
      }
    }
  }
}
#endif
