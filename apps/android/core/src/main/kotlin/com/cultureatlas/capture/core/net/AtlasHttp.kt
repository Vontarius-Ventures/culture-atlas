package com.cultureatlas.capture.core.net

import com.cultureatlas.capture.core.contract.AtlasContract
import com.cultureatlas.capture.core.contract.FlatServerError
import com.cultureatlas.capture.core.contract.ServerErrorBody
import com.cultureatlas.capture.core.policy.ErrorPolicy
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.File
import java.io.IOException
import java.util.UUID
import java.util.concurrent.TimeUnit

sealed class AtlasClientException(message: String) : Exception(message) {
    /** The server's `{error:{code,message,retryable,request_id,retry_after_ms?}}`. */
    class Server(
        val status: Int,
        override val code: String,
        val retryable: Boolean,
        val retryAfterSeconds: Double?,
    ) : AtlasClientException("$status $code")

    class Transport(cause: String) : AtlasClientException(cause)
    class Decoding(type: String) : AtlasClientException(type)
    class NotSignedIn : AtlasClientException("not_signed_in")
    /** The data belongs to another account than the signed-in one; nothing was sent. */
    class DraftLocked : AtlasClientException("draft_locked")
    class RefreshRequired : AtlasClientException("refresh_required")

    open val code: String? get() = null

    val policyAction: ErrorPolicy.Action
        get() = when (this) {
            is Server -> ErrorPolicy.action(code, retryable)
            is Transport -> ErrorPolicy.Action.RETRY_BACKOFF
            is Decoding -> ErrorPolicy.Action.SURFACE_NO_RETRY
            is NotSignedIn, is RefreshRequired -> ErrorPolicy.Action.SIGN_IN_REQUIRED
            is DraftLocked -> ErrorPolicy.Action.LOCK_TO_ORIGINAL_ACCOUNT
        }
}

/**
 * JSON over HTTPS for `/v2`. The base URL is the hosted API from the build
 * (never a relay or LAN address); cleartext is refused by the app's network
 * security config.
 */
