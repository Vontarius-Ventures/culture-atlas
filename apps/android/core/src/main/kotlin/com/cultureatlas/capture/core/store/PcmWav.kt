package com.cultureatlas.capture.core.store

import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * PCM s16le WAV for Music Mode keep (`POST /v2/media/audio`). Other
 * containers are not qualified yet on the keep path.
 */
object PcmWav {
    const val CODEC = "pcm_s16le"
    const val CONTENT_TYPE = "audio/wav"
    const val HEADER_BYTES = 44

    data class Info(
        val durationMs: Int,
        val sampleRateHz: Int,
        val channels: Int,
        val byteSize: Int,
        val codec: String = CODEC,
    )

    fun wrapPcm(pcm: ByteArray, sampleRateHz: Int, channels: Int): ByteArray {
        val dataSize = pcm.size
        val out = ByteArrayOutputStream(HEADER_BYTES + dataSize)
        val header = ByteBuffer.allocate(HEADER_BYTES).order(ByteOrder.LITTLE_ENDIAN)
        header.put("RIFF".toByteArray(Charsets.US_ASCII))
        header.putInt(36 + dataSize)
        header.put("WAVE".toByteArray(Charsets.US_ASCII))
        header.put("fmt ".toByteArray(Charsets.US_ASCII))
        header.putInt(16)
        header.putShort(1) // PCM
        header.putShort(channels.toShort())
        header.putInt(sampleRateHz)
        header.putInt(sampleRateHz * channels * 2)
        header.putShort((channels * 2).toShort())
        header.putShort(16)
        header.put("data".toByteArray(Charsets.US_ASCII))
        header.putInt(dataSize)
        out.write(header.array())
        out.write(pcm)
        return out.toByteArray()
    }

    fun parse(bytes: ByteArray): Info {
        require(bytes.size >= HEADER_BYTES && ascii(bytes, 0, 4) == "RIFF" && ascii(bytes, 8, 4) == "WAVE") {
            "Use a WAV recording. Other audio containers are not qualified yet."
        }
        val view = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
        val audioFormat = view.getShort(20).toInt() and 0xFFFF
        val channels = view.getShort(22).toInt() and 0xFFFF
        val sampleRateHz = view.getInt(24)
        val bitDepth = view.getShort(34).toInt() and 0xFFFF
        require(audioFormat == 1 && bitDepth == 16) {
            "Use a WAV recording. Other audio containers are not qualified yet."
        }
        require(channels == 1 || channels == 2) { "Use mono or stereo audio." }
        val dataSize = (bytes.size - HEADER_BYTES).coerceAtLeast(0)
        val durationMs = Math.round(dataSize / (sampleRateHz.toDouble() * channels * 2) * 1000.0).toInt()
        require(durationMs >= 1) { "Use a WAV recording. Other audio containers are not qualified yet." }
        return Info(durationMs, sampleRateHz, channels, bytes.size)
    }

    private fun ascii(bytes: ByteArray, offset: Int, length: Int): String =
        String(bytes, offset, length, Charsets.US_ASCII)
}
