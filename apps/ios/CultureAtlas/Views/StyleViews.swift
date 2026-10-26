import AtlasCapture
import SwiftUI
import UIKit

// The style reading and style-driven rails (prp/2026-10-23-style-analysis,
// section F). Every word about a claim is the server's `display` string; the
// phone never upgrades or composes wording, never shows certainty numbers,
// and never fills an empty rail with anything.

// MARK: - Experimental label

/// "Experimental" quiet pill; tapping it shows the note.
struct ExperimentalBadge: View {
  var label: String = StyleCopy.experimentalBadge
  var note: String = StyleCopy.experimentalNote
  @State private var showingNote = false

  var body: some View {
    Button {
      showingNote.toggle()
    } label: {
      Text(label)
        .font(.caption.weight(.medium))
        .foregroundStyle(AtlasTheme.ink)
        .padding(.horizontal, 10)
        .padding(.vertical, 4)
        .background(Capsule().fill(AtlasTheme.quiet))
        .overlay(Capsule().stroke(AtlasTheme.line))
        .frame(minHeight: 32)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel(label)
    .accessibilityHint(note)
    .accessibilityIdentifier("style.experimental-badge")
    .popover(isPresented: $showingNote, arrowEdge: .top) {
      Text(note)
        .font(.callout)
        .foregroundStyle(AtlasTheme.ink)
        .fixedSize(horizontal: false, vertical: true)
        .frame(width: 260, alignment: .leading)
        .padding(16)
        .presentationCompactAdaptation(.popover)
    }
  }
}

/// Badge plus the note written out (analysis screen, D.4 item 4).
struct ExperimentalNotice: View {
  let label: ExperimentalLabel

  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      ExperimentalBadge(label: label.label, note: label.note)
      Text(label.note)
        .font(.footnote)
        .foregroundStyle(AtlasTheme.muted)
        .fixedSize(horizontal: false, vertical: true)
    }
    .accessibilityElement(children: .combine)
  }
}

// MARK: - Evidence region on the photo

/// Outlines a claim's region on the photo (2 pt ivory outline, 1 pt olive
/// inner line) and dims everything else to 40 % black over 180 ms. The photo
/// is drawn aspect-fill, so the rect accounts for the crop.
struct StyleRegionOverlay: View {
  let region: StyleRegion?
  let imageAspect: Double?
  var onClear: () -> Void = {}
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    GeometryReader { geo in
      let rect = region.map { $0.rect(inAspectFill: geo.size, imageAspect: imageAspect) }
      ZStack(alignment: .topLeading) {
        if let rect, !rect.isNull, rect.width > 1, rect.height > 1 {
          Path { path in
            path.addRect(CGRect(origin: .zero, size: geo.size))
            path.addRoundedRect(in: rect, cornerSize: CGSize(width: 6, height: 6))
          }
          .fill(Color.black.opacity(0.4), style: FillStyle(eoFill: true))
          RoundedRectangle(cornerRadius: 6, style: .continuous)
            .stroke(AtlasTheme.ivory, lineWidth: 2)
            .frame(width: rect.width, height: rect.height)
            .offset(x: rect.minX, y: rect.minY)
          RoundedRectangle(cornerRadius: 5, style: .continuous)
            .stroke(AtlasTheme.olive, lineWidth: 1)
            .frame(width: max(0, rect.width - 4), height: max(0, rect.height - 4))
            .offset(x: rect.minX + 2, y: rect.minY + 2)
        }
      }
      .frame(width: geo.size.width, height: geo.size.height, alignment: .topLeading)
      .contentShape(Rectangle())
      .onTapGesture { onClear() }
      .allowsHitTesting(region != nil)
      .transition(.opacity)
    }
    .animation(reduceMotion ? nil : .easeOut(duration: 0.18), value: region)
    .accessibilityHidden(true)
    .onChange(of: region) { _, region in
      if let region {
        UIAccessibility.post(notification: .announcement, argument: "highlighted area: \(region.spokenPosition)")
      }
    }
  }
}

