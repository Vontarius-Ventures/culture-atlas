import AtlasCapture
import SwiftUI

/// Boards from `GET/POST /v1/collections`. Creating a board does not invent items.
/// A failed refresh never empties the grid; it shows a quiet banner instead.
struct BoardsView: View {
  @EnvironmentObject private var controller: CaptureController
  @State private var collections: [CollectionSummary] = []
  @State private var banner: String?
  @State private var initialLoading = true
  @State private var newName = ""
  @State private var creating = false
  @FocusState private var nameFocused: Bool

  private let columns = [
    GridItem(.flexible(), spacing: 14, alignment: .top),
    GridItem(.flexible(), spacing: 14, alignment: .top),
  ]

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 18) {
        Text("Private collections you build from suggestions and captures.")
          .font(.footnote)
          .foregroundStyle(AtlasTheme.muted)
        createRow
        if let banner {
          InlineBanner(text: banner, systemImage: "wifi.exclamationmark")
            .transition(.move(edge: .top).combined(with: .opacity))
        }
        if collections.isEmpty && !initialLoading {
          EmptyBoards()
            .transition(.opacity)
        }
        LazyVGrid(columns: columns, spacing: 18) {
          ForEach(collections) { board in
            NavigationLink(value: CaptureController.CollectionSummaryRoute(id: board.id, name: board.name)) {
              BoardCoverTile(board: board, baseURL: controller.api.baseURL)
            }
            .buttonStyle(.pressableCard)
            .transition(.scale(scale: 0.92).combined(with: .opacity))
          }
        }
      }
      .padding(16)
      .padding(.bottom, 24)
      .animation(AtlasMotion.spring, value: collections.map(\.id))
      .animation(AtlasMotion.spring, value: banner)
    }
    .background(AtlasTheme.ivory.ignoresSafeArea())
    .navigationTitle("Boards")
    .navigationDestination(for: CaptureController.CollectionSummaryRoute.self) { route in
      BoardDetailView(boardID: route.id, title: route.name)
    }
    .navigationDestination(item: $controller.openBoard) { route in
      BoardDetailView(boardID: route.id, title: route.name)
    }
    .overlay {
      if initialLoading && collections.isEmpty {
        ProgressView().tint(AtlasTheme.olive)
      }
    }
    // Detached: a view update during the pull must not cancel the request.
    .refreshable { await Task { await load() }.value }
    .task { await load() }
  }

  private var createRow: some View {
    HStack(spacing: 10) {
      Image(systemName: "plus.square.dashed")
        .foregroundStyle(AtlasTheme.olive)
        .accessibilityHidden(true)
      TextField("New board name", text: $newName)
        .focused($nameFocused)
        .submitLabel(.done)
        .onSubmit { Task { await create() } }
      if !newName.trimmingCharacters(in: .whitespaces).isEmpty {
        Button {
          Task { await create() }
        } label: {
          if creating { ProgressView() } else { Text("Create").fontWeight(.semibold) }
        }
        .buttonStyle(.borderedProminent)
        .transition(.scale.combined(with: .opacity))
      }
    }
    .padding(.horizontal, 14)
    .frame(minHeight: 50)
    .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(AtlasTheme.quiet))
    .animation(AtlasMotion.spring, value: newName.isEmpty)
  }

  private func load() async {
    do {
      let loaded = try await controller.api.collections().collections
      withAnimation(AtlasMotion.spring) {
        collections = loaded
        banner = nil
      }
    } catch where AtlasClientError.isCancellation(error) {
      // A cancelled request is not a failure.
    } catch {
      withAnimation(AtlasMotion.spring) {
        banner = collections.isEmpty
          ? "Boards aren't available right now. Pull to try again."
          : "Couldn't refresh. Showing your boards from before."
      }
    }
    initialLoading = false
  }

  private func create() async {
    let trimmed = newName.trimmingCharacters(in: .whitespaces)
    guard !trimmed.isEmpty, !creating else { return }
    creating = true
    defer { creating = false }
    do {
      let created = try await controller.api.createCollection(CreateCollectionRequest(name: trimmed))
      newName = ""
      nameFocused = false
      withAnimation(AtlasMotion.spring) { collections.insert(created, at: 0) }
      controller.showFlash(Flash(text: "Created \(created.name)", systemImage: "square.grid.2x2.fill"))
    } catch {
      controller.message = "Couldn't create that board. Try a different name."
    }
  }
}

private struct EmptyBoards: View {
  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Image(systemName: "square.grid.2x2")
        .font(.system(size: 34))
        .foregroundStyle(AtlasTheme.olive)
        .accessibilityHidden(true)
      Text("No boards yet").font(.system(.title3, design: .serif))
      Text("Name one above, or tap Add to a board on anything in your feed.")
        .foregroundStyle(AtlasTheme.muted)
    }
    .padding(.vertical, 24)
  }
}

