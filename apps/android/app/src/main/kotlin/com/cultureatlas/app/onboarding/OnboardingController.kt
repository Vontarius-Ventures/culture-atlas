package com.cultureatlas.app.onboarding

import com.cultureatlas.capture.core.contract.CreatePickRequest
import com.cultureatlas.capture.core.contract.CreatePickResponse
import com.cultureatlas.capture.core.contract.OnboardingCatalog
import com.cultureatlas.capture.core.contract.OnboardingCatalogEntry
import com.cultureatlas.capture.core.contract.OnboardingPick
import com.cultureatlas.capture.core.contract.OnboardingSearchResult
import com.cultureatlas.capture.core.contract.OnboardingStateResponse
import com.cultureatlas.capture.core.contract.TasteCategory
import com.cultureatlas.capture.core.contract.TasteSeedStatus
import com.cultureatlas.capture.core.net.AtlasApi
import com.cultureatlas.capture.core.net.completeOnboarding
import com.cultureatlas.capture.core.net.createOnboardingPick
import com.cultureatlas.capture.core.net.createTastePick
import com.cultureatlas.capture.core.net.deleteOnboardingPick
import com.cultureatlas.capture.core.net.deleteTastePick
import com.cultureatlas.capture.core.net.onboardingCatalog
import com.cultureatlas.capture.core.net.onboardingState
import com.cultureatlas.capture.core.net.putFoodExclusions
import com.cultureatlas.capture.core.net.searchOnboarding
import com.cultureatlas.capture.core.net.seedStatus
import com.cultureatlas.capture.core.net.tastePicks
import com.cultureatlas.capture.core.onboarding.OnboardingPolicy
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * Taste onboarding on Android (spec amendment 2.2): the required questionnaire
 * after sign-in (screen 14, three steps), the building-feed interstitial
 * (screen 15) and Settings → Taste (screen 18). Every pick is saved on the
 * server as it is made, so leaving mid-way keeps what was picked and the
 * questionnaire resumes at the next sign-in until 3 picks are complete.
 */
class OnboardingController(private val api: AtlasApi, private val scope: CoroutineScope) {
    enum class Gate { CHECKING, ONBOARDING, BUILDING, RETRY, DONE }

    private val _gate = MutableStateFlow(Gate.CHECKING)
    val gate: StateFlow<Gate> = _gate
    private val _catalog = MutableStateFlow<OnboardingCatalog?>(null)
    val catalog: StateFlow<OnboardingCatalog?> = _catalog
    private val _picks = MutableStateFlow<List<OnboardingPick>>(emptyList())
    val picks: StateFlow<List<OnboardingPick>> = _picks
    private val _picksCount = MutableStateFlow(0)
    val picksCount: StateFlow<Int> = _picksCount
    private val _exclusions = MutableStateFlow<List<String>>(emptyList())
    val exclusions: StateFlow<List<String>> = _exclusions
    val step = MutableStateFlow(1)
    private val _searchText = MutableStateFlow("")
    val searchText: StateFlow<String> = _searchText
    private val _searchResults = MutableStateFlow<List<OnboardingSearchResult>>(emptyList())
    val searchResults: StateFlow<List<OnboardingSearchResult>> = _searchResults
    private val _searchUnavailable = MutableStateFlow(false)
    val searchUnavailable: StateFlow<Boolean> = _searchUnavailable
    private val _searchPicked = MutableStateFlow<Set<String>>(emptySet())
    val searchPicked: StateFlow<Set<String>> = _searchPicked
    private val _busy = MutableStateFlow<Set<String>>(emptySet())
    val busy: StateFlow<Set<String>> = _busy
    private val _completing = MutableStateFlow(false)
    val completing: StateFlow<Boolean> = _completing
    private val _seed = MutableStateFlow<TasteSeedStatus?>(null)
    val seed: StateFlow<TasteSeedStatus?> = _seed
    private val _seedAction = MutableStateFlow(OnboardingPolicy.SeedAction.WAIT)
    val seedAction: StateFlow<OnboardingPolicy.SeedAction> = _seedAction
    /** The server ended this phone's session while checking onboarding. */
    private val _sessionEnded = MutableStateFlow(false)
    val sessionEnded: StateFlow<Boolean> = _sessionEnded
    val message = MutableStateFlow<String?>(null)

