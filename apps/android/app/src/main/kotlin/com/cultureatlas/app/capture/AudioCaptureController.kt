package com.cultureatlas.app.capture

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Build
import androidx.core.content.ContextCompat
import com.cultureatlas.capture.core.contract.AtlasContract
import com.cultureatlas.capture.core.policy.AudioPolicy
import com.cultureatlas.capture.core.store.PcmWav
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.io.File
import kotlin.math.abs

/**
 * Music Mode microphone recorder. Uses [AudioRecord] PCM only — never CameraX,
 * never a camera capture session, never a preview surface. AUD01: this class
 * has no camera imports and does not call [PhoneCameraController].
 *
 * Output is PCM s16le WAV for `POST /v2/media/audio`. Input labels come from
 * the actual [AudioDeviceInfo] list. Unverified Bluetooth is "Bluetooth
 * headset", never glasses. If the chosen device disappears or the OS records
 * a different route, recording stops and is not relabeled.
 */
class AudioCaptureController(private val context: Context) {
    data class InputRoute(
        val id: Int,
        val wire: String,
        val label: String,
        val verifiedGlasses: Boolean = false,
    )

    data class ClipResult(
        val file: File,
        val durationSeconds: Double,
        val interrupted: Boolean,
        val sourceRoute: String,
        val sampleRouteLabel: String,
        val verifiedGlasses: Boolean,
        val sampleRateHz: Int,
        val channels: Int,
        val codec: String,
    )

    class AudioError(val reason: Reason) : Exception(reason.name) {
        enum class Reason {
            PERMISSION_DENIED, BUSY, ROUTE_LOST, ROUTE_MISMATCH, STORAGE_FULL, INTERRUPTED_EMPTY, FAILED,
        }
    }

    private val audioManager = context.getSystemService(AudioManager::class.java)

    private val _state = MutableStateFlow(AudioPolicy.CaptureState.IDLE)
    val state: StateFlow<AudioPolicy.CaptureState> = _state
    private val _recording = MutableStateFlow(false)
    val recording: StateFlow<Boolean> = _recording
    private val _amplitude = MutableStateFlow(0)
    val amplitude: StateFlow<Int> = _amplitude
    private val _routes = MutableStateFlow<List<InputRoute>>(emptyList())
    val routes: StateFlow<List<InputRoute>> = _routes
    private val _selected = MutableStateFlow<InputRoute?>(null)
    val selected: StateFlow<InputRoute?> = _selected
    val cameraTrace: AudioPolicy.CameraTrace = AudioPolicy.emptyCameraTrace()

    private var recorder: AudioRecord? = null
    private var startedAtMs: Long = 0
    private var focusRequest: AudioFocusRequest? = null
    private var pending: CompletableDeferred<ClipResult>? = null
    private var targetFile: File? = null
    private var chosen: InputRoute? = null
    @Volatile private var stopRequested = false

    val microphonePermitted: Boolean
        get() = ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED

