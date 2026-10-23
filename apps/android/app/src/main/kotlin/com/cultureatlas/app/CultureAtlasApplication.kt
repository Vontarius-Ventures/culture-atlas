package com.cultureatlas.app

import android.app.Application
import coil.ImageLoader
import coil.ImageLoaderFactory
import com.cultureatlas.app.capture.AudioCaptureController
import com.cultureatlas.app.capture.GlassesAdapter
import com.cultureatlas.app.capture.GlassesFactory
import com.cultureatlas.app.capture.PhoneCameraController
import com.cultureatlas.app.data.FileDraftRepository
import com.cultureatlas.app.data.FileReceiptRepository
import com.cultureatlas.app.notify.AtlasMessagingService
import com.cultureatlas.app.notify.ReadyNoticeCenter
import com.cultureatlas.app.onboarding.OnboardingController
import com.cultureatlas.app.security.KeystoreVault
import com.cultureatlas.app.upload.OkHttpPartTransfer
import com.cultureatlas.capture.core.identity.AccountClient
import com.cultureatlas.capture.core.identity.SessionManager
import com.cultureatlas.capture.core.net.AtlasApi
import com.cultureatlas.capture.core.net.AtlasHttp
import com.cultureatlas.capture.core.net.PrivateMediaPolicy
import com.cultureatlas.capture.core.upload.UploadEngine
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient

class CultureAtlasApplication : Application(), ImageLoaderFactory {
    lateinit var graph: AppGraph
        private set

    override fun onCreate() {
        super.onCreate()
        graph = AppGraph(this)
        // Ready-notice push (screen 17) when the build carries Firebase settings.
        AtlasMessagingService.initialize(this)
    }

    /** Every AsyncImage uses the graph's loader (bearer for the owner's own media only). */
    override fun newImageLoader(): ImageLoader = graph.imageLoader
}

/**
 * Composition root: one instance of each dependency, no global relay profile,
 * operator device or shared upload identity.
 */
class AppGraph(val app: Application) {
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    val vault = KeystoreVault(app)
    val http = AtlasHttp.forHost(BuildConfig.ATLAS_API_HOST)
    val sessions = SessionManager(http, vault.tokens)
    val api = AtlasApi(http, sessions)
    val drafts = FileDraftRepository(app, vault)
    val receipts = FileReceiptRepository(app)
    val uploadEngine = UploadEngine(api, drafts, OkHttpPartTransfer())
    val camera = PhoneCameraController(app)
    val audio = AudioCaptureController(app)
    val glasses: GlassesAdapter = GlassesFactory.create(app)
    val accounts = AccountClient(
        http = http,
        sessions = sessions,
        keys = vault.installations,
        pending = vault.pendingSignIn,
        appVersion = "${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})",
        capabilities = {
            mapOf(
                "photo" to true,
                "video" to true,
                "microphone" to true,
                "meta_glasses_sdk" to BuildConfig.META_DAT,
            )
        },
    )

    val controller: AppController by lazy { AppController(this) }

    /**
     * Crossfading image loader. The owner's own renditions (`/v2/media/…` on
     * this build's API host) get the installation bearer; nothing else does.
     */
    val imageLoader: ImageLoader by lazy {
        ImageLoader.Builder(app)
            .okHttpClient {
                OkHttpClient.Builder()
                    .addInterceptor { chain ->
                        val request = chain.request()
                        val url = request.url
                        val private = PrivateMediaPolicy.needsBearer(url.scheme, url.host, url.port, url.encodedPath, BuildConfig.ATLAS_API_HOST)
                        val token = if (private) runCatching { runBlocking { sessions.accessToken() } }.getOrNull() else null
                        chain.proceed(
                            if (token != null) request.newBuilder().header("Authorization", "Bearer $token").build() else request,
                        )
                    }
                    .build()
            }
            .crossfade(true)
            .build()
    }
    val onboarding: OnboardingController by lazy { OnboardingController(api, scope) }
    val notices: ReadyNoticeCenter by lazy {
        ReadyNoticeCenter(app, api, sessions, scope, java.io.File(app.filesDir, "ready"))
    }

    private val draftsVersion = MutableStateFlow(0L)
    /** Bumped whenever a draft changes (UI reloads). */
    val draftsChanged: StateFlow<Long> = draftsVersion

    fun notifyDraftsChanged() {
        draftsVersion.value = draftsVersion.value + 1
    }
}