// MARK: - Capture style section (reading card + rails)

/// The full style presentation for one capture: the reading card, then the
/// rails in server order. `highlight` is drawn by the owner over its photo.
struct CaptureStyleSection: View {
  @ObservedObject var model: CaptureStyleViewModel
  @Binding var highlight: StyleRegion?
  let baseURL: URL
  var scrollProxy: ScrollViewProxy?
  var setCity: ((String) async throws -> Void)?

  @State private var pulsedRail: String?
  @State private var addingCity = false
  @State private var citySaved = false

  var body: some View {
    VStack(alignment: .leading, spacing: 24) {
      StyleReadingCard(
        state: model.cardState,
        experimental: model.experimental,
        highlight: $highlight,
        retryAvailable: model.retryAvailable,
        retrying: model.retrying,
        onRetry: { Task { await model.retry() } },
        onShowMore: showMore)
      ForEach(model.rails) { item in
        StyleRailSection(
          item: item, baseURL: baseURL, pulsing: pulsedRail == item.rail.key,
          citySaved: citySaved, onAddCity: setCity == nil ? nil : { addingCity = true })
          .id("rail.\(item.rail.key)")
      }
    }
    .sensoryFeedback(.selection, trigger: model.landedCount)
    .onChange(of: model.updatedCount) { _, _ in
      UIAccessibility.post(notification: .announcement, argument: StyleCopy.updated)
    }
    .sheet(isPresented: $addingCity) {
      CitySheet { city in
        try await setCity?(city)
        citySaved = true
      }
      .presentationDetents([.height(260)])
    }
  }

  /// Long-press "Show more like this style": scroll to the subject's rail and pulse its header.
  private func showMore(_ subject: StyleSubject) {
    let key = subject.rail ?? "more_like_this:\(subject.id)"
    guard model.rails.contains(where: { $0.rail.key == key }) else { return }
    withAnimation(AtlasMotion.spring) { scrollProxy?.scrollTo("rail.\(key)", anchor: .top) }
    pulsedRail = key
    Task {
      try? await Task.sleep(nanoseconds: 900_000_000)
      pulsedRail = nil
    }
  }
}

// MARK: - Style reading card

struct StyleReadingCard: View {
  let state: StyleCardState
  let experimental: ExperimentalLabel?
  @Binding var highlight: StyleRegion?
  var retryAvailable = false
  var retrying = false
  var onRetry: () -> Void = {}
  var onShowMore: (StyleSubject) -> Void = { _ in }

