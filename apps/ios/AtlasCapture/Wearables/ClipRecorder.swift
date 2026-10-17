// Clip recording for the hvc1 (HEVC) glasses stream: compressed frames pass straight
// through to AVAssetWriter (no re-encode on the phone), and a decoded preview keeps
// the on-screen view live. Decode + passthrough adapted from Meta's CameraAccess
// sample, hardened over six on-device debugging sessions (monotonic timeline rebase,
// sync-sample flags, keyframe-gated open, software decode that survives backgrounding).
//
// Ported from World Observer (WorldCompilerSensor/Wearables/ClipRecorder.swift).
// Changes for culture atlas: public API for the AtlasCapture module; clips are
// always written as fragmented MP4 (2 s fragments) so a disconnect or crash
// mid-recording leaves a playable file up to the last fragment, and the result
// says whether the clip was interrupted. The CameraAccess-derived portions remain
// subject to the Meta Wearables Device Access Toolkit license; see
// apps/ios/THIRD_PARTY_NOTICES.md.

import AVFoundation
import CoreMedia
import CoreVideo
import os
import UIKit
import VideoToolbox

public struct RecordedClip: Sendable {
  public let url: URL
  public let duration: Double
  /// True when the stream stopped (disconnect, teardown) before the requested
  /// stop or limit; the file is still valid up to the last fragment.
  public var interrupted = false
}

public enum ClipRecorderError: LocalizedError {
  case alreadyRecording
  case noFrames
  case writerFailed(String)
  case cancelled(String)

  public var errorDescription: String? {
    switch self {
    case .alreadyRecording: return "A clip is already recording"
    case .noFrames: return "No video frames arrived from the glasses"
    case .writerFailed(let reason): return "Couldn't write the clip: \(reason)"
    case .cancelled(let reason): return "Clip cancelled: \(reason)"
    }
  }
}

// MARK: - HEVC keyframe detection

extension CMSampleBuffer {
  /// True if any NAL unit in the buffer is an HEVC keyframe type (BLA 16-18, IDR 19-20,
  /// CRA 21). NAL units here are length-prefixed (HVCC layout), 4-byte big endian.
  /// Done by hand because SDK sample buffers do not carry `kCMSampleAttachmentKey_NotSync`.
  func isHEVCKeyframe() -> Bool {
    guard let dataBuffer = CMSampleBufferGetDataBuffer(self) else { return false }
    let totalLength = CMBlockBufferGetDataLength(dataBuffer)
    var offset = 0

    while offset + 4 < totalLength {
      var nalLengthBE: UInt32 = 0
      guard CMBlockBufferCopyDataBytes(dataBuffer, atOffset: offset, dataLength: 4, destination: &nalLengthBE) == kCMBlockBufferNoErr
      else { break }
      let nalLength = Int(UInt32(bigEndian: nalLengthBE))
      offset += 4

      guard nalLength > 0, offset + nalLength <= totalLength else { break }

      var nalHeader: UInt8 = 0
      guard CMBlockBufferCopyDataBytes(dataBuffer, atOffset: offset, dataLength: 1, destination: &nalHeader) == kCMBlockBufferNoErr
      else { break }
      let nalUnitType = (nalHeader >> 1) & 0x3F

      if nalUnitType >= 16 && nalUnitType <= 21 {
        return true
      }

      offset += nalLength
    }

    return false
  }
}

// MARK: - H.265 frame decoder

/// Decompresses HEVC sample buffers into `UIImage`s for the live preview. Software
/// decoding is forced so the session survives backgrounding (iOS tears down hardware
/// decode sessions in the background). On failure it holds the last good frame until
/// a keyframe arrives, so no corrupt frames reach the UI. Thread-safe.
public final class H265FrameDecoder: Sendable {
  public init() {}

  private struct State {
    var session: VTDecompressionSession?
    var formatDescription: CMFormatDescription?
    var consecutiveFailures: Int = 0
    var lastGoodImage: UIImage?
    var awaitingKeyframe: Bool = false
  }

