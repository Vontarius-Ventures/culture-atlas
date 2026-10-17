import Foundation

/// Elapsed/limit presentation for a bounded clip: 60 s maximum with a visible
/// countdown for the last 10 s (PRODUCT-AND-ARCHITECTURE "Product defaults").
public struct ClipClock: Equatable, Sendable {
  public let limitSeconds: Int
  public let countdownFrom: Int

  public init(limitSeconds: Int = AtlasContract.clipMaxSeconds, countdownFrom: Int = AtlasContract.countdownFromSeconds) {
    self.limitSeconds = limitSeconds
    self.countdownFrom = countdownFrom
  }

  public struct Display: Equatable, Sendable {
    /// "0:07 / 1:00"
    public var elapsedText: String
    /// Seconds left while inside the countdown window, else nil.
    public var countdown: Int?
    public var shouldStop: Bool
    /// Spoken by VoiceOver; never relies on colour.
    public var accessibilityText: String
  }

  public func display(elapsed: TimeInterval) -> Display {
    let whole = max(0, Int(elapsed.rounded(.down)))
    let remaining = max(0, limitSeconds - whole)
    let countdown = remaining <= countdownFrom ? remaining : nil
    let text = "\(Self.clock(whole)) / \(Self.clock(limitSeconds))"
    let spoken = countdown.map { "Recording, \($0) seconds left" } ?? "Recording, \(whole) seconds"
    return Display(elapsedText: text, countdown: countdown, shouldStop: whole >= limitSeconds, accessibilityText: spoken)
  }

  public static func clock(_ seconds: Int) -> String {
    String(format: "%d:%02d", seconds / 60, seconds % 60)
  }
}
