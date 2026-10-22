import AtlasCapture
import SwiftUI

/// Screen 19: Music recorder. Camera stays off; only the microphone is used.
struct MusicView: View {
  @EnvironmentObject private var controller: CaptureController
  @ObservedObject private var music = AppEnvironment.shared.controller.music
  @State private var selectedRoute: AudioInputRoute = .phoneMicrophone
  @State private var startedAt: Date?
  @State private var review: DraftRecord?
  @State private var detailID: UUID?
  @State private var error: String?

  var body: some View {
    let glasses = music.options.first { $0.route == .glassesMicrophone }
    let glassesAvailable = glasses?.available == true
    let glassesSelectedButMissing = selectedRoute == .glassesMicrophone && !glassesAvailable
    VStack(alignment: .leading, spacing: 16) {
      HStack {
        Text("Music").font(.system(.title2, design: .serif))
        Text("Camera off")
          .font(.caption)
          .padding(.horizontal, 8)
          .padding(.vertical, 2)
          .background(Capsule().fill(AtlasTheme.quiet))
          .accessibilityLabel("Camera off")
      }
      Text("Keep a little of what you hear.").foregroundStyle(AtlasTheme.muted)

      Picker("Microphone", selection: $selectedRoute) {
        Text("Phone microphone").tag(AudioInputRoute.phoneMicrophone)
        if glassesAvailable {
          Text("Glasses microphone · Verified input").tag(AudioInputRoute.glassesMicrophone)
        }
      }
      .pickerStyle(.menu)
      .disabled(music.isRecording)
      .accessibilityHint("Choose which microphone to record with")

      if !glassesAvailable {
        Text("Glasses microphone unavailable")
          .font(.footnote)
          .foregroundStyle(AtlasTheme.muted)
        Text("Choose this phone to record here. culture atlas will not switch microphones for you.")
          .font(.footnote)
          .foregroundStyle(AtlasTheme.muted)
      } else {
        Text("Experimental glasses route").font(.footnote).foregroundStyle(AtlasTheme.olive)
      }

      if glassesSelectedButMissing {
        Text("Glasses microphone unavailable. Choose this phone to keep recording here.")
          .font(.footnote)
          .accessibilityAddTraits(.isStaticText)
      }

      LevelMeter(level: music.level, recording: music.isRecording)
        .frame(height: 90)
        .accessibilityLabel("Microphone levels")
        .accessibilityValue(music.isRecording ? "Recording" : "Idle")

      TimelineView(.periodic(from: .now, by: 0.5)) { context in
        let elapsed = startedAt.map { context.date.timeIntervalSince($0) } ?? 0
        let display = ClipClock(limitSeconds: AtlasContract.audioMaxSeconds).display(elapsed: elapsed)
        VStack(alignment: .leading, spacing: 4) {
          Text(display.elapsedText)
            .font(.system(size: 46, design: .serif))
            .monospacedDigit()
          HStack {
            Image(systemName: music.isRecording ? "record.circle" : "pause.circle")
              .accessibilityHidden(true)
            Text(music.isRecording ? "Recording audio" : "Ready to record")
            if let left = display.countdown { Text("\(left) s left").bold() }
          }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(
          music.isRecording ? display.accessibilityText : "Ready to record, \(display.elapsedText)")
        .accessibilityAddTraits(.updatesFrequently)
      }

      if let error { Text(error).foregroundStyle(.red).accessibilityAddTraits(.isStaticText) }

      if music.isRecording {
        Button(role: .destructive) {
          controller.stopRecording()
        } label: {
          Text("Stop recording").frame(maxWidth: .infinity, minHeight: 48)
        }
        .buttonStyle(.borderedProminent)
        .accessibilityLabel("Stop recording")
        .accessibilityValue("Recording audio")
      } else {
        Button {
          Task { await startRecording() }
        } label: {
          Text("Record").frame(maxWidth: .infinity, minHeight: 48)
        }
        .buttonStyle(.borderedProminent)
        .disabled(glassesSelectedButMissing)
        .accessibilityLabel("Record")
        .accessibilityValue("Ready")
      }

      Text("Speech transcription is off. Review before keeping.")
        .font(.footnote)
        .foregroundStyle(AtlasTheme.muted)
      Spacer()
    }
    .padding(20)
    .background(AtlasTheme.ivory.ignoresSafeArea())
    .navigationTitle("Music")
    .toolbar(.hidden, for: .tabBar)
    .task { music.refreshRoutes() }
    .onChange(of: glassesAvailable) { _, available in
      // Never silently fall back to the phone.
      if selectedRoute == .glassesMicrophone, !available, !music.isRecording {
        error = "Glasses microphone unavailable. Choose this phone to record here."
      }
    }
    .sheet(item: $review) { draft in
      MusicReviewSheet(draft: draft) { kept in
        if let kept { detailID = kept.id }
      }
    }
    .navigationDestination(isPresented: Binding(
      get: { detailID != nil },
      set: { if !$0 { detailID = nil } }
    )) {
      if let detailID, let draft = controller.drafts.first(where: { $0.id == detailID }) {
        AudioDetailView(draft: draft)
      }
    }
  }

  private func startRecording() async {
    error = nil
    music.refreshRoutes()
    let glassesAvailable = music.options.first { $0.route == .glassesMicrophone }?.available == true
    if selectedRoute == .glassesMicrophone, !glassesAvailable {
      error = MusicCapture.CaptureError.glassesUnavailable.errorDescription
      return
    }
    startedAt = Date()
    let draft = await controller.recordAudio(route: selectedRoute)
    startedAt = nil
    if let draft {
      review = draft
    } else {
      error = controller.message
    }
  }
}

/// Keep is local. Explore music on screen 20 authorizes upload and analysis.
private struct MusicReviewSheet: View {
  @EnvironmentObject private var controller: CaptureController
  @Environment(\.dismiss) private var dismiss
  let draft: DraftRecord
  var onKeep: (DraftRecord?) -> Void

  var body: some View {
    VStack(spacing: 16) {
      Text("Keep this recording?").font(.system(.title2, design: .serif))
      Text("Keep saves it on this phone. Explore music uploads it and starts looking.")
        .foregroundStyle(AtlasTheme.muted)
      if draft.interrupted {
        Text("Recording was interrupted. The part before the interruption was kept.")
      }
      HStack {
        Button("Delete", role: .destructive) {
          Task {
            await controller.discard(draft)
            onKeep(nil)
            dismiss()
          }
        }
        Button("Keep") {
          Task {
            await controller.keep(draft)
            onKeep(draft)
            dismiss()
          }
        }
        .buttonStyle(.borderedProminent)
      }
    }
    .padding(24)
    .presentationDetents([.medium])
  }
}

struct LevelMeter: View {
  let level: Float
  let recording: Bool
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    GeometryReader { geo in
      let bars = 24
      HStack(alignment: .center, spacing: 4) {
        ForEach(0..<bars, id: \.self) { index in
          let threshold = Float(index) / Float(bars)
          Capsule()
            .fill(recording && level > threshold ? AtlasTheme.olive : AtlasTheme.quiet)
            .frame(width: max(4, (geo.size.width - CGFloat(bars - 1) * 4) / CGFloat(bars)),
                   height: reduceMotion ? geo.size.height * 0.4 : geo.size.height * CGFloat(0.25 + 0.75 * abs(sin(Double(index) * 0.4))))
        }
      }
    }
  }
}
