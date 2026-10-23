package com.cultureatlas.app.notify

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.cultureatlas.app.BuildConfig
import com.cultureatlas.app.MainActivity
import com.cultureatlas.capture.core.contract.AnalysisState
import com.cultureatlas.capture.core.contract.AnalyzeAudioRequest
import com.cultureatlas.capture.core.contract.AudioSelection
import com.cultureatlas.capture.core.contract.PushTokenRequest
import com.cultureatlas.capture.core.identity.SessionManager
import com.cultureatlas.capture.core.net.AtlasApi
import com.cultureatlas.capture.core.net.analysis
import com.cultureatlas.capture.core.net.clearPushToken
import com.cultureatlas.capture.core.net.media
import com.cultureatlas.capture.core.net.registerPushToken
import com.cultureatlas.capture.core.net.startAnalysis
import com.cultureatlas.capture.core.net.startAudioAnalysis
import com.cultureatlas.capture.core.policy.AudioPolicy
import com.cultureatlas.capture.core.notify.ReadyNoticeCopy
import com.cultureatlas.capture.core.notify.ReadyNoticePolicy
import com.cultureatlas.capture.core.notify.ReadyNoticeStore
import com.cultureatlas.capture.core.notify.WatchedAnalysis
import com.cultureatlas.capture.core.result.ResultRoute
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.io.File
import java.time.Instant

/**
 * Screen 17 on Android: "Your photo is ready" with Open, for analyses the user
 * started from this phone ("Explore this photo" in the library). Open shows
 * the native result screen ([openRequest]); nothing leaves for the browser.
 *
 * - FCM messages are data-only wake-ups carrying an opaque reference
 *   (ReadyNoticePolicy.isValidWake); nothing in them is shown or trusted. On a
 *   wake the app asks the server about the analyses it watches and posts a
 *   local notification for each one that completed.
 * - In the foreground the same check runs every few seconds and shows an
 *   in-app toast instead of a system notification.
 * - POST_NOTIFICATIONS is asked when the user first explores a photo, never at
 *   launch. The FCM token is registered with PUT /v2/device/push-token and
 *   cleared before sign-out.
 */
