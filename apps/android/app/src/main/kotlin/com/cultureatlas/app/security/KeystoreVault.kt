package com.cultureatlas.app.security

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import com.cultureatlas.capture.core.contract.AtlasContract
import com.cultureatlas.capture.core.identity.InstallationIdentity
import com.cultureatlas.capture.core.identity.InstallationKeys
import com.cultureatlas.capture.core.identity.PendingSignIn
import com.cultureatlas.capture.core.identity.PendingSignInStore
import com.cultureatlas.capture.core.identity.StoredSession
import com.cultureatlas.capture.core.identity.TokenVault
import kotlinx.serialization.KSerializer
import java.io.File
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Secrets at rest. Tokens, the pending sign-in and installation metadata are
 * JSON encrypted with an AES-GCM key that never leaves the Android Keystore;
 * installation signing keys are non-exportable Keystore EC keys (StrongBox
 * when present). Nothing secret is written to SharedPreferences or logs.
 */
class KeystoreVault(context: Context) {
    private val directory = File(context.noBackupFilesDir, "vault").apply { mkdirs() }
    private val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    private fun wrappingKey(): SecretKey {
        (keyStore.getKey(WRAP_ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(WRAP_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }

    fun <T> read(name: String, serializer: KSerializer<T>): T? {
        val file = File(directory, name)
        if (!file.exists()) return null
        return runCatching {
            val blob = file.readBytes()
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, wrappingKey(), GCMParameterSpec(128, blob, 0, 12))
            AtlasContract.json.decodeFromString(serializer, String(cipher.doFinal(blob, 12, blob.size - 12), Charsets.UTF_8))
        }.getOrNull()
    }

    fun <T> write(name: String, serializer: KSerializer<T>, value: T) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, wrappingKey())
        val sealed = cipher.iv + cipher.doFinal(AtlasContract.json.encodeToString(serializer, value).toByteArray(Charsets.UTF_8))
        val temp = File(directory, "$name.tmp")
        temp.writeBytes(sealed)
        if (!temp.renameTo(File(directory, name))) error("vault write failed")
    }

    fun delete(name: String) {
        File(directory, name).delete()
    }

    /** Per-account AES key for drafts, generated inside the Keystore. */
    fun draftKey(accountId: String): SecretKey {
        val alias = "draft.${accountId.lowercase()}"
        (keyStore.getKey(alias, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                // Drafts use their own random nonces (EncryptedFile).
                .setRandomizedEncryptionRequired(false)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }

    fun deleteDraftKey(accountId: String) {
        keyStore.deleteEntry("draft.${accountId.lowercase()}")
    }

    val tokens: TokenVault = object : TokenVault {
        override fun read(): StoredSession? = read(SESSION, StoredSession.serializer())
        override fun write(session: StoredSession) = write(SESSION, StoredSession.serializer(), session)
        override fun clear() = delete(SESSION)
    }

    val pendingSignIn: PendingSignInStore = object : PendingSignInStore {
        override fun read(): PendingSignIn? = read(PENDING, PendingSignIn.serializer())
        override fun write(value: PendingSignIn) = write(PENDING, PendingSignIn.serializer(), value)
        override fun clear() = delete(PENDING)
    }

    val installations: InstallationKeys = object : InstallationKeys {
        private fun file(accountId: String) = "installation.${accountId.lowercase()}"

        override fun identity(accountId: String): InstallationIdentity? =
            read(file(accountId), InstallationIdentity.serializer())

        @Synchronized
        override fun identityOrCreate(accountId: String): InstallationIdentity {
            identity(accountId)?.let { return it }
            val alias = "installation.${UUID.randomUUID()}"
            generateSigningKey(alias)
            val created = InstallationIdentity(accountId.lowercase(), UUID.randomUUID().toString(), alias)
            write(file(accountId), InstallationIdentity.serializer(), created)
            return created
        }

        @Synchronized
        override fun rotate(accountId: String): InstallationIdentity {
            identity(accountId)?.let { keyStore.deleteEntry(it.keyAlias) }
            delete(file(accountId))
            return identityOrCreate(accountId)
        }

        override fun save(identity: InstallationIdentity) =
            write(file(identity.accountId), InstallationIdentity.serializer(), identity)

        override fun publicKey(identity: InstallationIdentity): ECPublicKey =
            keyStore.getCertificate(identity.keyAlias).publicKey as ECPublicKey

        override fun signDer(identity: InstallationIdentity, payload: ByteArray): ByteArray {
            val entry = keyStore.getEntry(identity.keyAlias, null) as KeyStore.PrivateKeyEntry
            return Signature.getInstance("SHA256withECDSA").run {
                initSign(entry.privateKey)
                update(payload)
                sign()
            }
        }

        @Synchronized
        override fun nextStatusSequence(accountId: String): Long {
            val current = identity(accountId) ?: error("not enrolled")
            val next = current.copy(statusSequence = current.statusSequence + 1)
            save(next)
            return next.statusSequence
        }
    }

    private fun generateSigningKey(alias: String) {
        fun spec(strongBox: Boolean) = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
            .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
            .setDigests(KeyProperties.DIGEST_SHA256)
            .setIsStrongBoxBacked(strongBox)
            .build()
        val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
        try {
            generator.initialize(spec(true))
            generator.generateKeyPair()
        } catch (e: StrongBoxUnavailableException) {
            generator.initialize(spec(false))
            generator.generateKeyPair()
        }
    }

    private companion object {
        const val WRAP_ALIAS = "culture-atlas-vault"
        const val SESSION = "session"
        const val PENDING = "pending-sign-in"
    }
}
