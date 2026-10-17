package com.cultureatlas.capture.core.store

import com.cultureatlas.capture.core.contract.MediaKind
import com.cultureatlas.capture.core.contract.MediaSource
import com.cultureatlas.capture.core.contract.PartReceipt
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import java.util.UUID

/**
 * One local capture and its upload progress, persisted as JSON beside the
 * encrypted media. `clientCaptureId`, the upload id, receipts and the
 * idempotency keys are written before each network step so a killed app
 * resumes without creating a second asset.
 */
@Serializable
data class DraftRecord(
    val id: String,
    val ownerAccountId: String,
    val clientCaptureId: String,
    val kind: MediaKind,
    val source: MediaSource,
    val contentType: String,
    val filename: String,
    val byteSize: Long = 0,
    val sha256: String = "",
    val capturedAt: String,
    val durationSeconds: Double? = null,
    val audioPresent: Boolean = false,
    val interrupted: Boolean = false,
    val captureSessionId: String? = null,
    val commandId: String? = null,
    val status: Status = Status.AWAITING_REVIEW,
    val allowCellular: Boolean = false,
    val uploadId: String? = null,
    val assetId: String? = null,
    val partSize: Long? = null,
    val partCount: Int? = null,
    val receipts: List<PartReceipt> = emptyList(),
    val createKey: String = UUID.randomUUID().toString(),
    val completeKey: String? = null,
    val errorCode: String? = null,
    val attempts: Int = 0,
    val nextAttemptAtEpochMs: Long? = null,
) {
    @Serializable
    enum class Status {
        /** Retake/Keep (photo) or Keep/Delete (video); not uploaded. */
        @SerialName("awaiting_review") AWAITING_REVIEW,
        @SerialName("queued") QUEUED,
        @SerialName("uploading") UPLOADING,
        @SerialName("verifying") VERIFYING,
        @SerialName("committed") COMMITTED,
        /** Owner not signed in, or the server paused it for its account. */
        @SerialName("locked") LOCKED,
        @SerialName("rejected") REJECTED,
        @SerialName("failed") FAILED,
    }

    val isPending: Boolean get() = status in setOf(Status.QUEUED, Status.UPLOADING, Status.VERIFYING)

    companion object {
        fun new(
            owner: String,
            kind: MediaKind,
            source: MediaSource,
            contentType: String,
            capturedAt: String,
            commandCaptureId: String? = null,
        ): DraftRecord {
            val id = (commandCaptureId ?: UUID.randomUUID().toString()).lowercase()
            val ext = when (contentType) {
                "image/jpeg" -> "jpg"
                "image/png" -> "png"
                "image/webp" -> "webp"
                "video/quicktime" -> "mov"
                else -> "mp4"
            }
            val prefix = if (kind == MediaKind.PHOTO) "IMG" else "VID"
            return DraftRecord(
                id = id,
                ownerAccountId = owner.lowercase(),
                clientCaptureId = id,
                kind = kind,
                source = source,
                contentType = contentType,
                filename = "$prefix-${id.take(8)}.$ext",
                capturedAt = capturedAt,
            )
        }
    }
}

/** Account-scoped draft persistence (implemented with files + Keystore keys in the app). */
interface DraftRepository {
    fun drafts(owner: String): List<DraftRecord>
    fun save(draft: DraftRecord)
    fun update(id: String, owner: String, change: (DraftRecord) -> DraftRecord): DraftRecord?
    fun delete(draft: DraftRecord)

    /** Plaintext bytes [offset, offset+length) in a short-lived file. */
    fun preparePart(draft: DraftRecord, offset: Long, length: Long, partNumber: Int): java.io.File
}
