package com.cultureatlas.capture.core.upload

import com.cultureatlas.capture.core.contract.CompleteUploadRequest
import com.cultureatlas.capture.core.contract.CreateUploadRequest
import com.cultureatlas.capture.core.contract.PartInstruction
import com.cultureatlas.capture.core.contract.PartReceipt
import com.cultureatlas.capture.core.contract.UploadState
import com.cultureatlas.capture.core.net.AtlasApi
import com.cultureatlas.capture.core.net.AtlasClientException
import com.cultureatlas.capture.core.policy.Backoff
import com.cultureatlas.capture.core.policy.DraftLockPolicy
import com.cultureatlas.capture.core.policy.ErrorPolicy
import com.cultureatlas.capture.core.policy.PartPlanner
import com.cultureatlas.capture.core.store.DraftRecord
import com.cultureatlas.capture.core.store.DraftRecord.Status
import com.cultureatlas.capture.core.store.DraftRepository
import java.io.File
import java.time.Instant
import java.util.UUID

/** PUTs one plaintext part to a server-signed URL and returns its ETag. */
fun interface PartTransfer {
    /** Returns the ETag, or throws [ExpiredInstruction] on 403 / [java.io.IOException]. */
    suspend fun put(instruction: PartInstruction, file: File): String

    class ExpiredInstruction : Exception("part instruction expired")
}

/**
 * One upload pass for one draft (BACKEND-CONTRACTS "Upload state and
 * consistency", MED-01/MED-04): create with the persisted client capture id
 * and idempotency key → ask the server for state → send only missing parts
 * (server receipts win) → complete with the persisted key. Every step's
 * result is saved before the next, so WorkManager can kill and rerun it.
 */
