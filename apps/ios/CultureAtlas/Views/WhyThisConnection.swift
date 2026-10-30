import AtlasCapture
import SwiftUI

/// "Why this?" for a recommendation the owner already saw (VAL-FEED-003 /
/// VAL-NATIVE-001): the pinned proof exactly as the server recorded it —
/// the owner's support roots, the shared cultural path and the permitted
/// source links. The recommendation id is the one displayed in the card
/// that was opened, never another run's reason. Every entry (first open and
/// re-entry alike) revalidates that proof with the server before showing it
/// as current, so a withdrawal another client already made shows the honest
/// unavailable record, never the previously shown one. An unavailable proof
/// is shown as unavailable, never substituted, and a record that is not the
/// owner's hides the disclosure entirely.
struct WhyThisConnection: View {
  @EnvironmentObject private var graph: InterestGraphStore
  let recommendationID: UUID

  @State private var expanded = false

  private var phase: InterestGraphStore.ConnectionPhase {
    graph.connectionPhases[recommendationID] ?? .idle
  }

  var body: some View {
    // Not ours to disclose (a foreign or gone recommendation): nothing.
    if phase != .quiet {
      VStack(alignment: .leading, spacing: 10) {
        Button {
          expanded = true
          Task { await graph.connection(for: recommendationID) }
        } label: {
          Label("Why this?", systemImage: "quote.opening")
            .font(.callout.weight(.medium))
        }
        .buttonStyle(.bordered)
        .accessibilityIdentifier("detail.why-this")

        if expanded {
          switch phase {
          case .idle, .loading:
            HStack(spacing: 8) {
              ProgressView().controlSize(.small)
              Text("Checking the record behind this…")
                .font(.footnote)
                .foregroundStyle(AtlasTheme.muted)
            }
          case .shown(let connection):
            connectionBody(connection)
          case .failed:
            VStack(alignment: .leading, spacing: 8) {
              Text("This suggestion's background could not load.")
                .font(.footnote)
                .foregroundStyle(AtlasTheme.muted)
              Button("Try again") {
                Task { await graph.connection(for: recommendationID) }
              }
              .font(.callout.weight(.medium))
            }
          case .quiet:
            EmptyView()
          }
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .accessibilityElement(children: .contain)
      .accessibilityIdentifier("detail.why-this.disclosure")
    }
  }

  // MARK: The pinned record

  @ViewBuilder
  private func connectionBody(_ connection: RecommendationConnection) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      if connection.state == .unavailable {
        Text("The background for this suggestion is no longer available.")
          .font(.callout)
          .foregroundStyle(AtlasTheme.ink)
        Text(unavailableLine(connection.unavailableReason))
          .font(.footnote)
          .foregroundStyle(AtlasTheme.muted)
      } else {
        connectedBody(connection)
      }
    }
    .padding(14)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(AtlasTheme.quiet))
    .accessibilityIdentifier("detail.why-this.record")
  }

  @ViewBuilder
  private func connectedBody(_ connection: RecommendationConnection) -> some View {
    if let text = connection.reason.text {
      Text(text)
        .font(.callout)
        .foregroundStyle(AtlasTheme.ink)
    }
    if let roots = connection.support?.roots, !roots.isEmpty {
      Text("What this builds on:")
        .font(.footnote.weight(.semibold))
        .foregroundStyle(AtlasTheme.olive)
      ForEach(Array(roots.enumerated()), id: \.offset) { _, root in
        Text(root.phrase)
          .font(.footnote)
          .foregroundStyle(AtlasTheme.ink)
      }
    }
    if let path = connection.path, !path.isEmpty {
      Text("The cultural connection:")
        .font(.footnote.weight(.semibold))
        .foregroundStyle(AtlasTheme.olive)
      ForEach(Array(path.enumerated()), id: \.offset) { _, edge in
        Text("\(edge.subject.name) — \(edge.predicateText) — \(edge.object.name)")
          .font(.footnote)
          .foregroundStyle(AtlasTheme.ink)
      }
    }
    if !connection.sources.isEmpty {
      Text("Sources:")
        .font(.footnote.weight(.semibold))
        .foregroundStyle(AtlasTheme.olive)
      ForEach(connection.sources) { source in
        VStack(alignment: .leading, spacing: 1) {
          if let url = URL(string: source.url) {
            Link(destination: url) {
              Text(source.title ?? host(source.url))
                .font(.footnote.weight(.medium))
                .underline()
            }
          }
          let detail = [source.publisher, source.locator].compactMap { $0 }
          if !detail.isEmpty {
            Text(detail.joined(separator: " · "))
              .font(.caption)
              .foregroundStyle(AtlasTheme.muted)
          }
        }
      }
    }
  }

  /// The honest line for why the pinned proof no longer serves.
  private func unavailableLine(_ reason: String?) -> String {
    switch reason {
    case "support_withdrawn": return "What it was based on has changed."
    case "proof_missing": return "It never recorded an explanation."
    case "rights_expired": return "The source link's permission ended."
    default: return "It is no longer reliably explainable."
    }
  }

  private func host(_ url: String) -> String {
    URL(string: url)?.host ?? url
  }
}
