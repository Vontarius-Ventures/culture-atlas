package com.cultureatlas.capture.core.identity

import com.cultureatlas.capture.core.contract.NativeSessionTokens
import com.cultureatlas.capture.core.contract.RefreshRequest
import com.cultureatlas.capture.core.net.AtlasClientException
import com.cultureatlas.capture.core.net.AtlasHttp
import com.cultureatlas.capture.core.policy.RefreshPolicy
import kotlinx.coroutines.delay
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import java.security.SecureRandom
import java.time.Instant

/** Encrypted at rest by the app (Android Keystore); never in plain prefs, URLs or logs. */
interface TokenVault {
    fun read(): StoredSession?
    fun write(session: StoredSession)
    fun clear()
}

@Serializable
data class PendingRefresh(val refreshToken: String, val requestId: String, val startedAtEpochMs: Long)

@Serializable
data class StoredSession(val tokens: NativeSessionTokens, val pending: PendingRefresh? = null)

/**
 * Native session for the signed-in account. Refresh rotation per
 * IDENTITY-CONTRACT: a new refresh_request_id (32 random bytes, base64url) is
 * persisted with the refresh token BEFORE dispatch; a lost response is
 * retried with the same token and id inside 60 s; the new pair is committed
 * before the pending attempt is cleared.
 */
class SessionManager(private val http: AtlasHttp, private val vault: TokenVault) {
    private val mutex = Mutex()

    val currentAccountId: String? get() = vault.read()?.tokens?.accountId
    val currentTokens: NativeSessionTokens? get() = vault.read()?.tokens

    fun store(tokens: NativeSessionTokens) = vault.write(StoredSession(tokens))

    fun clear() = vault.clear()

    suspend fun accessToken(now: Instant = Instant.now()): String {
        val stored = vault.read() ?: throw AtlasClientException.NotSignedIn()
        val expires = Instant.parse(stored.tokens.accessExpiresAt)
        if (stored.pending == null && expires.epochSecond - now.epochSecond > 30) return stored.tokens.accessToken
        return refresh().accessToken
    }

    suspend fun refresh(): NativeSessionTokens = mutex.withLock {
        var stored = vault.read() ?: throw AtlasClientException.NotSignedIn()
        val pending = stored.pending ?: PendingRefresh(
            stored.tokens.refreshToken,
            newRequestId(),
            System.currentTimeMillis(),
        ).also {
            stored = stored.copy(pending = it)
            vault.write(stored)
        }
        while (true) {
            val outcome: RefreshPolicy.Outcome = try {
                val tokens = http.call(
                    "POST", "/v2/identity/native/refresh",
                    RefreshRequest(pending.refreshToken, stored.tokens.installationId, pending.requestId),
                    RefreshRequest.serializer(), NativeSessionTokens.serializer(),
                )
                vault.write(StoredSession(tokens))
                return@withLock tokens
            } catch (e: AtlasClientException.Server) {
                RefreshPolicy.Outcome.Http(e.status)
            } catch (e: AtlasClientException.Transport) {
                RefreshPolicy.Outcome.NetworkError
            }
            val elapsed = (System.currentTimeMillis() - pending.startedAtEpochMs) / 1000
            when (RefreshPolicy.action(outcome, elapsed)) {
                RefreshPolicy.Action.RETRY_SAME_REQUEST_ID -> delay(2_000)
                else -> {
                    vault.clear()
                    throw AtlasClientException.RefreshRequired()
                }
            }
        }
        @Suppress("UNREACHABLE_CODE")
        throw IllegalStateException()
    }

    companion object {
        private val random = SecureRandom()

        fun newRequestId(): String = EnrollmentProof.base64Url(ByteArray(32).also(random::nextBytes))
    }
}