    init {
        refreshRoutes()
        audioManager.registerAudioDeviceCallback(object : AudioDeviceCallback() {
            override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>?) = refreshRoutes()
            override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>?) {
                refreshRoutes()
                val current = chosen ?: return
                if (_recording.value && _routes.value.none { it.id == current.id && it.wire == current.wire }) {
                    abort(AudioError.Reason.ROUTE_LOST)
                }
            }
        }, null)
    }

    fun refreshRoutes() {
        val listed = audioManager.getDevices(AudioManager.GET_DEVICES_INPUTS).mapNotNull { device ->
            val wire = wireType(device.type) ?: return@mapNotNull null
            InputRoute(
                id = device.id,
                wire = wire,
                label = AudioPolicy.labelForInput(wire, verifiedGlasses = false),
                verifiedGlasses = false,
            )
        }.distinctBy { "${it.wire}:${it.id}" }
        _routes.value = listed
        val current = _selected.value
        if (current == null || listed.none { it.id == current.id }) {
            _selected.value = listed.firstOrNull { it.wire == "builtin_mic" } ?: listed.firstOrNull()
        }
    }

    fun select(route: InputRoute) {
        if (_recording.value) return
        _selected.value = route
    }

    fun device(info: InputRoute): AudioDeviceInfo? =
        audioManager.getDevices(AudioManager.GET_DEVICES_INPUTS).firstOrNull { it.id == info.id }

    @SuppressLint("MissingPermission")
    suspend fun record(target: File, maxSeconds: Int = AtlasContract.AUDIO_MAX_SECONDS): ClipResult =
        withContext(Dispatchers.IO) {
            if (!microphonePermitted) throw AudioError(AudioError.Reason.PERMISSION_DENIED)
            if (_recording.value || pending != null) throw AudioError(AudioError.Reason.BUSY)
            refreshRoutes()
            val route = _selected.value ?: throw AudioError(AudioError.Reason.ROUTE_LOST)
            val preferred = device(route)
            _state.value = AudioPolicy.CaptureState.ROUTE_CHECK
            chosen = route
            targetFile = target
            target.parentFile?.mkdirs()
            val finished = CompletableDeferred<ClipResult>()
            pending = finished
            stopRequested = false
            val sampleRate = AudioPolicy.SAMPLE_RATE_HZ
            val channel = AudioFormat.CHANNEL_IN_MONO
            val encoding = AudioFormat.ENCODING_PCM_16BIT
            val minBuf = AudioRecord.getMinBufferSize(sampleRate, channel, encoding)
            if (minBuf <= 0) {
                releaseRecorder()
                throw AudioError(AudioError.Reason.FAILED)
            }
            val bufferSize = minBuf * 2
            val audioRecord = try {
                AudioRecord(MediaRecorder.AudioSource.MIC, sampleRate, channel, encoding, bufferSize)
            } catch (e: Exception) {
                releaseRecorder()
                throw AudioError(AudioError.Reason.FAILED)
            }
            if (audioRecord.state != AudioRecord.STATE_INITIALIZED) {
                audioRecord.release()
                releaseRecorder()
                throw AudioError(AudioError.Reason.FAILED)
            }
            if (preferred != null) audioRecord.setPreferredDevice(preferred)
            recorder = audioRecord
            requestFocus()
            val pcm = ByteArrayOutputStream()
            val buf = ShortArray(bufferSize / 2)
            try {
                audioRecord.startRecording()
                startedAtMs = System.currentTimeMillis()
                _recording.value = true
                _state.value = AudioPolicy.CaptureState.RECORDING
                delay(200)
                val actual = actualWire(audioRecord)
                if (!AudioPolicy.routeStillMatches(route.wire, actual)) {
                    abort(AudioError.Reason.ROUTE_MISMATCH)
                    return@withContext finished.await()
                }
                val limitMs = maxSeconds * 1000L
                while (!stopRequested && _recording.value) {
                    val elapsed = System.currentTimeMillis() - startedAtMs
                    if (elapsed >= limitMs) break
                    val n = audioRecord.read(buf, 0, buf.size)
                    if (n > 0) {
                        _amplitude.value = peak(buf, n)
                        val bytes = ByteArray(n * 2)
                        for (i in 0 until n) {
                            val s = buf[i].toInt()
                            bytes[i * 2] = (s and 0xFF).toByte()
                            bytes[i * 2 + 1] = (s shr 8 and 0xFF).toByte()
                        }
                        pcm.write(bytes)
                    } else if (n < 0) {
                        break
                    }
                }
                complete(pcm.toByteArray(), interrupted = stopRequested && elapsedWasShort(maxSeconds))
            } catch (e: AudioError) {
                runCatching { audioRecord.stop() }
                releaseRecorder()
                throw e
            } catch (e: Exception) {
                runCatching { audioRecord.stop() }
                releaseRecorder()
                _state.value = AudioPolicy.CaptureState.IDLE
                throw AudioError(AudioError.Reason.FAILED)
            }
            finished.await()
        }

    fun stop() {
        stopRequested = true
    }

    fun peekAmplitude(): Int = _amplitude.value

    private fun elapsedWasShort(maxSeconds: Int): Boolean {
        val seconds = (System.currentTimeMillis() - startedAtMs) / 1000.0
        return seconds < maxSeconds && seconds > 0
    }

    private fun complete(pcm: ByteArray, interrupted: Boolean) {
        val target = targetFile ?: return
        val route = chosen ?: return
        val done = pending ?: return
        _state.value = AudioPolicy.CaptureState.FINALIZING
        runCatching { recorder?.stop() }
        val wav = PcmWav.wrapPcm(pcm, AudioPolicy.SAMPLE_RATE_HZ, AudioPolicy.CHANNELS)
        target.writeBytes(wav)
        val info = runCatching { PcmWav.parse(wav) }.getOrNull()
        val seconds = (info?.durationMs ?: 0) / 1000.0
        val hasContent = wav.size > PcmWav.HEADER_BYTES && seconds > 0
        releaseRecorder()
        if (!hasContent) {
            target.delete()
            done.completeExceptionally(AudioError(AudioError.Reason.INTERRUPTED_EMPTY))
            return
        }
        _state.value = AudioPolicy.CaptureState.LOCAL_DRAFT
        done.complete(
            ClipResult(
                file = target,
                durationSeconds = seconds,
                interrupted = interrupted,
                sourceRoute = route.wire,
                sampleRouteLabel = route.label,
                verifiedGlasses = route.verifiedGlasses,
                sampleRateHz = info?.sampleRateHz ?: AudioPolicy.SAMPLE_RATE_HZ,
                channels = info?.channels ?: AudioPolicy.CHANNELS,
                codec = PcmWav.CODEC,
            ),
        )
    }

    private fun abort(reason: AudioError.Reason) {
        stopRequested = true
        val target = targetFile
        val route = chosen
        val done = pending
        val seconds = ((System.currentTimeMillis() - startedAtMs) / 1000.0).coerceAtLeast(0.0)
        runCatching { recorder?.stop() }
        val hasContent = target?.exists() == true && target.length() > PcmWav.HEADER_BYTES
        releaseRecorder()
        if (hasContent && target != null && route != null && reason == AudioError.Reason.ROUTE_LOST) {
            _state.value = AudioPolicy.CaptureState.LOCAL_DRAFT
            done?.complete(
                ClipResult(
                    file = target,
                    durationSeconds = seconds,
                    interrupted = true,
                    sourceRoute = route.wire,
                    sampleRouteLabel = route.label,
                    verifiedGlasses = route.verifiedGlasses,
                    sampleRateHz = AudioPolicy.SAMPLE_RATE_HZ,
                    channels = AudioPolicy.CHANNELS,
                    codec = PcmWav.CODEC,
                ),
            )
            return
        }
        target?.delete()
        done?.completeExceptionally(AudioError(reason))
    }

    private fun releaseRecorder() {
        runCatching { recorder?.release() }
        recorder = null
        pending = null
        _recording.value = false
        _amplitude.value = 0
        abandonFocus()
        if (_state.value == AudioPolicy.CaptureState.RECORDING || _state.value == AudioPolicy.CaptureState.ROUTE_CHECK) {
            _state.value = AudioPolicy.CaptureState.IDLE
        }
        targetFile = null
        chosen = null
    }

    private fun actualWire(record: AudioRecord): String? {
        val session = record.audioSessionId
        val configs = audioManager.activeRecordingConfigurations
        val match = configs.firstOrNull { it.clientAudioSessionId == session }
        val device = match?.audioDevice ?: return chosen?.wire
        return wireType(device.type)
    }

    private fun peak(buf: ShortArray, n: Int): Int {
        var max = 0
        for (i in 0 until n) max = maxOf(max, abs(buf[i].toInt()))
        return max.coerceAtMost(32767)
    }

    private fun requestFocus() {
        val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
            .setOnAudioFocusChangeListener { change ->
                if (change == AudioManager.AUDIOFOCUS_LOSS || change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) {
                    stopRequested = true
                }
            }
            .build()
        focusRequest = request
        audioManager.requestAudioFocus(request)
    }

    private fun abandonFocus() {
        focusRequest?.let { audioManager.abandonAudioFocusRequest(it) }
        focusRequest = null
    }

    private fun wireType(type: Int): String? = when (type) {
        AudioDeviceInfo.TYPE_BUILTIN_MIC -> "builtin_mic"
        AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADPHONES -> "wired_headset"
        AudioDeviceInfo.TYPE_USB_DEVICE, AudioDeviceInfo.TYPE_USB_HEADSET, AudioDeviceInfo.TYPE_USB_ACCESSORY ->
            "usb_microphone"
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> "bluetooth_headset_input"
        else -> {
            if (Build.VERSION.SDK_INT >= 31 &&
                (type == AudioDeviceInfo.TYPE_BLE_HEADSET || type == AudioDeviceInfo.TYPE_BLE_BROADCAST)
            ) {
                "bluetooth_headset_input"
            } else {
                null
            }
        }
    }
}
