package com.cultureatlas.capture.core.store

import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Chunked AES-256-GCM container for local drafts. Same layout as the iOS
 * client (documented in docs/native.md) so the format is defined once:
 *
 *     "CAE1" | chunk size UInt32 BE | plaintext length UInt64 BE
 *     per chunk: nonce(12) | ciphertext | tag(16)
 *
 * Each chunk authenticates "culture-atlas-draft-v1" || index || total length,
 * so reordering, dropping or truncating chunks is detected. Parts are
 * decrypted into a short-lived file right before transfer.
 */
object EncryptedFile {
    private val MAGIC = "CAE1".toByteArray(Charsets.US_ASCII)
    const val DEFAULT_CHUNK_SIZE = 1 shl 20
    private const val HEADER_SIZE = 16
    private const val NONCE = 12
    private const val TAG = 16
    private val random = SecureRandom()

    data class Sealed(val byteSize: Long, val sha256Hex: String)

    class Failure(message: String) : Exception(message)

    fun seal(source: File, destination: File, key: SecretKey, chunkSize: Int = DEFAULT_CHUNK_SIZE): Sealed {
        val total = source.length()
        val digest = MessageDigest.getInstance("SHA-256")
        destination.outputStream().buffered().use { out ->
            out.write(MAGIC)
            out.write(ByteBuffer.allocate(4).putInt(chunkSize).array())
            out.write(ByteBuffer.allocate(8).putLong(total).array())
            source.inputStream().buffered().use { input ->
                val buffer = ByteArray(chunkSize)
                var index = 0L
                while (true) {
                    val read = readFully(input, buffer)
                    if (read == 0 && (index > 0 || total > 0)) break
                    digest.update(buffer, 0, read)
                    val nonce = ByteArray(NONCE).also(random::nextBytes)
                    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
                    cipher.init(Cipher.ENCRYPT_MODE, key, GCMParameterSpec(TAG * 8, nonce))
                    cipher.updateAAD(aad(index, total))
                    out.write(nonce)
                    out.write(cipher.doFinal(buffer, 0, read)) // ciphertext || tag
                    index++
                    if (read < chunkSize) break
                }
            }
        }
        return Sealed(total, digest.digest().joinToString("") { "%02x".format(it) })
    }

    fun decryptRange(source: File, offset: Long, length: Long, destination: File, key: SecretKey) {
        RandomAccessFile(source, "r").use { input ->
            val header = ByteArray(HEADER_SIZE)
            input.readFully(header)
            if (!header.copyOfRange(0, 4).contentEquals(MAGIC)) throw Failure("bad header")
            val chunkSize = ByteBuffer.wrap(header, 4, 4).int
            val total = ByteBuffer.wrap(header, 8, 8).long
            if (chunkSize <= 0) throw Failure("bad header")
            if (offset < 0 || length < 0 || offset + length > total) throw Failure("range out of bounds")
            destination.outputStream().buffered().use { out ->
                if (length == 0L) return
                val first = offset / chunkSize
                val last = (offset + length - 1) / chunkSize
                for (index in first..last) {
                    val plainLength = minOf(chunkSize.toLong(), total - index * chunkSize).toInt()
                    val blob = ByteArray(NONCE + plainLength + TAG)
                    input.seek(HEADER_SIZE + index * (chunkSize + NONCE + TAG))
                    try {
                        input.readFully(blob)
                    } catch (e: java.io.EOFException) {
                        throw Failure("truncated")
                    }
                    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
                    cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(TAG * 8, blob, 0, NONCE))
                    cipher.updateAAD(aad(index, total))
                    val plain = try {
                        cipher.doFinal(blob, NONCE, blob.size - NONCE)
                    } catch (e: AEADBadTagException) {
                        throw Failure("authentication failed")
                    }
                    val chunkStart = index * chunkSize
                    val from = (maxOf(offset, chunkStart) - chunkStart).toInt()
                    val to = (minOf(offset + length, chunkStart + plain.size) - chunkStart).toInt()
                    out.write(plain, from, to - from)
                }
            }
        }
    }

    fun plaintextLength(source: File): Long =
        RandomAccessFile(source, "r").use { input ->
            val header = ByteArray(HEADER_SIZE)
            input.readFully(header)
            ByteBuffer.wrap(header, 8, 8).long
        }

    /** Fills `buffer` unless EOF comes first (InputStream.readNBytes needs Android API 33). */
    private fun readFully(input: java.io.InputStream, buffer: ByteArray): Int {
        var filled = 0
        while (filled < buffer.size) {
            val n = input.read(buffer, filled, buffer.size - filled)
            if (n < 0) break
            filled += n
        }
        return filled
    }

    private fun aad(index: Long, total: Long): ByteArray =
        "culture-atlas-draft-v1".toByteArray(Charsets.US_ASCII) +
            ByteBuffer.allocate(16).putLong(index).putLong(total).array()
}
