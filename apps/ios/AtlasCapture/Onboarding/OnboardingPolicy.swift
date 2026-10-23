import Foundation

/// Exact copy for screens 14, 15 and 18 (specs/capture-platform-v2/design/copy.json,
/// mirrored in fixtures/native-contract/onboarding.json and checked by `OnboardingTests`).
public enum OnboardingCopy {
  public static let imagesTitle = "Pick what catches your eye."
  public static let chipsTitle = "Choose a few favorites."
  public static let searchPlaceholder = "Add an artist, film, brand or place"
  public static let searchUnavailable = "Search is taking a break. Pick from the ideas above."
  public static let searchAdd = "Add"
  public static let searchAdded = "Added"
  public static let exclusionsTitle = "Anything to leave out?"
  public static let exclusionsOptional = "Optional"
  public static let exclusionsNote = "We leave these out of food ideas and plans. They don't count as picks."
  public static let exclusionsOther = "Something else"
  public static let counter3 = "3 picks to go"
  public static let counter2 = "2 picks to go"
  public static let counter1 = "1 pick to go"
  public static let counterReady = "Ready"
  public static let primary = "Build my feed"
  public static let primaryDisabled = "Pick at least 3 so your feed starts with you."
  public static let back = "Back"
  public static let next = "Next"
  public static let hint = "Pick at least 3. You can change them later under Interests."
  public static func step(_ n: Int) -> String { "Step \(n) of 3" }

  public static let buildingTitle = "Building your feed…"
  public static let buildingLede = "Starting with what you picked."
  public static let buildingUnavailable = "We'll keep building in the background."
  public static let buildingCategoryReady = "Ready"
  public static let buildingCategoryLooking = "Looking"

  public static let tasteTitle = "Interests"
  public static let tasteLede = "Your interests shape the feed. Remove anything that no longer fits, or add more."
  public static let seeFeed = "See my feed"
  public static let tasteAddMore = "Add more"
  public static let tasteDone = "Done"
  public static let tasteSave = "Save"
  public static func tasteRemove(_ label: String) -> String { "Remove \(label)" }

  public static func group(_ category: TasteCategory) -> String {
    switch category {
    case .wear: return "Wear"
    case .play: return "Play"
    case .watch: return "Watch"
    case .eat: return "Eat"
    }
  }

  /// Every key this client renders, for the fixture comparison.
  public static let byKey: [String: String] = [
    "onboarding.images.title": imagesTitle,
    "onboarding.chips.title": chipsTitle,
    "onboarding.group.wear": group(.wear),
    "onboarding.group.play": group(.play),
    "onboarding.group.watch": group(.watch),
    "onboarding.group.eat": group(.eat),
    "onboarding.search.placeholder": searchPlaceholder,
    "onboarding.search.unavailable": searchUnavailable,
    "onboarding.search.add": searchAdd,
    "onboarding.search.added": searchAdded,
    "onboarding.exclusions.title": exclusionsTitle,
    "onboarding.exclusions.optional": exclusionsOptional,
    "onboarding.exclusions.note": exclusionsNote,
    "onboarding.exclusions.other": exclusionsOther,
    "onboarding.counter.3": counter3,
    "onboarding.counter.2": counter2,
    "onboarding.counter.1": counter1,
    "onboarding.counter.ready": counterReady,
    "onboarding.primary": primary,
    "onboarding.primary_disabled": primaryDisabled,
    "onboarding.back": back,
    "onboarding.next": next,
    "onboarding.hint": hint,
    "building.title": buildingTitle,
    "building.lede": buildingLede,
    "building.unavailable": buildingUnavailable,
    "building.category_ready": buildingCategoryReady,
    "building.category_looking": buildingCategoryLooking,
    "building.go": seeFeed,
    "settings_taste.title": tasteTitle,
    "settings_taste.lede": tasteLede,
    "settings_taste.add_more": tasteAddMore,
    "settings_taste.done": tasteDone,
    "settings_taste.save": tasteSave,
  ]
}

/// Pure rules of the native questionnaire (fixtures/native-contract/onboarding.json).
public enum OnboardingPolicy {
  public static let minPicks = 3
  public static let maxPicks = 60
  public static let searchMinChars = 2
  public static let searchMaxChars = 80
  public static let searchDebounce: TimeInterval = 0.3
  public static let exclusionsMax = 12
  public static let exclusionMaxChars = 40
  public static let defaultSeedPoll: TimeInterval = 1.5
  public static let seedMaxWait: TimeInterval = 20

