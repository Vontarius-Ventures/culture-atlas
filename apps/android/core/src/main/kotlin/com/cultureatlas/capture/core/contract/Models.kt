package com.cultureatlas.capture.core.contract

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * Wire models for the culture atlas `/v2` contract, written independently of
 * the iOS client and checked against fixtures/native-contract/messages.json.
 * UUIDs are carried as lowercase strings: the enrollment proof signs the
 * installation id exactly as the request body carries it.
 */
object AtlasContract {
    const val VERSION = "2026-10-15.1"
    const val CLIP_MAX_SECONDS = 60
    const val AUDIO_MAX_SECONDS = 120
    const val COUNTDOWN_FROM_SECONDS = 10
    const val REMOTE_ARM_MAX_SECONDS = 600
    const val HEARTBEAT_INTERVAL_SECONDS = 15L
    const val SERVER_STALE_AFTER_SECONDS = 30L
    const val COMMAND_POLL_WAIT_SECONDS = 25
    const val MAX_PART_NUMBERS_PER_REQUEST = 100
    const val PART_INSTRUCTION_REFRESH_MARGIN_SECONDS = 60L
    const val REFRESH_RETRY_WINDOW_SECONDS = 60L
    const val PLATFORM = "android"
    const val CALLBACK_URL = "https://app.cultureatlas.com/identity/callback"

    val json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
        encodeDefaults = true
    }
}

fun String.wireId(): String = lowercase()

@Serializable
enum class MediaKind {
    @SerialName("photo") PHOTO,
    @SerialName("video") VIDEO,
    @SerialName("audio") AUDIO,
}

@Serializable
enum class MediaSource {
    @SerialName("phone_camera") PHONE_CAMERA,
    @SerialName("phone_microphone") PHONE_MICROPHONE,
    @SerialName("meta_glasses") META_GLASSES,
    @SerialName("upload") UPLOAD,
}

@Serializable
enum class UploadState {
    @SerialName("created") CREATED,
    @SerialName("uploading") UPLOADING,
    @SerialName("verifying") VERIFYING,
    @SerialName("committed") COMMITTED,
    @SerialName("aborted") ABORTED,
    @SerialName("expired") EXPIRED,
    @SerialName("rejected") REJECTED,
    @SerialName("paused") PAUSED,
}

// Identity

@Serializable
data class EmailStartRequest(
    val email: String,
    val purpose: String,
    val destination: String,
    val state: String,
    val nonce: String,
    @SerialName("code_challenge") val codeChallenge: String,
)

@Serializable
data class EmailCompleteRequest(
    @SerialName("challenge_id") val challengeId: String,
    val token: String,
    val state: String,
    val nonce: String,
    @SerialName("code_verifier") val codeVerifier: String,
)

@Serializable
data class NativeEmailCompletion(
    @SerialName("account_id") val accountId: String,
    @SerialName("enrollment_grant") val enrollmentGrant: String,
    val platform: String,
)

@Serializable
data class RefreshRequest(
    @SerialName("refresh_token") val refreshToken: String,
    @SerialName("installation_id") val installationId: String,
    @SerialName("refresh_request_id") val refreshRequestId: String,
)

@Serializable
data class NativeSessionTokens(
    @SerialName("session_id") val sessionId: String,
    @SerialName("installation_id") val installationId: String,
    @SerialName("account_id") val accountId: String,
    @SerialName("access_token") val accessToken: String,
    @SerialName("refresh_token") val refreshToken: String,
    @SerialName("access_expires_at") val accessExpiresAt: String,
    @SerialName("refresh_expires_at") val refreshExpiresAt: String,
)

@Serializable
data class SwitchResponse(@SerialName("signed_out") val signedOut: Boolean)

// Enrollment

@Serializable
data class PublicKeyJwk(val kty: String = "EC", val crv: String = "P-256", val x: String, val y: String)

