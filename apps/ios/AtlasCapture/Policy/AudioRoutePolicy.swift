import Foundation

/// Actual microphone input used for Music Mode. These strings are the
/// `input_route` / `source_route` values recorded with a capture.
public enum AudioInputRoute: String, Codable, Sendable, CaseIterable {
  case phoneMicrophone = "phone_microphone"
  case glassesMicrophone = "glasses_microphone"
}

/// Classifies OS audio ports from input port type and name. Glasses are
/// offered only when an *input* port is verified; a Bluetooth output
/// connection is not enough, and an unverified headset is never labelled
/// as glasses. Music Mode never silently falls back from glasses to phone.
public enum AudioRoutePolicy {
  public struct Port: Equatable, Sendable {
    public var uid: String
    public var name: String
    public var type: String

    public init(uid: String, name: String, type: String) {
      self.uid = uid
      self.name = name
      self.type = type
    }
  }

  public struct Option: Equatable, Sendable, Identifiable {
    public var route: AudioInputRoute
    public var title: String
    public var available: Bool
    public var detail: String
    public var id: AudioInputRoute { route }
  }

  /// Speech analysis is off in Music Mode (amendment 2.3).
  public static let speechAnalysisEnabled = false

  public static let glassesNameTokens = ["ray-ban", "rayban", "ray ban", "meta glasses", "meta ray"]
  public static let notGlassesTokens = ["airpods", "beats", "earpods"]
  /// Input port types that *may* be a glasses microphone once the name matches.
  public static let glassesInputTypes: Set<String> = ["BluetoothHFP", "BluetoothLE", "HeadsetMic"]
  public static let phoneInputTypes: Set<String> = ["MicrophoneBuiltIn"]

  public static func isVerifiedGlassesInput(name: String, type: String) -> Bool {
    guard glassesInputTypes.contains(type) else { return false }
    let lowered = name.lowercased()
    if notGlassesTokens.contains(where: { lowered.contains($0) }) { return false }
    return glassesNameTokens.contains(where: { lowered.contains($0) })
  }

  public static func isPhoneInput(type: String) -> Bool {
    phoneInputTypes.contains(type)
  }

  /// Active route from the ports currently delivering input. Unknown Bluetooth
  /// headsets are neither phone nor glasses.
  public static func activeRoute(inputs: [Port]) -> AudioInputRoute? {
    if inputs.contains(where: { isVerifiedGlassesInput(name: $0.name, type: $0.type) }) {
      return .glassesMicrophone
    }
    if inputs.contains(where: { isPhoneInput(type: $0.type) }) {
      return .phoneMicrophone
    }
    return nil
  }

  public static func matches(expected: AudioInputRoute, inputs: [Port]) -> Bool {
    activeRoute(inputs: inputs) == expected
  }

  /// `outputs` are ignored for glasses availability: playback over Bluetooth
  /// does not prove a glasses microphone route.
  public static func options(inputs: [Port], outputs: [Port] = []) -> [Option] {
    _ = outputs
    let glasses = inputs.contains { isVerifiedGlassesInput(name: $0.name, type: $0.type) }
    return [
      Option(
        route: .phoneMicrophone, title: "Phone microphone", available: true,
        detail: "This phone"),
      Option(
        route: .glassesMicrophone,
        title: glasses ? "Glasses microphone · Verified input" : "Glasses microphone unavailable",
        available: glasses,
        detail: glasses
          ? "Experimental glasses route"
          : "Glasses microphone unavailable. Choose this phone to record here."),
    ]
  }

  public static func defaultRange(durationSeconds: Double) -> (start: Double, end: Double) {
    let duration = max(0, durationSeconds)
    let window = min(Double(AtlasContract.musicRecognitionDefaultSeconds), duration)
    return (0, window)
  }
}