class ReadyNoticeCenter(
    private val context: Context,
    private val api: AtlasApi,
    private val sessions: SessionManager,
    private val scope: CoroutineScope,
    directory: File,
) {
    data class Toast(val mediaId: String, val analysisId: String, val resultPath: String?)

    private val store = ReadyNoticeStore(directory)
    private val checking = Mutex()
    private val _toast = MutableStateFlow<Toast?>(null)
    val toast: StateFlow<Toast?> = _toast
    private val _openRequest = MutableStateFlow<ResultRoute?>(null)
    /** A result the user asked to open (toast, notification): the shell pushes the native result screen. */
    val openRequest: StateFlow<ResultRoute?> = _openRequest
    private val _exploring = MutableStateFlow<Set<String>>(emptySet())
    val exploring: StateFlow<Set<String>> = _exploring
    @Volatile private var presence = ReadyNoticePolicy.Presence.BACKGROUND
    private var foregroundLoop: Job? = null

    init {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(CHANNEL, "Ready notices", NotificationManager.IMPORTANCE_DEFAULT)
            context.getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
    }

    // Registration

    fun registerToken(token: String) {
        if (sessions.currentAccountId == null) return
        scope.launch {
            runCatching {
                api.registerPushToken(PushTokenRequest(provider = "fcm", token = token, environment = BuildConfig.ATLAS_PUSH_ENVIRONMENT))
            }
        }
    }

    /** Before sign-out: stop wake-ups for this phone and forget its watches. */
    suspend fun signingOut() {
        foregroundLoop?.cancel()
        _toast.value = null
        _exploring.value = emptySet()
        runCatching { api.clearPushToken() }
        sessions.currentAccountId?.let { store.clear(it) }
    }

    // "Explore this photo"

    suspend fun explore(assetId: String): Boolean {
        val account = sessions.currentAccountId ?: return false
        _exploring.value = _exploring.value + assetId.lowercase()
        return try {
            val media = api.media(assetId)
            val status = api.startAnalysis(assetId, media.generation)
            store.watch(WatchedAnalysis(assetId.lowercase(), status.analysisId, Instant.now().toString()), account)
            onForeground(true)
            true
        } catch (e: Exception) {
            _exploring.value = _exploring.value - assetId.lowercase()
            false
        }
    }

    /** Explore music: `POST /v2/media/{id}/analysis` with contract 2 and `music_match` only. */
    suspend fun exploreAudio(assetId: String, durationMs: Int): Boolean {
        val account = sessions.currentAccountId ?: return false
        val range = AudioPolicy.musicSelection(durationMs) ?: return false
        _exploring.value = _exploring.value + assetId.lowercase()
        return try {
            val media = api.media(assetId)
            val status = api.startAudioAnalysis(
                assetId,
                AnalyzeAudioRequest(
                    expectedGeneration = media.generation,
                    requestedComponents = AudioPolicy.musicMatchComponents,
                    selection = AudioSelection(startMs = range.first, endMs = range.second),
                ),
            )
            store.watch(WatchedAnalysis(assetId.lowercase(), status.analysisId, Instant.now().toString()), account)
            onForeground(true)
            true
        } catch (e: Exception) {
            _exploring.value = _exploring.value - assetId.lowercase()
            false
        }
    }

    // Checking watched analyses

    /** One pass over the watched analyses; returns whether anything changed. */
    suspend fun check(): Boolean = checking.withLock {
        val account = sessions.currentAccountId ?: return@withLock false
        var changed = false
        val now = Instant.now()
        for (watch in store.watched(account)) {
            val expired = watch.ageHours(now) >= ReadyNoticePolicy.EXPIRE_AFTER_HOURS
            val status = if (expired) null else runCatching { api.analysis(watch.mediaId, watch.analysisId) }.getOrNull()
            if (!expired && status == null) continue
            val decision = ReadyNoticePolicy.decide(
                status?.state ?: AnalysisState.CANCELLED, presence, watched = true, notified = watch.notified,
                ageHours = watch.ageHours(now),
            )
            when (decision.notice) {
                ReadyNoticePolicy.Notice.NOTIFICATION -> postNotification(watch, status?.resultUrl)
                ReadyNoticePolicy.Notice.TOAST -> _toast.value = Toast(watch.mediaId, watch.analysisId, status?.resultUrl)
                ReadyNoticePolicy.Notice.NONE -> Unit
            }
            if (!decision.keepWatching) {
                store.stop(watch.analysisId, account)
                _exploring.value = _exploring.value - watch.mediaId
                changed = true
            }
        }
        changed
    }

    /** A data message arrived. Invalid payloads are ignored. */
    suspend fun handleWake(data: Map<String, String>): Boolean {
        if (!ReadyNoticePolicy.isValidWake(data)) return false
        return check()
    }

    private fun postNotification(watch: WatchedAnalysis, resultPath: String?) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            return
        }
        val open = openIntent(watch)
        val notification = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_menu_gallery)
            .setContentTitle(ReadyNoticeCopy.TITLE)
            .setAutoCancel(true)
            .setContentIntent(open)
            .addAction(0, ReadyNoticeCopy.OPEN, open)
            .build()
        NotificationManagerCompat.from(context).notify(watch.analysisId.hashCode(), notification)
    }

    /** Opens this app on the native result screen (never the browser). */
    private fun openIntent(watch: WatchedAnalysis): PendingIntent {
        val intent = Intent(context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra(EXTRA_MEDIA, watch.mediaId)
            .putExtra(EXTRA_ANALYSIS, watch.analysisId)
        return PendingIntent.getActivity(
            context, watch.analysisId.hashCode(), intent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
    }

    /** From a notification tap: ids are validated as UUIDs before they reach an API path. */
    fun openFromIntent(intent: Intent?) {
        val route = ResultRoute.parse(intent?.getStringExtra(EXTRA_MEDIA), intent?.getStringExtra(EXTRA_ANALYSIS)) ?: return
        _toast.value = null
        _openRequest.value = route
    }

    fun resultUri(resultPath: String?): Uri? =
        resultPath?.takeIf { it.startsWith("/") && !it.startsWith("//") }?.let { Uri.parse("https://${BuildConfig.ATLAS_API_HOST}$it") }

    // Lifecycle and toast

    fun onForeground(isForeground: Boolean) {
        presence = if (isForeground) ReadyNoticePolicy.Presence.FOREGROUND else ReadyNoticePolicy.Presence.BACKGROUND
        foregroundLoop?.cancel()
        if (!isForeground) return
        foregroundLoop = scope.launch {
            while (isActive) {
                check()
                val account = sessions.currentAccountId ?: break
                if (store.watched(account).isEmpty()) break
                delay(ReadyNoticePolicy.FOREGROUND_POLL_SECONDS * 1000)
            }
        }
    }

    fun dismissToast() {
        _toast.value = null
    }

    /** "Open" on the in-app toast: the shell shows the native result. */
    fun open(toast: Toast) {
        _toast.value = null
        _openRequest.value = ResultRoute.parse(toast.mediaId, toast.analysisId)
    }

    fun consumeOpenRequest() {
        _openRequest.value = null
    }

    /** The user started exploring from a screen that shows the result itself (library, result screen). */
    suspend fun watch(mediaId: String, analysisId: String) {
        val account = sessions.currentAccountId ?: return
        _exploring.value = _exploring.value + mediaId.lowercase()
        store.watch(WatchedAnalysis(mediaId.lowercase(), analysisId, Instant.now().toString()), account)
        onForeground(true)
    }

    companion object {
        const val CHANNEL = "ready_notice"
        const val EXTRA_MEDIA = "com.cultureatlas.app.result.media"
        const val EXTRA_ANALYSIS = "com.cultureatlas.app.result.analysis"
    }
}
