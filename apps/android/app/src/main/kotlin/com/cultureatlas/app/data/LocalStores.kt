package com.cultureatlas.app.data

import android.content.Context
import android.os.StatFs
import com.cultureatlas.app.security.KeystoreVault
import com.cultureatlas.capture.core.commands.ReceiptRepository
import com.cultureatlas.capture.core.contract.AtlasContract
import com.cultureatlas.capture.core.policy.CommandReceipt
import com.cultureatlas.capture.core.policy.ReceiptState
import com.cultureatlas.capture.core.store.DraftRecord
import com.cultureatlas.capture.core.store.DraftRepository
import com.cultureatlas.capture.core.store.EncryptedFile
import kotlinx.serialization.Serializable
import java.io.File

/**
 * Account-scoped, encrypted local media library (independent Android
 * implementation of the ported Observer library store): one directory per
 * account under noBackupFilesDir, `media.enc` + `draft.json` per draft, and
 * a per-account Keystore AES key. Another account's drafts are never listed.
 */
class FileDraftRepository(private val context: Context, private val vault: KeystoreVault) : DraftRepository {
    private val root = File(context.noBackupFilesDir, "accounts")
    private val lock = Any()

    private fun accountDir(owner: String) = File(root, owner.lowercase())
    fun draftDir(draft: DraftRecord) = File(File(accountDir(draft.ownerAccountId), "drafts"), draft.id)
    fun mediaFile(draft: DraftRecord) = File(draftDir(draft), "media.enc")

    /** Plaintext recording target; recovered as an interrupted clip after a crash. */
    fun recordingFile(draft: DraftRecord) = File(draftDir(draft), "recording.${draft.filename.substringAfterLast('.')}")
    fun segmentDir(draft: DraftRecord) = File(draftDir(draft), "segments").apply { mkdirs() }

    override fun drafts(owner: String): List<DraftRecord> = synchronized(lock) {
        val dir = File(accountDir(owner), "drafts")
        (dir.listFiles() ?: emptyArray()).mapNotNull { entry ->
            runCatching {
                AtlasContract.json.decodeFromString(DraftRecord.serializer(), File(entry, "draft.json").readText())
            }.getOrNull()?.takeIf { it.ownerAccountId == owner.lowercase() }
        }.sortedByDescending { it.capturedAt }
    }

    override fun save(draft: DraftRecord) = synchronized(lock) {
        val dir = draftDir(draft).apply { mkdirs() }
        val temp = File(dir, "draft.json.tmp")
        temp.writeText(AtlasContract.json.encodeToString(DraftRecord.serializer(), draft))
        if (!temp.renameTo(File(dir, "draft.json"))) error("draft save failed")
    }

    override fun update(id: String, owner: String, change: (DraftRecord) -> DraftRecord): DraftRecord? = synchronized(lock) {
        val current = drafts(owner).firstOrNull { it.id == id } ?: return null
        change(current).also { save(it) }
    }

    override fun delete(draft: DraftRecord) {
        synchronized(lock) { draftDir(draft).deleteRecursively() }
    }

    /** Seals a finished plaintext capture into the draft and removes the plaintext. */
    fun ingest(plaintext: File, draft: DraftRecord): DraftRecord {
        save(draft)
        val sealed = EncryptedFile.seal(plaintext, mediaFile(draft), vault.draftKey(draft.ownerAccountId))
        plaintext.delete()
        return draft.copy(byteSize = sealed.byteSize, sha256 = sealed.sha256Hex).also { save(it) }
    }

    override fun preparePart(draft: DraftRecord, offset: Long, length: Long, partNumber: Int): File {
        val dir = File(context.cacheDir, "atlas-parts").apply { mkdirs() }
        val file = File(dir, "${draft.id}-$partNumber.part")
        EncryptedFile.decryptRange(mediaFile(draft), offset, length, file, vault.draftKey(draft.ownerAccountId))
        return file
    }

    fun openForPlayback(draft: DraftRecord): File {
        val file = File(context.cacheDir, "atlas-preview-${draft.id}.${draft.filename.substringAfterLast('.')}")
        EncryptedFile.decryptRange(
            mediaFile(draft), 0, EncryptedFile.plaintextLength(mediaFile(draft)), file, vault.draftKey(draft.ownerAccountId),
        )
        return file
    }

    /** Generic notice only: never titles, counts or thumbnails of another account. */
    fun hasLockedDrafts(otherThan: String?): Boolean =
        (root.listFiles() ?: emptyArray()).any { dir ->
            dir.name != otherThan?.lowercase() && drafts(dir.name).any { it.status != DraftRecord.Status.COMMITTED }
        }

    /** "Delete local drafts" on sign-out. */
    fun deleteAll(owner: String) {
        synchronized(lock) { accountDir(owner).deleteRecursively() }
        vault.deleteDraftKey(owner)
    }

    fun hasRoom(bytes: Long): Boolean = StatFs(context.noBackupFilesDir.path).availableBytes > bytes * 2 + 200_000_000
}

/** Command receipts and the poll cursor, per account, as JSON files. */
class FileReceiptRepository(context: Context) : ReceiptRepository {
    private val dir = File(context.noBackupFilesDir, "commands").apply { mkdirs() }

    @Serializable
    private data class Stored(val afterSequence: Long = 0, val receipts: Map<String, CommandReceipt> = emptyMap())

    private fun file(account: String) = File(dir, "receipts-${account.lowercase()}.json")

    private fun read(account: String): Stored =
        runCatching { AtlasContract.json.decodeFromString(Stored.serializer(), file(account).readText()) }.getOrDefault(Stored())

    private fun write(account: String, stored: Stored) {
        val temp = File(dir, "${file(account).name}.tmp")
        temp.writeText(AtlasContract.json.encodeToString(Stored.serializer(), stored))
        if (!temp.renameTo(file(account))) error("receipt save failed")
    }

    @Synchronized
    override fun receipt(commandId: String, account: String): CommandReceipt? = read(account).receipts[commandId]

    @Synchronized
    override fun put(receipt: CommandReceipt) {
        val stored = read(receipt.accountId)
        var receipts = stored.receipts + (receipt.commandId to receipt)
        if (receipts.size > 200) {
            receipts = receipts.values.sortedByDescending { it.receivedAtEpochMs }.take(200).associateBy { it.commandId }
        }
        write(receipt.accountId, stored.copy(receipts = receipts))
    }

    @Synchronized
    override fun afterSequence(account: String): Long = read(account).afterSequence

    @Synchronized
    override fun setAfterSequence(value: Long, account: String) {
        val stored = read(account)
        write(account, stored.copy(afterSequence = maxOf(stored.afterSequence, value)))
    }

    @Synchronized
    override fun unfinished(account: String): List<CommandReceipt> =
        read(account).receipts.values.filter { it.state == ReceiptState.EXECUTING }
}
