import AtlasCapture
import SwiftUI

/// Boards from `GET/POST /v1/collections`. Creating a board does not invent items.
struct BoardsView: View {
  @EnvironmentObject private var controller: CaptureController
  @EnvironmentObject private var notices: ReadyNoticeCenter
  @State private var collections: [CollectionSummary] = []
  @State private var message: String?
  @State private var loading = true
  @State private var newName = ""

  private let columns = [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)]

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        Text("Boards are private collections you build from suggestions and captures.")
          .font(.footnote)
          .foregroundStyle(AtlasTheme.muted)
        HStack {
          TextField("Board name", text: $newName)
          Button("Create") { Task { await create() } }
            .disabled(newName.trimmingCharacters(in: .whitespaces).isEmpty)
        }
        if let message {
          Text(message).foregroundStyle(AtlasTheme.muted)
        } else if collections.isEmpty && !loading {
          Text("No boards yet").font(.system(.title3, design: .serif))
          Text("Create a board, then add suggestions from Feed.")
            .foregroundStyle(AtlasTheme.muted)
        }
        LazyVGrid(columns: columns, spacing: 12) {
          ForEach(collections) { board in
            NavigationLink {
              BoardDetailView(boardID: board.id, title: board.name)
            } label: {
              BoardCoverTile(board: board, baseURL: controller.api.baseURL)
            }
            .buttonStyle(.plain)
          }
        }
      }
      .padding(16)
    }
    .background(AtlasTheme.ivory.ignoresSafeArea())
    .navigationTitle("Boards")
    .overlay { if loading { ProgressView() } }
    .refreshable { await load() }
    .task { await load() }
  }

  private func load() async {
    loading = true
    defer { loading = false }
    do {
      collections = try await controller.api.collections().collections
      message = nil
    } catch {
      collections = []
      message = "Boards aren't available right now. Pull to try again."
    }
  }

  private func create() async {
    let trimmed = newName.trimmingCharacters(in: .whitespaces)
    guard !trimmed.isEmpty else { return }
    do {
      let created = try await controller.api.createCollection(CreateCollectionRequest(name: trimmed))
      newName = ""
      collections.insert(created, at: 0)
    } catch {
      controller.message = "Couldn't create that board. Try a different name."
    }
  }
}

struct BoardCoverTile: View {
  let board: CollectionSummary
  let baseURL: URL

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      BoardCoverMosaic(images: board.cover, baseURL: baseURL)
        .frame(maxWidth: .infinity)
        .aspectRatio(1, contentMode: .fit)
        .clipShape(RoundedRectangle(cornerRadius: 14))
      Text(board.name)
        .font(.system(.callout, design: .serif))
        .foregroundStyle(AtlasTheme.ink)
        .lineLimit(2)
      Text("\(board.itemCount) \(board.itemCount == 1 ? "item" : "items")")
        .font(.caption)
        .foregroundStyle(AtlasTheme.muted)
    }
  }
}

struct BoardCoverMosaic: View {
  let images: [LibraryImage]
  let baseURL: URL

  var body: some View {
    let shown = Array(images.prefix(4))
    if shown.isEmpty {
      AtlasTheme.quiet
    } else if shown.count == 1, let url = shown[0].resolved(against: baseURL) {
      AsyncImage(url: url) { image in image.resizable().scaledToFill() } placeholder: { AtlasTheme.quiet }
    } else {
      let tiles = shown + Array(repeating: shown[0], count: max(0, 4 - shown.count))
      LazyVGrid(columns: [GridItem(.flexible(), spacing: 2), GridItem(.flexible(), spacing: 2)], spacing: 2) {
        ForEach(0..<4, id: \.self) { index in
          if let url = tiles[index].resolved(against: baseURL) {
            AsyncImage(url: url) { image in image.resizable().scaledToFill() } placeholder: { AtlasTheme.quiet }
              .frame(minHeight: 64)
              .clipped()
          } else {
            AtlasTheme.quiet.frame(minHeight: 64)
          }
        }
      }
    }
  }
}

struct BoardDetailView: View {
  @EnvironmentObject private var controller: CaptureController
  @EnvironmentObject private var notices: ReadyNoticeCenter
  let boardID: UUID
  let title: String
  @State private var items: [CollectionMember] = []
  @State private var boards: [CollectionSummary] = []
  @State private var message: String?
  @State private var loading = true
  @State private var adding: DiscoveryCard?
  @State private var newBoardName = ""

  private let columns = [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)]

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        if let message {
          Text(message).foregroundStyle(AtlasTheme.muted)
        } else if items.isEmpty && !loading {
          Text("Nothing on this board yet").font(.system(.title3, design: .serif))
          Text("Add suggestions from Feed.")
            .foregroundStyle(AtlasTheme.muted)
        }
        LazyVGrid(columns: columns, spacing: 12) {
          ForEach(items) { member in
            NavigationLink {
              FeedCardDetail(card: member.item, onAddToBoard: { adding = member.item })
            } label: {
              FeedCardTile(card: member.item, baseURL: controller.api.baseURL)
            }
            .buttonStyle(.plain)
          }
        }
      }
      .padding(16)
    }
    .background(AtlasTheme.ivory.ignoresSafeArea())
    .navigationTitle(title)
    .overlay { if loading { ProgressView() } }
    .refreshable { await load() }
    .task { await load() }
    .sheet(item: $adding) { card in
      NavigationStack {
        List {
          Section("New board") {
            TextField("Board name", text: $newBoardName)
            Button("Create and add") {
              Task { await add(card, creating: newBoardName) }
            }
            .disabled(newBoardName.trimmingCharacters(in: .whitespaces).isEmpty)
          }
          Section("Your boards") {
            ForEach(boards) { board in
              Button(board.name) { Task { await add(card, to: board.id) } }
            }
          }
        }
        .navigationTitle("Add to a board")
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { adding = nil } } }
        .task { boards = (try? await controller.api.collections())?.collections ?? [] }
      }
      .presentationDetents([.medium])
    }
  }

  private func load() async {
    loading = true
    defer { loading = false }
    do {
      items = try await controller.api.collection(boardID).items
      message = nil
    } catch {
      items = []
      message = "This board isn't available right now."
    }
  }

  private func add(_ card: DiscoveryCard, creating name: String) async {
    let trimmed = name.trimmingCharacters(in: .whitespaces)
    guard !trimmed.isEmpty else { return }
    do {
      let board = try await controller.api.createCollection(CreateCollectionRequest(name: trimmed))
      _ = try await controller.api.addCollectionItem(collectionID: board.id, itemID: card.id)
      newBoardName = ""
      adding = nil
    } catch {
      controller.message = "Couldn't add that to a board. Try again."
    }
  }

  private func add(_ card: DiscoveryCard, to boardID: UUID) async {
    do {
      _ = try await controller.api.addCollectionItem(collectionID: boardID, itemID: card.id)
      adding = nil
    } catch {
      controller.message = "Couldn't add that to a board. Try again."
    }
  }
}