  private let state = OSAllocatedUnfairLock(uncheckedState: State())
  private let ciContext = CIContext()

  public func decode(_ sampleBuffer: CMSampleBuffer) -> UIImage? {
    guard CMSampleBufferGetDataBuffer(sampleBuffer) != nil,
      let formatDescription = CMSampleBufferGetFormatDescription(sampleBuffer)
    else {
      return state.withLockUnchecked { $0.lastGoodImage }
    }

    let isKeyframe = sampleBuffer.isHEVCKeyframe()

    let (session, awaitingKeyframe) = state.withLockUnchecked { state -> (VTDecompressionSession?, Bool) in
      if let currentFormat = state.formatDescription,
        let existingSession = state.session,
        !CMFormatDescriptionEqual(currentFormat, otherFormatDescription: formatDescription)
      {
        VTDecompressionSessionInvalidate(existingSession)
        state.session = nil
        state.formatDescription = nil
        state.consecutiveFailures = 0
        state.awaitingKeyframe = true
      }

      if let session = state.session {
        if VTDecompressionSessionCanAcceptFormatDescription(session, formatDescription: formatDescription) {
          return (session, state.awaitingKeyframe)
        }
        VTDecompressionSessionInvalidate(session)
        state.session = nil
        state.formatDescription = nil
        state.consecutiveFailures = 0
        state.awaitingKeyframe = true
      }

      var decoderSpec: CFDictionary?
      if #available(iOS 17.0, *) {
        decoderSpec =
          [
            kVTVideoDecoderSpecification_EnableHardwareAcceleratedVideoDecoder as String: false
          ] as CFDictionary
      }

      let outputAttrs: [CFString: Any] = [
        kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
      ]

      var newSession: VTDecompressionSession?
      VTDecompressionSessionCreate(
        allocator: kCFAllocatorDefault,
        formatDescription: formatDescription,
        decoderSpecification: decoderSpec,
        imageBufferAttributes: outputAttrs as CFDictionary,
        outputCallback: nil,
        decompressionSessionOut: &newSession)
      state.session = newSession
      state.formatDescription = formatDescription
      state.consecutiveFailures = 0
      state.awaitingKeyframe = true
      return (newSession, true)
    }

    if awaitingKeyframe && !isKeyframe {
      return state.withLockUnchecked { $0.lastGoodImage }
    }

    guard let session else {
      return state.withLockUnchecked { $0.lastGoodImage }
    }

    nonisolated(unsafe) var outputPixelBuffer: CVPixelBuffer?
    let decodeStatus = VTDecompressionSessionDecodeFrame(
      session,
      sampleBuffer: sampleBuffer,
      flags: [],
      infoFlagsOut: nil
    ) { status, _, imageBuffer, _, _ in
      if status == noErr, let imageBuffer {
        outputPixelBuffer = imageBuffer
      }
    }

    if decodeStatus != noErr {
      return state.withLockUnchecked { state in
        state.consecutiveFailures += 1
        if state.consecutiveFailures >= 3 {
          if let session = state.session {
            VTDecompressionSessionInvalidate(session)
          }
          state.session = nil
          state.formatDescription = nil
          state.consecutiveFailures = 0
          state.awaitingKeyframe = true
        }
        return state.lastGoodImage
      }
    }

    state.withLockUnchecked {
      $0.consecutiveFailures = 0
      if isKeyframe {
        $0.awaitingKeyframe = false
      }
    }

    guard let pixelBuffer = outputPixelBuffer else {
      return state.withLockUnchecked { $0.lastGoodImage }
    }

    let cgImage = ciContext.createCGImage(
      CIImage(cvPixelBuffer: pixelBuffer),
      from: CGRect(
        x: 0, y: 0,
        width: CVPixelBufferGetWidth(pixelBuffer),
        height: CVPixelBufferGetHeight(pixelBuffer)))
    guard let cgImage else {
      return state.withLockUnchecked { $0.lastGoodImage }
    }

