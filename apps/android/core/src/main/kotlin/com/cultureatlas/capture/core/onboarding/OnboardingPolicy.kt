package com.cultureatlas.capture.core.onboarding

import com.cultureatlas.capture.core.contract.OnboardingCatalogEntry
import com.cultureatlas.capture.core.contract.OnboardingChips
import com.cultureatlas.capture.core.contract.SeedCategoryState
import com.cultureatlas.capture.core.contract.SeedState
import com.cultureatlas.capture.core.contract.TasteCategory
import com.cultureatlas.capture.core.contract.TasteSeedStatus
import com.cultureatlas.capture.core.net.AtlasClientException
import com.cultureatlas.capture.core.policy.ErrorPolicy

/**
 * Exact copy for screens 14, 15 and 18 (specs/capture-platform-v2/design/copy.json,
 * mirrored in fixtures/native-contract/onboarding.json and checked by OnboardingTest).
 */
object OnboardingCopy {
    const val IMAGES_TITLE = "Pick what catches your eye."
    const val CHIPS_TITLE = "Choose a few favorites."
    const val SEARCH_PLACEHOLDER = "Add an artist, film, brand or place"
    const val SEARCH_UNAVAILABLE = "Search is taking a break. Pick from the ideas above."
    const val SEARCH_ADD = "Add"
    const val SEARCH_ADDED = "Added"
    const val EXCLUSIONS_TITLE = "Anything to leave out?"
    const val EXCLUSIONS_OPTIONAL = "Optional"
    const val EXCLUSIONS_NOTE = "We leave these out of food ideas and plans. They don't count as picks."
    const val EXCLUSIONS_OTHER = "Something else"
    const val COUNTER_3 = "3 picks to go"
    const val COUNTER_2 = "2 picks to go"
    const val COUNTER_1 = "1 pick to go"
    const val COUNTER_READY = "Ready"
    const val PRIMARY = "Build my feed"
    const val PRIMARY_DISABLED = "Pick at least 3 so your feed starts with you."
    const val BACK = "Back"
    const val NEXT = "Next"
    const val HINT = "Pick at least 3. You can change them later under Interests."
    fun step(n: Int) = "Step $n of 3"

    const val BUILDING_TITLE = "Building your feed…"
    const val BUILDING_LEDE = "Starting with what you picked."
    const val BUILDING_UNAVAILABLE = "We'll keep building in the background."
    const val BUILDING_CATEGORY_READY = "Ready"
    const val BUILDING_CATEGORY_LOOKING = "Looking"

    const val TASTE_TITLE = "Interests"
    const val TASTE_LEDE = "Your interests shape the feed. Remove anything that no longer fits, or add more."
    const val SEE_FEED = "See my feed"
    const val TASTE_ADD_MORE = "Add more"
    const val TASTE_DONE = "Done"
    const val TASTE_SAVE = "Save"
    fun tasteRemove(label: String) = "Remove $label"

    fun group(category: TasteCategory) = when (category) {
        TasteCategory.WEAR -> "Wear"
        TasteCategory.PLAY -> "Play"
        TasteCategory.WATCH -> "Watch"
        TasteCategory.EAT -> "Eat"
    }

