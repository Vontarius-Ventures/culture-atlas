package com.cultureatlas.app.capture

import android.app.Activity
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageFormat
import android.graphics.Rect
import android.graphics.YuvImage
import com.cultureatlas.capture.core.policy.CapabilityGate
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import java.io.ByteArrayOutputStream
import java.io.File
import java.security.MessageDigest

/**
 * Experimental Meta glasses adapter for Android, written independently of the
 * iOS port but following the same lifecycle rules learned on Observer:
 * per-user registration through Meta AI, camera permission through the SDK,
 * a 2 s floor between stream restarts, a bounded number of revival attempts
 * after an unrequested stop, and no silent restart: a lost stream finalizes
 * the recording with what was captured and marks it interrupted.
 */
class MetaGlassesAdapter(private val context: Context, private val sdk: DatSdk) : GlassesAdapter {
    override val buildIncludesSdk = true
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val state = MutableStateFlow(
        CapabilityGate.Local(
            CapabilityGate.Registration.UNREGISTERED, CapabilityGate.Permission.UNKNOWN, false, CapabilityGate.Stream.STOPPED, false,
        ),
    )
    override val localState: StateFlow<CapabilityGate.Local> = state
    private val previewFrame = MutableStateFlow<Bitmap?>(null)
    override val preview: StateFlow<Bitmap?> = previewFrame

    private var stream: DatSdk.Stream? = null
    private var streamJobs: List<Job> = emptyList()
    private var lastPreviewAt = 0L
    private var deviceReference: String? = null

    /** One bounded recording in progress; the encoder opens on the first frame. */
    private class Clip(val target: File, val segmentDir: File, val maxUs: Long) {
        val done = CompletableDeferred<Unit>()
        var encoder: SegmentedClipEncoder? = null
        var startUs = -1L
        var interrupted = false
        var durationSeconds = 0.0
    }

    private var clip: Clip? = null

    init {
        scope.launch {
            sdk.registered.collect { registration ->
                state.update {
                    it.copy(
                        registration = when (registration) {
                            DatSdk.Registration.REGISTERED -> CapabilityGate.Registration.REGISTERED
                            DatSdk.Registration.REGISTERING -> CapabilityGate.Registration.REGISTERING
                            DatSdk.Registration.UNREGISTERED -> CapabilityGate.Registration.UNREGISTERED
                        },
                    )
                }
            }
        }
        scope.launch {
            sdk.deviceAvailable.collect { available ->
                state.update { it.copy(deviceAvailable = available, wasConnected = it.wasConnected || available) }
                if (!available) onStreamLost()
            }
        }
    }

    override suspend fun startRegistration(activity: Activity) {
        state.update { it.copy(registration = CapabilityGate.Registration.REGISTERING) }
        sdk.startRegistration(activity)
    }

    override suspend fun ensureCameraPermission(activity: Activity): Boolean {
        val granted = sdk.cameraPermissionGranted() || sdk.requestCameraPermission(activity)
        state.update { it.copy(permission = if (granted) CapabilityGate.Permission.GRANTED else CapabilityGate.Permission.DENIED) }
        return granted
    }

    override suspend fun unregister(activity: Activity) {
        stopStream()
        sdk.startUnregistration(activity)
    }

    override suspend fun startStream() {
        if (stream != null) return
        if (!sdk.cameraPermissionGranted()) {
            state.update { it.copy(permission = CapabilityGate.Permission.DENIED) }
            return
        }
        state.update { it.copy(permission = CapabilityGate.Permission.GRANTED, stream = CapabilityGate.Stream.STARTING) }
        var attempt = 0
        while (attempt < REVIVAL_ATTEMPTS) {
            try {
                val opened = sdk.openStream(FRAME_RATE)
                stream = opened
                deviceReference = deviceReference ?: "dat:${System.identityHashCode(opened)}"
                streamJobs = listOf(
                    scope.launch {
                        opened.streaming.collect { on ->
                            state.update { it.copy(stream = if (on) CapabilityGate.Stream.STREAMING else CapabilityGate.Stream.PAUSED) }
                        }
                    },
                    scope.launch { opened.frames.collect(::onFrame) },
                )
                return
            } catch (e: Exception) {
                attempt++
                delay(RESTART_FLOOR_MS)
            }
        }
        state.update { it.copy(stream = CapabilityGate.Stream.STOPPED) }
    }

