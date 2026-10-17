package com.cultureatlas.app.capture

import android.app.Activity
import android.content.Context
import com.meta.wearable.dat.camera.StreamSession
import com.meta.wearable.dat.camera.types.StreamConfiguration
import com.meta.wearable.dat.camera.types.VideoQuality
import com.meta.wearable.dat.core.Wearables
import com.meta.wearable.dat.core.selectors.AutoDeviceSelector
import com.meta.wearable.dat.core.types.Permission
import com.meta.wearable.dat.core.types.PermissionStatus
import com.meta.wearable.dat.core.types.RegistrationState
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

/**
 * The ONLY file that calls the Meta Wearables Device Access Toolkit for
 * Android. Everything else talks to [DatSdk].
 *
 * UNVERIFIED BINDING: this repository has no network access to the SDK, so
 * the package, class and method names below follow the toolkit's published
 * Android developer-preview documentation from memory and have never been
 * compiled. The first experimental CI build must confirm each call against
 * the pinned version (gradle/libs.versions.toml `metaWearables`) and adjust
 * this file only. See docs/native.md, "Android SDK binding".
 */
class MetaDatBinding(private val context: Context) : DatSdk {
    init {
        Wearables.initialize(context)
    }

    override val registered: Flow<DatSdk.Registration> = Wearables.registrationState.map { state ->
        when (state) {
            is RegistrationState.Registered -> DatSdk.Registration.REGISTERED
            is RegistrationState.Registering -> DatSdk.Registration.REGISTERING
            else -> DatSdk.Registration.UNREGISTERED
        }
    }

    override val deviceAvailable: Flow<Boolean> = Wearables.devices.map { it.isNotEmpty() }

    override suspend fun startRegistration(activity: Activity) {
        Wearables.startRegistration(activity)
    }

    override suspend fun startUnregistration(activity: Activity) {
        Wearables.startUnregistration(activity)
    }

    override suspend fun cameraPermissionGranted(): Boolean =
        Wearables.checkPermissionStatus(Permission.CAMERA) == PermissionStatus.Granted

    override suspend fun requestCameraPermission(activity: Activity): Boolean =
        Wearables.requestPermission(activity, Permission.CAMERA) == PermissionStatus.Granted

    override suspend fun openStream(frameRate: Int): DatSdk.Stream {
        // Low quality at 24 fps mirrors Observer's validated iOS stability profile.
        val session = Wearables.startStreamSession(
            context,
            AutoDeviceSelector(),
            StreamConfiguration(videoQuality = VideoQuality.LOW, frameRate = frameRate),
        )
        return BoundStream(session)
    }

    private class BoundStream(private val session: StreamSession) : DatSdk.Stream {
        override val streaming: Flow<Boolean> = session.state.map { it.name == "STREAMING" }
        override val frames: Flow<DatSdk.Frame> = session.videoStream.map { frame ->
            val bytes = ByteArray(frame.buffer.remaining()).also { frame.buffer.get(it) }
            DatSdk.Frame(bytes, frame.width, frame.height, frame.presentationTimeUs)
        }

        override suspend fun capturePhotoJpeg(): ByteArray = session.capturePhoto().getOrThrow().data

        override fun close() = session.close()
    }
}

/** SDK-independent surface used by [MetaGlassesAdapter]. */
interface DatSdk {
    enum class Registration { UNREGISTERED, REGISTERING, REGISTERED }

    /** One decoded I420 frame from the glasses. */
    class Frame(val i420: ByteArray, val width: Int, val height: Int, val presentationUs: Long)

    interface Stream {
        val streaming: Flow<Boolean>
        val frames: Flow<Frame>
        suspend fun capturePhotoJpeg(): ByteArray
        fun close()
    }

    val registered: Flow<Registration>
    val deviceAvailable: Flow<Boolean>
    suspend fun startRegistration(activity: Activity)
    suspend fun startUnregistration(activity: Activity)
    suspend fun cameraPermissionGranted(): Boolean
    suspend fun requestCameraPermission(activity: Activity): Boolean
    suspend fun openStream(frameRate: Int): Stream
}
