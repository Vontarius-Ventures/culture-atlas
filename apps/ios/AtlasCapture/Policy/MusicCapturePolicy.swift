import Foundation

/// Music Mode rules (amendment 2.3, AUD01). Pure policy: no AVFoundation,
/// no camera types, no network. The recorder asks for microphone permission
/// only; camera permission and any camera-session or capture-device video
/// APIs are out of bounds on this path.
public enum MusicCapturePolicy {
  public enum Phase: String, Equatable, Sendable, CaseIterable {
    case idle
    case permissionRequested = "permission_requested"
    case routeCheck = "route_check"
    case recording
    case finalizing
    case localDraft = "local_draft"
    case queuedUpload = "queued_upload"
    case ready
    case couldNotSave = "could_not_save"
  }

  /// Camera permission is never part of Music Mode.
  public static let requestsCameraPermission = false
  /// Music Mode must not construct or start a camera capture session.
  public static let initializesVideoCaptureSession = false
  /// Music Mode must not open a capture-device video input.
  public static let initializesAVCaptureDeviceVideo = false
  /// Playback starts paused. The person taps Play.
  public static let autoplayWithSound = false
  /// Speech transcription is off until an explicit later action.
  public static let speechTranscriptionDefault = false

  public static var maxSeconds: Int { AtlasContract.audioMaxSeconds }

  public static func clock(limitSeconds: Int = AtlasContract.audioMaxSeconds) -> ClipClock {
    ClipClock(limitSeconds: limitSeconds)
  }

  /// Default to the phone microphone. Glasses are listed only when verified;
  /// they are never auto-selected.
  public static func defaultRoute(options: [AudioRoutePolicy.Option]) -> AudioInputRoute {
    .phoneMicrophone
  }

  public static func mediaSource(for route: AudioInputRoute) -> MediaSource {
    switch route {
    case .phoneMicrophone: return .phoneMicrophone
    case .glassesMicrophone: return .glassesMicrophone
    }
  }

  public static func recordButtonLabel(isRecording: Bool) -> String {
    isRecording ? "Stop recording" : "Record"
  }

  public static func recordAccessibility(isRecording: Bool, elapsed: String) -> String {
    if isRecording {
      return "Stop recording. Recording audio, \(elapsed)"
    }
    return "Record. Camera off. Microphone only."
  }

  public static func unsavedMessage() -> String {
    "Recording could not be saved"
  }

  public static func contentTypeM4A() -> String { "audio/mp4" }
}