/// Non-blocking status line (never replaces content).
struct InlineBanner: View {
  let text: String
  var systemImage = "info.circle"

  var body: some View {
    Label(text, systemImage: systemImage)
      .font(.footnote)
      .foregroundStyle(AtlasTheme.muted)
      .padding(.horizontal, 12)
      .padding(.vertical, 10)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(AtlasTheme.quiet))
  }
}

struct BoardCoverTile: View {
  let board: CollectionSummary
  let baseURL: URL

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      BoardCoverMosaic(images: board.cover, baseURL: baseURL)
        .shadow(color: .black.opacity(0.06), radius: 8, y: 4)
      Text(board.name)
        .font(.system(.callout, design: .serif).weight(.medium))
        .foregroundStyle(AtlasTheme.ink)
        .lineLimit(2)
        .multilineTextAlignment(.leading)
      Text("\(board.itemCount) \(board.itemCount == 1 ? "item" : "items")")
        .font(.caption)
        .foregroundStyle(AtlasTheme.muted)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .accessibilityElement(children: .combine)
  }
}

/// Every board cover is the same square: one picture fills it, two to four
/// make a fixed 2×2 mosaic, none shows a quiet paper square with an icon.
struct BoardCoverMosaic: View {
  let images: [LibraryImage]
  let baseURL: URL

  var body: some View {
    Color.clear
      .aspectRatio(1, contentMode: .fit)
      .overlay { content }
      .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
      .accessibilityHidden(true)
  }

  @ViewBuilder private var content: some View {
    let urls = images.prefix(4).compactMap { $0.resolved(against: baseURL) }
    if urls.isEmpty {
      ZStack {
        AtlasTheme.quiet
        Image(systemName: "square.grid.2x2")
          .font(.title2)
          .foregroundStyle(AtlasTheme.line)
      }
    } else if urls.count == 1 {
      cell(urls[0])
    } else {
      let tiles = (0..<4).map { urls[$0 % urls.count] }
      Grid(horizontalSpacing: 2, verticalSpacing: 2) {
        GridRow {
          cell(tiles[0])
          cell(tiles[1])
        }
        GridRow {
          cell(tiles[2])
          cell(tiles[3])
        }
      }
    }
  }

  private func cell(_ url: URL) -> some View {
    Color.clear
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .overlay {
        RemoteImage(url: url, tier: .tile) { AtlasTheme.quiet }
      }
      .clipped()
  }
}

struct BoardDetailView: View {
  @EnvironmentObject private var controller: CaptureController
  let boardID: UUID
  let title: String
  @State private var items: [CollectionMember] = []
  @State private var banner: String?
  @State private var initialLoading = true

  private let columns = [
    GridItem(.flexible(), spacing: 14, alignment: .top),
    GridItem(.flexible(), spacing: 14, alignment: .top),
  ]

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        if let banner {
          InlineBanner(text: banner, systemImage: "wifi.exclamationmark")
        }
        if items.isEmpty && !initialLoading && banner == nil {
          VStack(alignment: .leading, spacing: 8) {
            Text("Nothing on this board yet").font(.system(.title3, design: .serif))
            Text("Open anything in your feed and tap Add to a board.")
              .foregroundStyle(AtlasTheme.muted)
            Button("Go to Feed") {
              controller.rootTab = .feed
            }
            .buttonStyle(.bordered)
            .padding(.top, 4)
          }
        }
        LazyVGrid(columns: columns, spacing: 18) {
          ForEach(items) { member in
            NavigationLink {
              FeedCardDetail(card: member.item)
            } label: {
              FeedCardTile(card: member.item, baseURL: controller.api.baseURL)
                .frame(maxHeight: .infinity, alignment: .top)
            }
            .buttonStyle(.pressableCard)
          }
        }
      }
      .padding(16)
      .padding(.bottom, 24)
      .animation(AtlasMotion.spring, value: items.map(\.id))
    }
    .background(AtlasTheme.ivory.ignoresSafeArea())
    .navigationTitle(title)
    .overlay {
      if initialLoading && items.isEmpty { ProgressView().tint(AtlasTheme.olive) }
    }
    .refreshable { await Task { await load() }.value }
    .task { await load() }
  }

  private func load() async {
    do {
      let loaded = try await controller.api.collection(boardID).items
      withAnimation(AtlasMotion.spring) {
        items = loaded
        banner = nil
      }
    } catch where AtlasClientError.isCancellation(error) {
    } catch {
      banner = items.isEmpty ? "This board isn't available right now. Pull to try again." : "Couldn't refresh this board."
    }
    initialLoading = false
  }
}

