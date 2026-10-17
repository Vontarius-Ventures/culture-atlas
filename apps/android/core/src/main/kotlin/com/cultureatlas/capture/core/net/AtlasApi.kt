package com.cultureatlas.capture.core.net

import com.cultureatlas.capture.core.contract.AgentConnectionList
import com.cultureatlas.capture.core.contract.ArmRequest
import com.cultureatlas.capture.core.contract.AtlasContract
import com.cultureatlas.capture.core.contract.Capabilities
import com.cultureatlas.capture.core.contract.CaptureSessionResponse
import com.cultureatlas.capture.core.contract.CommandAck
import com.cultureatlas.capture.core.contract.CommandBatch
import com.cultureatlas.capture.core.contract.CompleteUploadRequest
import com.cultureatlas.capture.core.contract.CreateCaptureSessionRequest
import com.cultureatlas.capture.core.contract.CreateUploadRequest
import com.cultureatlas.capture.core.contract.CreateWearableRequest
import com.cultureatlas.capture.core.contract.DeviceCommand
import com.cultureatlas.capture.core.contract.DeviceStatusRequest
import com.cultureatlas.capture.core.contract.EndSessionRequest
import com.cultureatlas.capture.core.contract.StatusAccepted
import com.cultureatlas.capture.core.contract.UploadPartsRequest
import com.cultureatlas.capture.core.contract.UploadPartsResponse
import com.cultureatlas.capture.core.contract.UploadResponse
import com.cultureatlas.capture.core.contract.WearableLink
import com.cultureatlas.capture.core.identity.SessionManager
import kotlinx.serialization.KSerializer
import java.util.UUID

/**
 * Authenticated `/v2` calls for the enrolled installation. Mutations carry an
 * Idempotency-Key and X-Atlas-Expected-Account (the owner of the data being
 * changed). When that owner is not the signed-in account nothing is sent.
 * An expired access token is refreshed once and the call retried with the
 * same key.
 */
class AtlasApi(val http: AtlasHttp, val sessions: SessionManager) {
    suspend fun <B, R> call(
        method: String,
        path: String,
        body: B?,
        bodySerializer: KSerializer<B>?,
        resultSerializer: KSerializer<R>,
        query: Map<String, String> = emptyMap(),
        idempotencyKey: UUID? = null,
        expectedAccount: String? = null,
    ): R {
        val signedIn = sessions.currentAccountId ?: throw AtlasClientException.NotSignedIn()
        val owner = (expectedAccount ?: signedIn).lowercase()
        if (owner != signedIn.lowercase()) throw AtlasClientException.DraftLocked()
        val mutation = method != "GET"
        val key = if (mutation) idempotencyKey ?: UUID.randomUUID() else null
        var attempt = 0
        while (true) {
            attempt++
            val token = sessions.accessToken()
            try {
                return http.call(
                    method, path, body, bodySerializer, resultSerializer, query, token, key,
                    if (mutation) owner else null,
                )
            } catch (e: AtlasClientException.Server) {
                if (e.code == "token_expired" && attempt == 1) sessions.refresh() else throw e
            }
        }
    }

    suspend fun <R> get(path: String, serializer: KSerializer<R>, query: Map<String, String> = emptyMap()): R =
        call<Unit, R>("GET", path, null, null, serializer, query)

    suspend fun capabilities(): Capabilities = get("/v2/capabilities", Capabilities.serializer())

    suspend fun reportStatus(status: DeviceStatusRequest): StatusAccepted =
        call("PUT", "/v2/device/status", status, DeviceStatusRequest.serializer(), StatusAccepted.serializer())

    suspend fun createSession(request: CreateCaptureSessionRequest): CaptureSessionResponse =
        call(
            "POST", "/v2/device/capture-sessions", request, CreateCaptureSessionRequest.serializer(),
            CaptureSessionResponse.serializer(),
        )

    suspend fun arm(sessionId: String, request: ArmRequest): CaptureSessionResponse =
        call(
            "POST", "/v2/device/capture-sessions/${sessionId.lowercase()}/arm", request, ArmRequest.serializer(),
            CaptureSessionResponse.serializer(),
        )

    suspend fun endSession(sessionId: String, reason: String): CaptureSessionResponse =
        call(
            "POST", "/v2/device/capture-sessions/${sessionId.lowercase()}/end", EndSessionRequest(reason),
            EndSessionRequest.serializer(), CaptureSessionResponse.serializer(),
        )

    suspend fun linkWearable(request: CreateWearableRequest): WearableLink =
        call("POST", "/v2/device/wearables", request, CreateWearableRequest.serializer(), WearableLink.serializer())

    suspend fun createUpload(request: CreateUploadRequest, key: UUID, owner: String): UploadResponse =
        call("POST", "/v2/uploads", request, CreateUploadRequest.serializer(), UploadResponse.serializer(), idempotencyKey = key, expectedAccount = owner)

    suspend fun upload(uploadId: String): UploadResponse =
        get("/v2/uploads/${uploadId.lowercase()}", UploadResponse.serializer())

    suspend fun parts(uploadId: String, numbers: List<Int>, owner: String): UploadPartsResponse =
        call(
            "POST", "/v2/uploads/${uploadId.lowercase()}/parts", UploadPartsRequest(numbers), UploadPartsRequest.serializer(),
            UploadPartsResponse.serializer(), expectedAccount = owner,
        )

    suspend fun complete(uploadId: String, request: CompleteUploadRequest, key: UUID, owner: String): UploadResponse =
        call(
            "POST", "/v2/uploads/${uploadId.lowercase()}/complete", request, CompleteUploadRequest.serializer(),
            UploadResponse.serializer(), idempotencyKey = key, expectedAccount = owner,
        )

    suspend fun pollCommands(afterSequence: Long): CommandBatch =
        get(
            "/v2/device/commands", CommandBatch.serializer(),
            mapOf("after_sequence" to afterSequence.toString(), "wait" to AtlasContract.COMMAND_POLL_WAIT_SECONDS.toString()),
        )

    suspend fun acknowledge(commandId: String, ack: CommandAck, key: UUID): DeviceCommand =
        call(
            "POST", "/v2/device/commands/${commandId.lowercase()}/ack", ack, CommandAck.serializer(),
            DeviceCommand.serializer(), idempotencyKey = key,
        )

    suspend fun agentConnections(): AgentConnectionList = get("/v2/agent-connections", AgentConnectionList.serializer())
}
