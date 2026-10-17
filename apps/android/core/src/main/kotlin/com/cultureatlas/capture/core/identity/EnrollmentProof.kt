package com.cultureatlas.capture.core.identity

import com.cultureatlas.capture.core.contract.PublicKeyJwk
import java.math.BigInteger
import java.security.MessageDigest
import java.security.interfaces.ECPublicKey
import java.util.Base64

/** Enrollment proof rules (fixtures/native-contract/enrollment-signature.json). */
object EnrollmentProof {
    const val PREFIX = "culture-atlas-enroll-v1"

    /** prefix LF nonce LF installation_public_id LF platform LF sha256hex(grant or "") */
    fun payload(nonce: String, installationPublicId: String, platform: String, enrollmentGrant: String?): String {
        val grantHash = sha256Hex((enrollmentGrant ?: "").toByteArray(Charsets.UTF_8))
        return listOf(PREFIX, nonce, installationPublicId, platform, grantHash).joinToString("\n")
    }

    /**
     * Android Keystore returns ASN.1 DER `SEQUENCE { INTEGER r, INTEGER s }`;
     * the server expects IEEE P1363 `r || s` (32 + 32 bytes).
     */
    fun derToP1363(der: ByteArray): ByteArray {
        require(der.size >= 8 && der[0] == 0x30.toByte()) { "not a DER sequence" }
        var index = if (der[1].toInt() and 0x80 != 0) 2 + (der[1].toInt() and 0x7F) else 2
        fun integer(): ByteArray {
            require(der[index] == 0x02.toByte()) { "not a DER integer" }
            val length = der[index + 1].toInt() and 0xFF
            var value = der.copyOfRange(index + 2, index + 2 + length)
            index += 2 + length
            while (value.size > 32 && value[0] == 0.toByte()) value = value.copyOfRange(1, value.size)
            require(value.size <= 32) { "integer too large" }
            return ByteArray(32 - value.size) + value
        }
        return integer() + integer()
    }

    fun jwk(publicKey: ECPublicKey): PublicKeyJwk {
        fun coordinate(value: BigInteger): String {
            var bytes = value.toByteArray()
            if (bytes.size > 32) bytes = bytes.copyOfRange(bytes.size - 32, bytes.size)
            return base64Url(ByteArray(32 - bytes.size) + bytes)
        }
        return PublicKeyJwk(x = coordinate(publicKey.w.affineX), y = coordinate(publicKey.w.affineY))
    }

    fun base64Url(bytes: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)

    fun sha256Hex(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
}
