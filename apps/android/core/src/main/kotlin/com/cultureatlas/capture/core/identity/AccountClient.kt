package com.cultureatlas.capture.core.identity

import com.cultureatlas.capture.core.contract.AtlasContract
import com.cultureatlas.capture.core.contract.EmailCompleteRequest
import com.cultureatlas.capture.core.contract.EmailStartRequest
import com.cultureatlas.capture.core.contract.EnrollProof
import com.cultureatlas.capture.core.contract.EnrollRequest
import com.cultureatlas.capture.core.contract.EnrollResponse
import com.cultureatlas.capture.core.contract.EnrollmentChallenge
import com.cultureatlas.capture.core.contract.EnrollmentChallengeRequest
import com.cultureatlas.capture.core.contract.NativeEmailCompletion
import com.cultureatlas.capture.core.contract.SwitchResponse
import com.cultureatlas.capture.core.net.AtlasClientException
import com.cultureatlas.capture.core.net.AtlasHttp
import com.cultureatlas.capture.core.policy.ErrorPolicy
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import java.net.URI
import java.net.URLDecoder
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.interfaces.ECPublicKey

/** Pending email sign-in, persisted (encrypted) until the App Link callback. */
@Serializable
data class PendingSignIn(val email: String, val state: String, val nonce: String, val codeVerifier: String)

/** Per-account installation identity. The key itself lives in the Android Keystore. */
@Serializable
data class InstallationIdentity(
    val accountId: String,
    val installationPublicId: String,
    val keyAlias: String,
    val installationId: String? = null,
    val statusSequence: Long = 0,
)

/** Implemented with AndroidKeyStore (StrongBox when available). */
interface InstallationKeys {
    fun identity(accountId: String): InstallationIdentity?
    fun identityOrCreate(accountId: String): InstallationIdentity
    fun rotate(accountId: String): InstallationIdentity
    fun save(identity: InstallationIdentity)
    fun publicKey(identity: InstallationIdentity): ECPublicKey
    /** DER-encoded ECDSA-SHA256 signature from the non-exportable key. */
    fun signDer(identity: InstallationIdentity, payload: ByteArray): ByteArray
    fun nextStatusSequence(accountId: String): Long
}

interface PendingSignInStore {
    fun read(): PendingSignIn?
    fun write(value: PendingSignIn)
    fun clear()
}

/**
 * Recoverable email sign-in, enrollment and sign-out (IDENTITY-CONTRACT),
 * replacing relay pairing entirely: no relay URL, QR code or operator approval.
 */
