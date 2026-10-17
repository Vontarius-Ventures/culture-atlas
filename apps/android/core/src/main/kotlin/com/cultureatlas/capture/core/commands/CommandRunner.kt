package com.cultureatlas.capture.core.commands

import com.cultureatlas.capture.core.contract.AckState
import com.cultureatlas.capture.core.contract.AtlasContract
import com.cultureatlas.capture.core.contract.CommandAck
import com.cultureatlas.capture.core.contract.CommandAction
import com.cultureatlas.capture.core.contract.DeviceCommand
import com.cultureatlas.capture.core.contract.SafeCommandError
import com.cultureatlas.capture.core.net.AtlasApi
import com.cultureatlas.capture.core.net.AtlasClientException
import com.cultureatlas.capture.core.policy.Backoff
import com.cultureatlas.capture.core.policy.CommandLocalState
import com.cultureatlas.capture.core.policy.CommandProcessor
import com.cultureatlas.capture.core.policy.CommandReceipt
import com.cultureatlas.capture.core.policy.ErrorPolicy
import com.cultureatlas.capture.core.policy.ReceiptSnapshot
import com.cultureatlas.capture.core.policy.ReceiptState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.nio.ByteBuffer
import java.security.MessageDigest
import java.time.Instant
import java.util.UUID

/** Persisted receipts and the poll cursor, per account. */
interface ReceiptRepository {
    fun receipt(commandId: String, account: String): CommandReceipt?
    fun put(receipt: CommandReceipt)
    fun afterSequence(account: String): Long
    fun setAfterSequence(value: Long, account: String)
    fun unfinished(account: String): List<CommandReceipt>
}

/** What the capture layer offers remote commands. Drafts use the command's capture_client_id. */
interface RemoteCaptureExecutor {
    suspend fun localState(): CommandLocalState
    suspend fun draftSaved(captureId: String): Boolean
    suspend fun capturePhoto(captureId: String, commandId: String, sessionId: String): CommandProcessor.Outcome
    suspend fun startVideo(captureId: String, commandId: String, sessionId: String, seconds: Int): CommandProcessor.Outcome
    suspend fun stopVideo()
    suspend fun resultAssetId(captureId: String): String?
}

/**
 * Polls `GET /v2/device/commands` only while explicitly armed and in the
 * foreground (the app starts/stops it), persisting a receipt before each
 * hardware effect. Video runs in its own coroutine so Stop is still seen.
 */
