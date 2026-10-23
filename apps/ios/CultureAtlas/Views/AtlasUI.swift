import AtlasCapture
import SwiftUI
import UIKit

// Shared motion, image and feedback primitives. Every screen uses the same
// press response, crossfades and springs so the app feels like one object.

enum AtlasMotion {
  /// Default UI spring: quick, lightly damped, never bouncy enough to distract.
  static let spring = Animation.spring(response: 0.36, dampingFraction: 0.82)
  static let press = Animation.spring(response: 0.3, dampingFraction: 0.7)
  static let fade = Animation.easeOut(duration: 0.28)
}

// MARK: - Press states

/// Cards shrink a touch and dim slightly while pressed, then spring back.
struct PressableCardStyle: ButtonStyle {
  var scale: CGFloat = 0.97

  func makeBody(configuration: Configuration) -> some View {
    PressableBody(configuration: configuration, scale: scale)
  }

  private struct PressableBody: View {
    let configuration: ButtonStyleConfiguration
    let scale: CGFloat
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
      configuration.label
        .scaleEffect(configuration.isPressed && !reduceMotion ? scale : 1)
        .opacity(configuration.isPressed ? 0.88 : 1)
        .animation(AtlasMotion.press, value: configuration.isPressed)
    }
  }
}

extension ButtonStyle where Self == PressableCardStyle {
  static var pressableCard: PressableCardStyle { PressableCardStyle() }
}

// MARK: - Images

/// Decoded-image cache plus a URLCache-backed session, so cards that drift
/// out and back in never refetch or pop.
@MainActor
final class ImagePipeline {
  static let shared = ImagePipeline()

  private let memory = NSCache<NSURL, UIImage>()
  private let session: URLSession
  private var inflight: [URL: Task<UIImage?, Never>] = [:]

  private init() {
    memory.countLimit = 300
    memory.totalCostLimit = 120 * 1024 * 1024
    let config = URLSessionConfiguration.default
    config.urlCache = URLCache(memoryCapacity: 32 * 1024 * 1024, diskCapacity: 256 * 1024 * 1024)
    config.requestCachePolicy = .returnCacheDataElseLoad
    session = URLSession(configuration: config)
  }

  func cached(_ url: URL) -> UIImage? { memory.object(forKey: url as NSURL) }

  /// `authorize` adds the bearer for our own private `/v2/media` content.
  func image(for url: URL, authorize: (@Sendable () async -> String?)? = nil) async -> UIImage? {
    if let hit = cached(url) { return hit }
    if let running = inflight[url] { return await running.value }
    let session = self.session
    let task = Task<UIImage?, Never> {
      var request = URLRequest(url: url, timeoutInterval: 30)
      if let authorize, let token = await authorize() {
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        // Private originals are never written to the shared disk cache.
        request.cachePolicy = .reloadIgnoringLocalCacheData
      }
      guard let (data, response) = try? await session.data(for: request),
        let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode)
      else { return nil }
      return await Self.decode(data)
    }
    inflight[url] = task
    let image = await task.value
    inflight[url] = nil
    if let image {
      memory.setObject(image, forKey: url as NSURL, cost: Int(image.size.width * image.size.height * image.scale * 4))
    }
    return image
  }

  /// Decode (and downsample) off the main thread so scrolling never hitches.
  nonisolated private static func decode(_ data: Data) async -> UIImage? {
    await Task.detached(priority: .userInitiated) {
      guard let image = UIImage(data: data) else { return nil }
      return image.preparingForDisplay() ?? image
    }.value
  }
}

/// Cached remote image with a placeholder and a soft crossfade on arrival.
struct RemoteImage<Placeholder: View, Failure: View>: View {
  let url: URL?
  var authorize: (@Sendable () async -> String?)?
  @ViewBuilder var placeholder: () -> Placeholder
  @ViewBuilder var failure: () -> Failure

  @State private var image: UIImage?
  @State private var failed = false
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  init(
    url: URL?, authorize: (@Sendable () async -> String?)? = nil,
    @ViewBuilder placeholder: @escaping () -> Placeholder,
    @ViewBuilder failure: @escaping () -> Failure
  ) {
    self.url = url
    self.authorize = authorize
    self.placeholder = placeholder
    self.failure = failure
    // A cache hit renders on the first frame: no placeholder flash.
    _image = State(initialValue: url.flatMap { ImagePipeline.shared.cached($0) })
  }