    override fun stopStream() {
        streamJobs.forEach { it.cancel() }
        streamJobs = emptyList()
        stream?.close()
        stream = null
        previewFrame.value = null
        state.update { it.copy(stream = CapabilityGate.Stream.STOPPED) }
        finishClip(interrupted = false)
    }

    private fun onStreamLost() {
        if (stream == null) return
        streamJobs.forEach { it.cancel() }
        stream?.close()
        stream = null
        state.update { it.copy(stream = CapabilityGate.Stream.STOPPED) }
        // No silent restart: keep the segments captured so far, marked interrupted.
        finishClip(interrupted = true)
    }

    private fun onFrame(frame: DatSdk.Frame) {
        clip?.let { active ->
            val encoder = active.encoder
                ?: SegmentedClipEncoder(active.segmentDir, frame.width, frame.height, FRAME_RATE).also { active.encoder = it }
            if (active.startUs < 0) active.startUs = frame.presentationUs
            encoder.append(frame.i420, frame.presentationUs)
            if (frame.presentationUs - active.startUs >= active.maxUs) finishClip(interrupted = false)
        }
        val now = System.currentTimeMillis()
        if (now - lastPreviewAt > 100) {
            lastPreviewAt = now
            previewFrame.value = toBitmap(frame)
        }
    }

    override suspend fun capturePhoto(target: File): File {
        val active = stream ?: throw IllegalStateException("glasses not streaming")
        val jpeg = withTimeout(PHOTO_TIMEOUT_MS) { active.capturePhotoJpeg() }
        target.writeBytes(jpeg)
        return target
    }

    override suspend fun recordClip(target: File, segmentDir: File, maxSeconds: Int): GlassesClip {
        checkNotNull(stream) { "glasses not streaming" }
        val active = synchronized(this) {
            check(clip == null) { "already recording" }
            Clip(target, segmentDir, maxSeconds * 1_000_000L).also { clip = it }
        }
        state.update { it.copy(recording = true) }
        try {
            active.done.await()
        } finally {
            state.update { it.copy(recording = false) }
        }
        if (!target.exists() || target.length() == 0L) throw IllegalStateException("no frames recorded")
        return GlassesClip(target, active.durationSeconds, active.interrupted)
    }

    override fun stopClip() = finishClip(interrupted = false)

    @Synchronized
    private fun finishClip(interrupted: Boolean) {
        val active = clip ?: return
        clip = null
        active.interrupted = interrupted
        active.encoder?.let { encoder ->
            active.durationSeconds = encoder.durationSeconds
            if (interrupted) encoder.abandon(active.target) else encoder.finish(active.target)
        }
        active.done.complete(Unit)
    }

    /** Opaque, non-reversible reference; the SDK's device identity never leaves the phone. */
    override fun sdkReference(installationPublicId: String): String? {
        val device = deviceReference ?: return null
        val digest = MessageDigest.getInstance("SHA-256").digest("$installationPublicId:$device".toByteArray())
        return "sha256:" + digest.joinToString("") { "%02x".format(it) }
    }

    private fun toBitmap(frame: DatSdk.Frame): Bitmap? = runCatching {
        // I420 -> NV21 for YuvImage preview (preview only; recording uses the encoder).
        val ySize = frame.width * frame.height
        val quarter = ySize / 4
        val nv21 = ByteArray(ySize + 2 * quarter)
        System.arraycopy(frame.i420, 0, nv21, 0, ySize)
        for (i in 0 until quarter) {
            nv21[ySize + 2 * i] = frame.i420[ySize + quarter + i]
            nv21[ySize + 2 * i + 1] = frame.i420[ySize + i]
        }
        val out = ByteArrayOutputStream()
        YuvImage(nv21, ImageFormat.NV21, frame.width, frame.height, null).compressToJpeg(Rect(0, 0, frame.width, frame.height), 70, out)
        BitmapFactory.decodeByteArray(out.toByteArray(), 0, out.size())
    }.getOrNull()

    private companion object {
        const val FRAME_RATE = 24
        const val PHOTO_TIMEOUT_MS = 5_000L
        const val RESTART_FLOOR_MS = 2_000L
        const val REVIVAL_ATTEMPTS = 4
    }
}