class CommandRunner(
    private val api: AtlasApi,
    private val receipts: ReceiptRepository,
    private val executor: RemoteCaptureExecutor,
    private val scope: CoroutineScope,
) {
    private var loop: Job? = null

    val isPolling: Boolean get() = loop?.isActive == true

    fun start(account: String) {
        if (isPolling) return
        loop = scope.launch {
            var attempt = 0
            while (isActive) {
                try {
                    val batch = api.pollCommands(receipts.afterSequence(account))
                    attempt = 0
                    for (command in batch.items) process(command, account)
                    receipts.setAfterSequence(batch.nextSequence, account)
                } catch (e: AtlasClientException) {
                    if (e.policyAction == ErrorPolicy.Action.SIGN_IN_REQUIRED) return@launch
                    attempt++
                    delay(Backoff.jitteredMillis(attempt))
                }
            }
        }
    }

    fun stop() {
        loop?.cancel()
        loop = null
    }

    /** After relaunch: commands left executing report succeeded (file saved) or unknown. */
    suspend fun reconcileAfterLaunch(account: String) {
        for (receipt in receipts.unfinished(account)) {
            val saved = executor.draftSaved(receipt.localCaptureId)
            val ack = if (saved) {
                CommandAck(receipt.lastAckSequence + 1, AckState.SUCCEEDED, receipt.resultAssetId)
            } else {
                CommandAck(receipt.lastAckSequence + 1, AckState.UNKNOWN, safeError = SafeCommandError.OUTCOME_UNKNOWN)
            }
            receipts.put(
                receipt.copy(
                    state = if (saved) ReceiptState.SUCCEEDED else ReceiptState.UNKNOWN,
                    lastAckSequence = ack.sequence, lastAck = ack,
                ),
            )
            send(ack, receipt.commandId)
        }
    }

    suspend fun process(command: DeviceCommand, account: String) {
        val existing = receipts.receipt(command.commandId, account)
        val snapshot = existing?.let {
            ReceiptSnapshot(it.state, it.lastAckSequence, executor.draftSaved(it.localCaptureId), it.resultAssetId, it.lastAck)
        }
        val decision = CommandProcessor.decide(command, snapshot, executor.localState(), Instant.now())
        if (decision.kind == com.cultureatlas.capture.core.policy.CommandDecision.Kind.SKIP_EXPIRED) return
        var receipt = existing ?: CommandReceipt(
            commandId = command.commandId,
            accountId = account,
            state = ReceiptState.EXECUTING,
            lastAckSequence = 0,
            localCaptureId = command.captureClientId,
            receivedAtEpochMs = System.currentTimeMillis(),
        )
        decision.persistReceipt?.let { receipt = receipt.copy(state = it) }
        decision.acks.lastOrNull()?.let { receipt = receipt.copy(lastAckSequence = it.sequence, lastAck = it) }
        receipts.put(receipt) // before any hardware effect or ack
        decision.acks.forEach { send(it, command.commandId) }
        if (decision.kind != com.cultureatlas.capture.core.policy.CommandDecision.Kind.EXECUTE) return
        if (command.action == CommandAction.START_VIDEO) {
            scope.launch { execute(command, decision.durationSeconds ?: AtlasContract.CLIP_MAX_SECONDS, receipt) }
        } else {
            execute(command, 0, receipt)
        }
    }

    private suspend fun execute(command: DeviceCommand, seconds: Int, start: CommandReceipt) {
        val outcome = when (command.action) {
            CommandAction.CAPTURE_PHOTO -> executor.capturePhoto(command.captureClientId, command.commandId, command.sessionId)
            CommandAction.START_VIDEO -> executor.startVideo(command.captureClientId, command.commandId, command.sessionId, seconds)
            CommandAction.STOP_VIDEO -> { executor.stopVideo(); CommandProcessor.Outcome.SAVED }
        }
        val assetId = if (command.action != CommandAction.STOP_VIDEO &&
            (outcome == CommandProcessor.Outcome.SAVED || outcome == CommandProcessor.Outcome.INTERRUPTED_WITH_FILE)
        ) executor.resultAssetId(command.captureClientId) else null
        val final = CommandProcessor.ack(outcome, start.lastAckSequence + 1, assetId)
        receipts.put(
            start.copy(
                state = when (final.state) {
                    AckState.SUCCEEDED -> ReceiptState.SUCCEEDED
                    AckState.UNKNOWN -> ReceiptState.UNKNOWN
                    else -> ReceiptState.FAILED
                },
                lastAckSequence = final.sequence, lastAck = final, resultAssetId = assetId,
            ),
        )
        send(final, command.commandId)
    }

    /** The server treats a repeated sequence as a no-op, so retries are safe. */
    private suspend fun send(ack: CommandAck, commandId: String) {
        val key = ackKey(commandId, ack.sequence)
        for (attempt in 1..4) {
            try {
                api.acknowledge(commandId, ack, key)
                return
            } catch (e: AtlasClientException) {
                if (e.policyAction != ErrorPolicy.Action.RETRY_BACKOFF) return
                delay(Backoff.jitteredMillis(attempt))
            }
        }
    }

    companion object {
        /** Deterministic RFC 4122 (version 8) Idempotency-Key per (command, sequence). */
        fun ackKey(commandId: String, sequence: Int): UUID {
            val hash = MessageDigest.getInstance("SHA-256").digest("${commandId.lowercase()}:$sequence".toByteArray())
            hash[6] = ((hash[6].toInt() and 0x0F) or 0x80).toByte()
            hash[8] = ((hash[8].toInt() and 0x3F) or 0x80).toByte()
            val buffer = ByteBuffer.wrap(hash, 0, 16)
            return UUID(buffer.long, buffer.long)
        }
    }
}