  var body: some View {
    ZStack {
      if let image {
        Image(uiImage: image)
          .resizable()
          .scaledToFill()
          .transition(.opacity)
      } else if failed {
        failure()
      } else {
        placeholder()
      }
    }
    .task(id: url) {
      guard let url else {
        failed = true
        return
      }
      if image != nil { return }
      let loaded = await ImagePipeline.shared.image(for: url, authorize: authorize)
      withAnimation(reduceMotion ? nil : AtlasMotion.fade) {
        if let loaded { image = loaded } else { failed = true }
      }
    }
  }
}

extension RemoteImage where Failure == Placeholder {
  init(url: URL?, authorize: (@Sendable () async -> String?)? = nil, @ViewBuilder placeholder: @escaping () -> Placeholder) {
    self.init(url: url, authorize: authorize, placeholder: placeholder, failure: placeholder)
  }
}

extension AtlasAPI {
  /// Bearer for our own private media content routes (images only).
  var imageAuthorizer: @Sendable () async -> String? {
    { [sessions, transport, baseURL] in
      try? await sessions.accessToken(transport: transport, baseURL: baseURL)
    }
  }
}

// MARK: - Edges

extension View {
  /// Soft fade at the leading/trailing (or top/bottom) edge instead of a hard clip line.
  func edgeFade(_ axis: Axis, length: CGFloat = 24) -> some View {
    mask {
      GeometryReader { geo in
        let extent = axis == .vertical ? geo.size.height : geo.size.width
        let fraction = extent > 0 ? min(0.45, length / extent) : 0
        LinearGradient(
          stops: [
            .init(color: .clear, location: 0),
            .init(color: .black, location: fraction),
            .init(color: .black, location: 1 - fraction),
            .init(color: .clear, location: 1),
          ],
          startPoint: axis == .vertical ? .top : .leading,
          endPoint: axis == .vertical ? .bottom : .trailing)
      }
    }
  }
}

// MARK: - Flash banner (confirmation toasts)

/// A short confirmation with an optional action ("Added to Audit board · View").
struct Flash: Equatable, Identifiable {
  enum Action: Equatable {
    case openBoard(UUID, String)
  }

  let id = UUID()
  let text: String
  var systemImage = "checkmark.circle.fill"
  var actionLabel: String?
  var action: Action?
}

struct FlashBanner: View {
  let flash: Flash
  let onAction: (Flash.Action) -> Void
  let onDismiss: () -> Void

  var body: some View {
    HStack(spacing: 12) {
      Image(systemName: flash.systemImage)
        .font(.title3)
        .foregroundStyle(AtlasTheme.olive)
        .symbolEffect(.bounce, value: flash.id)
        .accessibilityHidden(true)
      Text(flash.text)
        .font(.callout.weight(.medium))
        .foregroundStyle(AtlasTheme.ink)
        .lineLimit(2)
      Spacer(minLength: 8)
      if let label = flash.actionLabel, let action = flash.action {
        Button(label) { onAction(action) }
          .font(.callout.weight(.semibold))
          .foregroundStyle(AtlasTheme.olive)
          .frame(minHeight: 44)
      }
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 6)
    .frame(minHeight: 56)
    .background(
      RoundedRectangle(cornerRadius: 18, style: .continuous)
        .fill(AtlasTheme.ivory)
        .shadow(color: .black.opacity(0.12), radius: 18, y: 8))
    .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(AtlasTheme.line))
    .padding(.horizontal, 16)
    .gesture(DragGesture(minimumDistance: 10).onEnded { value in
      if value.translation.height > 12 { onDismiss() }
    })
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("flash.banner")
  }
}

// MARK: - Section header

struct SectionHeader: View {
  let title: String
  var trailing: String?
  var action: (() -> Void)?

  var body: some View {
    HStack(alignment: .firstTextBaseline) {
      Text(title)
        .font(.system(.title3, design: .serif))
        .foregroundStyle(AtlasTheme.ink)
        .accessibilityAddTraits(.isHeader)
      Spacer()
      if let trailing, let action {
        Button(trailing, action: action)
          .font(.callout.weight(.medium))
          .foregroundStyle(AtlasTheme.olive)
      }
    }
  }
}

/// Ivory surface for system Lists so every tab shares one paper background.
extension View {
  func atlasListSurface() -> some View {
    scrollContentBackground(.hidden)
      .background(AtlasTheme.ivory.ignoresSafeArea())
  }
}