/// Shared "Add to a board" sheet: pick a board or name a new one. On success
/// it closes, plays a success haptic and shows "Added to … · View".
struct AddToBoardSheet: View {
  @EnvironmentObject private var controller: CaptureController
  @Environment(\.dismiss) private var dismiss
  let card: DiscoveryCard
  /// Boards this card is already on (from item detail), shown with a check.
  var savedIn: Set<UUID> = []
  var onAdded: (UUID) -> Void = { _ in }

  @State private var boards: [CollectionSummary] = []
  @State private var loading = true
  @State private var newBoardName = ""
  @State private var working: UUID?
  @State private var creating = false
  @State private var failed = false

  var body: some View {
    NavigationStack {
      List {
        Section {
          HStack(spacing: 12) {
            FeedCardVisual(card: card, baseURL: controller.api.baseURL)
              .frame(width: 52)
            VStack(alignment: .leading, spacing: 2) {
              Text(card.title).font(.system(.callout, design: .serif).weight(.semibold)).lineLimit(2)
              if let subtitle = card.subtitle {
                Text(subtitle).font(.caption).foregroundStyle(AtlasTheme.muted).lineLimit(1)
              }
            }
          }
          .listRowBackground(Color.clear)
        }
        Section("New board") {
          HStack {
            TextField("Board name", text: $newBoardName)
              .submitLabel(.done)
              .onSubmit { Task { await addToNew() } }
            Button {
              Task { await addToNew() }
            } label: {
              if creating { ProgressView() } else { Text("Create and add").fontWeight(.semibold) }
            }
            .disabled(newBoardName.trimmingCharacters(in: .whitespaces).isEmpty || creating)
          }
        }
        Section("Your boards") {
          if loading && boards.isEmpty {
            ProgressView().frame(maxWidth: .infinity)
          } else if boards.isEmpty {
            Text("No boards yet. Name one above.")
              .foregroundStyle(AtlasTheme.muted)
          }
          ForEach(boards) { board in
            Button {
              Task { await add(to: board) }
            } label: {
              HStack(spacing: 12) {
                BoardCoverMosaic(images: board.cover, baseURL: controller.api.baseURL)
                  .frame(width: 40)
                VStack(alignment: .leading, spacing: 2) {
                  Text(board.name).foregroundStyle(AtlasTheme.ink)
                  Text("\(board.itemCount) \(board.itemCount == 1 ? "item" : "items")")
                    .font(.caption)
                    .foregroundStyle(AtlasTheme.muted)
                }
                Spacer()
                if working == board.id {
                  ProgressView()
                } else if savedIn.contains(board.id) {
                  Image(systemName: "checkmark.circle.fill").foregroundStyle(AtlasTheme.olive)
                    .accessibilityLabel("Already on this board")
                }
              }
            }
            .disabled(working != nil)
          }
        }
      }
      .atlasListSurface()
      .navigationTitle("Add to a board")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
      .task { await loadBoards() }
      .sensoryFeedback(.error, trigger: failed)
    }
    .presentationDetents([.medium, .large])
    .presentationDragIndicator(.visible)
    .presentationCornerRadius(24)
    .tint(AtlasTheme.olive)
  }

  private func loadBoards() async {
    boards = (try? await controller.api.collections())?.collections ?? boards
    loading = false
  }

  private func addToNew() async {
    let trimmed = newBoardName.trimmingCharacters(in: .whitespaces)
    guard !trimmed.isEmpty, !creating else { return }
    creating = true
    defer { creating = false }
    do {
      let board = try await controller.api.createCollection(CreateCollectionRequest(name: trimmed))
      _ = try await controller.api.addCollectionItem(collectionID: board.id, itemID: card.id)
      finish(board.id, name: board.name)
    } catch {
      failed.toggle()
      controller.message = "Couldn't add that to a board. Try again."
    }
  }

  private func add(to board: CollectionSummary) async {
    working = board.id
    defer { working = nil }
    do {
      _ = try await controller.api.addCollectionItem(collectionID: board.id, itemID: card.id)
      finish(board.id, name: board.name)
    } catch {
      failed.toggle()
      controller.message = "Couldn't add that to a board. Try again."
    }
  }

  private func finish(_ boardID: UUID, name: String) {
    onAdded(boardID)
    dismiss()
    controller.showFlash(
      Flash(text: "Added to \(name)", systemImage: "checkmark.circle.fill", actionLabel: "View", action: .openBoard(boardID, name)))
  }
}
