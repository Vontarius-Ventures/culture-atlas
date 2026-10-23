import AtlasCapture
import SwiftUI

// Screen 14 (taste picks) on a phone: three steps with a step indicator, no tab
// bar, built against specs/capture-platform-v2/design/html/14-taste-picks.html
// at 390/320 px. Selection is an olive outline plus a check, never colour alone;
// every pick is a toggle button; the counter is announced politely.

struct OnboardingFlowView: View {
  @EnvironmentObject private var onboarding: OnboardingController

  var body: some View {
    VStack(spacing: 0) {
      StepHeader()
      ScrollView {
        VStack(alignment: .leading, spacing: 20) {
          switch onboarding.step {
          case 1: ImagePickStep(settings: false)
          case 2: ChipPickStep(settings: false)
          default: ExclusionStep()
          }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 20)
      }
      PickBar()
    }
    .background(AtlasTheme.ivory.ignoresSafeArea())
    .task { if onboarding.catalog == nil { await onboarding.loadCatalog() } }
    .alert(
      "culture atlas",
      isPresented: Binding(get: { onboarding.message != nil }, set: { if !$0 { onboarding.message = nil } })
    ) {
      Button("OK", role: .cancel) {}
    } message: {
      Text(onboarding.message ?? "")
    }
  }
}

private struct StepHeader: View {
  @EnvironmentObject private var onboarding: OnboardingController

  var body: some View {
    HStack {
      if onboarding.step > 1 {
        Button {
          onboarding.step -= 1
        } label: {
          Label(OnboardingCopy.back, systemImage: "arrow.left").frame(minHeight: 44)
        }
      }
      Spacer()
      HStack(spacing: 12) {
        Text(OnboardingCopy.step(onboarding.step))
          .font(.footnote)
          .foregroundStyle(AtlasTheme.muted)
        HStack(spacing: 4) {
          ForEach(1...3, id: \.self) { n in
            Capsule()
              .fill(n == onboarding.step ? AtlasTheme.ink : AtlasTheme.line)
              .frame(width: 22, height: 4)
          }
        }
        .accessibilityHidden(true)
      }
    }
    .padding(.horizontal, 16)
    .frame(minHeight: 52)
  }
}

/// Sticky bar: progress, counter (live region) and the primary action.
private struct PickBar: View {
  @EnvironmentObject private var onboarding: OnboardingController

  var body: some View {
    let counter = onboarding.counter
    VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 12) {
        HStack(spacing: 6) {
          ForEach(0..<OnboardingPolicy.minPicks, id: \.self) { i in
            Capsule()
              .fill(i < counter.progress ? AtlasTheme.olive : AtlasTheme.line)
              .frame(width: 28, height: 6)
          }
        }
        .accessibilityHidden(true)
        Text(counter.text)
          .font(.system(.title3, design: .serif))
          .foregroundStyle(counter.canComplete ? AtlasTheme.olive : AtlasTheme.ink)
          .accessibilityAddTraits(.updatesFrequently)
        Spacer()
        if onboarding.step < 3 {
          Button {
            onboarding.step += 1
          } label: {
            Label(OnboardingCopy.next, systemImage: "arrow.right")
              .labelStyle(TrailingIconLabelStyle())
              .frame(minHeight: 44)
          }
          .buttonStyle(.borderedProminent)
          .tint(counter.canComplete ? AtlasTheme.olive : AtlasTheme.line)
          .foregroundStyle(counter.canComplete ? Color.white : AtlasTheme.ink)
        }
      }
      if onboarding.step == 3 {
        if !counter.canComplete {
          Text(OnboardingCopy.primaryDisabled)
            .font(.footnote)
            .foregroundStyle(AtlasTheme.muted)
        }
        Button {
          Task { await onboarding.buildFeed() }
        } label: {
          Text(OnboardingCopy.primary).frame(maxWidth: .infinity, minHeight: 48)
        }
        .buttonStyle(.borderedProminent)
        .disabled(!counter.canComplete || onboarding.completing)
        .accessibilityHint(counter.canComplete ? "" : OnboardingCopy.primaryDisabled)
      }
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 12)
    .background(AtlasTheme.ivory)
    .overlay(alignment: .top) { Divider() }
    .onChange(of: counter.text) { _, text in
      AccessibilityNotification.Announcement(text).post()
    }
  }
}

