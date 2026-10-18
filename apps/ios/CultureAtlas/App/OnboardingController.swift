import AtlasCapture
import Foundation
import SwiftUI

/// Taste onboarding on iOS (spec amendment 2.2): the required questionnaire
/// after sign-in (screen 14, three steps), the building-feed interstitial
/// (screen 15) and Settings → Taste (screen 18). Every pick is saved on the
/// server as it is made, so leaving mid-way keeps what was picked and the
/// questionnaire resumes at the next sign-in until 3 picks are complete.
@MainActor
final class OnboardingController: ObservableObject {
  enum Gate: Equatable {
    /// Asking the server whether this account must finish the questionnaire.
    case checking
    case onboarding
    case building
    /// The state could not be loaded; the questionnaire is required, so it is not skipped.
    case retry
    case done
  }

  @Published private(set) var gate: Gate = .checking
  @Published private(set) var catalog: OnboardingCatalog?
  @Published private(set) var picks: [OnboardingPick] = []
  @Published private(set) var picksCount = 0
  @Published private(set) var exclusions: [String] = []
  @Published var step = 1
  @Published var searchText = "" {
    didSet { scheduleSearch() }
  }
  @Published private(set) var searchResults: [OnboardingSearchResult] = []
  @Published private(set) var searchUnavailable = false
  @Published private(set) var busyIDs: Set<String> = []
  @Published private(set) var completing = false
  @Published private(set) var seed: TasteSeedStatus?
  @Published private(set) var seedAction: OnboardingPolicy.SeedAction = .wait
  @Published var message: String?
  /// The server ended this phone's session while checking onboarding.
  @Published private(set) var sessionEnded = false

  let api: AtlasAPI
  /// Exclusions as last saved on the server (PUT only when they changed).
  private var savedExclusions: [String] = []
  private var searchTask: Task<Void, Never>?
  private var seedTask: Task<Void, Never>?
  private var searchPickIDs: [String: UUID] = [:]

  init(api: AtlasAPI) {
    self.api = api
  }

  var counter: OnboardingPolicy.Counter { OnboardingPolicy.counter(picks: picksCount) }

  // MARK: Entry (after sign-in)

  /// Decides whether the signed-in account goes to the questionnaire.
  func evaluate() async {
    gate = .checking
    let flag = (try? await api.capabilities())?.flag("onboarding_required") ?? true
    guard flag else { gate = .done; return }
    do {
      let response = try await api.onboardingState()
      apply(response)
      route(OnboardingPolicy.entry(onboardingFlag: true, state: response.state, error: nil))
    } catch let error as AtlasClientError {
      route(OnboardingPolicy.entry(onboardingFlag: true, state: nil, error: error))
    } catch {
      gate = .retry
    }
  }

  private func route(_ entry: OnboardingPolicy.Entry) {
    switch entry {
    case .app: gate = .done
    case .retry: gate = .retry
    case .onboarding:
      gate = .onboarding
      Task { await loadCatalog() }
    case .signIn:
      // RootView observes this and signs out (local drafts are kept).
      sessionEnded = true
    }
  }

  func reset() {
    searchTask?.cancel()
    seedTask?.cancel()
    gate = .checking
    sessionEnded = false
    catalog = nil
    picks = []
    picksCount = 0
    exclusions = []
    savedExclusions = []
    step = 1
    searchText = ""
    searchResults = []
    seed = nil
  }

  private func apply(_ response: OnboardingStateResponse) {
    picks = response.picks
    picksCount = response.state.picksCount
    exclusions = response.foodExclusions
    savedExclusions = response.foodExclusions
    seed = response.seed
  }

  func loadCatalog() async {
    do {
      catalog = try await api.onboardingCatalog()
    } catch {
      message = "We couldn't load the ideas. Check your connection and try again."
    }
  }

  // MARK: Picks (catalog images, chips, search)

  func isPicked(_ entry: OnboardingCatalogEntry) -> Bool {
    picks.contains { $0.catalogItemID == entry.id }
  }

  func isPicked(_ result: OnboardingSearchResult) -> Bool {
    result.picked || searchPickIDs[result.resultID] != nil
  }

  /// Toggles a catalog pick: picking saves it at once; unpicking unsaves every save of the pick.
  func toggle(_ entry: OnboardingCatalogEntry, settings: Bool = false) async {
    guard !busyIDs.contains(entry.id) else { return }
    busyIDs.insert(entry.id)
    defer { busyIDs.remove(entry.id) }
    do {
      if let pick = picks.first(where: { $0.catalogItemID == entry.id }) {
        let removed = try await (settings ? api.deleteTastePick(pick.id) : api.deleteOnboardingPick(pick.id))
        picks.removeAll { $0.id == removed.removedPickID }
        picksCount = removed.state.picksCount
      } else {
        let request = CreatePickRequest.catalog(itemID: entry.id)
        let created = try await (settings ? api.createTastePick(request) : api.createOnboardingPick(request))
        record(created)
      }
    } catch {
      message = "That didn't save. Try again."
    }
  }