@Serializable
data class EnrollmentChallengeRequest(
    @SerialName("enrollment_grant") val enrollmentGrant: String? = null,
    @SerialName("installation_public_id") val installationPublicId: String,
    val platform: String = AtlasContract.PLATFORM,
    @SerialName("public_key") val publicKey: PublicKeyJwk,
)

@Serializable
data class EnrollmentChallenge(val nonce: String, @SerialName("expires_at") val expiresAt: String)

@Serializable
data class EnrollProof(val nonce: String, val signature: String, @SerialName("public_key") val publicKey: PublicKeyJwk)

@Serializable
data class EnrollRequest(
    val platform: String = AtlasContract.PLATFORM,
    @SerialName("app_version") val appVersion: String,
    @SerialName("installation_public_id") val installationPublicId: String,
    @SerialName("enrollment_grant") val enrollmentGrant: String? = null,
    val proof: EnrollProof,
    val capabilities: Map<String, Boolean> = emptyMap(),
)

@Serializable
data class InstallationDto(
    val id: String,
    val platform: String,
    @SerialName("app_version") val appVersion: String,
    val revision: Int,
    @SerialName("last_seen_at") val lastSeenAt: String,
    @SerialName("revoked_at") val revokedAt: String? = null,
    val capabilities: Map<String, Boolean>,
    val readiness: String,
    @SerialName("app_state") val appState: String,
)

@Serializable
data class EnrollResponse(
    val installation: InstallationDto,
    @SerialName("native_session") val nativeSession: NativeSessionTokens,
)

@Serializable
data class DeviceStatusRequest(
    val sequence: Long,
    val capabilities: Map<String, Boolean>,
    val readiness: String,
    @SerialName("app_state") val appState: String,
)

@Serializable
data class StatusAccepted(@SerialName("accepted_sequence") val acceptedSequence: Long)

@Serializable
data class CreateWearableRequest(
    @SerialName("sdk_reference") val sdkReference: String,
    @SerialName("display_name") val displayName: String,
    val capabilities: Map<String, Boolean>,
    @SerialName("permission_state") val permissionState: String,
)

@Serializable
data class WearableLink(@SerialName("connection_id") val connectionId: String)

// Capture sessions

@Serializable
data class CreateCaptureSessionRequest(
    val source: MediaSource,
    val mode: MediaKind,
    @SerialName("connection_id") val connectionId: String? = null,
    @SerialName("local_session_id") val localSessionId: String? = null,
)

@Serializable
data class CaptureSessionResponse(
    @SerialName("session_id") val sessionId: String,
    val generation: Int,
    val state: String,
    @SerialName("remote_arm_expires_at") val remoteArmExpiresAt: String? = null,
)

@Serializable
data class ArmRequest(
    val enabled: Boolean,
    @SerialName("duration_seconds") val durationSeconds: Int,
    @SerialName("allowed_agent_connection_ids") val allowedAgentConnectionIds: List<String>,
)

@Serializable
data class EndSessionRequest(val reason: String)

// Uploads

@Serializable
data class CreateUploadRequest(
    @SerialName("client_capture_id") val clientCaptureId: String,
    val kind: MediaKind,
    val source: MediaSource,
    val filename: String,
    @SerialName("content_type") val contentType: String,
    @SerialName("byte_size") val byteSize: Long,
    val sha256: String,
    @SerialName("captured_at") val capturedAt: String? = null,
    @SerialName("capture_session_id") val captureSessionId: String? = null,
    @SerialName("source_route") val sourceRoute: String? = null,
    @SerialName("capture_mode") val captureMode: String? = null,
)

@Serializable
data class PartReceipt(@SerialName("part_number") val partNumber: Int, val etag: String)

@Serializable
data class PartInstruction(
    @SerialName("part_number") val partNumber: Int,
    val method: String,
    val url: String,
    val headers: Map<String, String>,
    @SerialName("expires_at") val expiresAt: String,
)