  @State private var selectedSubject = 0
  @State private var expanded: Set<String> = []
  @State private var revealed = false
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    switch state {
    case .absent:
      EmptyView()
    default:
      VStack(alignment: .leading, spacing: 14) {
        header
        content
      }
      .padding(16)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(RoundedRectangle(cornerRadius: 18, style: .continuous).fill(Color.white.opacity(0.55)))
      .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(AtlasTheme.line))
      .accessibilityElement(children: .contain)
      .accessibilityIdentifier("style.card")
    }
  }

  private var header: some View {
    HStack(alignment: .center, spacing: 10) {
      Text(StyleCopy.header)
        .font(.system(size: 20, design: .serif))
        .foregroundStyle(AtlasTheme.ink)
        .accessibilityAddTraits(.isHeader)
      if let experimental {
        ExperimentalBadge(label: experimental.label, note: experimental.note)
      }
      Spacer(minLength: 0)
    }
  }

  @ViewBuilder private var content: some View {
    switch state {
    case .absent:
      EmptyView()
    case .reading:
      StyleSkeleton()
    case .failed:
      VStack(alignment: .leading, spacing: 10) {
        Text(StyleCopy.failed).foregroundStyle(AtlasTheme.muted)
        if retryAvailable {
          Button {
            onRetry()
          } label: {
            HStack(spacing: 8) {
              if retrying { ProgressView().controlSize(.small) }
              Text(StyleCopy.tryAgain)
            }
            .frame(minHeight: 44)
          }
          .buttonStyle(.bordered)
          .disabled(retrying)
          .accessibilityIdentifier("style.try-again")
        }
      }
    case .empty:
      Text(StyleCopy.empty).foregroundStyle(AtlasTheme.muted)
    case .held(let message):
      Text(message).foregroundStyle(AtlasTheme.muted)
    case .ready(let reading):
      ready(reading)
    }
  }

  @ViewBuilder private func ready(_ reading: StyleReading) -> some View {
    let subjects = StylePresentation.subjects(reading)
    VStack(alignment: .leading, spacing: 14) {
      if let summary = reading.summary {
        Text(summary)
          .font(.system(size: 16))
          .foregroundStyle(AtlasTheme.ink)
          .fixedSize(horizontal: false, vertical: true)
      }
      if subjects.count > 1 {
        subjectTabs(subjects)
      }
      if let subject = subjects[safe: min(selectedSubject, subjects.count - 1)] {
        subjectBody(subject)
          .id(subject.id)
          .transition(.opacity)
      }
    }
    .onAppear { revealed = true }
    .animation(reduceMotion ? nil : .easeOut(duration: 0.2), value: subjects)
  }

  private func subjectTabs(_ subjects: [StyleSubjectPresentation]) -> some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 8) {
        ForEach(Array(subjects.enumerated()), id: \.element.id) { index, subject in
          let selected = index == min(selectedSubject, subjects.count - 1)
          Button {
            withAnimation(AtlasMotion.spring) { selectedSubject = index }
            flash(subject.subject.region)
          } label: {
            Text(subject.subject.label)
              .font(.callout.weight(.medium))
              .foregroundStyle(selected ? Color.white : AtlasTheme.ink)
              .padding(.horizontal, 14)
              .frame(minHeight: 36)
              .background(Capsule().fill(selected ? AtlasTheme.olive : AtlasTheme.quiet))
          }
          .buttonStyle(.plain)
          .accessibilityAddTraits(selected ? .isSelected : [])
        }
      }
    }
  }

  /// Selecting a subject outlines its region for 1.2 s.
  private func flash(_ region: StyleRegion?) {
    guard let region else { return }
    highlight = region
    Task {
      try? await Task.sleep(nanoseconds: 1_200_000_000)
      if highlight == region { highlight = nil }
    }
  }

  @ViewBuilder private func subjectBody(_ subject: StyleSubjectPresentation) -> some View {
    VStack(alignment: .leading, spacing: 16) {
      if !subject.aesthetics.isEmpty {
        FlowLayout(spacing: 8) {
          ForEach(Array(subject.aesthetics.enumerated()), id: \.element.id) { index, claim in
            AestheticChip(claim: claim, active: highlight != nil && highlight == claim.region) {
              toggle(claim.region)
            } onShowMore: {
              onShowMore(subject.subject)
            }
            .opacity(revealed || reduceMotion ? 1 : 0)
            .offset(y: revealed || reduceMotion ? 0 : 12)
            .animation(
              reduceMotion ? nil : .easeOut(duration: 0.2).delay(Double(min(index, 7)) * 0.04),
              value: revealed)
          }
        }
      }
      if !subject.palette.isEmpty {
        PaletteRow(swatches: subject.palette)
          .opacity(revealed || reduceMotion ? 1 : 0)
          .animation(
            reduceMotion ? nil : .easeOut(duration: 0.2).delay(Double(min(subject.aesthetics.count, 8)) * 0.04 + 0.08),
            value: revealed)
      }
      if !subject.rows.isEmpty {
        detailRows(subject)
      }
      if let brand = subject.subject.brand {
        Text("\(brand.name) · reads “\(brand.readText)”")
          .font(.footnote)
          .foregroundStyle(AtlasTheme.muted)
      }
      if let mood = subject.moodLine {
        Text(mood)
          .font(.system(.callout, design: .serif).italic())
          .foregroundStyle(AtlasTheme.ink)
      }
      if let qloo = subject.qlooLine {
        Text(qloo)
          .font(.footnote)
          .foregroundStyle(AtlasTheme.muted)
          .accessibilityIdentifier("style.qloo-links")
      }
    }
  }

  private func detailRows(_ subject: StyleSubjectPresentation) -> some View {
    let isExpanded = expanded.contains(subject.id)
    let rows = subject.visibleRows(expanded: isExpanded)
    return VStack(alignment: .leading, spacing: 10) {
      ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
        if index == 0 || rows[index - 1].group != row.group {
          Text(row.group)
            .font(.caption.weight(.semibold))
            .tracking(0.6)
            .foregroundStyle(AtlasTheme.olive)
            .padding(.top, index == 0 ? 0 : 4)
        }
        HStack(alignment: .firstTextBaseline, spacing: 8) {
          Text(row.claim.display)
            .font(.callout)
            .foregroundStyle(row.isResemblance ? AtlasTheme.muted : AtlasTheme.ink)
            .fixedSize(horizontal: false, vertical: true)
          Spacer(minLength: 4)
          if let region = row.claim.region {
            Button {
              toggle(region)
            } label: {
              Image(systemName: "scope")
                .font(.system(size: 15, weight: .regular))
                .foregroundStyle(highlight == region ? AtlasTheme.olive : AtlasTheme.muted)
                .frame(width: 32, height: 32)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Show where: \(row.claim.display)")
          }
        }
        .transition(.opacity)
      }
      if subject.hasMoreRows && !isExpanded {
        Button(StyleCopy.showDetails) {
          withAnimation(AtlasMotion.spring) { _ = expanded.insert(subject.id) }
        }
        .font(.callout.weight(.medium))
        .foregroundStyle(AtlasTheme.olive)
        .frame(minHeight: 36)
        .accessibilityIdentifier("style.show-details")
      }
    }
  }

  private func toggle(_ region: StyleRegion?) {
    guard let region else { return }
    highlight = highlight == region ? nil : region
  }
}

