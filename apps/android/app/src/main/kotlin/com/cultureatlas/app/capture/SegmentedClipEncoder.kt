package com.cultureatlas.app.capture

import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMuxer
import java.io.File
import java.nio.ByteBuffer

/**
 * Bounded clip writer for decoded glasses frames, with crash/disconnect-safe
 * segments (the Android counterpart of Observer's rolling segment writer).
 *
 * MediaMuxer only writes a playable MP4 when `stop()` runs, so a process kill
 * would lose a single long file. Instead, H.264 output is split into ~2 s
 * segments that start on keyframes; each closed segment is a complete MP4.
 * [finish] concatenates them losslessly into one MP4. After a crash,
 * [recover] concatenates whatever segments were closed and marks the clip
 * interrupted. Not thread-safe: call from one frame thread.
 */
class SegmentedClipEncoder(
    private val segmentDir: File,
    private val width: Int,
    private val height: Int,
    private val frameRate: Int = 24,
    private val segmentSeconds: Double = 2.0,
) {
    private val codec: MediaCodec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
    private var muxer: MediaMuxer? = null
    private var track = -1
    private var outputFormat: MediaFormat? = null
    private var segmentIndex = 0
    private var segmentStartUs = -1L
    private var firstPtsUs = -1L
    private var lastPtsUs = 0L
    private val info = MediaCodec.BufferInfo()

    init {
        segmentDir.mkdirs()
        val format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, width, height).apply {
            setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatYUV420Flexible)
            setInteger(MediaFormat.KEY_BIT_RATE, 4_000_000)
            setInteger(MediaFormat.KEY_FRAME_RATE, frameRate)
            setFloat(MediaFormat.KEY_I_FRAME_INTERVAL, segmentSeconds.toFloat())
        }
        codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
        codec.start()
    }

    /** Queues one I420 frame (Y plane, then U, then V) at [presentationUs]. */
    fun append(i420: ByteArray, presentationUs: Long) {
        if (firstPtsUs < 0) firstPtsUs = presentationUs
        val index = codec.dequeueInputBuffer(10_000)
        if (index >= 0) {
            val image = codec.getInputImage(index)
            if (image != null) {
                copyI420(i420, image)
                codec.queueInputBuffer(index, 0, width * height * 3 / 2, presentationUs - firstPtsUs, 0)
            } else {
                val buffer = codec.getInputBuffer(index)!!
                buffer.clear()
                buffer.put(i420, 0, minOf(i420.size, buffer.remaining()))
                codec.queueInputBuffer(index, 0, minOf(i420.size, buffer.capacity()), presentationUs - firstPtsUs, 0)
            }
        }
        drain(endOfStream = false)
    }

    private fun copyI420(source: ByteArray, image: android.media.Image) {
        var offset = 0
        for ((planeIndex, plane) in image.planes.withIndex()) {
            val planeWidth = if (planeIndex == 0) width else width / 2
            val planeHeight = if (planeIndex == 0) height else height / 2
            val buffer = plane.buffer
            for (row in 0 until planeHeight) {
                for (col in 0 until planeWidth) {
                    buffer.put(row * plane.rowStride + col * plane.pixelStride, source[offset++])
                }
            }
        }
    }

    private fun drain(endOfStream: Boolean) {
        while (true) {
            val index = codec.dequeueOutputBuffer(info, if (endOfStream) 10_000 else 0)
            when {
                index == MediaCodec.INFO_TRY_AGAIN_LATER -> if (!endOfStream) return
                index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> outputFormat = codec.outputFormat
                index >= 0 -> {
                    val data = codec.getOutputBuffer(index)!!
                    val isConfig = info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0
                    if (!isConfig && info.size > 0) write(data, info)
                    codec.releaseOutputBuffer(index, false)
                    if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) return
                }
            }
        }
    }

    private fun write(data: ByteBuffer, bufferInfo: MediaCodec.BufferInfo) {
        val keyframe = bufferInfo.flags and MediaCodec.BUFFER_FLAG_KEY_FRAME != 0
        val due = segmentStartUs >= 0 && bufferInfo.presentationTimeUs - segmentStartUs >= (segmentSeconds * 1_000_000).toLong()
        if (muxer == null || (keyframe && due)) {
            if (muxer == null && !keyframe) return // segments must start on a decodable frame
            closeSegment()
            val format = outputFormat ?: return
            muxer = MediaMuxer(File(segmentDir, "segment-%05d.mp4".format(segmentIndex++)).path, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
                .also { track = it.addTrack(format); it.start() }
            segmentStartUs = bufferInfo.presentationTimeUs
        }
        muxer?.writeSampleData(track, data, bufferInfo)
        lastPtsUs = bufferInfo.presentationTimeUs
    }

    private fun closeSegment() {
        muxer?.let {
            runCatching { it.stop() }
            it.release()
        }
        muxer = null
    }

    val durationSeconds: Double get() = lastPtsUs / 1e6

    /** Normal stop: flush, close the last segment and join all segments into [target]. */
    fun finish(target: File): Boolean {
        val index = codec.dequeueInputBuffer(10_000)
        if (index >= 0) codec.queueInputBuffer(index, 0, 0, lastPtsUs + 1, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
        drain(endOfStream = true)
        closeSegment()
        codec.stop()
        codec.release()
        return concatenate(segmentDir, target)
    }

    /** Disconnect mid-recording: keep what was closed. */
    fun abandon(target: File): Boolean {
        closeSegment()
        runCatching { codec.stop() }
        codec.release()
        return concatenate(segmentDir, target)
    }

    companion object {
        /** After a crash: join the closed segments left on disk. */
        fun recover(segmentDir: File, target: File): Boolean = concatenate(segmentDir, target)

        /** Lossless remux of complete MP4 segments into one MP4, rebasing timestamps. */
        fun concatenate(segmentDir: File, target: File): Boolean {
            val segments = (segmentDir.listFiles() ?: emptyArray())
                .filter { it.name.startsWith("segment-") && it.length() > 0 }
                .sortedBy { it.name }
            if (segments.isEmpty()) return false
            val muxer = MediaMuxer(target.path, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
            var outTrack = -1
            var offsetUs = 0L
            val buffer = ByteBuffer.allocate(4 * 1024 * 1024)
            val info = MediaCodec.BufferInfo()
            var wrote = false
            try {
                for (segment in segments) {
                    val extractor = MediaExtractor()
                    try {
                        // A segment cut off by a crash has no index; skip it.
                        if (runCatching { extractor.setDataSource(segment.path) }.isFailure) continue
                        val trackIndex = (0 until extractor.trackCount).firstOrNull {
                            extractor.getTrackFormat(it).getString(MediaFormat.KEY_MIME)?.startsWith("video/") == true
                        } ?: continue
                        extractor.selectTrack(trackIndex)
                        if (outTrack < 0) {
                            outTrack = muxer.addTrack(extractor.getTrackFormat(trackIndex))
                            muxer.start()
                        }
                        var lastUs = 0L
                        while (true) {
                            info.size = extractor.readSampleData(buffer, 0)
                            if (info.size < 0) break
                            info.offset = 0
                            info.presentationTimeUs = offsetUs + extractor.sampleTime
                            info.flags = if (extractor.sampleFlags and MediaExtractor.SAMPLE_FLAG_SYNC != 0) {
                                MediaCodec.BUFFER_FLAG_KEY_FRAME
                            } else {
                                0
                            }
                            muxer.writeSampleData(outTrack, buffer, info)
                            lastUs = extractor.sampleTime
                            wrote = true
                            extractor.advance()
                        }
                        offsetUs += lastUs + 1_000_000L / 24
                    } finally {
                        extractor.release()
                    }
                }
            } finally {
                if (outTrack >= 0) runCatching { muxer.stop() }
                muxer.release()
            }
            if (wrote) segmentDir.deleteRecursively() else target.delete()
            return wrote
        }
    }
}
