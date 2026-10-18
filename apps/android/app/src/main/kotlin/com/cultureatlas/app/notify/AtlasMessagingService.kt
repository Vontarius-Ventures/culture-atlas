package com.cultureatlas.app.notify

import android.content.Context
import com.cultureatlas.app.BuildConfig
import com.cultureatlas.app.CultureAtlasApplication
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Data-only FCM wake-ups (packages/providers/src/push/push.ts): the message
 * carries `data.ref` and nothing else. The phone then checks the analyses it
 * watches with its own session; delivery never depends on the push.
 */
class AtlasMessagingService : FirebaseMessagingService() {
    private val graph get() = (application as CultureAtlasApplication).graph

    override fun onNewToken(token: String) {
        graph.notices.registerToken(token)
    }

    /** Called on a background thread; FCM allows a short window for high-priority work. */
    override fun onMessageReceived(message: RemoteMessage) {
        runBlocking { withTimeoutOrNull(WAKE_BUDGET_MS) { graph.notices.handleWake(message.data) } }
    }

    companion object {
        private const val WAKE_BUDGET_MS = 15_000L

        /**
         * Firebase is configured from build properties (no google-services.json
         * in the repository). Without them push stays off and ready notices
         * appear only while the app is open.
         */
        fun initialize(context: Context): Boolean {
            if (BuildConfig.FCM_PROJECT_ID.isEmpty() || BuildConfig.FCM_APP_ID.isEmpty()) return false
            if (FirebaseApp.getApps(context).isEmpty()) {
                FirebaseApp.initializeApp(
                    context,
                    FirebaseOptions.Builder()
                        .setProjectId(BuildConfig.FCM_PROJECT_ID)
                        .setApplicationId(BuildConfig.FCM_APP_ID)
                        .setApiKey(BuildConfig.FCM_API_KEY)
                        .setGcmSenderId(BuildConfig.FCM_SENDER_ID)
                        .build(),
                )
            }
            return true
        }

        /** After sign-in: fetch the current token and register it for this installation. */
        fun registerCurrentToken(context: Context, notices: ReadyNoticeCenter) {
            if (!initialize(context)) return
            FirebaseMessaging.getInstance().token.addOnSuccessListener { token -> notices.registerToken(token) }
        }
    }
}