class AccountClient(
    private val http: AtlasHttp,
    private val sessions: SessionManager,
    private val keys: InstallationKeys,
    private val pending: PendingSignInStore,
    private val appVersion: String,
    private val capabilities: () -> Map<String, Boolean>,
) {
    suspend fun startSignIn(email: String, purpose: String = "sign_in") {
        val verifier = randomUrlSafe(32)
        val value = PendingSignIn(email, randomUrlSafe(32), randomUrlSafe(32), verifier)
        pending.write(value)
        http.call(
            "POST", "/v2/identity/email/start",
            EmailStartRequest(email, purpose, AtlasContract.PLATFORM, value.state, value.nonce, pkceChallenge(verifier)),
            EmailStartRequest.serializer(), JsonObject.serializer(),
        )
    }

    /** Completes the email proof from the App Link and enrolls this installation. */
    suspend fun completeSignIn(callback: String): String {
        val saved = pending.read() ?: throw CallbackException("no_pending_sign_in")
        val values =
            parseCallback(callback, setOf("app.cultureatlas.com", http.baseUrl.host))
                ?: throw CallbackException("malformed_callback")
        if (values["state"] != saved.state || values["nonce"] != saved.nonce) throw CallbackException("state_mismatch")
        val completion = http.call(
            "POST", "/v2/identity/email/complete",
            EmailCompleteRequest(values.getValue("challenge_id"), values.getValue("token"), saved.state, saved.nonce, saved.codeVerifier),
            EmailCompleteRequest.serializer(), NativeEmailCompletion.serializer(),
        )
        pending.clear()
        enroll(completion)
        return completion.accountId
    }

    suspend fun enroll(completion: NativeEmailCompletion) {
        val identity = keys.identityOrCreate(completion.accountId)
        try {
            enroll(completion, identity)
        } catch (e: AtlasClientException.Server) {
            // "This phone was removed": a new installation identity, never the old authority.
            if (e.code != "token_revoked") throw e
            enroll(completion, keys.rotate(completion.accountId))
        }
    }

    private suspend fun enroll(completion: NativeEmailCompletion, identity: InstallationIdentity) {
        val jwk = EnrollmentProof.jwk(keys.publicKey(identity))
        val publicId = identity.installationPublicId.lowercase()
        val challenge = http.call(
            "POST", "/v2/devices/enrollment/challenge",
            EnrollmentChallengeRequest(completion.enrollmentGrant, publicId, AtlasContract.PLATFORM, jwk),
            EnrollmentChallengeRequest.serializer(), EnrollmentChallenge.serializer(),
            expectedAccount = completion.accountId,
        )
        val payload = EnrollmentProof.payload(challenge.nonce, publicId, AtlasContract.PLATFORM, completion.enrollmentGrant)
        val signature = EnrollmentProof.base64Url(EnrollmentProof.derToP1363(keys.signDer(identity, payload.toByteArray(Charsets.UTF_8))))
        val response = http.call(
            "POST", "/v2/devices/enroll",
            EnrollRequest(
                appVersion = appVersion,
                installationPublicId = publicId,
                enrollmentGrant = completion.enrollmentGrant,
                proof = EnrollProof(challenge.nonce, signature, jwk),
                capabilities = capabilities(),
            ),
            EnrollRequest.serializer(), EnrollResponse.serializer(),
            expectedAccount = completion.accountId,
        )
        if (response.nativeSession.accountId.lowercase() != completion.accountId.lowercase()) {
            throw AtlasClientException.Server(409, "account_mismatch", false, null)
        }
        keys.save(identity.copy(installationId = response.installation.id))
        sessions.store(response.nativeSession)
    }

    /**
     * Ends server authority for this installation. token_revoked/token_expired
     * on this endpoint mean "already signed out". Credentials are cleared
     * either way; local drafts stay locked to their account.
     */
    suspend fun signOut() {
        val token = sessions.currentTokens?.accessToken
        if (token != null) {
            try {
                http.call(
                    "POST", "/v2/identity/switch", JsonObject(emptyMap()), JsonObject.serializer(),
                    SwitchResponse.serializer(), bearer = token,
                )
            } catch (e: AtlasClientException.Server) {
                if (e.code !in ErrorPolicy.switchTerminalCodes) {
                    // Other failures still end local authority; credentials are removed below.
                }
            } catch (e: AtlasClientException.Transport) {
                // Offline: local authority ends now.
            }
        }
        sessions.clear()
    }

    class CallbackException(reason: String) : Exception(reason)

    companion object {
        private val random = SecureRandom()

        fun randomUrlSafe(bytes: Int): String = EnrollmentProof.base64Url(ByteArray(bytes).also(random::nextBytes))

        fun pkceChallenge(verifier: String): String =
            EnrollmentProof.base64Url(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.US_ASCII)))

        /** https://{api-host}/identity/callback#challenge_id=…&token=…&state=…&nonce=… */
        fun parseCallback(
            value: String,
            allowedHosts: Set<String> = setOf("app.cultureatlas.com"),
        ): Map<String, String>? {
            val uri = runCatching { URI(value) }.getOrNull() ?: return null
            if (uri.scheme != "https" || uri.host !in allowedHosts || uri.path != "/identity/callback") return null
            val fragment = uri.rawFragment ?: return null
            val values = fragment.split('&').mapNotNull { pair ->
                val index = pair.indexOf('=')
                if (index <= 0) null else URLDecoder.decode(pair.substring(0, index), "UTF-8") to
                    URLDecoder.decode(pair.substring(index + 1), "UTF-8")
            }.toMap()
            return if (listOf("challenge_id", "token", "state", "nonce").all { !values[it].isNullOrEmpty() }) values else null
        }
    }
}
