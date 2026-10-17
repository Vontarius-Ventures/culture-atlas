package com.cultureatlas.app.capture

import android.app.Activity
import android.graphics.Bitmap
import com.cultureatlas.capture.core.policy.CapabilityGate
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import java.io.File

/**
 * Glasses seam. The experimental flavor provides the Meta DAT implementation
 * (src/experimental); the store flavor provides [UnavailableGlasses]
 * (src/store). The app never assumes the SDK exists, and `CapabilityGate`
 * combines this local state with server policy.
 */
interface GlassesAdapter {
    val buildIncludesSdk: Boolean
    val localState: StateFlow<CapabilityGate.Local>
    val preview: StateFlow<Bitmap?>

    suspend fun startRegistration(activity: Activity)
    suspend fun ensureCameraPermission(activity: Activity): Boolean
    suspend fun unregister(activity: Activity)
    suspend fun startStream()
    fun stopStream()
    suspend fun capturePhoto(target: File): File
    /** Bounded clip; the result says whether a disconnect interrupted it. */
    suspend fun recordClip(target: File, segmentDir: File, maxSeconds: Int): GlassesClip
    fun stopClip()
    fun sdkReference(installationPublicId: String): String?
}

data class GlassesClip(val file: File, val durationSeconds: Double, val interrupted: Boolean)

/** Store build: the Experimental entry stays visible and explains it is not in this release. */
class UnavailableGlasses : GlassesAdapter {
    override val buildIncludesSdk = false
    override val localState: StateFlow<CapabilityGate.Local> = MutableStateFlow(
        CapabilityGate.Local(
            CapabilityGate.Registration.UNAVAILABLE, CapabilityGate.Permission.UNKNOWN, false, CapabilityGate.Stream.STOPPED, false,
        ),
    )
    override val preview: StateFlow<Bitmap?> = MutableStateFlow(null)

    override suspend fun startRegistration(activity: Activity) = throw UnsupportedOperationException("not in this build")
    override suspend fun ensureCameraPermission(activity: Activity) = false
    override suspend fun unregister(activity: Activity) = Unit
    override suspend fun startStream() = Unit
    override fun stopStream() = Unit
    override suspend fun capturePhoto(target: File): File = throw UnsupportedOperationException("not in this build")
    override suspend fun recordClip(target: File, segmentDir: File, maxSeconds: Int): GlassesClip =
        throw UnsupportedOperationException("not in this build")
    override fun stopClip() = Unit
    override fun sdkReference(installationPublicId: String): String? = null
}
