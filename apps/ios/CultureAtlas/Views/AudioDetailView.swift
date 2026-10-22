import AtlasCapture
import AVFoundation
import SwiftUI

/// Screen 20: audio detail, range selection, Explore music. Speech stays off.
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

  private var live: DraftRecord {
    controller.drafts.first(where: { $0.id == draft.id }) ?? draft
  }

  private var duration: Double { live.durationSeconds ?? 0 }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        Text("A recording").font(.system(.title, design: .serif))
        Text("Audio · \(ClipClock.clock(Int(duration.rounded(.down)))) · Private")
          .foregroundStyle(AtlasTheme.muted)
        if let route = live.sourceRoute {
          Text(route == AudioInputRoute.glassesMicrophone.rawValue ? "Glasses microphone" : "Phone microphone")
            .font(.footnote)
            .foregroundStyle(AtlasTheme.muted)
        }

        LevelMeter(level: playing ? 0.6 : 0.15, recording: playing)
          .frame(height: 80)
          .accessibilityLabel("Audio waveform")

        Button(playing ? "Pause audio" : "Play audio") { togglePlayback() }
          .disabled(live.byteSize == 0)

        Group {
          Text("Choose a part").font(.system(.title3, design: .serif))
          HStack {
            VStack(alignment: .leading) {
              Text("From")
              TextField("0", value: $startSeconds, format: .number)
                .keyboardType(.numberPad)
                .textFieldStyle(.roundedBorder)
                .frame(width: 90)
              Text("seconds").font(.footnote).foregroundStyle(AtlasTheme.muted)
            }
            VStack(alignment: .leading) {
              Text("To")
              TextField("15", value: $endSeconds, format: .number)
                .keyboardType(.numberPad)
                .textFieldStyle(.roundedBorder)
                .frame(width: 90)
              Text("seconds").font(.footnote).foregroundStyle(AtlasTheme.muted)
            }
          }
        }
        .disabled(duration <= 0)

        VStack(alignment: .leading, spacing: 12) {
          Text("What should we explore?").font(.system(.title3, design: .serif))
          Label("Music", systemImage: "checkmark.circle.fill")
          Label("Spoken references", systemImage: "circle")
            .foregroundStyle(AtlasTheme.muted)
            .accessibilityLabel("Spoken references, off")
          Text("Speech transcription is off in Music Mode.")
            .font(.footnote)
            .foregroundStyle(AtlasTheme.muted)
          Label("Sounds and atmosphere", systemImage: "circle")
            .foregroundStyle(AtlasTheme.muted)
            .accessibilityLabel("Sounds and atmosphere, off")
        }

        exploreButton
        Text("Saving this recording does not add everything heard to your taste.")
          .font(.footnote)
          .foregroundStyle(AtlasTheme.muted)
      }
      .padding(20)
    }
    .background(AtlasTheme.ivory.ignoresSafeArea())
    .navigationTitle("Audio")
    .toolbar(.hidden, for: .tabBar)
    .onAppear { applyDefaultRange() }
    .onDisappear { stopPlayback() }
  }

  @ViewBuilder private var exploreButton: some View {
    if let assetID = live.assetID, notices.exploring.contains(assetID) || exploring {
      Text("Looking at your music. This takes a few seconds.")
        .font(.footnote)
        .foregroundStyle(AtlasTheme.muted)
        .accessibilityAddTraits(.updatesFrequently)
    } else if live.status == .committed, let assetID = live.assetID {
      Button {
        Task { await explore(assetID: assetID) }
      } label: {
        Text("Explore music").frame(maxWidth: .infinity, minHeight: 48)
      }
      .buttonStyle(.borderedProminent)
    } else if live.status == .queued || live.status == .uploading || live.status == .verifying {
      Text("Waiting until this recording is in your library. Uploading does not start analysis.")
        .font(.footnote)
        .foregroundStyle(AtlasTheme.muted)
        .accessibilityAddTraits(.updatesFrequently)
    } else if live.status == .failed || live.status == .rejected {
      Text("This recording is on this phone. Exploring isn't available until it is in your library.")
        .font(.footnote)
        .foregroundStyle(AtlasTheme.muted)
    } else {
      Button {
        Task { await authorizeExplore() }
      } label: {
        Text("Explore music").frame(maxWidth: .infinity, minHeight: 48)
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
      player?.play()
      playing = true
    } catch {
      controller.message = "This recording couldn't be played."
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