struct ImagePickStep: View {
  @EnvironmentObject private var onboarding: OnboardingController
  let settings: Bool

  private let columns = [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)]

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(OnboardingCopy.imagesTitle)
        .font(.system(.title, design: .serif))
        .accessibilityAddTraits(.isHeader)
      if !settings {
        Text(OnboardingCopy.hint).foregroundStyle(AtlasTheme.muted)
      }
    }
    if let catalog = onboarding.catalog {
      LazyVGrid(columns: columns, spacing: 16) {
        ForEach(catalog.images) { entry in
          PickTile(entry: entry, settings: settings)
        }
      }
    } else {
      ProgressView().frame(maxWidth: .infinity, minHeight: 120)
    }
  }
}

private struct PickTile: View {
  @EnvironmentObject private var onboarding: OnboardingController
  let entry: OnboardingCatalogEntry
  let settings: Bool

  var body: some View {
    let picked = onboarding.isPicked(entry)
    Button {
      Task { await onboarding.toggle(entry, settings: settings) }
    } label: {
      VStack(alignment: .leading, spacing: 6) {
        ZStack(alignment: .topTrailing) {
          AsyncImage(url: entry.image?.resolved(against: onboarding.api.baseURL)) { image in
            image.resizable().scaledToFill()
          } placeholder: {
            AtlasTheme.quiet
          }
          .frame(maxWidth: .infinity)
          .aspectRatio(4 / 5, contentMode: .fit)
          .clipShape(RoundedRectangle(cornerRadius: 12))
          .overlay(
            RoundedRectangle(cornerRadius: 12)
              .stroke(picked ? AtlasTheme.olive : .clear, lineWidth: 3))
          if picked {
            Image(systemName: "checkmark")
              .font(.footnote.weight(.bold))
              .foregroundStyle(.white)
              .padding(6)
              .background(Circle().fill(AtlasTheme.olive))
              .padding(8)
          }
        }
        Text(entry.label)
          .font(.callout.weight(picked ? .semibold : .regular))
          .foregroundStyle(AtlasTheme.ink)
      }
    }
    .buttonStyle(.plain)
    .disabled(onboarding.busyIDs.contains(entry.id))
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(entry.image?.alt.isEmpty == false ? "\(entry.label). \(entry.image!.alt)" : entry.label)
    .accessibilityAddTraits(picked ? [.isButton, .isSelected] : .isButton)
  }
}

struct ChipPickStep: View {
  @EnvironmentObject private var onboarding: OnboardingController
  let settings: Bool

  var body: some View {
    Text(OnboardingCopy.chipsTitle)
      .font(.system(.title, design: .serif))
      .accessibilityAddTraits(.isHeader)
    if onboarding.catalog != nil {
      FlowLayout(spacing: 8) {
        ForEach(mixedChips) { entry in
          let picked = onboarding.isPicked(entry)
          VStack(alignment: .leading, spacing: 2) {
            Text(OnboardingCopy.group(entry.category))
              .font(.caption2)
              .foregroundStyle(AtlasTheme.muted)
            PillToggle(label: entry.label, selected: picked) {
              Task { await onboarding.toggle(entry, settings: settings) }
            }
            .disabled(onboarding.busyIDs.contains(entry.id))
          }
        }
      }
    } else {
      ProgressView().frame(maxWidth: .infinity, minHeight: 120)
    }
    SearchBlock(settings: settings)
  }

