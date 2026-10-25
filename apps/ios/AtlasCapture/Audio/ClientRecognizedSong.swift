import Foundation

/// A song this client recognized on-device before asking for analysis
/// (ShazamKit on iOS). It is a hint for the same server pipeline, never a
/// result: culture atlas still resolves the artist through its own catalog
/// before anything is shown or added to taste.
public struct ClientRecognizedSong: Codable, Sendable, Equatable {
  /// Always "shazamkit": the server accepts this one vendor.
  public var vendor: String
  public var artistName: String
  public var title: String?
  public var matchedAtMS: Int?
  public var vendorRecordingID: String?

  public init(
    vendor: String = "shazamkit",
    artistName: String,
    title: String? = nil,
    matchedAtMS: Int? = nil,
    vendorRecordingID: String? = nil
  ) {
    self.vendor = vendor
    self.artistName = artistName
    self.title = title
    self.matchedAtMS = matchedAtMS
    self.vendorRecordingID = vendorRecordingID
  }

  enum CodingKeys: String, CodingKey {
    case vendor, title
    case artistName = "artist_name"
    case matchedAtMS = "matched_at_ms"
    case vendorRecordingID = "vendor_recording_id"
  }
}

/// Recognition seam for Music Mode: the recording in, a recognized song out.
/// Recognition is optional and best-effort; `nil` means "no hint", and the
/// server then uses its own fingerprint and transcript tiers.
public protocol SongRecognizer {
  func recognize(fileURL: URL) async -> ClientRecognizedSong?
}

/// No recognizer in this build: every call answers "no hint".
struct UnavailableSongRecognizer: SongRecognizer {
  func recognize(fileURL: URL) async -> ClientRecognizedSong? { nil }
}

/// Builds the recognizer for this build. Apple ships ShazamKit through the
/// developer downloads (behind sign-in), so the xcframework is never
/// vendored in the repo: `canImport(SHShazamKit)` is true only in builds
/// where it was added to the project, and this file (plus the whole app)
/// compiles and tests without it.
public enum SongRecognizerFactory {
  /// True when the ShazamKit xcframework is present in this build.
  public static var isShazamKitAvailable: Bool {
    #if canImport(SHShazamKit)
      return true
    #else
      return false
    #endif
  }

  public static func make() -> SongRecognizer {
    #if canImport(SHShazamKit)
      return ShazamSongRecognizer()
    #else
      return UnavailableSongRecognizer()
    #endif
  }
}
