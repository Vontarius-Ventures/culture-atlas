package com.cultureatlas.capture.core.policy

import com.cultureatlas.capture.core.contract.AckState
import com.cultureatlas.capture.core.contract.AtlasContract
import com.cultureatlas.capture.core.contract.CommandAck
import com.cultureatlas.capture.core.contract.CommandAction
import com.cultureatlas.capture.core.contract.DeviceCommand
import com.cultureatlas.capture.core.contract.MediaKind
import com.cultureatlas.capture.core.contract.SafeCommandError
import kotlinx.serialization.Serializable
import java.time.Instant

/** Durable, per-command record persisted BEFORE any hardware effect. */
@Serializable
data class CommandReceipt(
    val commandId: String,
    val accountId: String,
    val state: ReceiptState,
    val lastAckSequence: Int,
    val localCaptureId: String,
    val resultAssetId: String? = null,
    val lastAck: CommandAck? = null,
    val receivedAtEpochMs: Long,
)

@Serializable
enum class ReceiptState { EXECUTING, SUCCEEDED, FAILED, UNKNOWN }

data class CommandLocalState(
    val armedSessionId: String?,
    val armedGeneration: Int?,
    val armExpiresAt: Instant?,
    val sessionMode: MediaKind?,
    val sourceReady: Boolean,
    val recordingCommandId: String?,
    val storageOk: Boolean,
)

data class ReceiptSnapshot(
    val state: ReceiptState,
    val lastAckSequence: Int,
    val draftSaved: Boolean,
    val resultAssetId: String?,
    val lastAck: CommandAck? = null,
)

data class CommandDecision(
    val kind: Kind,
    val persistReceipt: ReceiptState?,
    val acks: List<CommandAck>,
    val durationSeconds: Int? = null,
) {
    enum class Kind(val wire: String) {
        EXECUTE("execute"),
        RESEND_ACK("resend_ack"),
        SKIP_EXPIRED("skip_expired"),
        REFUSE("refuse"),
        ACKNOWLEDGE_NO_OP("acknowledge_no_op"),
    }
}

/**
 * Phone-side remote command decisions (fixtures/native-contract/command-lifecycle.json):
 * never re-execute a command with a receipt, report unknown after a crash
 * with no saved file, skip expired commands, keep Stop available locally.
 */