  /// Round-robin Wear / Play / Watch / Eat so the first screen is not one category.
  private var mixedChips: [OnboardingCatalogEntry] {
    guard let catalog = onboarding.catalog else { return [] }
    var queues = Dictionary(uniqueKeysWithValues: TasteCategory.allCases.map { ($0, catalog.chips[$0]) })
    var out: [OnboardingCatalogEntry] = []
    var index = 0
    let order = TasteCategory.allCases
    while queues.values.contains(where: { !$0.isEmpty }) && index < 64 {
      let category = order[index % order.count]
      if var remaining = queues[category], !remaining.isEmpty {
        out.append(remaining.removeFirst())
        queues[category] = remaining
      }
      index += 1
    }
    return out
  }
}

private struct SearchBlock: View {
  @EnvironmentObject private var onboarding: OnboardingController
  let settings: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text(OnboardingCopy.searchPlaceholder)
        .font(.system(.title3, design: .serif))
      TextField(OnboardingCopy.searchPlaceholder, text: $onboarding.searchText)
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .submitLabel(.search)
        .padding(12)
        .frame(minHeight: 44)
        .background(RoundedRectangle(cornerRadius: 10).stroke(AtlasTheme.muted))
      if onboarding.searchUnavailable {
        Label(OnboardingCopy.searchUnavailable, systemImage: "info.circle")
          .font(.callout)
          .foregroundStyle(AtlasTheme.muted)
      } else if !onboarding.searchResults.isEmpty {
        VStack(spacing: 4) {
          ForEach(onboarding.searchResults) { result in
            let added = onboarding.isPicked(result)
            Button {
              Task { await onboarding.add(result, settings: settings) }
            } label: {
              HStack(spacing: 12) {
                Text(result.name).fontWeight(.medium).foregroundStyle(AtlasTheme.ink)
                Text(result.typeLabel).font(.subheadline).foregroundStyle(AtlasTheme.muted)
                Spacer()
                if added {
                  Label(OnboardingCopy.searchAdded, systemImage: "checkmark")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(AtlasTheme.olive)
                } else {
                  Label(OnboardingCopy.searchAdd, systemImage: "plus")
                    .font(.subheadline)
                    .foregroundStyle(AtlasTheme.muted)
                }
              }
              .padding(.horizontal, 12)
              .frame(minHeight: 52)
              .overlay(RoundedRectangle(cornerRadius: 10).stroke(added ? AtlasTheme.olive : .clear, lineWidth: 2))
            }
            .buttonStyle(.plain)
            .disabled(added || onboarding.busyIDs.contains(result.resultID))
            .accessibilityAddTraits(added ? [.isButton, .isSelected] : .isButton)
          }
        }
        .padding(4)
        .background(RoundedRectangle(cornerRadius: 12).stroke(AtlasTheme.line))
      }
    }
    .padding(.top, 12)
  }
}

struct ExclusionStep: View {
  @EnvironmentObject private var onboarding: OnboardingController
  @State private var other = ""

  var body: some View {
    HStack(alignment: .firstTextBaseline) {
      Text(OnboardingCopy.exclusionsTitle)
        .font(.system(.title, design: .serif))
        .accessibilityAddTraits(.isHeader)
      Text(OnboardingCopy.exclusionsOptional).font(.footnote).foregroundStyle(AtlasTheme.muted)
    }
    Text(OnboardingCopy.exclusionsNote).foregroundStyle(AtlasTheme.muted)
    ExclusionEditor(other: $other)
  }
}

/// Suggestion pills plus "Something else"; shared by onboarding and Settings → Taste.
struct ExclusionEditor: View {
  @EnvironmentObject private var onboarding: OnboardingController
  @Binding var other: String

