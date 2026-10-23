package com.cultureatlas.capture.core.notify

import com.cultureatlas.capture.core.contract.AnalysisState
import com.cultureatlas.capture.core.contract.AtlasContract
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import java.io.File
import java.time.Duration
import java.time.Instant

/**
 * Screen 17 on Android: "Your photo is ready" for analyses this phone's user
 * started (fixtures/native-contract/ready-notice.json).
 *
 * FCM messages are data-only wake-ups that carry an opaque reference. Nothing
 * in them is trusted or shown: on a valid wake the app asks the server about
 * the analyses it is watching and decides locally what to show.
 */
object ReadyNoticeCopy {
    const val TITLE = "Your photo is ready"
    const val OPEN = "Open"
    const val DISMISS = "Dismiss"

    val byKey = mapOf("ready.toast" to TITLE, "ready.open" to OPEN, "ready.dismiss" to DISMISS)
}

object ReadyNoticePolicy {
    const val MAX_WATCHED = 20
    const val EXPIRE_AFTER_HOURS = 24.0
    const val FOREGROUND_POLL_SECONDS = 5L
    private val REFERENCE = Regex("^[A-Za-z0-9_-]{16,64}$")

    enum class Presence(val wire: String) { BACKGROUND("background"), FOREGROUND("foreground"), VIEWING("viewing") }

    enum class Notice(val wire: String) { NONE("none"), TOAST("toast"), NOTIFICATION("notification") }

    data class Decision(val notice: Notice, val keepWatching: Boolean)

    fun decide(state: AnalysisState, app: Presence, watched: Boolean, notified: Boolean, ageHours: Double): Decision {
        val stop = Decision(Notice.NONE, keepWatching = false)
        // Only analyses the user started on this phone; never twice; never stale.
        if (!watched || notified || ageHours >= EXPIRE_AFTER_HOURS) return stop
        return when (state) {
            AnalysisState.QUEUED, AnalysisState.RUNNING, AnalysisState.PARTIAL -> Decision(Notice.NONE, keepWatching = true)
            AnalysisState.FAILED, AnalysisState.CANCELLED -> stop
            AnalysisState.COMPLETE -> when (app) {
                Presence.BACKGROUND -> Decision(Notice.NOTIFICATION, keepWatching = false)
                Presence.FOREGROUND -> Decision(Notice.TOAST, keepWatching = false)
                Presence.VIEWING -> stop
            }
        }
    }

    /** A wake is valid only when its data carries an opaque base64url reference. */
    fun isValidWake(data: Map<String, String>): Boolean = data["ref"]?.let { REFERENCE.matches(it) } == true
}

/** An analysis the user started from this phone, watched until it ends. */
@Serializable
data class WatchedAnalysis(
    val mediaId: String,
    val analysisId: String,
    val startedAt: String,
    val notified: Boolean = false,
) {
    fun ageHours(now: Instant): Double = Duration.between(Instant.parse(startedAt), now).toMillis() / 3_600_000.0
}

/**
 * Watched analyses per account in the app's private files (ids only, never
 * media or results). Synchronized: FCM and the UI may touch it concurrently.
 */
class ReadyNoticeStore(private val directory: File) {
    private val serializer = ListSerializer(WatchedAnalysis.serializer())

    private fun file(account: String) = File(directory, "ready-${account.lowercase()}.json")

    @Synchronized
    fun watched(account: String): List<WatchedAnalysis> {
        val file = file(account)
        if (!file.exists()) return emptyList()
        return runCatching { AtlasContract.json.decodeFromString(serializer, file.readText()) }.getOrDefault(emptyList())
    }

    @Synchronized
    private fun save(list: List<WatchedAnalysis>, account: String) {
        directory.mkdirs()
        val tmp = File(directory, "ready-${account.lowercase()}.tmp")
        tmp.writeText(AtlasContract.json.encodeToString(serializer, list))
        tmp.renameTo(file(account))
    }

    /** Starts watching; the oldest entries drop beyond [ReadyNoticePolicy.MAX_WATCHED]. */
    @Synchronized
    fun watch(analysis: WatchedAnalysis, account: String) {
        val list = (watched(account).filterNot { it.analysisId == analysis.analysisId } + analysis)
            .sortedBy { Instant.parse(it.startedAt) }
        save(list.takeLast(ReadyNoticePolicy.MAX_WATCHED), account)
    }

    @Synchronized
    fun stop(analysisId: String, account: String) {
        save(watched(account).filterNot { it.analysisId == analysisId }, account)
    }

    @Synchronized
    fun clear(account: String) {
        file(account).delete()
    }
}
