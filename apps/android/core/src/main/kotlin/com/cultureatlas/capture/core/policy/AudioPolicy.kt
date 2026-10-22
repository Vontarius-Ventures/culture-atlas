package com.cultureatlas.capture.core.policy

import com.cultureatlas.capture.core.contract.MediaKind
import com.cultureatlas.capture.core.contract.MediaSource
import com.cultureatlas.capture.core.store.PcmWav

/**
 * Music Mode (amendment 2.3): audio-only capture with the camera off.
 * Phone and verified OS microphone routes only. Never start a camera stream
 * and discard frames. Never label phone sound as glasses sound.
 * Keep is local and never starts analysis. Explore uploads WAV and requests
 * `music_match` only — no ElevenLabs, no speech.
 */
object AudioPolicy {
    const val MAX_SECONDS = 120
    const val SAMPLE_RATE_HZ = 44_100
    const val CHANNELS = 1
    const val CODEC = PcmWav.CODEC
    const val CONTENT_TYPE = PcmWav.CONTENT_TYPE
    const val MUSIC_WINDOW_DEFAULT_MS = 15_000
    const val MUSIC_WINDOW_MIN_MS = 5_000
    const val MUSIC_WINDOW_MAX_MS = 30_000

    const val CAMERA_OFF_LABEL = "Camera off"
    const val RECORDING_LABEL = "Recording audio"
    const val IDLE_LABEL = "Not recording"
    const val FINALIZING_LABEL = "Saving the recording"
    const val SPEECH_OFF_COPY = "Speech transcription is off. Review before keeping."
    const val KEEP_COPY = "Saved on this phone. Keep does not start analysis. Explore music uploads this recording and asks for a music match."
    const val EXPLORE_LABEL = "Explore music"
    const val RECORD_LABEL = "Record"
    const val STOP_LABEL = "Stop recording"
    const val GLASSES_UNAVAILABLE = "Glasses microphone unavailable"
    const val MICROPHONE_RATIONALE =
        "culture atlas records sound you choose in Music Mode. The camera stays off. Microphone access is used only while you record."

    val musicMatchComponents: List<String> = listOf("music_match")

    data class CameraTrace(
        val cameraInitialized: Boolean = false,
        val cameraPermissionRequested: Boolean = false,
        val frames: Int = 0,
        val networkImages: Int = 0,
    ) {
        val cameraOff: Boolean
            get() = !cameraInitialized && !cameraPermissionRequested && frames == 0 && networkImages == 0
    }

    fun emptyCameraTrace(): CameraTrace = CameraTrace()

    enum class CaptureState(val spoken: String) {
        IDLE("Not recording. Camera off."),
        PERMISSION_REQUESTED("Microphone permission needed. Camera stays off."),
        ROUTE_CHECK("Checking the microphone in use. Camera off."),
        RECORDING("Recording audio. Camera off."),
        FINALIZING("Saving the recording. Camera off."),
        LOCAL_DRAFT("Saved on this phone. Camera stayed off."),
    }

    data class Route(
        val wire: String,
        val label: String,
        val verifiedGlasses: Boolean = false,
    )

    fun labelForInput(type: String, verifiedGlasses: Boolean): String {
        if (verifiedGlasses) return "Glasses microphone · Verified input"
        return when (type) {
            "builtin_mic" -> "This phone"
            "wired_headset" -> "Wired headset"
            "usb_microphone" -> "USB microphone"
            "bluetooth_headset_input" -> "Bluetooth headset"
            else -> "Microphone"
        }
    }

    /** Bluetooth output or an unverified radio is not a glasses microphone. */
    fun glassesMicrophoneAvailable(verifiedGlassesInput: Boolean): Boolean = verifiedGlassesInput

    fun wireSource(verifiedGlasses: Boolean): MediaSource =
        if (verifiedGlasses) MediaSource.META_GLASSES else MediaSource.PHONE_MICROPHONE

    /**
     * If the active device is not the one the person chose, stop. Never keep
     * the take and relabel it as the original choice.
     */
    fun routeStillMatches(chosenWire: String, actualWire: String?): Boolean =
        actualWire != null && actualWire == chosenWire

    fun silentPhoneFallbackForbidden(chosen: Route, actual: Route): Boolean =
        chosen.verifiedGlasses && !actual.verifiedGlasses

    fun requestsCameraPermission(): Boolean = false

    fun initializesCamera(): Boolean = false

    fun keepSavesLocal(kind: MediaKind): Boolean = kind == MediaKind.AUDIO

    fun exploreAuthorizesUpload(kind: MediaKind): Boolean = kind == MediaKind.AUDIO

    fun elevenLabsEnabled(): Boolean = false

    fun qualifiedKeepContentType(mime: String?): Boolean = mime in QUALIFIED_WAV

    fun supportedAudioContentType(mime: String?): Boolean = mime in QUALIFIED_WAV || mime in PENDING_AUDIO

    fun musicSelection(durationMs: Int): Pair<Int, Int>? {
        if (durationMs < MUSIC_WINDOW_MIN_MS) return null
        val end = minOf(durationMs, MUSIC_WINDOW_DEFAULT_MS).coerceAtMost(MUSIC_WINDOW_MAX_MS)
        return 0 to end
    }

    private val QUALIFIED_WAV = setOf("audio/wav", "audio/wave", "audio/x-wav")
    private val PENDING_AUDIO = setOf(
        "audio/mpeg",
        "audio/mp4",
        "audio/aac",
        "audio/x-m4a",
        "audio/flac",
        "audio/ogg",
        "audio/opus",
        "audio/webm",
    )
}
