package com.cultureatlas.capture.core.policy

import com.cultureatlas.capture.core.contract.AtlasContract
import com.cultureatlas.capture.core.contract.Capabilities
import com.cultureatlas.capture.core.contract.UploadState
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.random.Random

/** Drafts belong to the account that captured them (TEN-02, draft-lock.json). */
object DraftLockPolicy {
    data class Visibility(val visible: Boolean, val uploadable: Boolean, val lockedNotice: Boolean)

    fun visibility(draftOwner: String, signedIn: String?): Visibility {
        val owner = signedIn == draftOwner
        return Visibility(owner, owner, !owner)
    }

    /** X-Atlas-Expected-Account for every upload mutation: the draft's owner. */
    fun expectedAccountHeader(draftOwner: String): String = draftOwner.lowercase()

    enum class Effect(val wire: String) { LOCK_TO_OWNER("lock_to_owner"), KEEP_LOCKED("keep_locked"), NONE("none") }

    fun effectForErrorCode(code: String): Effect = when (code) {
        "account_mismatch" -> Effect.LOCK_TO_OWNER
        "token_revoked", "unauthenticated" -> Effect.KEEP_LOCKED
        else -> Effect.NONE
    }

    fun effectForUploadState(state: UploadState, pauseReason: String?): Effect =
        if (state == UploadState.PAUSED && pauseReason == "authority_ended") Effect.LOCK_TO_OWNER else Effect.NONE

    enum class SignOutStep(val wire: String) {
        STOP_CAPTURE_AND_RECORDING("stop_capture_and_recording"),
        DISARM_AND_END_CAPTURE_SESSION("disarm_and_end_capture_session_best_effort"),
        STOP_COMMAND_POLLING("stop_command_polling"),
        CANCEL_IN_FLIGHT_TRANSFERS("cancel_in_flight_transfers"),
        LOCK_PENDING_DRAFTS("lock_pending_drafts_to_owner"),
        CALL_IDENTITY_SWITCH("call_identity_switch"),
        CLEAR_CREDENTIALS("clear_credentials"),
    }

    val signOutOrder: List<SignOutStep> = SignOutStep.entries
}

/** Experimental Meta glasses gating (capability-gate.json): server policy AND local SDK state. */
object CapabilityGate {
    val distributionReasons = setOf(
        "build_unsupported", "release_channel_ineligible", "rollout_unavailable", "device_unsupported", "temporarily_disabled",
    )

    enum class Registration { UNAVAILABLE, UNREGISTERED, REGISTERING, REGISTERED }
    enum class Permission { UNKNOWN, DENIED, GRANTED }
    enum class Stream { STOPPED, STARTING, STREAMING, PAUSED }

    data class Local(
        val registration: Registration,
        val permission: Permission,
        val deviceAvailable: Boolean,
        val stream: Stream,
        val recording: Boolean,
        val wasConnected: Boolean = false,
        val error: String? = null,
    )

    enum class GlassesState(val wire: String) {
        UNAVAILABLE("unavailable"), NOT_CONNECTED("not_connected"), REGISTERING("registering"),
        AWAITING_PERMISSION("awaiting_permission"), CONNECTING("connecting"), READY("ready"),
        RECORDING("recording"), DISCONNECTED("disconnected"), ERROR("error"),
    }

    data class Result(
        val state: GlassesState,
        val reasons: List<String>,
        val allowCapture: Boolean,
        val showCameraAndUpload: Boolean = true,
    )

    fun evaluate(buildIncludesSdk: Boolean, serverReasons: List<String>, local: Local): Result {
        val blocking = serverReasons.filter { it in distributionReasons }.toMutableList()
        if (!buildIncludesSdk && "build_unsupported" !in blocking) blocking.add(0, "build_unsupported")
        if (blocking.isNotEmpty()) return Result(GlassesState.UNAVAILABLE, blocking, false)
        if (local.error != null) return Result(GlassesState.ERROR, emptyList(), false)
        when (local.registration) {
            Registration.UNAVAILABLE -> return Result(GlassesState.UNAVAILABLE, listOf("build_unsupported"), false)
            Registration.UNREGISTERED -> return Result(GlassesState.NOT_CONNECTED, emptyList(), false)
            Registration.REGISTERING -> return Result(GlassesState.REGISTERING, emptyList(), false)
            Registration.REGISTERED -> Unit
        }
        // A connected radio does not prove camera permission.
        if (local.permission != Permission.GRANTED && local.deviceAvailable) {
            return Result(GlassesState.AWAITING_PERMISSION, emptyList(), false)
        }
        if (!local.deviceAvailable) {
            return Result(if (local.wasConnected) GlassesState.DISCONNECTED else GlassesState.NOT_CONNECTED, emptyList(), false)
        }
        if (local.recording) return Result(GlassesState.RECORDING, emptyList(), true)
        return when (local.stream) {
            Stream.STREAMING -> Result(GlassesState.READY, emptyList(), true)
            Stream.STARTING, Stream.PAUSED -> Result(GlassesState.CONNECTING, emptyList(), false)
            Stream.STOPPED -> Result(
                if (local.wasConnected) GlassesState.DISCONNECTED else GlassesState.CONNECTING, emptyList(), false,
            )
        }
    }

