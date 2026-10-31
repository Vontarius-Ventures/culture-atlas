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
      HStack(alignment: .firstTextBaseline) {
        Text("Keep a little of what you hear.")
          .font(.system(.title3, design: .serif))
        Spacer()
        Label("Camera off", systemImage: "video.slash")
          .font(.caption)
          .foregroundStyle(AtlasTheme.muted)
          .padding(.horizontal, 8)
          .padding(.vertical, 3)
          .background(Capsule().fill(AtlasTheme.quiet))
          .accessibilityLabel("Camera off")
      }

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

      LiveWaveform(level: music.level, recording: music.isRecording)
        .frame(height: 96)
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

      RecordButton(recording: music.isRecording, disabled: glassesSelectedButMissing) {
        if music.isRecording {
          controller.stopRecording()
        } else {
          Task { await startRecording() }
        }
      }
      .frame(maxWidth: .infinity)
      .sensoryFeedback(.impact(weight: .medium), trigger: music.isRecording)

      Text("Speech transcription is off. Review before keeping.")
        .font(.footnote)
        .foregroundStyle(AtlasTheme.muted)
      Spacer()
    }
    .padding(20)
    .background(AtlasTheme.ivory.ignoresSafeArea())
    .navigationTitle("Music")
    .navigationBarTitleDisplayMode(.inline)
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
      // Report once: inline on this screen, not also as an alert.
      error = controller.message ?? "Recording could not be saved."
      controller.message = nil
    }
  }
}

/// Keep saves to the account. Explore music on screen 20 authorizes analysis.
private struct MusicReviewSheet: View {
  @EnvironmentObject private var controller: CaptureController
  @Environment(\.dismiss) private var dismiss
  let draft: DraftRecord
  var onKeep: (DraftRecord?) -> Void

  var body: some View {
    VStack(spacing: 16) {
      Text("Keep this recording?").font(.system(.title2, design: .serif))
      Text("Keep saves it privately to your library. Explore music starts looking for the song.")
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
    .presentationCornerRadius(24)
    .tint(AtlasTheme.olive)
  }
}

/// Live microphone level as a rolling waveform: the newest sample enters on
/// the right and older ones slide left, so it reads as sound, not a gauge.
struct LiveWaveform: View {
  let level: Float
  let recording: Bool
  @State private var history: [CGFloat] = Array(repeating: 0.06, count: 36)
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    GeometryReader { geo in
      let count = history.count
      let gap: CGFloat = 4
      let barWidth = max(3, (geo.size.width - CGFloat(count - 1) * gap) / CGFloat(count))
      HStack(alignment: .center, spacing: gap) {
        ForEach(0..<count, id: \.self) { index in
          Capsule()
            .fill(recording ? AtlasTheme.olive.opacity(0.35 + 0.65 * Double(index) / Double(count)) : AtlasTheme.line)
            .frame(width: barWidth, height: max(6, geo.size.height * history[index]))
        }
      }
      .frame(width: geo.size.width, height: geo.size.height)
      .animation(reduceMotion ? nil : .easeOut(duration: 0.12), value: history)
    }
    .onChange(of: level) { _, value in
      guard recording else { return }
      history.removeFirst()
      history.append(max(0.06, min(1, CGFloat(value))))
    }
    .onChange(of: recording) { _, on in
      if !on { withAnimation(.easeOut(duration: 0.4)) { history = Array(repeating: 0.06, count: history.count) } }
    }
  }
}

/// Round record control: a red dot that morphs into a stop square.
private struct RecordButton: View {
  let recording: Bool
  let disabled: Bool
  let action: () -> Void
  @State private var pulse = false

  var body: some View {
    Button(action: action) {
      ZStack {
        Circle()
          .stroke(AtlasTheme.ink.opacity(0.85), lineWidth: 4)
          .frame(width: 84, height: 84)
        if recording {
          Circle()
            .stroke(Color.red.opacity(0.35), lineWidth: 6)
            .frame(width: 84, height: 84)
            .scaleEffect(pulse ? 1.18 : 1)
            .opacity(pulse ? 0 : 1)
        }
        RoundedRectangle(cornerRadius: recording ? 8 : 34, style: .continuous)
          .fill(Color.red)
          .frame(width: recording ? 32 : 68, height: recording ? 32 : 68)
      }
      .animation(AtlasMotion.spring, value: recording)
    }
    .buttonStyle(.pressableCard)
    .disabled(disabled)
    .opacity(disabled ? 0.4 : 1)
    .onChange(of: recording) { _, on in
      pulse = false
      if on { withAnimation(.easeOut(duration: 1.2).repeatForever(autoreverses: false)) { pulse = true } }
    }
    .accessibilityLabel(recording ? "Stop recording" : "Record")
    .accessibilityValue(recording ? "Recording audio" : "Ready")
  }
}