  var body: some View {
    let suggestions = onboarding.catalog?.exclusionSuggestions ?? []
    let custom = onboarding.exclusions.filter { term in !suggestions.contains { $0.lowercased() == term.lowercased() } }
    FlowLayout(spacing: 8) {
      ForEach(suggestions + custom, id: \.self) { term in
        PillToggle(label: OnboardingPolicy.label(term), selected: onboarding.isExcluded(term)) {
          onboarding.toggleExclusion(term)
        }
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Foods to leave out")
    HStack(spacing: 8) {
      TextField(OnboardingCopy.exclusionsOther, text: $other)
        .padding(12)
        .frame(minHeight: 44)
        .background(RoundedRectangle(cornerRadius: 10).stroke(AtlasTheme.muted))
        .onSubmit(addOther)
      Button(OnboardingCopy.searchAdd, action: addOther)
        .buttonStyle(.bordered)
        .frame(minHeight: 44)
        .disabled(other.trimmingCharacters(in: .whitespaces).isEmpty)
    }
  }

  private func addOther() {
    if onboarding.addOtherExclusion(other) == nil { other = "" }
  }
}

/// Filter-pill toggle: olive outline and a check when selected (not colour alone).
struct PillToggle: View {
  let label: String
  let selected: Bool
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 6) {
        if selected { Image(systemName: "checkmark").font(.footnote.weight(.bold)) }
        Text(label)
      }
      .padding(.horizontal, 14)
      .frame(minHeight: 44)
      .foregroundStyle(selected ? AtlasTheme.olive : AtlasTheme.ink)
      .background(Capsule().fill(selected ? AtlasTheme.olive.opacity(0.08) : AtlasTheme.ivory))
      .overlay(Capsule().stroke(selected ? AtlasTheme.olive : AtlasTheme.line, lineWidth: selected ? 2 : 1))
    }
    .buttonStyle(.plain)
    .accessibilityLabel(label)
    .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
  }
}

struct TrailingIconLabelStyle: LabelStyle {
  func makeBody(configuration: Configuration) -> some View {
    HStack(spacing: 6) {
      configuration.title
      configuration.icon
    }
  }
}

/// Wrapping row layout for pills.
struct FlowLayout: Layout {
  var spacing: CGFloat = 8

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    let width = proposal.width ?? .infinity
    var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0, widest: CGFloat = 0
    for view in subviews {
      let size = view.sizeThatFits(.unspecified)
      if x > 0, x + size.width > width {
        y += rowHeight + spacing
        x = 0
        rowHeight = 0
      }
      x += size.width + spacing
      rowHeight = max(rowHeight, size.height)
      widest = max(widest, x - spacing)
    }
    return CGSize(width: min(widest, width), height: y + rowHeight)
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    var x = bounds.minX, y = bounds.minY, rowHeight: CGFloat = 0
    for view in subviews {
      let size = view.sizeThatFits(.unspecified)
      if x > bounds.minX, x + size.width > bounds.maxX {
        y += rowHeight + spacing
        x = bounds.minX
        rowHeight = 0
      }
      view.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
      x += size.width + spacing
      rowHeight = max(rowHeight, size.height)
    }
  }
}

// MARK: - Screen 15: Building your feed

struct BuildingFeedView: View {
  @EnvironmentObject private var onboarding: OnboardingController

