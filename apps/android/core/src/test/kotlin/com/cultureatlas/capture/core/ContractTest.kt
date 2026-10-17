package com.cultureatlas.capture.core

import com.cultureatlas.capture.core.contract.ArmRequest
import com.cultureatlas.capture.core.contract.AtlasContract
import com.cultureatlas.capture.core.contract.Capabilities
import com.cultureatlas.capture.core.contract.CaptureSessionResponse
import com.cultureatlas.capture.core.contract.CommandAck
import com.cultureatlas.capture.core.contract.CommandAction
import com.cultureatlas.capture.core.contract.CommandBatch
import com.cultureatlas.capture.core.contract.CompleteUploadRequest
import com.cultureatlas.capture.core.contract.CreateCaptureSessionRequest
import com.cultureatlas.capture.core.contract.CreateUploadRequest
import com.cultureatlas.capture.core.contract.CreateWearableRequest
import com.cultureatlas.capture.core.contract.DeviceStatusRequest
import com.cultureatlas.capture.core.contract.EmailCompleteRequest
import com.cultureatlas.capture.core.contract.EmailStartRequest
import com.cultureatlas.capture.core.contract.EndSessionRequest
import com.cultureatlas.capture.core.contract.EnrollRequest
import com.cultureatlas.capture.core.contract.EnrollResponse
import com.cultureatlas.capture.core.contract.EnrollmentChallenge
import com.cultureatlas.capture.core.contract.EnrollmentChallengeRequest
import com.cultureatlas.capture.core.contract.NativeEmailCompletion
import com.cultureatlas.capture.core.contract.NativeSessionTokens
import com.cultureatlas.capture.core.contract.RefreshRequest
import com.cultureatlas.capture.core.contract.ServerErrorBody
import com.cultureatlas.capture.core.contract.StatusAccepted
import com.cultureatlas.capture.core.contract.SwitchResponse
import com.cultureatlas.capture.core.contract.UploadPartsRequest
import com.cultureatlas.capture.core.contract.UploadPartsResponse
import com.cultureatlas.capture.core.contract.UploadResponse
import com.cultureatlas.capture.core.contract.UploadState
import com.cultureatlas.capture.core.contract.WearableLink
import com.cultureatlas.capture.core.identity.AccountClient
import com.cultureatlas.capture.core.identity.SessionManager
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.Json
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test

class ContractTest {
    private val json = AtlasContract.json

    @Test
    fun constantsMatchTheContractFixture() {
        val contract = Fixtures.json("contract.json")
        assertEquals(AtlasContract.VERSION, contract["contract_version"].str)
        assertEquals("lowercase", contract["wire_uuid_case"].str)
        val identity = contract["identity"]!!.obj
        assertEquals(AtlasContract.CALLBACK_URL, identity["callbacks"]!!.obj["android"].str)
        assertEquals(AtlasContract.REFRESH_RETRY_WINDOW_SECONDS, identity["refresh_lost_response_retry_window_seconds"].long)
        val capture = contract["capture"]!!.obj
        assertEquals(AtlasContract.CLIP_MAX_SECONDS, capture["native_clip_max_seconds"].int)
        assertEquals(AtlasContract.COUNTDOWN_FROM_SECONDS, capture["countdown_from_seconds"].int)
        assertEquals(AtlasContract.REMOTE_ARM_MAX_SECONDS, capture["remote_arm_max_seconds"].int)
        val commands = contract["commands"]!!.obj
        assertEquals(AtlasContract.COMMAND_POLL_WAIT_SECONDS, commands["poll_wait_seconds"].int)
        assertEquals(AtlasContract.HEARTBEAT_INTERVAL_SECONDS, commands["heartbeat_interval_seconds"].long)
    }