object CommandProcessor {
    fun decide(
        command: DeviceCommand,
        receipt: ReceiptSnapshot?,
        local: CommandLocalState,
        now: Instant,
        clipMaxSeconds: Int = AtlasContract.CLIP_MAX_SECONDS,
    ): CommandDecision {
        if (receipt != null) {
            val next = receipt.lastAckSequence + 1
            return when (receipt.state) {
                ReceiptState.SUCCEEDED -> resend(
                    ReceiptState.SUCCEEDED,
                    receipt.lastAck ?: CommandAck(receipt.lastAckSequence, AckState.SUCCEEDED, receipt.resultAssetId),
                )
                ReceiptState.FAILED -> resend(
                    ReceiptState.FAILED,
                    receipt.lastAck
                        ?: CommandAck(receipt.lastAckSequence, AckState.FAILED, safeError = SafeCommandError.DEVICE_UNAVAILABLE),
                )
                ReceiptState.UNKNOWN -> resend(
                    ReceiptState.UNKNOWN,
                    receipt.lastAck
                        ?: CommandAck(receipt.lastAckSequence, AckState.UNKNOWN, safeError = SafeCommandError.OUTCOME_UNKNOWN),
                )
                ReceiptState.EXECUTING -> when {
                    command.action == CommandAction.START_VIDEO && local.recordingCommandId == command.commandId ->
                        resend(ReceiptState.EXECUTING, CommandAck(receipt.lastAckSequence, AckState.EXECUTING))
                    receipt.draftSaved ->
                        resend(ReceiptState.SUCCEEDED, CommandAck(next, AckState.SUCCEEDED, receipt.resultAssetId))
                    // The shutter may or may not have fired: unknown, never a retake.
                    else -> resend(
                        ReceiptState.UNKNOWN,
                        CommandAck(next, AckState.UNKNOWN, safeError = SafeCommandError.OUTCOME_UNKNOWN),
                    )
                }
            }
        }

        if (!Instant.parse(command.expiresAt).isAfter(now)) {
            return CommandDecision(CommandDecision.Kind.SKIP_EXPIRED, null, emptyList())
        }
        val sameSession = local.armedSessionId == command.sessionId && local.armedGeneration == command.generation

        if (command.action == CommandAction.STOP_VIDEO) {
            if (!sameSession) return refuse(SafeCommandError.PERMISSION_DENIED)
            return if (local.recordingCommandId != null) {
                CommandDecision(CommandDecision.Kind.EXECUTE, ReceiptState.EXECUTING, listOf(CommandAck(1, AckState.EXECUTING)))
            } else {
                CommandDecision(
                    CommandDecision.Kind.ACKNOWLEDGE_NO_OP,
                    ReceiptState.SUCCEEDED,
                    listOf(CommandAck(1, AckState.EXECUTING), CommandAck(2, AckState.SUCCEEDED)),
                )
            }
        }

        val armExpires = local.armExpiresAt
        if (!sameSession || armExpires == null || !armExpires.isAfter(now)) return refuse(SafeCommandError.PERMISSION_DENIED)
        val mode = if (command.action == CommandAction.CAPTURE_PHOTO) MediaKind.PHOTO else MediaKind.VIDEO
        if (local.sessionMode != mode || !local.sourceReady || local.recordingCommandId != null) {
            return refuse(SafeCommandError.DEVICE_UNAVAILABLE)
        }
        if (!local.storageOk) return refuse(SafeCommandError.STORAGE_FULL)
        val duration = if (command.action == CommandAction.START_VIDEO) {
            (command.durationSeconds ?: clipMaxSeconds).coerceIn(1, clipMaxSeconds)
        } else {
            null
        }
        return CommandDecision(
            CommandDecision.Kind.EXECUTE,
            ReceiptState.EXECUTING,
            listOf(CommandAck(1, AckState.EXECUTING)),
            duration,
        )
    }

    private fun resend(state: ReceiptState, ack: CommandAck) =
        CommandDecision(CommandDecision.Kind.RESEND_ACK, state, listOf(ack))

    private fun refuse(error: SafeCommandError) =
        CommandDecision(
            CommandDecision.Kind.REFUSE,
            ReceiptState.FAILED,
            listOf(CommandAck(1, AckState.FAILED, safeError = error)),
        )

    enum class Outcome(val wire: String) {
        SAVED("saved"),
        INTERRUPTED_WITH_FILE("interrupted_with_file"),
        INTERRUPTED_WITHOUT_FILE("interrupted_without_file"),
        STORAGE_FULL("storage_full"),
        PERMISSION_DENIED("permission_denied"),
        DEVICE_UNAVAILABLE("device_unavailable"),
        UNKNOWN("unknown"),
    }

    /** `succeeded` = local file durably recorded; cloud upload is reported by asset commit. */
    fun ack(outcome: Outcome, sequence: Int, resultAssetId: String?): CommandAck = when (outcome) {
        Outcome.SAVED, Outcome.INTERRUPTED_WITH_FILE -> CommandAck(sequence, AckState.SUCCEEDED, resultAssetId)
        Outcome.INTERRUPTED_WITHOUT_FILE -> CommandAck(sequence, AckState.FAILED, safeError = SafeCommandError.INTERRUPTED)
        Outcome.STORAGE_FULL -> CommandAck(sequence, AckState.FAILED, safeError = SafeCommandError.STORAGE_FULL)
        Outcome.PERMISSION_DENIED -> CommandAck(sequence, AckState.FAILED, safeError = SafeCommandError.PERMISSION_DENIED)
        Outcome.DEVICE_UNAVAILABLE -> CommandAck(sequence, AckState.FAILED, safeError = SafeCommandError.DEVICE_UNAVAILABLE)
        Outcome.UNKNOWN -> CommandAck(sequence, AckState.UNKNOWN, safeError = SafeCommandError.OUTCOME_UNKNOWN)
    }
}
