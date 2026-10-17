import Foundation
import Observation
import UIKit

/// Capture-device seam shared by the real Meta adapter (Experimental builds)
/// and the unavailable stand-in (public builds). The app never assumes the
/// SDK exists; `CapabilityGate` combines this local state with server policy.
@MainActor
public protocol WearablesAdapter: AnyObject {
  var buildIncludesSDK: Bool { get }
  var localState: CapabilityGate.Local { get }
  var isRecording: Bool { get }
  var preview: PreviewFrameStore { get }
  func startRegistration() async throws
  func ensureCameraPermission() async throws -> Bool
  func unregister() async
  func handleURL(_ url: URL) async -> Bool
  func startSession()
  func endSession()
  func capturePhoto() async throws -> Data
  func recordClip(to url: URL, maxDuration: Double) async throws -> RecordedClip
  func stopClip()
  func sdkReference(installationPublicID: UUID) -> String?
}

/// Public-store build without the Meta SDK: the Experimental entry stays
/// visible and explains that glasses capture is not in this release (screen 09).
/// No fake pairing, no fake reconnect.
@MainActor
public final class UnavailableWearables: WearablesAdapter {
  public init() {}
  public let buildIncludesSDK = false
  public let preview = PreviewFrameStore()
  public var isRecording: Bool { false }
  public var localState: CapabilityGate.Local {
    CapabilityGate.Local(registration: .unavailable, permission: .unknown, deviceAvailable: false, stream: .stopped, recording: false)
  }
  public func startRegistration() async throws { throw UnavailableError.notInThisBuild }
  public func ensureCameraPermission() async throws -> Bool { false }
  public func unregister() async {}
  public func handleURL(_ url: URL) async -> Bool { false }
  public func startSession() {}
  public func endSession() {}
  public func capturePhoto() async throws -> Data { throw UnavailableError.notInThisBuild }
  public func recordClip(to url: URL, maxDuration: Double) async throws -> RecordedClip { throw UnavailableError.notInThisBuild }
  public func stopClip() {}
  public func sdkReference(installationPublicID: UUID) -> String? { nil }

  public enum UnavailableError: Error { case notInThisBuild }
}

/// Holds the latest preview frame separately so ~24 fps updates only
/// re-render the preview view (from Observer's `PreviewFrameStore`).
@Observable
@MainActor
public final class PreviewFrameStore {
  public var image: UIImage?
  @ObservationIgnored public var latestFrameAt: Date?

  public init() {}

  public var latestFrameAge: TimeInterval? { latestFrameAt.map { Date().timeIntervalSince($0) } }
}