/// Fully rounded pill. Asserted: solid olive border and the name. Resembles:
/// dashed border and the server's "Resembles …" text. Strength is spoken only.
struct AestheticChip: View {
  let claim: StyleClaim
  var active = false
  var onTap: () -> Void = {}
  var onShowMore: () -> Void = {}

  var body: some View {
    Button(action: onTap) {
      HStack(spacing: 6) {
        Text(claim.display)
          .font(.callout.weight(claim.isAsserted ? .semibold : .regular))
          .foregroundStyle(AtlasTheme.ink)
        if claim.region != nil {
          Image(systemName: "scope")
            .font(.caption)
            .foregroundStyle(active ? AtlasTheme.olive : AtlasTheme.muted)
            .accessibilityHidden(true)
        }
      }
      .padding(.horizontal, 14)
      .frame(minHeight: 36)
      .background(Capsule().fill(active ? AtlasTheme.quiet : Color.clear))
      .overlay(
        Capsule().strokeBorder(
          AtlasTheme.olive,
          style: StrokeStyle(lineWidth: 1.5, dash: claim.isAsserted ? [] : [4, 3])))
      .contentShape(Capsule())
    }
    .buttonStyle(.pressableCard)
    .animation(.easeOut(duration: 0.2), value: claim.isAsserted)
    .contextMenu {
      Button {
        onShowMore()
      } label: {
        Label(StyleCopy.moreLikeThisStyle, systemImage: "sparkles")
      }
    }
    .accessibilityLabel(claim.display)
    .accessibilityValue(claim.strengthLabel ?? "")
    .accessibilityHint(claim.region != nil ? "Highlights it on the photo" : "")
    .accessibilityIdentifier("style.chip")
  }
}