class UploadEngine(
    private val api: AtlasApi,
    private val drafts: DraftRepository,
    private val transfer: PartTransfer,
    private val now: () -> Instant = Instant::now,
) {
    sealed interface Result {
        data object Done : Result
        data object Waiting : Result
        data class Retry(val afterMillis: Long) : Result
        data object Locked : Result
    }

    suspend fun run(draftId: String, signedInAccount: String?): Result {
        val start = signedInAccount?.let { account -> drafts.drafts(account).firstOrNull { it.id == draftId } }
            ?: return Result.Locked
        if (!DraftLockPolicy.visibility(start.ownerAccountId, signedInAccount).uploadable) return Result.Locked
        return try {
            val result = step(start)
            drafts.update(start.id, start.ownerAccountId) { it.copy(attempts = 0, nextAttemptAtEpochMs = null, errorCode = null) }
            result
        } catch (e: AtlasClientException) {
            handle(e, start.id, start.ownerAccountId)
        } catch (e: java.io.IOException) {
            handle(AtlasClientException.Transport(e.javaClass.simpleName), start.id, start.ownerAccountId)
        }
    }

    private suspend fun step(input: DraftRecord): Result {
        var draft = input
        val owner = draft.ownerAccountId
        if (draft.uploadId == null) {
            val created = api.createUpload(
                CreateUploadRequest(
                    clientCaptureId = draft.clientCaptureId,
                    kind = draft.kind,
                    source = draft.source,
                    filename = draft.filename,
                    contentType = draft.contentType,
                    byteSize = draft.byteSize,
                    sha256 = draft.sha256,
                    capturedAt = draft.capturedAt,
                    captureSessionId = draft.captureSessionId,
                ),
                UUID.fromString(draft.createKey),
                owner,
            )
            draft = save(draft.copy(uploadId = created.uploadId, assetId = created.assetId, partSize = created.partSize, partCount = created.partCount, status = Status.UPLOADING))
        }
        val uploadId = draft.uploadId!!
        val status = api.upload(uploadId)
        when (PartPlanner.nextStep(status.state)) {
            PartPlanner.NextStep.MARK_COMMITTED -> { save(draft.copy(status = Status.COMMITTED)); return Result.Done }
            PartPlanner.NextStep.AWAIT_SERVER -> { save(draft.copy(status = Status.VERIFYING)); return Result.Waiting }
            PartPlanner.NextStep.LOCK_UNTIL_ORIGINAL_ACCOUNT -> { save(draft.copy(status = Status.LOCKED)); return Result.Locked }
            PartPlanner.NextStep.SURFACE_REJECTION -> {
                save(draft.copy(status = Status.REJECTED, errorCode = status.errorCode)); return Result.Done
            }
            PartPlanner.NextStep.RESTART_WITH_NEW_CLIENT_CAPTURE_ID -> {
                // The server keeps the expired/aborted upload under the old id; nothing was committed.
                save(
                    draft.copy(
                        clientCaptureId = UUID.randomUUID().toString(), createKey = UUID.randomUUID().toString(),
                        completeKey = null, uploadId = null, assetId = null, receipts = emptyList(), status = Status.QUEUED,
                    ),
                )
                return Result.Retry(0)
            }
            PartPlanner.NextStep.SEND_MISSING_PARTS -> Unit
        }
        val merged = PartPlanner.merge(status.verifiedParts, draft.receipts).toMutableMap()
        val plan = PartPlanner.plan(draft.byteSize, status.partSize)
        val missing = PartPlanner.missing(status.partCount, merged)
        val instructions = mutableMapOf<Int, PartInstruction>()
        status.parts.filter { PartPlanner.isUsable(it, now()) }.forEach { instructions[it.partNumber] = it }
        for (batch in PartPlanner.batches(missing.filter { it !in instructions })) {
            api.parts(uploadId, batch, owner).parts.forEach { instructions[it.partNumber] = it }
        }
        for (number in missing) {
            val part = plan.first { it.number == number }
            val file = drafts.preparePart(draft, part.offset, part.length, number)
            try {
                val etag = transfer.put(instructions.getValue(number), file)
                merged[number] = etag
                // Persist each receipt immediately (resume after process death).
                draft = save(draft.copy(receipts = merged.map { PartReceipt(it.key, it.value) }.sortedBy { it.partNumber }))
            } catch (e: PartTransfer.ExpiredInstruction) {
                return Result.Retry(0)
            } finally {
                file.delete()
            }
        }
        val parts = PartPlanner.completion(status.partCount, merged) ?: return Result.Retry(0)
        val completeKey = draft.completeKey ?: UUID.randomUUID().toString().also { draft = save(draft.copy(completeKey = it)) }
        val completed = api.complete(uploadId, CompleteUploadRequest(parts), UUID.fromString(completeKey), owner)
        save(draft.copy(status = if (completed.state == UploadState.COMMITTED) Status.COMMITTED else Status.VERIFYING))
        return Result.Done
    }

    private fun save(draft: DraftRecord): DraftRecord {
        drafts.save(draft)
        return draft
    }

    private fun handle(error: AtlasClientException, id: String, owner: String): Result {
        val current = drafts.drafts(owner).firstOrNull { it.id == id } ?: return Result.Done
        val attempts = current.attempts + 1
        val retryAfter = (error as? AtlasClientException.Server)?.retryAfterSeconds
        return when (error.policyAction) {
            ErrorPolicy.Action.LOCK_TO_ORIGINAL_ACCOUNT, ErrorPolicy.Action.SIGN_IN_REQUIRED -> {
                save(current.copy(status = Status.LOCKED, errorCode = error.code)); Result.Locked
            }
            ErrorPolicy.Action.REJECT_ITEM, ErrorPolicy.Action.SURFACE_NO_RETRY -> {
                save(current.copy(status = Status.REJECTED, errorCode = error.code)); Result.Done
            }
            ErrorPolicy.Action.FEATURE_UNAVAILABLE_KEEP_LOCAL, ErrorPolicy.Action.PAUSE_UNTIL_QUOTA -> {
                save(current.copy(status = Status.FAILED, errorCode = error.code)); Result.Done
            }
            ErrorPolicy.Action.RELOAD_STATE -> {
                // A remote-capture session that ended before upload: upload without it.
                val dropSession = error.code == "not_found" && current.uploadId == null && current.captureSessionId != null
                val next = current.copy(
                    attempts = attempts,
                    captureSessionId = if (dropSession) null else current.captureSessionId,
                    createKey = if (dropSession) UUID.randomUUID().toString() else current.createKey,
                    status = if (attempts >= 8) Status.FAILED else current.status,
                    errorCode = error.code,
                )
                save(next)
                if (next.status == Status.FAILED) Result.Done else Result.Retry(Backoff.jitteredMillis(attempts))
            }
            else -> {
                val delay = Backoff.jitteredMillis(attempts, retryAfter)
                save(current.copy(attempts = attempts, nextAttemptAtEpochMs = System.currentTimeMillis() + delay, errorCode = error.code))
                Result.Retry(delay)
            }
        }
    }
}
