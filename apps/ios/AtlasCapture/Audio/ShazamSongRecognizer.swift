#if canImport(SHShazamKit)
import AVFoundation
import Foundation
import SHShazamKit

/// On-device song recognition against the Shazam Music catalog (ShazamKit).
/// The whole file disappears from builds without the xcframework; add it in
/// Xcode (Frameworks, Libraries → SHShazamKit.xcframework, "Embed & Sign")
/// and this becomes the recognizer `SongRecognizerFactory.make()` returns.
///
/// Only the vendor's own words ever leave the device: the recognized artist
/// name and song title, as a hint with the analysis request. No audio, no
/// transcript, no confidence score.
final class ShazamSongRecognizer: NSObject, @unchecked Sendable, SongRecognizer {
  private let lock = NSLock()
  private var continuation: CheckedContinuation<ClientRecognizedSong?, Never>?

  func recognize(fileURL: URL) async -> ClientRecognizedSong? {
    guard let signature = Self.signature(of: fileURL) else { return nil }
    return await withCheckedContinuation { continuation in
      lock.lock()
      self.continuation = continuation
      lock.unlock()
      let session = SHSession()
      session.delegate = self
      session.match(signature)
    }
  }

  /// One 44.1 kHz mono signature over the recording, in ShazamKit's supported
  /// PCM shape (the documented file-conversion loop, one chunk at a time).
  private static func signature(of fileURL: URL) -> SHSignature? {
    guard
      let format = AVAudioFormat(standardFormatWithSampleRate: 44_100, channels: 1),
      let audioFile = try? AVAudioFile(forReading: fileURL)
    else { return nil }
    let generator = SHSignatureGenerator()
    let frameCount = AVAudioFrameCount(
      (1024 * 64) / (audioFile.processingFormat.streamDescription.pointee.mBytesPerFrame))
    let outputCapacity = AVAudioFrameCount(
      round(Double(frameCount) * (format.sampleRate / audioFile.processingFormat.sampleRate)))
    guard
      let input = AVAudioPCMBuffer(pcmFormat: audioFile.processingFormat, frameCapacity: frameCount),
      let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: outputCapacity),
      let converter = AVAudioConverter(from: audioFile.processingFormat, to: format)
    else { return nil }
    while true {
      let status = converter.convert(to: output, error: nil) { _, outStatus in
        do {
          try audioFile.read(into: input)
          outStatus.pointee = .haveData
          return input
        } catch {
          outStatus.pointee = audioFile.framePosition >= audioFile.length ? .endOfStream : .noDataNow
          return nil
        }
      }
      switch status {
      case .error:
        return nil
      case .haveData:
        do { try generator.append(output, at: nil) } catch { return nil }
      default:
        break
      }
      if status == .endOfStream || status == .inputRanDry {
        if output.frameLength > 0, status == .inputRanDry {
          do { try generator.append(output, at: nil) } catch { return nil }
        }
        return generator.signature()
      }
      input.frameLength = 0
      output.frameLength = 0
    }
  }

  private func resume(_ song: ClientRecognizedSong?) {
    lock.lock()
    let pending = continuation
    continuation = nil
    lock.unlock()
    pending?.resume(returning: song)
  }
}

extension ShazamSongRecognizer: SHSessionDelegate {
  func session(_ session: SHSession, didFind match: SHMatch) {
    guard
      let item = match.mediaItems
        .compactMap({ $0 as? SHMatchedMediaItem })
        .first(where: { $0.artist?.isEmpty == false })
    else {
      resume(nil)
      return
    }
    // The vendor's own fields only. Match offset (when present) locates the
    // song inside the recording; the Shazam id is the vendor's recording id.
    let offsetMS = (item.value(forProperty: .matchOffset) as? NSNumber)
      .map { max(0, Int($0.doubleValue * 1000)) }
    let song = ClientRecognizedSong(
      artistName: item.artist ?? "",
      title: item.title,
      matchedAtMS: offsetMS,
      vendorRecordingID: item.shazamID.map { "\($0)" })
    resume(song)
  }

  func session(_ session: SHSession, didNotFindMatchFor signature: SHSignature, error: Error?) {
    resume(nil)
  }
}
#endif