    /** Every key this client renders, for the fixture comparison. */
    val byKey: Map<String, String> = mapOf(
        "onboarding.images.title" to IMAGES_TITLE,
        "onboarding.chips.title" to CHIPS_TITLE,
        "onboarding.group.wear" to group(TasteCategory.WEAR),
        "onboarding.group.play" to group(TasteCategory.PLAY),
        "onboarding.group.watch" to group(TasteCategory.WATCH),
        "onboarding.group.eat" to group(TasteCategory.EAT),
        "onboarding.search.placeholder" to SEARCH_PLACEHOLDER,
        "onboarding.search.unavailable" to SEARCH_UNAVAILABLE,
        "onboarding.search.add" to SEARCH_ADD,
        "onboarding.search.added" to SEARCH_ADDED,
        "onboarding.exclusions.title" to EXCLUSIONS_TITLE,
        "onboarding.exclusions.optional" to EXCLUSIONS_OPTIONAL,
        "onboarding.exclusions.note" to EXCLUSIONS_NOTE,
        "onboarding.exclusions.other" to EXCLUSIONS_OTHER,
        "onboarding.counter.3" to COUNTER_3,
        "onboarding.counter.2" to COUNTER_2,
        "onboarding.counter.1" to COUNTER_1,
        "onboarding.counter.ready" to COUNTER_READY,
        "onboarding.primary" to PRIMARY,
        "onboarding.primary_disabled" to PRIMARY_DISABLED,
        "onboarding.back" to BACK,
        "onboarding.next" to NEXT,
        "onboarding.hint" to HINT,
        "building.title" to BUILDING_TITLE,
        "building.lede" to BUILDING_LEDE,
        "building.unavailable" to BUILDING_UNAVAILABLE,
        "building.category_ready" to BUILDING_CATEGORY_READY,
        "building.category_looking" to BUILDING_CATEGORY_LOOKING,
        "building.go" to SEE_FEED,
        "settings_taste.title" to TASTE_TITLE,
        "settings_taste.lede" to TASTE_LEDE,
        "settings_taste.add_more" to TASTE_ADD_MORE,
        "settings_taste.done" to TASTE_DONE,
        "settings_taste.save" to TASTE_SAVE,
    )
}

/** Pure rules of the native questionnaire (fixtures/native-contract/onboarding.json). */
object OnboardingPolicy {
    const val MIN_PICKS = 3
    const val MAX_PICKS = 60
    const val SEARCH_MIN_CHARS = 2
    const val SEARCH_MAX_CHARS = 80
    const val SEARCH_DEBOUNCE_MS = 300L
    const val EXCLUSIONS_MAX = 12
    const val EXCLUSION_MAX_CHARS = 40
    const val DEFAULT_SEED_POLL_MS = 1500L
    const val SEED_MAX_WAIT_MS = 20_000L

    data class Counter(val text: String, val progress: Int, val canComplete: Boolean)

    fun counter(picks: Int): Counter {
        val left = (MIN_PICKS - picks).coerceAtLeast(0)
        val text = when (left) {
            0 -> OnboardingCopy.COUNTER_READY
            1 -> OnboardingCopy.COUNTER_1
            2 -> OnboardingCopy.COUNTER_2
            else -> OnboardingCopy.COUNTER_3
        }
        return Counter(text, picks.coerceAtMost(MIN_PICKS), picks >= MIN_PICKS)
    }

    /** Round-robin Wear / Play / Watch / Eat so the first screen is not one category. */
    fun mixChips(chips: OnboardingChips): List<OnboardingCatalogEntry> {
        val queues = TasteCategory.entries.associateWith { ArrayDeque(chips[it]) }
        val mixed = mutableListOf<OnboardingCatalogEntry>()
        while (queues.values.any { it.isNotEmpty() }) {
            for (category in TasteCategory.entries) {
                queues[category]?.removeFirstOrNull()?.let(mixed::add)
            }
        }
        return mixed
    }

    /**
     * Step 1 photos arrive grouped by category (five Wear photos first). Round-robin
     * them the same way so the first screen shows Wear, Play, Watch and Eat.
     * Keeps the server order within each category.
     */
    fun mixImages(images: List<OnboardingCatalogEntry>): List<OnboardingCatalogEntry> {
        val queues = TasteCategory.entries.associateWith { category -> ArrayDeque(images.filter { it.category == category }) }
        val mixed = mutableListOf<OnboardingCatalogEntry>()
        while (queues.values.any { it.isNotEmpty() }) {
            for (category in TasteCategory.entries) {
                queues[category]?.removeFirstOrNull()?.let(mixed::add)
            }
        }
        return mixed
    }

    /** The query to send, or null while it is too short or too long to search. */
    fun searchQuery(input: String): String? = input.trim().takeIf { it.length in SEARCH_MIN_CHARS..SEARCH_MAX_CHARS }

    enum class ExclusionRejection(val wire: String) { EMPTY("empty"), TOO_LONG("too_long"), DUPLICATE("duplicate"), FULL("full") }

    data class ExclusionResult(val list: List<String>, val rejected: ExclusionRejection?)

