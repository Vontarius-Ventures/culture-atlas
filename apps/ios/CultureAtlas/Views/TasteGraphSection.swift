import AtlasCapture
import SwiftUI

/// Settings → Taste · background discovery (VAL-NATIVE-001): the typed graph
/// summary and its controls. Everything is server truth held by
/// `InterestGraphStore`; the explicit picks/saves above keep their ordinary
/// controls, and this section only reads them back, controls the tentative
/// photo affinities and pauses background discovery.
struct TasteGraphSection: View {
  @EnvironmentObject private var graph: InterestGraphStore

  var body: some View {
    Group {
      Section {
        switch graph.loadPhase {
        case .idle, .loading:
          HStack(spacing: 10) {
            ProgressView().controlSize(.small)
            Text("Loading your background discovery…")
              .font(.footnote)
              .foregroundStyle(AtlasTheme.muted)
          }
          .accessibilityIdentifier("taste.graph.pending")
        case .failed:
          VStack(alignment: .leading, spacing: 8) {
            Text("Your background discovery summary could not load.")
              .font(.footnote)
              .foregroundStyle(AtlasTheme.muted)
            Button("Try again") { Task { await graph.reload() } }
              .font(.callout.weight(.medium))
          }
          .accessibilityIdentifier("taste.graph.error")
        case .loaded:
          statusRows
        }
      } header: {
        Text("Background discovery")
      } footer: {
        Text("Pause stops background discovery only — your graph still follows what you save and pick.")
      }

      if let summary = graph.summary {
        confirmedSection(summary)
        tentativeSection(summary)
      }
    }
    // Fresh server truth every time Settings → Taste opens (the web section
    // reloads on mount the same way), and again on pull-to-refresh.
    .task { await graph.reload() }
  }

  // MARK: Status and pause

  @ViewBuilder
  private var statusRows: some View {
    Text(projectionLine)
      .font(.footnote)
      .foregroundStyle(AtlasTheme.muted)
      .accessibilityIdentifier("taste.graph.status")
    if let notice = graph.notice {
      Text(noticeText(notice))
        .font(.footnote)
        .foregroundStyle(AtlasTheme.ink)
        .accessibilityIdentifier("taste.graph.notice")
    }
    Button {
      Task { await graph.togglePause() }
    } label: {
      Label(
        paused ? "Resume background discovery" : "Pause background discovery",
        systemImage: paused ? "play.circle" : "pause.circle")
        .frame(maxWidth: .infinity, minHeight: 44)
    }
    .buttonStyle(.bordered)
    .disabled(graph.busyPause)
    .accessibilityIdentifier("taste.graph.pause")
  }

  private var paused: Bool { graph.summary?.settings.discoveryPaused ?? false }

  /// The honest background line, same rule as the web section.
  private var projectionLine: String {
    if paused { return "Background discovery is paused. Your graph still follows your saves and picks." }
    guard let projection = graph.summary?.projection else { return "" }
    if projection.state == .failed {
      return "Background discovery hit a problem and will retry with your next change."
    }
    if projection.state == .neverProjected { return "Background discovery follows what you save and pick." }
    if projection.lagging || projection.state == .queued || projection.state == .running {
      return "Catching up on your recent changes."
    }
    return "Up to date with your saves and picks."
  }

  private func noticeText(_ notice: InterestGraphStore.Notice) -> String {
    switch notice {
    case .conflictRefreshed: return "Just updated elsewhere. Showing the latest state."
    case .updateFailed: return "That could not be updated right now."
    case .confirmedNeedsControls:
      return "Confirmed interests change through saving or removing the item, not through the graph."
    }
  }

  // MARK: Confirmed list

  private func confirmedSection(_ summary: InterestGraphSummary) -> some View {
    Section {
      if summary.interests.items.isEmpty {
        Text("Nothing here yet. What you save and pick will appear.")
          .font(.footnote)
          .foregroundStyle(AtlasTheme.muted)
      } else {
        ForEach(summary.interests.items) { interest in
          Label(interest.title, systemImage: "checkmark.seal")
            .font(.system(.body, design: .serif))
            .accessibilityIdentifier("taste.graph.confirmed")
        }
      }
      if summary.interests.nextCursor != nil {
        moreButton(.interests, "Show more from your saves and picks")
      }
    } header: {
      Text("From your saves and picks (\(summary.counts.confirmed))")
    } footer: {
      Text("Confirmed on purpose. Change them by saving or removing items.")
    }
  }

  // MARK: Tentative list

  private func tentativeSection(_ summary: InterestGraphSummary) -> some View {
    Section {
      if summary.tentative.items.isEmpty {
        Text("Affinities your photos suggest will appear here.")
          .font(.footnote)
          .foregroundStyle(AtlasTheme.muted)
      } else {
        ForEach(summary.tentative.items) { item in
          HStack {
            Text(item.name)
              .font(.system(.body, design: .serif))
              .strikethrough(item.state == .suppressed, color: AtlasTheme.muted)
              .foregroundStyle(item.state == .suppressed ? AtlasTheme.muted : AtlasTheme.ink)
            Spacer()
            Button(item.state == .suppressed ? "Show again" : "Stop showing") {
              Task {
                await graph.setInterestState(item.edgeID, to: item.state == .suppressed ? .tentative : .suppressed)
              }
            }
            .font(.callout.weight(.medium))
            .buttonStyle(.bordered)
            .disabled(graph.busyEdges.contains(item.edgeID))
            .accessibilityLabel(
              item.state == .suppressed ? "Show again \(item.name)" : "Stop showing \(item.name)")
            .accessibilityIdentifier("taste.graph.interest")
          }
        }
      }
      if summary.tentative.nextCursor != nil {
        moreButton(.tentative, "Show more from your photos")
      }
    } header: {
      Text("Also picked up from your photos (\(summary.counts.tentative))")
    } footer: {
      Text("Tentative affinities your photos suggested. Hide one without deleting anything you saved.")
    }
  }

  private func moreButton(_ list: InterestGraphStore.List, _ title: String) -> some View {
    Button {
      Task { await graph.loadMore(list) }
    } label: {
      Label(title, systemImage: "chevron.down")
        .frame(maxWidth: .infinity, minHeight: 40)
    }
    .buttonStyle(.bordered)
    .disabled(graph.busyMore.contains(list))
  }
}
