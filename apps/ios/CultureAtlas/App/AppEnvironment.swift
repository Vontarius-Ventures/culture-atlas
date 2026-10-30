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

  let baseURL: URL
  let keychain = KeychainStore()
  let sessions: SessionStore
  let identities: InstallationIdentityStore
  let api: AtlasAPI
  let accounts: AccountService
  let drafts: DraftStore
  let transfer = BackgroundTransfer()
  let uploads: UploadCoordinator
  let receipts: ReceiptStore
  let wearables: WearablesAdapter
  let controller: CaptureController
  let onboarding: OnboardingController
  let graphStore: InterestGraphStore
  let deletionModel: AccountDeletionModel
  let notices: ReadyNoticeCenter

  private init() {
    let info = Bundle.main.infoDictionary ?? [:]
    // ATLAS_API_BASE_URL comes from the build configuration (xcconfig), e.g.
    // https://api.cultureatlas.example; never a LAN relay address.
    let configured = (info["AtlasAPIBaseURL"] as? String).flatMap(URL.init(string:))
    baseURL = configured ?? URL(string: "https://app.cultureatlas.com")!
    sessions = SessionStore(keychain: keychain)
    identities = InstallationIdentityStore(keychain: keychain)
    api = AtlasAPI(baseURL: baseURL, sessions: sessions)
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
      baseURL: baseURL, transport: HTTPTransport(), sessions: sessions, identities: identities, keychain: keychain,
      appVersion: version,
      capabilities: { ["photo": true, "video": true, "microphone": true, "meta_glasses_sdk": glassesSDK] })
    drafts = DraftStore(keychain: keychain)
    uploads = UploadCoordinator(api: api, store: drafts, transfer: transfer)
    receipts = ReceiptStore(directory: drafts.root.appendingPathComponent("commands", isDirectory: true))
    controller = CaptureController(
      api: api, accounts: accounts, sessions: sessions, identities: identities, drafts: drafts, uploads: uploads,
      transfer: transfer, receipts: receipts, wearables: wearables)
    onboarding = OnboardingController(api: api)
    graphStore = InterestGraphStore(service: api)
    deletionModel = AccountDeletionModel(service: api, tokenStore: AccountDeletionModel.KeychainTokenStore(keychain: keychain))
    notices = ReadyNoticeCenter(
      api: api, sessions: sessions, directory: drafts.root.appendingPathComponent("ready", isDirectory: true))
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
}