    fun mayShowReady(lastStatusAgeSeconds: Long): Boolean = lastStatusAgeSeconds <= AtlasContract.SERVER_STALE_AFTER_SECONDS

    data class PhoneCamera(val photo: Boolean, val video: Boolean)

    fun phoneCamera(capabilities: Capabilities?): PhoneCamera =
        PhoneCamera(
            capabilities?.flags?.get("camera_photo") ?: true,
            capabilities?.flags?.get("camera_video") ?: true,
        )

    /**
     * Photo Explore: server `availability.analysis`. Capture still works when this is off.
     * [experimental] is true when readings run on an unqualified role (production experimental
     * mode or a demo override); [label] and [note] are then shown with the capture button.
     */
    data class PhotoAnalysis(
        val available: Boolean,
        val message: String,
        val experimental: Boolean = false,
        val label: String? = null,
        val note: String? = null,
    )

    const val EXPERIMENTAL_BADGE = "Experimental"
    const val EXPERIMENTAL_NOTE = "Photo and video readings can miss details. Qloo explores entity-level taste and catalogue connections, not verified visual matches."
    const val PAUSED_MESSAGE = "Photo reading is paused right now. Your photo is saved, and we'll read it when it's back."

    fun photoAnalysis(capabilities: Capabilities?): PhotoAnalysis {
        if (capabilities == null) return PhotoAnalysis(true, "")
        val analysis = capabilities.availability["analysis"]
        val flaggedOff = capabilities.flags["concentrate_analysis_enabled"] == false
        if (analysis?.available == false || (analysis == null && flaggedOff)) {
            // The experimental kill switch pauses readings; the server's own words win when sent.
            val message = if (analysis?.reason == "paused") {
                analysis.note?.takeIf { it.isNotBlank() } ?: PAUSED_MESSAGE
            } else {
                photoAnalysisMessage(analysis?.reasons.orEmpty())
            }
            return PhotoAnalysis(false, message)
        }
        if (analysis?.experimental == true) {
            // The badge text is always "Experimental" (older servers sent "Experimental reading", no note).
            return PhotoAnalysis(
                available = true,
                message = "",
                experimental = true,
                label = EXPERIMENTAL_BADGE,
                note = analysis.note?.takeIf { it.isNotBlank() } ?: EXPERIMENTAL_NOTE,
            )
        }
        return PhotoAnalysis(true, "")
    }

    fun photoAnalysisMessage(reasons: List<String>): String = when {
        "model_unqualified" in reasons ->
            "Photo analysis isn't available yet. The vision model isn't qualified for this build. Your photos stay in this private library."
        "provider_unconfigured" in reasons ->
            "Photo analysis isn't configured. Your photos stay in this private library."
        "budget_exhausted" in reasons ->
            "Photo analysis is paused. Your photos stay in this private library."
        "privacy_unverified" in reasons ->
            "Photo analysis is waiting on a privacy confirmation. Your photos stay in this private library."
        else ->
            "Photo analysis isn't available yet. Your photos stay in this private library."
    }

    /** Music Mode Explore: server `availability.music_match`. Recording still works when this is off. */
    data class MusicMatch(val available: Boolean, val message: String)

    fun musicMatch(capabilities: Capabilities?): MusicMatch {
        if (capabilities == null) return MusicMatch(true, "")
        val match = capabilities.availability["music_match"] ?: return MusicMatch(true, "")
        if (match.available) return MusicMatch(true, "")
        return MusicMatch(false, musicMatchMessage(match.reasons))
    }

    fun musicMatchMessage(reasons: List<String>): String =
        if (reasons.any { it == "transcript_unconfigured" || it == "qloo_unconfigured" || it == "fingerprint_unavailable" })
            "Song catalog matching isn't available yet. Your recording stays in this private library. Nothing was invented."
        else
            "Music identification isn't available. Your recording stays in this private library. Nothing was invented."
}

/** Client reaction to server error codes (error-policy.json). */
object ErrorPolicy {
    enum class Action(val wire: String) {
        SURFACE_NO_RETRY("surface_no_retry"),
        SIGN_IN_REQUIRED("sign_in_required"),
        REFRESH_THEN_RETRY_ONCE("refresh_then_retry_once"),
        FEATURE_UNAVAILABLE_KEEP_LOCAL("feature_unavailable_keep_local"),
        RELOAD_STATE("reload_state"),
        LOCK_TO_ORIGINAL_ACCOUNT("lock_to_original_account"),
        SHOW_LOCAL_ACTION("show_local_action"),
        RETRY_BACKOFF("retry_backoff"),
        RESYNC("resync"),
        REJECT_ITEM("reject_item"),
        PAUSE_UNTIL_QUOTA("pause_until_quota"),
        RETRY_BACKOFF_IF_RETRYABLE_ELSE_SURFACE("retry_backoff_if_retryable_else_surface"),
    }