class AtlasHttp(
    val baseUrl: HttpUrl,
    val client: OkHttpClient = OkHttpClient.Builder()
        .callTimeout(60, TimeUnit.SECONDS)
        .readTimeout(40, TimeUnit.SECONDS)
        .build(),
) {
    private val jsonType = "application/json".toMediaType()

    suspend fun <B, R> call(
        method: String,
        path: String,
        body: B?,
        bodySerializer: KSerializer<B>?,
        resultSerializer: KSerializer<R>,
        query: Map<String, String> = emptyMap(),
        bearer: String? = null,
        idempotencyKey: UUID? = null,
        expectedAccount: String? = null,
    ): R = withContext(Dispatchers.IO) {
        val url = baseUrl.newBuilder().apply {
            path.trim('/').split('/').forEach { addPathSegment(it) }
            query.forEach { (k, v) -> addQueryParameter(k, v) }
        }.build()
        val payload = if (body != null && bodySerializer != null) {
            AtlasContract.json.encodeToString(bodySerializer, body).toRequestBody(jsonType)
        } else if (method != "GET") {
            "{}".toRequestBody(jsonType)
        } else {
            null
        }
        val request = Request.Builder().url(url).method(method, payload).apply {
            header("Accept", "application/json")
            bearer?.let { header("Authorization", "Bearer $it") }
            idempotencyKey?.let { header("Idempotency-Key", it.toString().lowercase()) }
            expectedAccount?.let { header("X-Atlas-Expected-Account", it.lowercase()) }
        }.build()
        val response = try {
            client.newCall(request).execute()
        } catch (e: IOException) {
            throw AtlasClientException.Transport(e.javaClass.simpleName)
        }
        response.use {
            val text = it.body?.string().orEmpty()
            if (!it.isSuccessful) {
                val retryAfter = it.header("Retry-After")?.toDoubleOrNull()
                val parsed = runCatching { AtlasContract.json.decodeFromString(ServerErrorBody.serializer(), text) }.getOrNull()
                // /v1 routes (taste onboarding) answer with the flat error body.
                val flat = if (parsed == null) {
                    runCatching { AtlasContract.json.decodeFromString(FlatServerError.serializer(), text) }.getOrNull()
                } else {
                    null
                }
                throw if (parsed != null) {
                    AtlasClientException.Server(
                        it.code,
                        parsed.error.code,
                        parsed.error.retryable,
                        retryAfter ?: parsed.error.retryAfterMs?.div(1000),
                    )
                } else if (flat != null) {
                    AtlasClientException.Server(it.code, flat.code, flat.retryable, retryAfter ?: flat.retryAfterMs?.div(1000))
                } else {
                    AtlasClientException.Server(it.code, "http_${it.code}", it.code >= 500, retryAfter)
                }
            }
            try {
                AtlasContract.json.decodeFromString(resultSerializer, text.ifEmpty { "{}" })
            } catch (e: Exception) {
                throw AtlasClientException.Decoding(resultSerializer.descriptor.serialName)
            }
        }
    }

    suspend fun <R> get(
        path: String,
        resultSerializer: KSerializer<R>,
        query: Map<String, String> = emptyMap(),
        bearer: String? = null,
    ): R = call<Unit, R>("GET", path, null, null, resultSerializer, query, bearer)

    /**
     * `POST /v2/media/audio`: JSON keep request plus a WAV file. No analysis.
     */
    suspend fun <B, R> postMultipart(
        path: String,
        body: B,
        bodySerializer: KSerializer<B>,
        file: File,
        resultSerializer: KSerializer<R>,
        bearer: String? = null,
        idempotencyKey: UUID? = null,
        expectedAccount: String? = null,
    ): R = withContext(Dispatchers.IO) {
        val url = baseUrl.newBuilder().apply {
            path.trim('/').split('/').forEach { addPathSegment(it) }
        }.build()
        val fields = AtlasContract.json.encodeToJsonElement(bodySerializer, body).jsonObject
        val payload = MultipartBody.Builder().setType(MultipartBody.FORM).apply {
            for ((name, value) in fields) {
                if (value is kotlinx.serialization.json.JsonNull) continue
                val text = (value as? kotlinx.serialization.json.JsonPrimitive)?.content ?: value.toString()
                addFormDataPart(name, text)
            }
            addFormDataPart("file", file.name, file.asRequestBody("audio/wav".toMediaType()))
        }.build()
        val request = Request.Builder().url(url).post(payload).apply {
            header("Accept", "application/json")
            bearer?.let { header("Authorization", "Bearer $it") }
            idempotencyKey?.let { header("Idempotency-Key", it.toString().lowercase()) }
            expectedAccount?.let { header("X-Atlas-Expected-Account", it.lowercase()) }
        }.build()
        val response = try {
            client.newCall(request).execute()
        } catch (e: IOException) {
            throw AtlasClientException.Transport(e.javaClass.simpleName)
        }
        response.use {
            val text = it.body?.string().orEmpty()
            if (!it.isSuccessful) {
                val retryAfter = it.header("Retry-After")?.toDoubleOrNull()
                val parsed = runCatching { AtlasContract.json.decodeFromString(ServerErrorBody.serializer(), text) }.getOrNull()
                val flat = if (parsed == null) {
                    runCatching { AtlasContract.json.decodeFromString(FlatServerError.serializer(), text) }.getOrNull()
                } else {
                    null
                }
                throw if (parsed != null) {
                    AtlasClientException.Server(
                        it.code,
                        parsed.error.code,
                        parsed.error.retryable,
                        retryAfter ?: parsed.error.retryAfterMs?.div(1000),
                    )
                } else if (flat != null) {
                    AtlasClientException.Server(it.code, flat.code, flat.retryable, retryAfter ?: flat.retryAfterMs?.div(1000))
                } else {
                    AtlasClientException.Server(it.code, "http_${it.code}", it.code >= 500, retryAfter)
                }
            }
            try {
                AtlasContract.json.decodeFromString(resultSerializer, text.ifEmpty { "{}" })
            } catch (e: Exception) {
                throw AtlasClientException.Decoding(resultSerializer.descriptor.serialName)
            }
        }
    }

    companion object {
        fun forHost(host: String): AtlasHttp = AtlasHttp("https://$host/".toHttpUrl())
    }
}