/// Measured colors: circles sized by share, the color name below. Tapping
/// copies the name (no hex text).
struct PaletteRow: View {
  let swatches: [StyleSubjectPresentation.PaletteSwatch]
  @State private var copied = 0

  var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(alignment: .top, spacing: 14) {
        ForEach(swatches) { swatch in
          Button {
            UIPasteboard.general.string = swatch.entry.display
            copied += 1
          } label: {
            VStack(spacing: 6) {
              Circle()
                .fill(Color(hex: swatch.entry.hex))
                .overlay(Circle().stroke(Color.black.opacity(0.08)))
                .frame(width: swatch.diameter, height: swatch.diameter)
                .frame(height: 56, alignment: .center)
              Text(swatch.entry.display)
                .font(.system(size: 13))
                .foregroundStyle(AtlasTheme.muted)
                .lineLimit(2)
                .multilineTextAlignment(.center)
                .frame(width: 72)
            }
          }
          .buttonStyle(.plain)
          .accessibilityLabel(swatch.entry.display)
          .accessibilityHint("Copies the color name")
        }
      }
    }
    .sensoryFeedback(.selection, trigger: copied)
  }
}

/// Static placeholder while the style is read (no shimmer, per the guide).
struct StyleSkeleton: View {
  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack(spacing: 8) {
        ForEach([96.0, 120.0, 80.0], id: \.self) { width in
          Capsule().stroke(AtlasTheme.quiet, lineWidth: 2).frame(width: width, height: 34)
        }
      }
      HStack(spacing: 14) {
        ForEach(0..<5, id: \.self) { _ in
          Circle().fill(AtlasTheme.quiet).frame(width: 28, height: 28)
        }
      }
      Text(StyleCopy.reading)
        .font(.footnote)
        .foregroundStyle(AtlasTheme.muted)
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(StyleCopy.reading)
  }
}

// MARK: - Rails

/// One rail: serif title, the attributes that drove it, an optional
/// experimental caption, then the cards drifting by in the floating rail.
struct StyleRailSection: View {
  let item: StylePresentation.RailItem
  let baseURL: URL
  var pulsing = false
  var citySaved = false
  var onAddCity: (() -> Void)?
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      if let caption = item.caption {
        Text(caption)
          .font(.system(size: 14))
          .foregroundStyle(AtlasTheme.muted)
      }
      VStack(alignment: .leading, spacing: 2) {
        Text(item.rail.title)
          .font(.system(.title3, design: .serif))
          .foregroundStyle(AtlasTheme.ink)
          .accessibilityAddTraits(.isHeader)
        if let subtitle = item.rail.subtitle {
          Text(subtitle).font(.footnote).foregroundStyle(AtlasTheme.muted)
        }
      }
      .scaleEffect(pulsing && !reduceMotion ? 1.04 : 1, anchor: .leading)
      .animation(reduceMotion ? nil : .spring(response: 0.3, dampingFraction: 0.5), value: pulsing)
      if item.isRunning && item.rail.cards.isEmpty {
        RailSkeleton()
      } else if item.showsEmpty {
        VStack(alignment: .leading, spacing: 8) {
          Text(citySaved && item.offersAddCity ? "City saved." : item.emptyText)
            .font(.callout)
            .foregroundStyle(AtlasTheme.muted)
          if item.offersAddCity, !citySaved, let onAddCity {
            Button(StyleCopy.addCity, action: onAddCity)
              .buttonStyle(.bordered)
              .accessibilityIdentifier("style.add-city")
          }
        }
      } else {
        SimilarConveyorRail(
          cards: item.rail.cards, baseURL: baseURL, reduceMotion: reduceMotion, showsReason: true,
          identifier: "style.rail.\(item.rail.key)", cardPrefix: "style.card."
        ) { card in
          FeedCardDetail(card: card)
        }
        .padding(.horizontal, -16)
        if item.isRunning {
          Text(StyleCopy.railRunning).font(.footnote).foregroundStyle(AtlasTheme.muted)
        }
      }
    }
    .accessibilityElement(children: .contain)
  }
}