@Serializable
data class UploadResponse(
    @SerialName("asset_id") val assetId: String,
    @SerialName("upload_id") val uploadId: String,
    val state: UploadState,
    @SerialName("expires_at") val expiresAt: String,
    @SerialName("part_size") val partSize: Long,
    @SerialName("part_count") val partCount: Int,
    val parts: List<PartInstruction>,
    @SerialName("verified_parts") val verifiedParts: List<PartReceipt>,
    @SerialName("error_code") val errorCode: String? = null,
    @SerialName("pause_reason") val pauseReason: String? = null,
)

@Serializable
data class UploadPartsRequest(@SerialName("part_numbers") val partNumbers: List<Int>)

@Serializable
data class UploadPartsResponse(val parts: List<PartInstruction>)

@Serializable
data class CompleteUploadRequest(val parts: List<PartReceipt>)

// Commands

@Serializable
enum class CommandAction {
    @SerialName("capture_photo") CAPTURE_PHOTO,
    @SerialName("start_video") START_VIDEO,
    @SerialName("stop_video") STOP_VIDEO,
}

@Serializable
data class DeviceCommand(
    @SerialName("command_id") val commandId: String,
    @SerialName("session_id") val sessionId: String,
    val generation: Int,
    val action: CommandAction,
    @SerialName("delivery_sequence") val deliverySequence: Long,
    @SerialName("duration_seconds") val durationSeconds: Int? = null,
    @SerialName("capture_client_id") val captureClientId: String,
    @SerialName("authorization_version") val authorizationVersion: Int,
    val state: String,
    @SerialName("expires_at") val expiresAt: String,
    @SerialName("result_asset_id") val resultAssetId: String? = null,
    @SerialName("error_code") val errorCode: String? = null,
)

@Serializable
data class CommandBatch(
    @SerialName("schema_version") val schemaVersion: String? = null,
    @SerialName("request_id") val requestId: String? = null,
    val items: List<DeviceCommand>,
    @SerialName("next_sequence") val nextSequence: Long,
)

@Serializable
enum class AckState {
    @SerialName("awaiting_user") AWAITING_USER,
    @SerialName("executing") EXECUTING,
    @SerialName("succeeded") SUCCEEDED,
    @SerialName("failed") FAILED,
    @SerialName("unknown") UNKNOWN,
}

@Serializable
enum class SafeCommandError {
    @SerialName("device_unavailable") DEVICE_UNAVAILABLE,
    @SerialName("permission_denied") PERMISSION_DENIED,
    @SerialName("interrupted") INTERRUPTED,
    @SerialName("storage_full") STORAGE_FULL,
    @SerialName("outcome_unknown") OUTCOME_UNKNOWN,
}

@Serializable
data class CommandAck(
    val sequence: Int,
    val state: AckState,
    @SerialName("result_asset_id") val resultAssetId: String? = null,
    @SerialName("safe_error") val safeError: SafeCommandError? = null,
)

// Capabilities, errors, agents

@Serializable
data class Availability(val available: Boolean, val reasons: List<String>)

@Serializable
data class Capabilities(
    @SerialName("contract_version") val contractVersion: String,
    val flags: Map<String, Boolean>,
    val limits: Map<String, Long>,
    val availability: Map<String, Availability>,
) {
    fun flag(name: String): Boolean = flags[name] == true
}

@Serializable
data class ServerErrorDetail(
    val code: String,
    val message: String,
    val retryable: Boolean,
    @SerialName("request_id") val requestId: String,
    @SerialName("retry_after_ms") val retryAfterMs: Double? = null,
)

@Serializable
data class ServerErrorBody(val error: ServerErrorDetail)

@Serializable
data class AgentConnection(
    val id: String,
    @SerialName("client_name") val clientName: String,
    val scopes: List<String>,
)

@Serializable
data class AgentConnectionList(val connections: List<AgentConnection>)