    /** Exclusions as last saved on the server (PUT only when they changed). */
    private var savedExclusions: List<String> = emptyList()
    private var searchJob: Job? = null
    private var seedJob: Job? = null

    // Entry (after sign-in)

    /** Decides whether the signed-in account goes to the questionnaire. */
    suspend fun evaluate(onboardingFlag: Boolean) {
        _gate.value = Gate.CHECKING
        val entry = try {
            val response = if (onboardingFlag) api.onboardingState() else null
            response?.let(::apply)
            OnboardingPolicy.entry(onboardingFlag, response?.state?.required, null)
        } catch (e: Exception) {
            OnboardingPolicy.entry(onboardingFlag, null, OnboardingPolicy.errorCode(e))
        }
        when (entry) {
            OnboardingPolicy.Entry.APP -> _gate.value = Gate.DONE
            OnboardingPolicy.Entry.RETRY -> _gate.value = Gate.RETRY
            OnboardingPolicy.Entry.ONBOARDING -> {
                _gate.value = Gate.ONBOARDING
                loadCatalog()
            }
            // AtlasApp observes this and signs out (local drafts are kept).
            OnboardingPolicy.Entry.SIGN_IN -> _sessionEnded.value = true
        }
    }

    fun reset() {
        searchJob?.cancel()
        seedJob?.cancel()
        _gate.value = Gate.CHECKING
        _sessionEnded.value = false
        _catalog.value = null
        _picks.value = emptyList()
        _picksCount.value = 0
        _exclusions.value = emptyList()
        savedExclusions = emptyList()
        step.value = 1
        _searchText.value = ""
        _searchResults.value = emptyList()
        _searchPicked.value = emptySet()
        _seed.value = null
    }

    private fun apply(response: OnboardingStateResponse) {
        _picks.value = response.picks
        _picksCount.value = response.state.picksCount
        _exclusions.value = response.foodExclusions
        savedExclusions = response.foodExclusions
        _seed.value = response.seed
    }

    suspend fun loadCatalog() {
        try {
            _catalog.value = api.onboardingCatalog()
        } catch (e: Exception) {
            message.value = "We couldn't load the ideas. Check your connection and try again."
        }
    }

    // Picks (catalog images, chips, search)

    fun isPicked(entry: OnboardingCatalogEntry, picks: List<OnboardingPick>) = picks.any { it.catalogItemId == entry.id }

    /** Picking saves at once; unpicking unsaves every save of the pick. */
    fun toggle(entry: OnboardingCatalogEntry, settings: Boolean = false) {
        if (entry.id in _busy.value) return
        scope.launch {
            _busy.update { it + entry.id }
            try {
                val existing = _picks.value.firstOrNull { it.catalogItemId == entry.id }
                if (existing != null) {
                    val removed = if (settings) api.deleteTastePick(existing.id) else api.deleteOnboardingPick(existing.id)
                    _picks.update { list -> list.filterNot { it.id == removed.removedPickId } }
                    _picksCount.value = removed.state.picksCount
                } else {
                    val request = CreatePickRequest.catalog(entry.id)
                    record(if (settings) api.createTastePick(request) else api.createOnboardingPick(request))
                }
            } catch (e: Exception) {
                message.value = "That didn't save. Try again."
            } finally {
                _busy.update { it - entry.id }
            }
        }
    }

    fun add(result: OnboardingSearchResult, settings: Boolean = false) {
        if (result.picked || result.resultId in _searchPicked.value || result.resultId in _busy.value) return
        scope.launch {
            _busy.update { it + result.resultId }
            try {
                val request = CreatePickRequest.search(result.resultId)
                record(if (settings) api.createTastePick(request) else api.createOnboardingPick(request))
                _searchPicked.update { it + result.resultId }
            } catch (e: Exception) {
                message.value = "That didn't save. Try again."
            } finally {
                _busy.update { it - result.resultId }
            }
        }
    }

    fun remove(pick: OnboardingPick) {
        scope.launch {
            try {
                val removed = api.deleteTastePick(pick.id)
                _picks.update { list -> list.filterNot { it.id == removed.removedPickId } }
                _picksCount.value = removed.state.picksCount
            } catch (e: Exception) {
                message.value = "That wasn't removed. Try again."
            }
        }
    }

