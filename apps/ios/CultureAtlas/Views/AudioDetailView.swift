import AtlasCapture
import AVFoundation
import SwiftUI

/// Screen 20: audio detail, range selection, Explore music. Speech stays off.
/// The waveform is drawn from the recording itself; the part to explore is
/// chosen by dragging two handles over it (5–30 s).
struct AudioDetailView: View {
  @EnvironmentObject private var controller: CaptureController
  @EnvironmentObject private var notices: ReadyNoticeCenter
  let draft: DraftRecord

  @State private var startSeconds: Double = 0
  @State private var endSeconds: Double = Double(AtlasContract.musicRecognitionDefaultSeconds)
  @State private var playing = false
  @State private var player: AVAudioPlayer?
  @State private var playbackURL: URL?
  @State private var exploring = false
  @State private var peaks: [Float] = []
  @State private var playhead: Double?

  private var live: DraftRecord {
    controller.drafts.first(where: { $0.id == draft.id }) ?? draft
  }

  private var duration: Double { live.durationSeconds ?? 0 }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 22) {
        VStack(alignment: .leading, spacing: 4) {
          Text("A recording").font(.system(.title, design: .serif))
          Text("Audio · \(ClipClock.clock(Int(duration.rounded(.down)))) · Private · \(routeText)")
            .font(.callout)
            .foregroundStyle(AtlasTheme.muted)
        }

        VStack(alignment: .leading, spacing: 10) {
          HStack {
            Text("Choose a part").font(.system(.title3, design: .serif))
            Spacer()
            Text("\(ClipClock.clock(Int(startSeconds))) – \(ClipClock.clock(Int(endSeconds.rounded())))")
              .font(.callout.monospacedDigit())
              .foregroundStyle(AtlasTheme.olive)
              .contentTransition(.numericText())
          }
          WaveformRangePicker(
            peaks: peaks, duration: duration, start: $startSeconds, end: $endSeconds, playhead: playhead,
            minSpan: Double(AtlasContract.musicRecognitionMinSeconds),
            maxSpan: Double(AtlasContract.musicRecognitionMaxSeconds))
            .frame(height: 96)
            .disabled(duration <= 0)
          Text("Drag the handles to pick 5–30 seconds where the song is clearest.")
            .font(.footnote)
            .foregroundStyle(AtlasTheme.muted)
          Button {
            togglePlayback()
          } label: {
            Label(playing ? "Pause" : "Play this part", systemImage: playing ? "pause.fill" : "play.fill")
              .contentTransition(.symbolEffect(.replace))
              .frame(minHeight: 44)
          }
          .buttonStyle(.bordered)
          .disabled(live.byteSize == 0)
        }

        VStack(alignment: .leading, spacing: 10) {
          Text("What should we explore?").font(.system(.title3, design: .serif))
          Label("Music", systemImage: "checkmark.circle.fill")
            .foregroundStyle(AtlasTheme.olive)
          Label("Spoken references (off in Music Mode)", systemImage: "circle")
            .foregroundStyle(AtlasTheme.muted)
            .accessibilityLabel("Spoken references, off")
          Label("Sounds and atmosphere (off)", systemImage: "circle")
            .foregroundStyle(AtlasTheme.muted)
            .accessibilityLabel("Sounds and atmosphere, off")
          if CapabilityGate.musicMatch(controller.capabilities).available {
            Text("We look for the artist in this part and never guess a match.")
              .font(.footnote)
              .foregroundStyle(AtlasTheme.muted)
          } else {
            InlineBanner(text: CapabilityGate.musicMatch(controller.capabilities).message, systemImage: "lock")
          }
        }

        if CapabilityGate.musicMatch(controller.capabilities).available {
          exploreButton
        }
        Text("Saving this recording does not add everything heard to your taste.")
          .font(.footnote)
          .foregroundStyle(AtlasTheme.muted)
      }
      .padding(20)
      .animation(AtlasMotion.spring, value: live.status)
    }
    .background(AtlasTheme.ivory.ignoresSafeArea())
    .navigationTitle("Audio")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar(.hidden, for: .tabBar)
    .onAppear { applyDefaultRange() }
    .task { await loadPeaks() }
    .task(id: playing) { await trackPlayhead() }
    .onDisappear { stopPlayback() }
  }

  private var routeText: String {
    live.sourceRoute == AudioInputRoute.glassesMicrophone.rawValue ? "Glasses microphone" : "Phone microphone"
  }

  @ViewBuilder private var exploreButton: some View {
    if let assetID = live.assetID, notices.exploring.contains(assetID) || exploring {
      AnalysisLookingBanner()
      Text("Listening to your music. We'll let you know when it's ready.")
        .font(.footnote)
        .foregroundStyle(AtlasTheme.muted)
        .accessibilityAddTraits(.updatesFrequently)
    } else if live.status == .committed, let assetID = live.assetID {
      Button {
        Task { await explore(assetID: assetID) }
      } label: {
        Label("Explore music", systemImage: "sparkles").frame(maxWidth: .infinity, minHeight: 50)
      }
      .buttonStyle(.borderedProminent)
    } else if live.status == .queued || live.status == .uploading || live.status == .verifying {
      HStack(spacing: 10) {
        ProgressView().tint(AtlasTheme.olive)
        Text("Adding this recording to your library…")
          .font(.footnote)
          .foregroundStyle(AtlasTheme.muted)
      }
      .accessibilityAddTraits(.updatesFrequently)
    } else if live.status == .failed || live.status == .rejected {
      Text("This recording is on this phone. Exploring isn't available until it is in your library.")
        .font(.footnote)
        .foregroundStyle(AtlasTheme.muted)
    } else {
      Button {
        Task { await authorizeExplore() }
      } label: {
        Label("Explore music", systemImage: "sparkles").frame(maxWidth: .infinity, minHeight: 50)
      }
      .buttonStyle(.borderedProminent)
      .disabled(clampedSelection() == nil)
    }
  }

  private func applyDefaultRange() {
    let range = AudioRoutePolicy.defaultRange(durationSeconds: duration)
    startSeconds = range.start
    endSeconds = range.end
  }

  private func clampedSelection() -> (startMS: Int, endMS: Int)? {
    let start = max(0, min(startSeconds, duration))
    var end = max(start, min(endSeconds, duration))
    let span = end - start
    if duration >= Double(AtlasContract.musicRecognitionMinSeconds) {
      if span < Double(AtlasContract.musicRecognitionMinSeconds) {
        end = min(duration, start + Double(AtlasContract.musicRecognitionMinSeconds))
      }
      if end - start > Double(AtlasContract.musicRecognitionMaxSeconds) {
        end = start + Double(AtlasContract.musicRecognitionMaxSeconds)
      }
    }
    guard end > start else { return nil }
    return (Int(start * 1000), Int(end * 1000))
  }

  private func explore(assetID: UUID) async {
    guard let selection = clampedSelection() else { return }
    exploring = true
    let started = await notices.exploreMusic(assetID: assetID, startMS: selection.startMS, endMS: selection.endMS)
    exploring = false
    if !started {
      controller.message = "Exploring isn't available right now. Your recording is safe in your library."
    }
  }

  /// Keep is local. Explore authorizes upload and music analysis.
  private func authorizeExplore() async {
    guard let selection = clampedSelection() else { return }
    exploring = true
    await controller.queueAudioExplore(live, startMS: selection.startMS, endMS: selection.endMS)
    if let assetID = (controller.drafts.first { $0.id == live.id })?.assetID,
      controller.drafts.first(where: { $0.id == live.id })?.status == .committed {
      await explore(assetID: assetID)
    }
    exploring = false
  }

  // MARK: Waveform

  /// Peaks from the decrypted recording, read off the main thread. The
  /// plaintext copy is removed as soon as it has been read.
  private func loadPeaks() async {
    guard peaks.isEmpty, live.byteSize > 0, let url = try? controller.draftStore.openForPlayback(live) else { return }
    let computed = await Task.detached(priority: .userInitiated) { () -> [Float] in
      defer { try? FileManager.default.removeItem(at: url) }
      return Self.peaks(of: url, bins: 72)
    }.value
    withAnimation(AtlasMotion.spring) { peaks = computed }
  }

  nonisolated private static func peaks(of url: URL, bins: Int) -> [Float] {
    guard let file = try? AVAudioFile(forReading: url) else { return [] }
    let format = file.processingFormat
    let total = AVAudioFrameCount(file.length)
    guard total > 0, let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: total),
      (try? file.read(into: buffer)) != nil, let channel = buffer.floatChannelData?[0]
    else { return [] }
    let frames = Int(buffer.frameLength)
    let perBin = max(1, frames / bins)
    var result: [Float] = []
    result.reserveCapacity(bins)
    for bin in 0..<bins {
      let start = bin * perBin
      guard start < frames else { break }
      let end = min(frames, start + perBin)
      var peak: Float = 0
      var index = start
      // Stride so very long bins stay cheap.
      let step = max(1, (end - start) / 400)
      while index < end {
        peak = max(peak, abs(channel[index]))
        index += step
      }
      result.append(peak)
    }
    let loudest = max(0.0001, result.max() ?? 1)
    return result.map { max(0.05, $0 / loudest) }
  }

  // MARK: Playback

  private func togglePlayback() {
    if playing {
      player?.pause()
      playing = false
      return
    }
    do {
      if player == nil {
        let url = try controller.draftStore.openForPlayback(live)
        playbackURL = url
        try AVAudioSession.sharedInstance().setCategory(.playback, mode: .default)
        try AVAudioSession.sharedInstance().setActive(true)
        player = try AVAudioPlayer(contentsOf: url)
      }
      // Play the chosen part.
      if let player, player.currentTime < startSeconds || player.currentTime >= endSeconds {
        player.currentTime = startSeconds
      }
      player?.play()
      playing = true
    } catch {
      controller.message = "This recording couldn't be played."
    }
  }

  private func trackPlayhead() async {
    guard playing else {
      playhead = nil
      return
    }
    while !Task.isCancelled, playing, let player {
      playhead = player.currentTime
      if player.currentTime >= endSeconds || !player.isPlaying {
        player.pause()
        playing = false
        return
      }
      try? await Task.sleep(nanoseconds: 33_000_000)
    }
  }

  private func stopPlayback() {
    player?.stop()
    player = nil
    playing = false
    if let playbackURL {
      try? FileManager.default.removeItem(at: playbackURL)
    }
    playbackURL = nil
  }
}

