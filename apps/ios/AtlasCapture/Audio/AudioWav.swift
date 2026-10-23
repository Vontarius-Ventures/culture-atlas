import AVFoundation
import Foundation

/// PCM s16le WAV for `POST /v2/media/audio`. Music Mode may record AAC locally;
/// Explore converts to this container because keep is WAV-only.
public enum AudioWav {
  public static func pcmS16le(samples: [Int16], sampleRateHz: Int, channels: Int) -> Data {
    let dataSize = samples.count * 2
    var bytes = Data(count: 44 + dataSize)
    bytes.replaceSubrange(0..<4, with: Array("RIFF".utf8))
    writeU32(&bytes, 4, UInt32(36 + dataSize))
    bytes.replaceSubrange(8..<12, with: Array("WAVE".utf8))
    bytes.replaceSubrange(12..<16, with: Array("fmt ".utf8))
    writeU32(&bytes, 16, 16)
    writeU16(&bytes, 20, 1)
    writeU16(&bytes, 22, UInt16(channels))
    writeU32(&bytes, 24, UInt32(sampleRateHz))
    writeU32(&bytes, 28, UInt32(sampleRateHz * channels * 2))
    writeU16(&bytes, 32, UInt16(channels * 2))
    writeU16(&bytes, 34, 16)
    bytes.replaceSubrange(36..<40, with: Array("data".utf8))
    writeU32(&bytes, 40, UInt32(dataSize))
    samples.withUnsafeBufferPointer { ptr in
      bytes.replaceSubrange(44..<(44 + dataSize), with: UnsafeRawBufferPointer(ptr))
    }
    return bytes
  }

  /// Already-qualified PCM WAV is passed through; AAC/M4A is decoded to s16le.
  public static func pcmS16le(fromFile url: URL) throws -> Data {
    let raw = try Data(contentsOf: url)
    if isPcmS16leWav(raw) { return raw }
    let file = try AVAudioFile(forReading: url)
    let src = file.processingFormat
    let frames = AVAudioFrameCount(file.length)
    guard frames > 0, let buffer = AVAudioPCMBuffer(pcmFormat: src, frameCapacity: frames) else {
      throw AudioWavError.empty
    }
    try file.read(into: buffer)
    let channels = Int(src.channelCount)
    guard channels == 1 || channels == 2 else { throw AudioWavError.channels }
    let sampleRate = Int(src.sampleRate.rounded())
    let samples = int16Samples(buffer: buffer, channels: channels)
    return pcmS16le(samples: samples, sampleRateHz: sampleRate, channels: channels)
  }

  public static func isPcmS16leWav(_ data: Data) -> Bool {
    guard data.count >= 44 else { return false }
    guard ascii(data, 0, 4) == "RIFF", ascii(data, 8, 4) == "WAVE", ascii(data, 12, 4) == "fmt " else {
      return false
    }
    return u16(data, 20) == 1 && u16(data, 34) == 16
  }

  private static func int16Samples(buffer: AVAudioPCMBuffer, channels: Int) -> [Int16] {
    let frames = Int(buffer.frameLength)
    if buffer.format.commonFormat == .pcmFormatInt16, let int16 = buffer.int16ChannelData {
      if buffer.format.isInterleaved {
        return Array(UnsafeBufferPointer(start: int16[0], count: frames * channels))
      }
      var out = [Int16](repeating: 0, count: frames * channels)
      for ch in 0..<channels {
        let plane = int16[ch]
        for i in 0..<frames { out[i * channels + ch] = plane[i] }
      }
      return out
    }
    guard let float = buffer.floatChannelData else { return [] }
    var out = [Int16](repeating: 0, count: frames * channels)
    for ch in 0..<channels {
      let plane = float[ch]
      for i in 0..<frames {
        let clipped = max(-1, min(1, plane[i]))
        out[i * channels + ch] = Int16(clipped * Float(Int16.max))
      }
    }
    return out
  }

  private static func writeU16(_ data: inout Data, _ offset: Int, _ value: UInt16) {
    var le = value.littleEndian
    data.replaceSubrange(offset..<(offset + 2), with: Data(bytes: &le, count: 2))
  }

  private static func writeU32(_ data: inout Data, _ offset: Int, _ value: UInt32) {
    var le = value.littleEndian
    data.replaceSubrange(offset..<(offset + 4), with: Data(bytes: &le, count: 4))
  }

  private static func u16(_ data: Data, _ offset: Int) -> UInt16 {
    UInt16(data[offset]) | (UInt16(data[offset + 1]) << 8)
  }

  private static func ascii(_ data: Data, _ offset: Int, _ count: Int) -> String {
    String(bytes: data[offset..<(offset + count)], encoding: .ascii) ?? ""
  }
}

public enum AudioWavError: LocalizedError {
  case empty, channels

  public var errorDescription: String? {
    switch self {
    case .empty: return "This recording has no audio to send."
    case .channels: return "Use mono or stereo audio."
    }
  }
}