    @Test
    fun decodesEveryResponseExample() {
        json.decodeFromString(NativeEmailCompletion.serializer(), Fixtures.messageText("email_complete_native_response"))
        json.decodeFromString(NativeSessionTokens.serializer(), Fixtures.messageText("native_session_tokens"))
        json.decodeFromString(EnrollmentChallenge.serializer(), Fixtures.messageText("enrollment_challenge_response"))
        assertEquals("unavailable", json.decodeFromString(EnrollResponse.serializer(), Fixtures.messageText("enroll_response")).installation.readiness)
        json.decodeFromString(StatusAccepted.serializer(), Fixtures.messageText("device_status_response"))
        json.decodeFromString(WearableLink.serializer(), Fixtures.messageText("create_wearable_response"))
        json.decodeFromString(CaptureSessionResponse.serializer(), Fixtures.messageText("capture_session_response"))
        assertEquals(8_388_608L, json.decodeFromString(UploadResponse.serializer(), Fixtures.messageText("upload_response")).partSize)
        assertEquals(UploadState.PAUSED, json.decodeFromString(UploadResponse.serializer(), Fixtures.messageText("upload_paused_response")).state)
        json.decodeFromString(UploadPartsResponse.serializer(), Fixtures.messageText("upload_parts_response"))
        assertEquals(CommandAction.CAPTURE_PHOTO, json.decodeFromString(CommandBatch.serializer(), Fixtures.messageText("native_command_batch")).items.first().action)
        assertFalse(json.decodeFromString(Capabilities.serializer(), Fixtures.messageText("capabilities_response")).flag("meta_glasses_capture_enabled"))
        assertEquals("account_mismatch", json.decodeFromString(ServerErrorBody.serializer(), Fixtures.messageText("error_body")).error.code)
        json.decodeFromString(SwitchResponse.serializer(), Fixtures.messageText("switch_response"))
    }

    /** Requests re-encode to exactly the example JSON (names, lowercase UUIDs, omitted nulls). */
    @Test
    fun requestsEncodeToTheExampleBodies() {
        roundTrip(EmailStartRequest.serializer(), "email_start_android")
        roundTrip(EmailCompleteRequest.serializer(), "email_complete_request")
        roundTrip(RefreshRequest.serializer(), "refresh_request")
        roundTrip(EnrollmentChallengeRequest.serializer(), "enrollment_challenge_request")
        roundTrip(EnrollRequest.serializer(), "enroll_request")
        roundTrip(DeviceStatusRequest.serializer(), "device_status_request")
        roundTrip(CreateWearableRequest.serializer(), "create_wearable_request")
        roundTrip(CreateCaptureSessionRequest.serializer(), "create_capture_session_request")
        roundTrip(ArmRequest.serializer(), "arm_request")
        roundTrip(EndSessionRequest.serializer(), "end_session_request")
        roundTrip(CreateUploadRequest.serializer(), "create_upload_photo_request")
        roundTrip(CreateUploadRequest.serializer(), "create_upload_glasses_video_request")
        roundTrip(UploadPartsRequest.serializer(), "upload_parts_request")
        roundTrip(CompleteUploadRequest.serializer(), "complete_upload_request")
        listOf("command_ack_executing", "command_ack_succeeded", "command_ack_unknown", "command_ack_failed", "command_ack_awaiting_user")
            .forEach { roundTrip(CommandAck.serializer(), it) }
    }

    private fun <T> roundTrip(serializer: KSerializer<T>, key: String) {
        val example = Fixtures.message(key)
        val model = json.decodeFromString(serializer, example.toString())
        assertEquals(example, Json.parseToJsonElement(json.encodeToString(serializer, model)), key)
    }

    @Test
    fun callbackParsingAcceptsOnlyTheFixedAppLink() {
        val good = "https://app.cultureatlas.com/identity/callback#challenge_id=4f1d9a52-7b8c-4e3d-9a10-2b3c4d5e6f70&token=t0k&state=s&nonce=n"
        assertEquals("4f1d9a52-7b8c-4e3d-9a10-2b3c4d5e6f70", AccountClient.parseCallback(good)?.get("challenge_id"))
        assertNull(AccountClient.parseCallback("https://evil.example/identity/callback#challenge_id=a&token=b&state=c&nonce=d"))
        assertNull(AccountClient.parseCallback("http://app.cultureatlas.com/identity/callback#challenge_id=a&token=b&state=c&nonce=d"))
        assertNull(AccountClient.parseCallback("https://app.cultureatlas.com/identity/callback#challenge_id=a&token=b"))
    }

    @Test
    fun pkceAndRequestIdFormats() {
        // RFC 7636 appendix B.
        assertEquals(
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
            AccountClient.pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
        )
        val pattern = Regex(Fixtures.json("contract.json")["token_patterns"]!!.obj["refresh_request_id"].str!!)
        org.junit.jupiter.api.Assertions.assertTrue(pattern.matches(SessionManager.newRequestId()))
    }
}