    let image = UIImage(cgImage: cgImage)
    state.withLockUnchecked { $0.lastGoodImage = image }
    return image
  }
}

// MARK: - Passthrough writer

/// Persists AVAssetWriter's streaming output, not its crash-recovery movie
/// fragments. The HLS profile emits an empty-table init followed by moof/mdat
/// segments even after finishWriting. Delegate writes are serialized and a
/// failed write prevents the caller from treating the output as finalized.
final class FragmentedMP4FileOutput: NSObject, AVAssetWriterDelegate, @unchecked Sendable {
  private let lock = NSLock()
  private var handle: FileHandle?
  private var failed = false
  private var initializationCount = 0
  private var fragmentCount = 0

  init(url: URL) throws {
    try Data().write(to: url, options: .withoutOverwriting)
    handle = try FileHandle(forWritingTo: url)
    super.init()
  }

  deinit { try? handle?.close() }

  func makeWriter(fragmentInterval: CMTime) -> AVAssetWriter {
    let writer = AVAssetWriter(contentType: .mpeg4Movie)
    writer.outputFileTypeProfile = .mpeg4AppleHLS
    writer.preferredOutputSegmentInterval = fragmentInterval
    writer.initialSegmentStartTime = .zero
    writer.delegate = self
    return writer
  }

  func assetWriter(
    _ writer: AVAssetWriter,
    didOutputSegmentData segmentData: Data,
    segmentType: AVAssetSegmentType
  ) {
    lock.withLock {
      guard !failed, let handle else { failed = true; return }
      switch segmentType {
      case .initialization:
        guard initializationCount == 0, fragmentCount == 0 else { failed = true; return }
      case .separable:
        guard initializationCount == 1 else { failed = true; return }
      @unknown default:
        failed = true
        return
      }
      do {
        try handle.write(contentsOf: segmentData)
        if segmentType == .initialization { initializationCount += 1 }
        else { fragmentCount += 1 }
      } catch {
        failed = true
      }
    }
  }

  /// Call only from the writer's finishWriting completion.
  func finish() -> Bool {
    lock.withLock {
      if let handle {
        do { try handle.synchronize() } catch { failed = true }
        do { try handle.close() } catch { failed = true }
        self.handle = nil
      }
      return !failed && initializationCount == 1 && fragmentCount > 0
    }
  }
}

/// Writes the compressed HEVC track as-is: `AVAssetWriterInput` with a
/// `sourceFormatHint` and no re-encode settings. Rebases presentation timestamps
/// without changing their cadence, makes decode timestamps strictly monotonic, and
/// stamps sync-sample flags so the MOV carries a proper keyframe index. Not internally
/// synchronized: callers serialize (the ClipRecorder lock), and after `finish` the
/// writer is handed off to that one call.
final class PassthroughClipWriter: @unchecked Sendable {
  private let writer: AVAssetWriter
  private let input: AVAssetWriterInput
  private let fragmentOutput: FragmentedMP4FileOutput?
  private var timelineStart: CMTime?
  private var lastOutputDTS: CMTime?
  private var wroteAnyFrame = false

  private static let fallbackFrameRate: Int32 = 24

  init?(
    url: URL,
    firstSampleBuffer: CMSampleBuffer,
    fileType: AVFileType = .mov,
    fragmentInterval: CMTime? = nil
  ) {
    guard let formatDescription = CMSampleBufferGetFormatDescription(firstSampleBuffer) else { return nil }
    let dimensions = CMVideoFormatDescriptionGetDimensions(formatDescription)
    guard dimensions.width > 0, dimensions.height > 0 else { return nil }

    try? FileManager.default.removeItem(at: url)
    do {
      if let fragmentInterval {
        let output = try FragmentedMP4FileOutput(url: url)
        fragmentOutput = output
        writer = output.makeWriter(fragmentInterval: fragmentInterval)
      } else {
        fragmentOutput = nil
        writer = try AVAssetWriter(outputURL: url, fileType: fileType)
      }
    } catch {
      return nil
    }
    input = AVAssetWriterInput(mediaType: .video, outputSettings: nil, sourceFormatHint: formatDescription)
    input.expectsMediaDataInRealTime = true
    guard writer.canAdd(input) else { return nil }
    writer.add(input)
    guard writer.startWriting() else { return nil }
    writer.startSession(atSourceTime: .zero)
  }