    /** Adds a free-text or suggested exclusion (trimmed, inner spaces collapsed, case-insensitive dedupe). */
    fun addExclusion(current: List<String>, raw: String): ExclusionResult {
        val value = raw.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }.joinToString(" ")
        return when {
            value.isEmpty() -> ExclusionResult(current, ExclusionRejection.EMPTY)
            value.length > EXCLUSION_MAX_CHARS -> ExclusionResult(current, ExclusionRejection.TOO_LONG)
            current.any { it.equals(value, ignoreCase = true) } -> ExclusionResult(current, ExclusionRejection.DUPLICATE)
            current.size >= EXCLUSIONS_MAX -> ExclusionResult(current, ExclusionRejection.FULL)
            else -> ExclusionResult(current + value, null)
        }
    }

    fun toggleExclusion(current: List<String>, term: String): List<String> =
        if (current.any { it.equals(term, ignoreCase = true) }) {
            current.filterNot { it.equals(term, ignoreCase = true) }
        } else {
            addExclusion(current, term).list
        }

    /** "tree nuts" -> "Tree nuts" (the stored term stays as the server vocabulary). */
    fun label(term: String): String = term.replaceFirstChar { it.uppercase() }

    // Where to go after sign-in

    enum class Entry(val wire: String) { APP("app"), ONBOARDING("onboarding"), RETRY("retry"), SIGN_IN("sign_in") }

    /** [errorCode] is the failure of GET /v1/onboarding/state ("transport" for a network failure). */
    fun entry(onboardingFlag: Boolean, required: Boolean?, errorCode: String?): Entry = when {
        !onboardingFlag -> Entry.APP
        errorCode != null -> when {
            // A server that does not offer native onboarding never blocks the app.
            errorCode == "not_found" || errorCode == "scope_denied" -> Entry.APP
            errorCode == "token_expired" -> Entry.SIGN_IN
            ErrorPolicy.action(errorCode) == ErrorPolicy.Action.SIGN_IN_REQUIRED -> Entry.SIGN_IN
            else -> Entry.RETRY
        }
        required == true -> Entry.ONBOARDING
        else -> Entry.APP
    }

    fun errorCode(error: Throwable): String = when (error) {
        is AtlasClientException.Server -> error.code
        is AtlasClientException.Transport -> "transport"
        is AtlasClientException.Decoding -> "decoding"
        is AtlasClientException.NotSignedIn, is AtlasClientException.RefreshRequired -> "unauthenticated"
        is AtlasClientException.DraftLocked -> "account_mismatch"
        else -> "transport"
    }

    // "Build my feed"

    enum class CompleteAction(val wire: String) { DISABLED("disabled"), BUILDING("building"), RELOAD_STATE("reload_state"), RETRY("retry") }

    fun complete(picks: Int, errorCode: String? = null): CompleteAction = when {
        picks < MIN_PICKS -> CompleteAction.DISABLED
        errorCode == null -> CompleteAction.BUILDING
        errorCode == "conflict" -> CompleteAction.RELOAD_STATE
        else -> CompleteAction.RETRY
    }

    // Screen 15

    enum class SeedAction(val wire: String) { WAIT("wait"), ADVANCE("advance"), BACKGROUND("background") }

    fun seed(state: SeedState, categories: List<SeedCategoryState>, elapsedMs: Long): SeedAction = when {
        SeedCategoryState.READY in categories -> SeedAction.ADVANCE
        state == SeedState.COMPLETE || state == SeedState.NOT_STARTED -> SeedAction.ADVANCE
        state == SeedState.FAILED || state == SeedState.RETRYING || SeedCategoryState.UNAVAILABLE in categories ->
            SeedAction.BACKGROUND
        elapsedMs >= SEED_MAX_WAIT_MS -> SeedAction.BACKGROUND
        else -> SeedAction.WAIT
    }

    fun seed(status: TasteSeedStatus, elapsedMs: Long): SeedAction = seed(status.state, status.categories.map { it.state }, elapsedMs)

    fun seedPollMs(status: TasteSeedStatus): Long = status.pollAfterMs ?: DEFAULT_SEED_POLL_MS
}
