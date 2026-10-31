import AtlasCapture
import Foundation
#if ATLAS_META_DAT
import AtlasGlasses
#endif

/// Composition root. Every dependency is created once here; there is no
/// global relay profile, operator device or shared upload identity.
@MainActor
final class AppEnvironment {
  static let shared = AppEnvironment()

  static var isUITestFixture: Bool {
    #if DEBUG && targetEnvironment(simulator)
    return ProcessInfo.processInfo.arguments.contains("-AtlasNativeUITestFixture")
    #else
    return false
    #endif
  }

  let baseURL: URL
  let keychain: KeychainStore
  let sessions: SessionStore
  let identities: InstallationIdentityStore
  let api: AtlasAPI
  let accounts: AccountService
  let drafts: DraftStore
  let transfer: BackgroundTransfer
  let uploads: UploadCoordinator
  let receipts: ReceiptStore
  let wearables: WearablesAdapter
  let controller: CaptureController
  let onboarding: OnboardingController
  let notices: ReadyNoticeCenter

  private init() {
    let info = Bundle.main.infoDictionary ?? [:]
    // ATLAS_API_BASE_URL comes from the build configuration (xcconfig), e.g.
    // https://api.cultureatlas.example; never a LAN relay address.
    let configured = (info["AtlasAPIBaseURL"] as? String).flatMap(URL.init(string:))
    var transport = HTTPTransport()
    var draftRoot: URL?
    #if DEBUG && targetEnvironment(simulator)
    if Self.isUITestFixture {
      // Neither the user's Keychain, drafts nor background transfers are reused.
      // All API requests are intercepted; unknown requests fail closed.
      keychain = KeychainStore(service: "com.cultureatlas.native-ui-fixture")
      keychain.delete("session.current")
      baseURL = NativeUITestProtocol.baseURL
      let configuration = URLSessionConfiguration.ephemeral
      configuration.protocolClasses = [NativeUITestProtocol.self]
      transport = HTTPTransport(session: URLSession(configuration: configuration))
      draftRoot = FileManager.default.temporaryDirectory
        .appendingPathComponent("NativeUITest-\(UUID().uuidString)", isDirectory: true)
      transfer = BackgroundTransfer(namespace: "com.cultureatlas.native-ui-fixture.uploads")
    } else {
      keychain = KeychainStore()
      baseURL = configured ?? URL(string: "https://app.cultureatlas.com")!
      transfer = BackgroundTransfer()
    }
    #else
    keychain = KeychainStore()
    baseURL = configured ?? URL(string: "https://app.cultureatlas.com")!
    transfer = BackgroundTransfer()
    #endif
    sessions = SessionStore(keychain: keychain)
    identities = InstallationIdentityStore(keychain: keychain)
    api = AtlasAPI(baseURL: baseURL, transport: transport, sessions: sessions)
    let version = "\(info["CFBundleShortVersionString"] as? String ?? "0") (\(info["CFBundleVersion"] as? String ?? "0"))"
    #if ATLAS_META_DAT
    do { try MetaWearablesAdapter.configureSDK() } catch { NSLog("[atlas] Meta SDK configure failed") }
    wearables = MetaWearablesAdapter()
    let glassesSDK = true
    #else
    wearables = UnavailableWearables()
    let glassesSDK = false
    #endif
    accounts = AccountService(
      baseURL: baseURL, transport: transport, sessions: sessions, identities: identities, keychain: keychain,
      appVersion: version,
      capabilities: { ["photo": true, "video": true, "microphone": true, "meta_glasses_sdk": glassesSDK] })
    drafts = DraftStore(root: draftRoot, keychain: keychain)
    uploads = UploadCoordinator(api: api, store: drafts, transfer: transfer)
    receipts = ReceiptStore(directory: drafts.root.appendingPathComponent("commands", isDirectory: true))
    controller = CaptureController(
      api: api, accounts: accounts, sessions: sessions, identities: identities, drafts: drafts, uploads: uploads,
      transfer: transfer, receipts: receipts, wearables: wearables)
    onboarding = OnboardingController(api: api)
    notices = ReadyNoticeCenter(
      api: api, sessions: sessions, directory: drafts.root.appendingPathComponent("ready", isDirectory: true),
      remoteNotificationsEnabled: !Self.isUITestFixture)
    // Stop wake-ups for this phone before its session ends.
    controller.beforeSignOut = { [notices] in await notices.signingOut() }
    controller.afterCommittedExplore = { [notices] draft in
      guard let assetID = draft.assetID else { return }
      let durationMS = Int((draft.durationSeconds ?? 0) * 1000)
      let start = draft.exploreStartMS ?? 0
      let defaultEnd = AtlasContract.musicRecognitionDefaultSeconds * 1000
      let end = draft.exploreEndMS ?? min(max(durationMS, start + 1), start + defaultEnd)
      _ = await notices.exploreMusic(assetID: assetID, startMS: start, endMS: max(start + 1, end))
    }
  }