    fun action(code: String, retryable: Boolean = false): Action = when (code) {
        "invalid_input", "csrf_failed" -> Action.SURFACE_NO_RETRY
        "unauthenticated", "token_revoked", "account_required" -> Action.SIGN_IN_REQUIRED
        "token_expired" -> Action.REFRESH_THEN_RETRY_ONCE
        "scope_denied" -> Action.FEATURE_UNAVAILABLE_KEEP_LOCAL
        "not_found", "conflict", "idempotency_conflict", "onboarding_required" -> Action.RELOAD_STATE
        "account_mismatch" -> Action.LOCK_TO_ORIGINAL_ACCOUNT
        "action_required" -> Action.SHOW_LOCAL_ACTION
        "idempotency_in_progress", "rate_limited", "service_unavailable", "provider_unavailable", "internal" ->
            Action.RETRY_BACKOFF
        "cursor_expired" -> Action.RESYNC
        "payload_too_large", "unsupported_media", "duration_exceeded" -> Action.REJECT_ITEM
        "quota_exceeded" -> Action.PAUSE_UNTIL_QUOTA
        else -> if (retryable) Action.RETRY_BACKOFF else Action.RETRY_BACKOFF_IF_RETRYABLE_ELSE_SURFACE
    }

    /** On POST /v2/identity/switch only: already signed out. */
    val switchTerminalCodes = setOf("token_revoked", "token_expired")
}

object Backoff {
    const val BASE_SECONDS = 2.0
    const val FACTOR = 2.0
    const val MAX_SECONDS = 300.0

    fun delaySeconds(attempt: Int, retryAfterSeconds: Double? = null): Double {
        val computed = min(MAX_SECONDS, BASE_SECONDS * FACTOR.pow(max(attempt, 1) - 1))
        return if (retryAfterSeconds != null && retryAfterSeconds > computed) retryAfterSeconds else computed
    }

    fun jitteredMillis(attempt: Int, retryAfterSeconds: Double? = null): Long =
        (delaySeconds(attempt, retryAfterSeconds) * Random.nextDouble(0.8, 1.0) * 1000).toLong()
}

/** Refresh rotation (IDENTITY-CONTRACT native/refresh). */
object RefreshPolicy {
    sealed interface Outcome {
        data object Success : Outcome
        data object NetworkError : Outcome
        data class Http(val status: Int) : Outcome
    }

    enum class Action(val wire: String) {
        COMMIT_TOKENS_THEN_CLEAR_PENDING("commit_tokens_then_clear_pending"),
        RETRY_SAME_REQUEST_ID("retry_same_request_id"),
        SIGN_IN_REQUIRED("sign_in_required"),
    }

    fun action(outcome: Outcome, elapsedSeconds: Long): Action {
        val inWindow = elapsedSeconds <= AtlasContract.REFRESH_RETRY_WINDOW_SECONDS
        return when (outcome) {
            Outcome.Success -> Action.COMMIT_TOKENS_THEN_CLEAR_PENDING
            Outcome.NetworkError -> if (inWindow) Action.RETRY_SAME_REQUEST_ID else Action.SIGN_IN_REQUIRED
            is Outcome.Http ->
                if (outcome.status in setOf(400, 401, 403) || !inWindow) Action.SIGN_IN_REQUIRED else Action.RETRY_SAME_REQUEST_ID
        }
    }
}

/** 60 s bounded clips with a countdown for the last 10 s. */
class ClipClock(
    private val limitSeconds: Int = AtlasContract.CLIP_MAX_SECONDS,
    private val countdownFrom: Int = AtlasContract.COUNTDOWN_FROM_SECONDS,
) {
    data class Display(val elapsedText: String, val countdown: Int?, val shouldStop: Boolean, val spokenText: String)

    fun display(elapsedSeconds: Double): Display {
        val whole = max(0, elapsedSeconds.toInt())
        val remaining = max(0, limitSeconds - whole)
        val countdown = if (remaining <= countdownFrom) remaining else null
        val spoken = countdown?.let { "Recording, $it seconds left" } ?: "Recording, $whole seconds"
        return Display("${clock(whole)} / ${clock(limitSeconds)}", countdown, whole >= limitSeconds, spoken)
    }

    companion object {
        fun clock(seconds: Int): String = "%d:%02d".format(seconds / 60, seconds % 60)
    }
}
