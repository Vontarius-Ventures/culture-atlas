package com.cultureatlas.capture.core.policy

import com.cultureatlas.capture.core.contract.AtlasContract
import com.cultureatlas.capture.core.contract.PartInstruction
import com.cultureatlas.capture.core.contract.PartReceipt
import com.cultureatlas.capture.core.contract.UploadState
import java.time.Instant

data class PlannedPart(val number: Int, val offset: Long, val length: Long)

/** Multipart rules (fixtures/native-contract/upload-parts.json). Part size comes from the server. */
object PartPlanner {
    fun plan(byteSize: Long, partSize: Long): List<PlannedPart> {
        require(partSize > 0) { "part size must be positive" }
        val parts = mutableListOf<PlannedPart>()
        var offset = 0L
        var number = 1
        while (offset < byteSize) {
            parts += PlannedPart(number, offset, minOf(partSize, byteSize - offset))
            offset += partSize
            number++
        }
        return parts
    }

    fun batches(missing: List<Int>, maxPerRequest: Int = AtlasContract.MAX_PART_NUMBERS_PER_REQUEST): List<List<Int>> =
        missing.chunked(maxPerRequest)

    /** Local receipts first, then server-verified parts, so the server's etag wins. */
    fun merge(server: List<PartReceipt>, local: List<PartReceipt>): Map<Int, String> {
        val merged = linkedMapOf<Int, String>()
        local.forEach { merged[it.partNumber] = it.etag }
        server.forEach { merged[it.partNumber] = it.etag }
        return merged
    }

    fun missing(partCount: Int, receipts: Map<Int, String>): List<Int> =
        (1..partCount).filter { it !in receipts }

    fun completion(partCount: Int, receipts: Map<Int, String>): List<PartReceipt>? {
        if (partCount <= 0 || missing(partCount, receipts).isNotEmpty()) return null
        return (1..partCount).map { PartReceipt(it, receipts.getValue(it)) }
    }

    enum class NextStep(val wire: String) {
        MARK_COMMITTED("mark_committed"),
        AWAIT_SERVER("await_server"),
        SEND_MISSING_PARTS("send_missing_parts"),
        LOCK_UNTIL_ORIGINAL_ACCOUNT("lock_until_original_account"),
        SURFACE_REJECTION("surface_rejection"),
        RESTART_WITH_NEW_CLIENT_CAPTURE_ID("restart_with_new_client_capture_id"),
    }

    fun nextStep(state: UploadState): NextStep = when (state) {
        UploadState.COMMITTED -> NextStep.MARK_COMMITTED
        UploadState.VERIFYING -> NextStep.AWAIT_SERVER
        UploadState.CREATED, UploadState.UPLOADING -> NextStep.SEND_MISSING_PARTS
        UploadState.PAUSED -> NextStep.LOCK_UNTIL_ORIGINAL_ACCOUNT
        UploadState.REJECTED -> NextStep.SURFACE_REJECTION
        UploadState.EXPIRED, UploadState.ABORTED -> NextStep.RESTART_WITH_NEW_CLIENT_CAPTURE_ID
    }

    fun isUsable(instruction: PartInstruction, now: Instant): Boolean =
        Instant.parse(instruction.expiresAt).epochSecond - now.epochSecond >
            AtlasContract.PART_INSTRUCTION_REFRESH_MARGIN_SECONDS
}