private struct RailSkeleton: View {
  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 12) {
        ForEach(0..<3, id: \.self) { _ in
          RoundedRectangle(cornerRadius: 14, style: .continuous)
            .fill(AtlasTheme.quiet)
            .frame(width: 132, height: 165)
        }
      }
      Text(StyleCopy.railRunning).font(.footnote).foregroundStyle(AtlasTheme.muted)
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(StyleCopy.railRunning)
  }
}

/// One field: the user's own city, for place suggestions. Never inferred.
struct CitySheet: View {
  let save: (String) async throws -> Void
  @Environment(\.dismiss) private var dismiss
  @State private var city = ""
  @State private var saving = false
  @State private var failed = false
  @FocusState private var focused: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      Text("Your city").font(.system(.title3, design: .serif))
      Text("Used only to find places with this style.").font(.footnote).foregroundStyle(AtlasTheme.muted)
      TextField("Los Angeles, CA", text: $city)
        .textContentType(.addressCity)
        .textFieldStyle(.roundedBorder)
        .focused($focused)
        .submitLabel(.done)
        .onSubmit(submit)
      if failed {
        Text("Couldn't save your city. Try again.").font(.footnote).foregroundStyle(AtlasTheme.muted)
      }
      Button(action: submit) {
        HStack {
          if saving { ProgressView().tint(.white) }
          Text("Save")
        }
        .frame(maxWidth: .infinity, minHeight: 44)
      }
      .buttonStyle(.borderedProminent)
      .disabled(saving || trimmed.isEmpty)
    }
    .padding(20)
    .onAppear { focused = true }
  }

  private var trimmed: String { String(city.trimmingCharacters(in: .whitespacesAndNewlines).prefix(80)) }

  private func submit() {
    guard !trimmed.isEmpty, !saving else { return }
    saving = true
    failed = false
    Task {
      do {
        try await save(trimmed)
        dismiss()
      } catch {
        failed = true
      }
      saving = false
    }
  }
}

// MARK: - Preview on the analysis screen (E.3)

/// Compact chips and swatches from the media analysis, shown before the full
/// capture loads.
struct StylePreviewView: View {
  let preview: StylePreview

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      if let summary = preview.summary {
        Text(summary).font(.callout).foregroundStyle(AtlasTheme.ink)
      }
      if !preview.aesthetics.isEmpty {
        FlowLayout(spacing: 8) {
          ForEach(preview.aesthetics) { aesthetic in
            Text(aesthetic.display)
              .font(.callout.weight(aesthetic.isAsserted ? .semibold : .regular))
              .padding(.horizontal, 12)
              .frame(minHeight: 32)
              .overlay(
                Capsule().strokeBorder(
                  AtlasTheme.olive, style: StrokeStyle(lineWidth: 1.5, dash: aesthetic.isAsserted ? [] : [4, 3])))
          }
        }
      }
      if !preview.swatches.isEmpty {
        HStack(spacing: 8) {
          ForEach(Array(preview.swatches.enumerated()), id: \.offset) { _, hex in
            Circle().fill(Color(hex: hex)).frame(width: 24, height: 24)
              .overlay(Circle().stroke(Color.black.opacity(0.08)))
          }
        }
        .accessibilityHidden(true)
      }
    }
  }
}

// MARK: - Helpers

extension Color {
  /// "#RRGGBB" from the server's measured swatches; quiet gray otherwise.
  init(hex: String) {
    if let rgb = StyleColor.rgb(hex) {
      self.init(red: rgb.red, green: rgb.green, blue: rgb.blue)
    } else {
      self = AtlasTheme.quiet
    }
  }
}

extension Array {
  subscript(safe index: Int) -> Element? { indices.contains(index) ? self[index] : nil }
}