  public struct Counter: Equatable, Sendable {
    public var text: String
    /// Filled segments of the three-segment progress bar.
    public var progress: Int
    public var canComplete: Bool
  }

  public static func counter(picks: Int) -> Counter {
    let left = max(0, minPicks - picks)
    let text: String
    switch left {
    case 0: text = OnboardingCopy.counterReady
    case 1: text = OnboardingCopy.counter1
    case 2: text = OnboardingCopy.counter2
    default: text = OnboardingCopy.counter3
    }
    return Counter(text: text, progress: min(picks, minPicks), canComplete: picks >= minPicks)
  }

  /// The query to send, or nil while it is too short or too long to search.
  public static func searchQuery(_ input: String) -> String? {
    let q = input.trimmingCharacters(in: .whitespacesAndNewlines)
    return (searchMinChars...searchMaxChars).contains(q.count) ? q : nil
  }

  public enum ExclusionRejection: String, Equatable, Sendable {
    case empty, tooLong = "too_long", duplicate, full
  }

  /// Adds a free-text or suggested exclusion (trimmed, inner spaces collapsed, case-insensitive dedupe).
  public static func addExclusion(_ current: [String], _ raw: String) -> (list: [String], rejected: ExclusionRejection?) {
    let value = raw.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
    if value.isEmpty { return (current, .empty) }
    if value.count > exclusionMaxChars { return (current, .tooLong) }
    if current.contains(where: { $0.lowercased() == value.lowercased() }) { return (current, .duplicate) }
    if current.count >= exclusionsMax { return (current, .full) }
    return (current + [value], nil)
  }

  public static func toggleExclusion(_ current: [String], _ term: String) -> [String] {
    if current.contains(where: { $0.lowercased() == term.lowercased() }) {
      return current.filter { $0.lowercased() != term.lowercased() }
    }
    return addExclusion(current, term).list
  }

  /// "tree nuts" → "Tree nuts" (the stored term stays as the server vocabulary).
  public static func label(_ term: String) -> String {
    term.prefix(1).uppercased() + term.dropFirst()
  }

  // MARK: Where to go after sign-in

  public enum Entry: String, Equatable, Sendable {
    case app, onboarding, retry
    case signIn = "sign_in"
  }

  /// `error` is the failure of GET /v1/onboarding/state, if any.
  public static func entry(onboardingFlag: Bool, state: OnboardingState?, error: AtlasClientError?) -> Entry {
    guard onboardingFlag else { return .app }
    if let error { return entry(errorCode: errorCode(error)) }
    return state?.required == true ? .onboarding : .app
  }

  static func entry(errorCode: String) -> Entry {
    switch errorCode {
    // A server that does not offer native onboarding never blocks the app.
    case "not_found", "scope_denied": return .app
    case "token_expired": return .signIn
    default:
      return ErrorPolicy.action(forCode: errorCode) == .signInRequired ? .signIn : .retry
    }
  }

  static func errorCode(_ error: AtlasClientError) -> String {
    switch error {
    case .server(_, let code, _, _, _): return code
    case .transport: return "transport"
    case .decoding: return "decoding"
    case .notSignedIn, .refreshRequired: return "unauthenticated"
    case .draftLocked: return "account_mismatch"
    }
  }

  // MARK: "Build my feed"

  public enum CompleteAction: String, Equatable, Sendable {
    case disabled, building, retry
    case reloadState = "reload_state"
  }

  public static func complete(picks: Int, error: AtlasClientError? = nil) -> CompleteAction {
    if picks < minPicks { return .disabled }
    guard let error else { return .building }
    return errorCode(error) == "conflict" ? .reloadState : .retry
  }

  // MARK: Screen 15

  public enum SeedAction: String, Equatable, Sendable {
    case wait, advance, background
  }

  public static func seed(state: SeedState, categories: [SeedCategoryState], elapsed: TimeInterval) -> SeedAction {
    if categories.contains(.ready) { return .advance }
    if state == .complete || state == .notStarted { return .advance }
    if state == .failed || state == .retrying || categories.contains(.unavailable) { return .background }
    if elapsed >= seedMaxWait { return .background }
    return .wait
  }

  public static func seed(_ status: TasteSeedStatus, elapsed: TimeInterval) -> SeedAction {
    seed(state: status.state, categories: status.categories.map(\.state), elapsed: elapsed)
  }

  public static func seedPollInterval(_ status: TasteSeedStatus) -> TimeInterval {
    status.pollAfterMS.map { TimeInterval($0) / 1000 } ?? defaultSeedPoll
  }
}
