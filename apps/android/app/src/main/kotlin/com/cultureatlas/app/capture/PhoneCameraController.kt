package com.cultureatlas.app.capture

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.video.FileOutputOptions
import androidx.camera.video.Quality
import androidx.camera.video.QualitySelector
import androidx.camera.video.Recorder
import androidx.camera.video.Recording
import androidx.camera.video.VideoCapture
import androidx.camera.video.VideoRecordEvent
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.suspendCancellableCoroutine
import java.io.File
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * Phone camera via CameraX: preview, photo and bounded video, front/back and
 * an explicit microphone state (SCREEN-CONTRACT reference 03).
 *
 * - Permissions are requested by the UI at the moment of use.
 * - Audio is enabled only when the person turned the microphone on AND the
 *   RECORD_AUDIO permission is granted; silent video is never blocked.
 * - A recording that is interrupted (backgrounding, camera loss, low storage)
 *   is finalized by CameraX; a file with content is kept and marked interrupted.
 */
class PhoneCameraController(private val context: Context) {
    data class ClipResult(val file: File, val durationSeconds: Double, val interrupted: Boolean, val audioPresent: Boolean)

    class CameraError(val reason: Reason) : Exception(reason.name) {
        enum class Reason { PERMISSION_DENIED, UNAVAILABLE, BUSY, STORAGE_FULL, FAILED }
    }

    private val _running = MutableStateFlow(false)
    val running: StateFlow<Boolean> = _running
    private val _recording = MutableStateFlow(false)
    val recording: StateFlow<Boolean> = _recording
    private val _microphoneOn = MutableStateFlow(false)
    val microphoneOn: StateFlow<Boolean> = _microphoneOn
    private val _lensFacing = MutableStateFlow(CameraSelector.LENS_FACING_BACK)
    val lensFacing: StateFlow<Int> = _lensFacing

    val preview: Preview = Preview.Builder().build()
    private val imageCapture = ImageCapture.Builder().setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY).build()
    private val recorder = Recorder.Builder().setQualitySelector(QualitySelector.from(Quality.HD)).build()
    private val videoCapture = VideoCapture.withOutput(recorder)
    private var provider: ProcessCameraProvider? = null
    private var lifecycleOwner: LifecycleOwner? = null
    private var activeRecording: Recording? = null

    val cameraPermitted: Boolean
        get() = ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED
    private val microphonePermitted: Boolean
        get() = ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    suspend fun start(owner: LifecycleOwner) {
        if (!cameraPermitted) throw CameraError(CameraError.Reason.PERMISSION_DENIED)
        val cameraProvider = provider ?: suspendCancellableCoroutine { continuation ->
            val future = ProcessCameraProvider.getInstance(context)
            future.addListener({
                runCatching { future.get() }.fold(continuation::resume, continuation::resumeWithException)
            }, ContextCompat.getMainExecutor(context))
        }
        provider = cameraProvider
        lifecycleOwner = owner
        bind()
    }

    private fun bind() {
        val cameraProvider = provider ?: return
        val owner = lifecycleOwner ?: return
        cameraProvider.unbindAll()
        val selector = CameraSelector.Builder().requireLensFacing(_lensFacing.value).build()
        try {
            cameraProvider.bindToLifecycle(owner, selector, preview, imageCapture, videoCapture)
            _running.value = true
        } catch (e: IllegalArgumentException) {
            _running.value = false
            throw CameraError(CameraError.Reason.UNAVAILABLE)
        }
    }

    fun stop() {
        activeRecording?.stop()
        provider?.unbindAll()
        _running.value = false
    }

    fun flip() {
        if (_recording.value) throw CameraError(CameraError.Reason.BUSY)
        _lensFacing.value = if (_lensFacing.value == CameraSelector.LENS_FACING_BACK) {
            CameraSelector.LENS_FACING_FRONT
        } else {
            CameraSelector.LENS_FACING_BACK
        }
        bind()
    }

    /** Returns the effective state: on only with explicit permission. */
    fun setMicrophone(on: Boolean): Boolean {
        if (_recording.value) return _microphoneOn.value
        _microphoneOn.value = on && microphonePermitted
        return _microphoneOn.value
    }

    suspend fun capturePhoto(target: File): File = suspendCancellableCoroutine { continuation ->
        if (!_running.value) {
            continuation.resumeWithException(CameraError(CameraError.Reason.UNAVAILABLE))
            return@suspendCancellableCoroutine
        }
        imageCapture.takePicture(
            ImageCapture.OutputFileOptions.Builder(target).build(),
            ContextCompat.getMainExecutor(context),
            object : ImageCapture.OnImageSavedCallback {
                override fun onImageSaved(output: ImageCapture.OutputFileResults) = continuation.resume(target)
                override fun onError(exception: ImageCaptureException) =
                    continuation.resumeWithException(CameraError(CameraError.Reason.FAILED))
            },
        )
    }

    /** Records to [target] until [stopRecording] or [maxSeconds]. */
    @SuppressLint("MissingPermission") // Audio is enabled only after an explicit permission check above.
    suspend fun recordClip(target: File, maxSeconds: Int): ClipResult {
        if (!_running.value || activeRecording != null) throw CameraError(CameraError.Reason.BUSY)
        val finished = CompletableDeferred<ClipResult>()
        val options = FileOutputOptions.Builder(target).setDurationLimitMillis(maxSeconds * 1000L).build()
        val audio = _microphoneOn.value && microphonePermitted
        val pending = recorder.prepareRecording(context, options).let { if (audio) it.withAudioEnabled() else it }
        _recording.value = true
        activeRecording = pending.start(ContextCompat.getMainExecutor(context)) { event ->
            if (event is VideoRecordEvent.Finalize) {
                activeRecording = null
                _recording.value = false
                val seconds = event.recordingStats.recordedDurationNanos / 1e9
                val hasContent = target.exists() && target.length() > 0 && seconds > 0
                val limitReached = event.error == VideoRecordEvent.Finalize.ERROR_DURATION_LIMIT_REACHED
                when {
                    event.error == VideoRecordEvent.Finalize.ERROR_INSUFFICIENT_STORAGE && !hasContent ->
                        finished.completeExceptionally(CameraError(CameraError.Reason.STORAGE_FULL))
                    hasContent && (!event.hasError() || limitReached || event.error in KEEPABLE_ERRORS) ->
                        finished.complete(ClipResult(target, seconds, event.hasError() && !limitReached, audio))
                    else -> finished.completeExceptionally(CameraError(CameraError.Reason.FAILED))
                }
            }
        }
        return finished.await()
    }

    fun stopRecording() {
        activeRecording?.stop()
    }

    private companion object {
        /** CameraX keeps a valid file for these interruptions. */
        val KEEPABLE_ERRORS = setOf(
            VideoRecordEvent.Finalize.ERROR_SOURCE_INACTIVE,
            VideoRecordEvent.Finalize.ERROR_INSUFFICIENT_STORAGE,
            VideoRecordEvent.Finalize.ERROR_FILE_SIZE_LIMIT_REACHED,
        )
    }
}