  private let columns = [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)]

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        // Quiet collage of what was picked.
        LazyVGrid(columns: columns, spacing: 8) {
          ForEach(onboarding.picks.prefix(6)) { pick in
            Group {
              if let url = pick.image?.resolved(against: onboarding.api.baseURL) {
                AsyncImage(url: url) { $0.resizable().scaledToFill() } placeholder: { AtlasTheme.quiet }
              } else {
                ZStack {
                  AtlasTheme.quiet
                  Text(pick.label).font(.footnote).multilineTextAlignment(.center).padding(6)
                }
              }
            }
            .aspectRatio(1, contentMode: .fit)
            .clipShape(RoundedRectangle(cornerRadius: 10))
          }
        }
        .accessibilityHidden(true)
        Text(OnboardingCopy.buildingTitle)
          .font(.system(.largeTitle, design: .serif))
          .accessibilityAddTraits(.isHeader)
        Text(OnboardingCopy.buildingLede).foregroundStyle(AtlasTheme.muted)
        if let seed = onboarding.seed {
          VStack(spacing: 0) {
            ForEach(seed.categories, id: \.category) { row in
              HStack {
                Text(OnboardingCopy.group(row.category))
                Spacer()
                Text(row.state == .ready ? OnboardingCopy.buildingCategoryReady : OnboardingCopy.buildingCategoryLooking)
                  .foregroundStyle(row.state == .ready ? AtlasTheme.olive : AtlasTheme.muted)
              }
              .frame(minHeight: 44)
              .accessibilityElement(children: .combine)
              Divider()
            }
          }
        }
        if onboarding.seedAction == .background {
          Text(OnboardingCopy.buildingUnavailable)
            .accessibilityAddTraits(.updatesFrequently)
          Button {
            onboarding.finish()
          } label: {
            Text(OnboardingCopy.seeFeed).frame(maxWidth: .infinity, minHeight: 48)
          }
          .buttonStyle(.borderedProminent)
        }
      }
      .padding(16)
    }
    .background(AtlasTheme.ivory.ignoresSafeArea())
  }
}

// MARK: - Screen 18: Settings → Taste

struct TasteSettingsView: View {
  @EnvironmentObject private var onboarding: OnboardingController
  @State private var addingMore = false
  @State private var other = ""

  var body: some View {
    List {
      Section {
        Text(OnboardingCopy.tasteLede).foregroundStyle(AtlasTheme.muted)
        Button(OnboardingCopy.tasteAddMore) { addingMore = true }
      }
      ForEach(TasteCategory.allCases) { category in
        let picks = onboarding.picks(in: category)
        if !picks.isEmpty {
          Section(OnboardingCopy.group(category)) {
            ForEach(picks) { pick in PickRow(pick: pick) }
          }
        }
      }
      let uncategorized = onboarding.picks(in: nil)
      if !uncategorized.isEmpty {
        Section { ForEach(uncategorized) { pick in PickRow(pick: pick) } }
      }
      Section(OnboardingCopy.exclusionsTitle) {
        Text(OnboardingCopy.exclusionsNote).font(.footnote).foregroundStyle(AtlasTheme.muted)
        ExclusionEditor(other: $other)
        Button(OnboardingCopy.tasteSave) { Task { _ = await onboarding.saveExclusions() } }
      }
    }
    .navigationTitle(OnboardingCopy.tasteTitle)
    .task { await onboarding.loadTaste() }
    .refreshable { await onboarding.loadTaste() }
    .sheet(isPresented: $addingMore, onDismiss: { Task { await onboarding.loadTaste() } }) {
      NavigationStack {
        ScrollView {
          VStack(alignment: .leading, spacing: 20) {
            ImagePickStep(settings: true)
            ChipPickStep(settings: true)
          }
          .padding(16)
        }
        .navigationTitle(OnboardingCopy.tasteAddMore)
        .toolbar {
          ToolbarItem(placement: .confirmationAction) {
            Button(OnboardingCopy.tasteDone) { addingMore = false }
          }
        }
      }
      .environmentObject(onboarding)
    }
  }
}

private struct PickRow: View {
  @EnvironmentObject private var onboarding: OnboardingController
  let pick: OnboardingPick

  var body: some View {
    HStack {
      Text(pick.label)
      Spacer()
      // Removing below 3 is allowed here; the minimum applies only to finishing onboarding.
      Button {
        Task { await onboarding.remove(pick) }
      } label: {
        Image(systemName: "xmark.circle").frame(minWidth: 44, minHeight: 44)
      }
      .buttonStyle(.plain)
      .accessibilityLabel(OnboardingCopy.tasteRemove(pick.label))
    }
  }
}