  /// Test-owned session only, not email proof or enrollment qualification.
  func prepareUITestSession() async throws {
    #if DEBUG && targetEnvironment(simulator)
    guard Self.isUITestFixture,
      !ProcessInfo.processInfo.arguments.contains("-AtlasNativeUITestSignedOut") else { return }
    let tokens = try AtlasJSON.decoder().decode(NativeSessionTokens.self, from: Data(NativeUITestProtocol.sessionJSON.utf8))
    try await sessions.store(tokens)
    #endif
  }
}

#if DEBUG && targetEnvironment(simulator)
/// Synthetic owner responses for native UI regression tests. Compiled out of
/// Release and physical-device builds. This session has no server authority,
/// no Qloo/provider provenance, and cannot reach a network transport.
private final class NativeUITestProtocol: URLProtocol {
  static let baseURL = URL(string: "https://native-ui-fixture.invalid")!
  static let account = "00000000-0000-4000-8000-000000000001"
  static let token = "native-ui-fixture-not-a-server-credential"
  static let sessionJSON = """
    {"session_id":"00000000-0000-4000-8000-000000000002",
     "installation_id":"00000000-0000-4000-8000-000000000003",
     "account_id":"\(account)","access_token":"\(token)","refresh_token":"fixture-no-refresh",
     "access_expires_at":"2099-01-01T00:00:00.000Z","refresh_expires_at":"2099-01-02T00:00:00.000Z"}
    """

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    guard let url = request.url, url.host == Self.baseURL.host,
      request.httpMethod == "GET",
      request.value(forHTTPHeaderField: "Authorization") == "Bearer \(Self.token)"
    else {
      client?.urlProtocol(self, didFailWithError: URLError(.userAuthenticationRequired))
      return
    }
    let incomplete = ProcessInfo.processInfo.arguments.contains("-AtlasNativeUITestOnboardingRequired")
    let body: String
    switch url.path {
    case "/v2/capabilities":
      body = """
        {"contract_version":"2026-10-15.1","flags":{"onboarding_required":true},
         "limits":{},"availability":{}}
        """
    case "/v1/onboarding/state":
      body = """
        {"state":{"required":\(incomplete),"picks_count":\(incomplete ? 0 : 3),"min_picks":3,
         "completed_at":\(incomplete ? "null" : "\"2026-10-23T00:00:00.000Z\"")},
         "picks":[],"food_exclusions":[],"seed":{"state":"complete","categories":[]}}
        """
    case "/v1/onboarding/catalog":
      body = """
        {"catalog_version":"native-ui-fixture","images":[],
         "chips":{"wear":[],"play":[],"watch":[],"eat":[]},"exclusion_suggestions":[],"min_picks":3}
        """
    case "/v1/discoveries":
      guard !incomplete else {
        client?.urlProtocol(self, didFailWithError: URLError(.userAuthenticationRequired))
        return
      }
      let cards = (1...16).map { index in
        """
        {"id":"00000000-0000-4000-8001-\(String(format: "%012d", index))",
         "kind":"brand","category":"wear","title":"UI fixture \(index)",
         "is_example":true,"saved":false,"evidence_available":false}
        """
      }.joined(separator: ",")
      body = """
        {"items":[\(cards)],"feed_id":"00000000-0000-4000-8000-000000000004",
         "feed_revision":1,"is_example_feed":true,"available_categories":["wear"]}
        """
    default:
      client?.urlProtocol(self, didFailWithError: URLError(.unsupportedURL))
      return
    }
    let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil,
                                   headerFields: ["Content-Type": "application/json"])!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(body.utf8))
    client?.urlProtocolDidFinishLoading(self)
  }

  override func stopLoading() {}
}
#endif