  @discardableResult
  func append(_ sampleBuffer: CMSampleBuffer) -> Bool {
    guard let formatDescription = CMSampleBufferGetFormatDescription(sampleBuffer),
      CMFormatDescriptionGetMediaType(formatDescription) == kCMMediaType_Video
    else { return false }

    let sourcePTS = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
    let sourceDTS = CMSampleBufferGetDecodeTimeStamp(sampleBuffer)

    let isSync = sampleBuffer.isHEVCKeyframe()

    if timelineStart == nil { timelineStart = sourcePTS }
    guard let timelineStart else { return false }
    guard var timingInfo = Self.adjustedTiming(
      sourcePTS: sourcePTS,
      sourceDTS: sourceDTS,
      sourceDuration: CMSampleBufferGetDuration(sampleBuffer),
      timelineStart: timelineStart,
      lastOutputDTS: lastOutputDTS
    ) else { return false }
    var adjustedSampleBuffer: CMSampleBuffer?
    guard
      CMSampleBufferCreateCopyWithNewTiming(
        allocator: kCFAllocatorDefault,
        sampleBuffer: sampleBuffer,
        sampleTimingEntryCount: 1,
        sampleTimingArray: &timingInfo,
        sampleBufferOut: &adjustedSampleBuffer
      ) == noErr, let adjustedSampleBuffer
    else { return false }

    if let attachments = CMSampleBufferGetSampleAttachmentsArray(adjustedSampleBuffer, createIfNecessary: true) as? [NSMutableDictionary],
      let dict = attachments.first
    {
      dict[kCMSampleAttachmentKey_NotSync] = !isSync
      dict[kCMSampleAttachmentKey_DependsOnOthers] = !isSync
    }

    guard input.isReadyForMoreMediaData, writer.status == .writing else { return false }
    if input.append(adjustedSampleBuffer) {
      lastOutputDTS = timingInfo.decodeTimeStamp
      wroteAnyFrame = true
      return true
    }
    return false
  }

  /// Keep the media presentation timeline faithful to source PTS. Clamping PTS to
  /// the decode-time floor silently changes frame cadence when DAT timestamps arrive
  /// at a rate other than the fallback duration (for example, 30 Hz PTS with an
  /// invalid duration). Only DTS needs strict monotonicity for the muxer.
  static func adjustedTiming(
    sourcePTS: CMTime,
    sourceDTS: CMTime,
    sourceDuration: CMTime,
    timelineStart: CMTime,
    lastOutputDTS: CMTime?
  ) -> CMSampleTimingInfo? {
    guard sourcePTS.isNumeric, timelineStart.isNumeric else { return nil }
    let duration = sourceDuration.isValid && sourceDuration > .zero
      ? sourceDuration
      : CMTime(value: 1, timescale: fallbackFrameRate)
    var dts = CMTimeSubtract(
      sourceDTS.isNumeric ? sourceDTS : sourcePTS,
      timelineStart
    )
    if let lastOutputDTS, dts <= lastOutputDTS {
      let timescale = max(dts.timescale, lastOutputDTS.timescale)
      guard timescale > 0 else { return nil }
      dts = CMTimeAdd(lastOutputDTS, CMTime(value: 1, timescale: timescale))
    }
    let pts = CMTimeSubtract(sourcePTS, timelineStart)
    return CMSampleTimingInfo(duration: duration, presentationTimeStamp: pts, decodeTimeStamp: dts)
  }

  var wroteFrames: Bool { wroteAnyFrame }