    private fun record(created: CreatePickResponse) {
        _picks.update { list -> if (list.any { it.id == created.pick.id }) list else list + created.pick }
        _picksCount.value = created.state.picksCount
    }

    // Search ("Add an artist, film, brand or place")

    fun onSearchText(text: String) {
        _searchText.value = text
        searchJob?.cancel()
        val query = OnboardingPolicy.searchQuery(text)
        if (query == null) {
            _searchResults.value = emptyList()
            _searchUnavailable.value = false
            return
        }
        searchJob = scope.launch {
            delay(OnboardingPolicy.SEARCH_DEBOUNCE_MS)
            try {
                val response = api.searchOnboarding(query)
                _searchUnavailable.value = response.unavailable
                _searchResults.value = response.results
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Exception) {
                // Picks from the ideas above always work; search just takes a break.
                _searchUnavailable.value = true
                _searchResults.value = emptyList()
            }
        }
    }

    // Exclusions (optional, never picks)

    fun toggleExclusion(term: String) {
        _exclusions.update { OnboardingPolicy.toggleExclusion(it, term) }
    }

    /** Adds a free-text exclusion; returns the reason it was not added, if any. */
    fun addOtherExclusion(raw: String): OnboardingPolicy.ExclusionRejection? {
        val out = OnboardingPolicy.addExclusion(_exclusions.value, raw)
        _exclusions.value = out.list
        return out.rejected
    }

    suspend fun saveExclusions(): Boolean {
        if (_exclusions.value == savedExclusions) return true
        return try {
            val saved = api.putFoodExclusions(_exclusions.value)
            _exclusions.value = saved.foodExclusions
            savedExclusions = saved.foodExclusions
            true
        } catch (e: Exception) {
            message.value = "Your exclusions didn't save. Try again."
            false
        }
    }

    // "Build my feed" and screen 15

    fun buildFeed() {
        if (OnboardingPolicy.complete(_picksCount.value) == OnboardingPolicy.CompleteAction.DISABLED || _completing.value) return
        scope.launch {
            _completing.value = true
            try {
                if (!saveExclusions()) return@launch
                val response = api.completeOnboarding()
                _picksCount.value = response.state.picksCount
                _seed.value = response.seed
                _gate.value = Gate.BUILDING
                pollSeed(response.seed)
            } catch (e: Exception) {
                when (OnboardingPolicy.complete(_picksCount.value, OnboardingPolicy.errorCode(e))) {
                    OnboardingPolicy.CompleteAction.RELOAD_STATE -> runCatching { api.onboardingState() }.getOrNull()?.let(::apply)
                    else -> message.value = "We couldn't start your feed. Check your connection and try again."
                }
            } finally {
                _completing.value = false
            }
        }
    }

    private fun pollSeed(initial: TasteSeedStatus) {
        seedJob?.cancel()
        val started = System.currentTimeMillis()
        seedJob = scope.launch {
            var status = initial
            while (true) {
                val action = OnboardingPolicy.seed(status, System.currentTimeMillis() - started)
                _seed.value = status
                _seedAction.value = action
                when (action) {
                    OnboardingPolicy.SeedAction.ADVANCE -> {
                        finish()
                        return@launch
                    }
                    // Shows "We'll keep building in the background." with Done.
                    OnboardingPolicy.SeedAction.BACKGROUND -> return@launch
                    OnboardingPolicy.SeedAction.WAIT -> {
                        delay(OnboardingPolicy.seedPollMs(status))
                        runCatching { api.seedStatus() }.getOrNull()?.let { status = it }
                    }
                }
            }
        }
    }

    fun finish() {
        seedJob?.cancel()
        _gate.value = Gate.DONE
    }

    // Settings → Taste

    suspend fun loadTaste() {
        try {
            val taste = api.tastePicks()
            _picks.value = taste.picks.all
            _picksCount.value = taste.picksCount
            taste.foodExclusions?.let {
                _exclusions.value = it
                savedExclusions = it
            }
            if (_catalog.value == null) loadCatalog()
        } catch (e: Exception) {
            message.value = "We couldn't load your taste. Check your connection and try again."
        }
    }

    fun picksIn(category: TasteCategory?, picks: List<OnboardingPick>) = picks.filter { it.category == category }
}