/// Waveform with a selectable window: drag either handle (or the window) to
/// choose the part to explore. The span stays within `minSpan...maxSpan`.
struct WaveformRangePicker: View {
  let peaks: [Float]
  let duration: Double
  @Binding var start: Double
  @Binding var end: Double
  var playhead: Double?
  let minSpan: Double
  let maxSpan: Double

  @State private var dragOrigin: (start: Double, end: Double)?
  @GestureState private var activeHandle: Handle?

  private enum Handle { case start, end, window }

  var body: some View {
    GeometryReader { geo in
      let width = geo.size.width
      let x = { (t: Double) -> CGFloat in duration > 0 ? CGFloat(t / duration) * width : 0 }
      let bars = peaks.isEmpty ? Array(repeating: Float(0.15), count: 72) : peaks
      ZStack(alignment: .leading) {
        HStack(alignment: .center, spacing: 2) {
          ForEach(bars.indices, id: \.self) { index in
            let t = duration * Double(index) / Double(bars.count)
            Capsule()
              .fill(t >= start && t <= end ? AtlasTheme.olive : AtlasTheme.line)
              .frame(height: max(4, geo.size.height * 0.8 * CGFloat(bars[index])))
          }
        }
        .frame(width: width, height: geo.size.height)
        // Selected window.
        RoundedRectangle(cornerRadius: 10, style: .continuous)
          .stroke(AtlasTheme.olive, lineWidth: 2)
          .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(AtlasTheme.olive.opacity(0.08)))
          .frame(width: max(12, x(end) - x(start)), height: geo.size.height)
          .offset(x: x(start))
          .gesture(windowDrag(width: width))
        handle(at: x(start), height: geo.size.height, active: activeHandle == .start)
          .gesture(handleDrag(.start, width: width))
        handle(at: x(end) - 14, height: geo.size.height, active: activeHandle == .end)
          .gesture(handleDrag(.end, width: width))
        if let playhead {
          Rectangle()
            .fill(AtlasTheme.ink)
            .frame(width: 2, height: geo.size.height)
            .offset(x: x(playhead))
            .allowsHitTesting(false)
        }
      }
    }
    .sensoryFeedback(.selection, trigger: activeHandle != nil)
    .accessibilityElement()
    .accessibilityLabel("Part to explore")
    .accessibilityValue("From \(Int(start)) to \(Int(end.rounded())) seconds")
    .accessibilityAdjustableAction { direction in
      let step = 1.0
      let delta = direction == .increment ? step : -step
      let span = end - start
      let newStart = max(0, min(duration - span, start + delta))
      start = newStart
      end = newStart + span
    }
  }

  private func handle(at x: CGFloat, height: CGFloat, active: Bool) -> some View {
    RoundedRectangle(cornerRadius: 5, style: .continuous)
      .fill(AtlasTheme.olive)
      .frame(width: 14, height: height + (active ? 10 : 0))
      .overlay(Capsule().fill(.white.opacity(0.85)).frame(width: 3, height: 18))
      .shadow(color: .black.opacity(0.15), radius: active ? 6 : 2, y: 1)
      // 44 pt hit area centred on the 14 pt handle.
      .frame(width: 44, height: height)
      .contentShape(Rectangle())
      .offset(x: x - 15)
      .animation(AtlasMotion.press, value: active)
  }

  private func seconds(_ points: CGFloat, width: CGFloat) -> Double {
    width > 0 ? Double(points / width) * duration : 0
  }

  private func handleDrag(_ which: Handle, width: CGFloat) -> some Gesture {
    DragGesture(minimumDistance: 0)
      .updating($activeHandle) { _, state, _ in state = which }
      .onChanged { value in
        if dragOrigin == nil { dragOrigin = (start, end) }
        guard let origin = dragOrigin else { return }
        let delta = seconds(value.translation.width, width: width)
        let lowerSpan = min(minSpan, duration)
        if which == .start {
          let candidate = origin.start + delta
          start = max(max(0, origin.end - maxSpan), min(origin.end - lowerSpan, candidate))
        } else {
          let candidate = origin.end + delta
          end = min(min(duration, origin.start + maxSpan), max(origin.start + lowerSpan, candidate))
        }
      }
      .onEnded { _ in dragOrigin = nil }
  }

  private func windowDrag(width: CGFloat) -> some Gesture {
    DragGesture(minimumDistance: 4)
      .updating($activeHandle) { _, state, _ in state = .window }
      .onChanged { value in
        if dragOrigin == nil { dragOrigin = (start, end) }
        guard let origin = dragOrigin else { return }
        let span = origin.end - origin.start
        let shifted = max(0, min(duration - span, origin.start + seconds(value.translation.width, width: width)))
        start = shifted
        end = shifted + span
      }
      .onEnded { _ in dragOrigin = nil }
  }
}