  func finish(_ completion: @escaping @Sendable (Bool) -> Void) {
    input.markAsFinished()
    writer.finishWriting { [writer, fragmentOutput] in
      let outputFinished = fragmentOutput?.finish() ?? true
      completion(writer.status == .completed && outputFinished)
    }
  }
}

// MARK: - ClipRecorder

/// Records the hvc1 stream to a `.mov`, either until `stop()`/`cancel(reason:)` or for
/// a bounded `maxDuration`. `append` runs on the SDK's frame callback thread, so all
/// state is guarded by `lock`.
public final class ClipRecorder: @unchecked Sendable {
  /// Fragment interval for crash/disconnect-safe output.
  public static let fragmentInterval = CMTime(value: 2, timescale: 1)

  private let lock = NSLock()
  private var interrupted = false
  private var writer: PassthroughClipWriter?
  private var url: URL?
  private var maxDuration: Double?
  private var startTime: CFTimeInterval?
  private var completion: ClipCompletion?
  private var finishing = false

  /// Recording completions hop from the frame callback thread, so they are `@Sendable`.
  public typealias ClipCompletion = @Sendable (Result<RecordedClip, Error>) -> Void

  public init() {}

  public var isRecording: Bool {
    lock.withLock { completion != nil }
  }

  public func start(
    url: URL,
    maxDuration: Double? = nil,
    completion: @escaping ClipCompletion
  ) {
    lock.lock()
    guard self.completion == nil else {
      lock.unlock()
      completion(.failure(ClipRecorderError.alreadyRecording))
      return
    }
    self.url = url
    self.maxDuration = maxDuration
    startTime = nil
    finishing = false
    interrupted = false
    writer = nil
    self.completion = completion
    lock.unlock()
  }

  /// Ends the recording now and finalizes the file with everything captured so far.
  @discardableResult
  public func stop() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    guard completion != nil, !finishing else { return false }
    finishing = true
    finalizeLocked()
    return true
  }

  /// Ends early (stream stop, session teardown). Finalizes if any frames were written.
  public func cancel(reason: String) {
    lock.lock()
    guard completion != nil, !finishing else {
      lock.unlock()
      return
    }
    if writer == nil {
      let done = completion
      completion = nil
      lock.unlock()
      done?(.failure(ClipRecorderError.cancelled(reason)))
      return
    }
    finishing = true
    interrupted = true
    finalizeLocked()
    lock.unlock()
  }

  /// Appends a compressed stream frame. The first keyframe opens the writer — a
  /// passthrough track must start on a decodable frame or the clip plays back black.
  public func append(_ sampleBuffer: CMSampleBuffer) {
    lock.lock()
    defer { lock.unlock() }
    guard completion != nil, !finishing else { return }

    if writer == nil {
      guard sampleBuffer.isHEVCKeyframe(),
        let url,
        let newWriter = PassthroughClipWriter(
          url: url, firstSampleBuffer: sampleBuffer, fileType: .mp4, fragmentInterval: Self.fragmentInterval)
      else { return }
      writer = newWriter
      startTime = CACurrentMediaTime()
    }
    writer?.append(sampleBuffer)

    // Bounded mode: the app's requested duration is measured from the first written
    // frame, checked on the frame thread — no timer races, no early truncation.
    if let maxDuration, let startTime, CACurrentMediaTime() - startTime >= maxDuration {
      finishing = true
      finalizeLocked()
    }
  }

  // MARK: - Private (call with lock held)

  private func finalizeLocked() {
    let done = completion
    completion = nil
    guard let writer else {
      done?(.failure(ClipRecorderError.noFrames))
      return
    }
    self.writer = nil
    let duration = startTime.map { CACurrentMediaTime() - $0 } ?? 0
    let outputURL = url ?? FileManager.default.temporaryDirectory
    let wasInterrupted = interrupted
    writer.finish { [done] completed in
      guard completed else {
        done?(.failure(ClipRecorderError.writerFailed("the writer did not finish cleanly")))
        return
      }
      done?(.success(RecordedClip(url: outputURL, duration: duration, interrupted: wasInterrupted)))
    }
  }
}