  func add(_ result: OnboardingSearchResult, settings: Bool = false) async {
    guard !isPicked(result), !busyIDs.contains(result.resultID) else { return }
    busyIDs.insert(result.resultID)
    defer { busyIDs.remove(result.resultID) }
    do {
      let request = CreatePickRequest.search(resultID: result.resultID)
      let created = try await (settings ? api.createTastePick(request) : api.createOnboardingPick(request))
      searchPickIDs[result.resultID] = created.pick.id
      record(created)
    } catch {
      message = "That didn't save. Try again."
    }
  }

  func remove(_ pick: OnboardingPick) async {
    do {
      let removed = try await api.deleteTastePick(pick.id)
      picks.removeAll { $0.id == removed.removedPickID }
      picksCount = removed.state.picksCount
    } catch {
      message = "That wasn't removed. Try again."
    }
  }

  private func record(_ created: CreatePickResponse) {
    if !picks.contains(where: { $0.id == created.pick.id }) { picks.append(created.pick) }
    picksCount = created.state.picksCount
  }

  // MARK: Search ("Add an artist, film, brand or place")

  private func scheduleSearch() {
    searchTask?.cancel()
    guard let query = OnboardingPolicy.searchQuery(searchText) else {
      searchResults = []
      searchUnavailable = false
      return
    }
    searchTask = Task { [weak self] in
      try? await Task.sleep(nanoseconds: UInt64(OnboardingPolicy.searchDebounce * 1_000_000_000))
      guard !Task.isCancelled, let self else { return }
      do {
        let response = try await self.api.searchOnboarding(query)
        guard !Task.isCancelled else { return }
        self.searchUnavailable = response.status == .unavailable
        self.searchResults = response.results
      } catch {
        guard !Task.isCancelled else { return }
        // Picks from the ideas above always work; search just takes a break.
        self.searchUnavailable = true
        self.searchResults = []
      }
    }
  }

  // MARK: Exclusions (optional, never picks)

  func toggleExclusion(_ term: String) {
    exclusions = OnboardingPolicy.toggleExclusion(exclusions, term)
  }

  func isExcluded(_ term: String) -> Bool {
    exclusions.contains { $0.lowercased() == term.lowercased() }
  }

  /// Adds a free-text exclusion; returns the reason it was not added, if any.
  @discardableResult
  func addOtherExclusion(_ raw: String) -> OnboardingPolicy.ExclusionRejection? {
    let out = OnboardingPolicy.addExclusion(exclusions, raw)
    exclusions = out.list
    return out.rejected
  }

  func saveExclusions() async -> Bool {
    guard exclusions != savedExclusions else { return true }
    do {
      let saved = try await api.putFoodExclusions(exclusions)
      exclusions = saved.foodExclusions
      savedExclusions = saved.foodExclusions
      return true
    } catch {
      message = "Your exclusions didn't save. Try again."
      return false
    }
  }

  // MARK: "Build my feed" and screen 15

  func buildFeed() async {
    guard OnboardingPolicy.complete(picks: picksCount) != .disabled, !completing else { return }
    completing = true
    defer { completing = false }
    guard await saveExclusions() else { return }
    do {
      let response = try await api.completeOnboarding()
      picksCount = response.state.picksCount
      seed = response.seed
      gate = .building
      startSeedPolling(initial: response.seed)
    } catch let error as AtlasClientError {
      switch OnboardingPolicy.complete(picks: picksCount, error: error) {
      case .reloadState:
        if let state = try? await api.onboardingState() { apply(state) }
      default:
        message = "We couldn't start your feed. Check your connection and try again."
      }
    } catch {
      message = "We couldn't start your feed. Try again."
    }
  }

  private func startSeedPolling(initial: TasteSeedStatus) {
    seedTask?.cancel()
    let started = Date()
    seedTask = Task { [weak self] in
      var status = initial
      while !Task.isCancelled {
        guard let self else { return }
        let action = OnboardingPolicy.seed(status, elapsed: Date().timeIntervalSince(started))
        self.seed = status
        self.seedAction = action
        switch action {
        case .advance:
          self.finish()
          return
        case .background:
          return  // Shows "We'll keep building in the background." with Done.
        case .wait:
          try? await Task.sleep(nanoseconds: UInt64(OnboardingPolicy.seedPollInterval(status) * 1_000_000_000))
          if let next = try? await self.api.seedStatus() { status = next }
        }
      }
    }
  }

  func finish() {
    seedTask?.cancel()
    gate = .done
  }

  // MARK: Settings → Taste

  @Published private(set) var tastePicks: TastePicksResponse?

  func loadTaste() async {
    do {
      let taste = try await api.tastePicks()
      tastePicks = taste
      let grouped = taste.picks
      picks = grouped.wear + grouped.play + grouped.watch + grouped.eat + grouped.other
      picksCount = taste.picksCount
      if let food = taste.foodExclusions {
        exclusions = food
        savedExclusions = food
      }
      if catalog == nil { await loadCatalog() }
    } catch {
      message = "We couldn't load your taste. Check your connection and try again."
    }
  }

  func picks(in category: TasteCategory?) -> [OnboardingPick] {
    picks.filter { $0.category == category }
  }
}
