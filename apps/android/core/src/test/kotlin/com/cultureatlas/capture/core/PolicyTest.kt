package com.cultureatlas.capture.core

import com.cultureatlas.capture.core.commands.CommandRunner
import com.cultureatlas.capture.core.contract.AtlasContract
import com.cultureatlas.capture.core.contract.CommandAck
import com.cultureatlas.capture.core.contract.CommandAction
import com.cultureatlas.capture.core.contract.DeviceCommand
import com.cultureatlas.capture.core.contract.MediaKind
import com.cultureatlas.capture.core.contract.PartReceipt
import com.cultureatlas.capture.core.contract.UploadState
import com.cultureatlas.capture.core.identity.EnrollmentProof
import com.cultureatlas.capture.core.policy.Backoff
import com.cultureatlas.capture.core.policy.CapabilityGate
import com.cultureatlas.capture.core.policy.ClipClock
import com.cultureatlas.capture.core.policy.CommandLocalState
import com.cultureatlas.capture.core.policy.CommandProcessor
import com.cultureatlas.capture.core.policy.DraftLockPolicy
import com.cultureatlas.capture.core.policy.ErrorPolicy
import com.cultureatlas.capture.core.policy.PartPlanner
import com.cultureatlas.capture.core.policy.ReceiptSnapshot
import com.cultureatlas.capture.core.policy.ReceiptState
import com.cultureatlas.capture.core.policy.RefreshPolicy
import com.cultureatlas.capture.core.store.EncryptedFile
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.math.BigInteger
import java.nio.file.Files
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPublicKeySpec
import java.time.Instant
import java.util.Base64
import javax.crypto.KeyGenerator

private fun hex(value: String) = value.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
private fun b64url(value: String) = Base64.getUrlDecoder().decode(value)

class EnrollmentProofTest {
    @Test
    fun payloadSignatureAndDerConversionMatchVectors() {
        val fixture = Fixtures.json("enrollment-signature.json")
        val jwk = fixture["public_key"]!!.obj
        val params = AlgorithmParameters.getInstance("EC").apply { init(ECGenParameterSpec("secp256r1")) }
            .getParameterSpec(ECParameterSpec::class.java)
        val point = ECPoint(BigInteger(1, b64url(jwk["x"].str!!)), BigInteger(1, b64url(jwk["y"].str!!)))
        val publicKey = KeyFactory.getInstance("EC").generatePublic(ECPublicKeySpec(point, params)) as java.security.interfaces.ECPublicKey
        assertEquals(jwk["x"].str, EnrollmentProof.jwk(publicKey).x)
        assertEquals(jwk["y"].str, EnrollmentProof.jwk(publicKey).y)
        for (vector in fixture["vectors"]!!.arr) {
            val v = vector.obj
            val name = v["name"].str
            val payload = EnrollmentProof.payload(v["nonce"].str!!, v["installation_public_id"].str!!, v["platform"].str!!, v["enrollment_grant"].str)
            assertEquals(v["payload_utf8"].str, payload, name)
            val der = hex(v["signature_der_hex"].str!!)
            val verifier = Signature.getInstance("SHA256withECDSA").apply { initVerify(publicKey); update(payload.toByteArray()) }
            assertTrue(verifier.verify(der), name)
            assertArrayEquals(b64url(v["signature_p1363_base64url"].str!!), EnrollmentProof.derToP1363(der), name)
        }
        for (conversion in fixture["der_conversion"]!!.arr) {
            val c = conversion.obj
            assertArrayEquals(hex(c["p1363_hex"].str!!), EnrollmentProof.derToP1363(hex(c["der_hex"].str!!)), c["name"].str)
        }
    }

    @Test
    fun freshKeystoreStyleSignaturesConvertToThe86CharacterEncoding() {
        val pair = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
        repeat(20) {
            val der = Signature.getInstance("SHA256withECDSA").apply { initSign(pair.private); update(byteArrayOf(it.toByte())) }.sign()
            assertEquals(86, EnrollmentProof.base64Url(EnrollmentProof.derToP1363(der)).length)
        }
    }
}

class PartPlannerTest {
    @Test
    fun plansBatchesResumeAndNextSteps() {
        val fixture = Fixtures.json("upload-parts.json")
        for (plan in fixture["plans"]!!.arr) {
            val p = plan.obj
            val parts = PartPlanner.plan(p["byte_size"].long!!, p["part_size"].long!!)
            val expected = p["parts"]!!.arr.map { row -> row.arr.map { it.long!! } }
            assertEquals(expected, parts.map { listOf(it.number.toLong(), it.offset, it.length) }, p["name"].str)
        }
        val max = fixture["max_video"]!!.obj
        val big = PartPlanner.plan(max["byte_size"].long!!, max["part_size"].long!!)
        assertEquals(max["part_count"].int, big.size)
        assertEquals(max["last_part"]!!.arr.map { it.long!! }, big.last().let { listOf(it.number.toLong(), it.offset, it.length) })
        assertEquals(listOf(listOf(1, 100), listOf(101, 200), listOf(201, 205)), PartPlanner.batches((1..205).toList(), 100).map { listOf(it.first(), it.last()) })
        for (resume in fixture["resume"]!!.arr) {
            val r = resume.obj
            fun receipts(key: String) = r[key]!!.arr.map { PartReceipt(it.obj["part_number"].int!!, it.obj["etag"].str!!) }
            val merged = PartPlanner.merge(receipts("server_verified"), receipts("local_receipts")).toMutableMap()
            val count = r["part_count"].int!!
            val missing = PartPlanner.missing(count, merged)
            assertEquals(r["missing"]!!.arr.map { it.int }, missing, r["name"].str)
            missing.forEach { merged[it] = "\"new$it\"" }
            assertEquals(receipts("complete_after_sending"), PartPlanner.completion(count, merged), r["name"].str)
        }
        for (step in fixture["next_step"]!!.arr) {
            val s = step.obj
            val state = UploadState.entries.first { it.name.lowercase() == s["server_state"].str }
            assertEquals(s["action"].str, PartPlanner.nextStep(state).wire, s["name"].str)
        }
    }
}

class CommandProcessorTest {
    @Test
    fun decisionTable() {
        val fixture = Fixtures.json("command-lifecycle.json")
        for (item in fixture["decisions"]!!.arr) {
            val d = item.obj
            val name = d["name"].str
            val local = d["local"]!!.obj
            val c = d["command"]!!.obj
            val command = DeviceCommand(
                commandId = c["command_id"].str!!, sessionId = c["session_id"].str!!, generation = c["generation"].int!!,
                action = CommandAction.entries.first { it.name.lowercase() == c["action"].str },
                deliverySequence = 1, durationSeconds = c["duration_seconds"].int, captureClientId = c["capture_client_id"].str!!,
                authorizationVersion = 1, state = "delivered", expiresAt = c["expires_at"].str!!,
            )
            val state = CommandLocalState(
                armedSessionId = local["armed_session_id"].str,
                armedGeneration = local["armed_generation"].int,
                armExpiresAt = local["arm_expires_at"].str?.let(Instant::parse),
                sessionMode = local["session_mode"].str?.let { mode -> MediaKind.entries.first { it.name.lowercase() == mode } },
                sourceReady = local["source_ready"].bool!!,
                recordingCommandId = local["recording_command_id"].str,
                storageOk = local["storage_ok"].bool!!,
            )
            val receipt = d["receipt"]?.takeIf { it !is JsonNull }?.obj?.let {
                ReceiptSnapshot(
                    ReceiptState.valueOf(it["state"].str!!.uppercase()), it["last_ack_sequence"].int!!,
                    it["draft_saved"].bool!!, it["result_asset_id"].str,
                )
            }
            val decision = CommandProcessor.decide(command, receipt, state, Instant.parse(d["now"].str!!))
            val expect = d["expect"]!!.obj
            assertEquals(expect["decision"].str, decision.kind.wire, name)
            assertEquals(expect["persist_receipt"].str, decision.persistReceipt?.name?.lowercase(), name)
            val acks = Json.parseToJsonElement(AtlasContract.json.encodeToString(ListSerializer(CommandAck.serializer()), decision.acks))
            assertEquals(expect["acks"], acks, name)
            if (expect.containsKey("duration_seconds")) assertEquals(expect["duration_seconds"].int, decision.durationSeconds, name)
        }
    }

    @Test
    fun outcomeAcksAndDeterministicKeys() {
        for (item in Fixtures.json("command-lifecycle.json")["outcomes"]!!.arr) {
            val o = item.obj
            val outcome = CommandProcessor.Outcome.entries.first { it.wire == o["outcome"].str }
            val ack = CommandProcessor.ack(outcome, 2, null)
            assertEquals(o["ack"]!!.obj["state"].str, ack.state.name.lowercase())
            assertEquals(o["ack"]!!.obj["safe_error"].str, ack.safeError?.name?.lowercase())
        }
        val a = CommandRunner.ackKey("5f6a7b8c-9d0e-4f1a-8b2c-3d4e5f6a7b8c", 2)
        assertEquals(a, CommandRunner.ackKey("5F6A7B8C-9D0E-4F1A-8B2C-3D4E5F6A7B8C", 2))
        assertNotEquals(a, CommandRunner.ackKey("5f6a7b8c-9d0e-4f1a-8b2c-3d4e5f6a7b8c", 3))
        assertEquals(8, a.version())
        assertEquals(2, a.variant())
    }
}

class DraftLockPolicyTest {
    @Test
    fun visibilityHeadersEffectsAndSignOutOrder() {
        val fixture = Fixtures.json("draft-lock.json")
        val accounts = fixture["accounts"]!!.obj
        for (row in fixture["visibility"]!!.arr) {
            val r = row.obj
            val result = DraftLockPolicy.visibility(accounts[r["draft_owner"].str!!].str!!, r["signed_in"].str?.let { accounts[it].str })
            assertEquals(r["visible"].bool, result.visible)
            assertEquals(r["uploadable"].bool, result.uploadable)
            assertEquals(r["locked_notice"].bool, result.lockedNotice)
        }
        val header = fixture["upload_headers"]!!.arr.first().obj
        assertEquals(accounts[header["expected_account_header"].str!!].str, DraftLockPolicy.expectedAccountHeader(accounts[header["draft_owner"].str!!].str!!.uppercase()))
        for (response in fixture["server_responses"]!!.arr) {
            response.obj["error_code"].str?.let { assertNotEquals(DraftLockPolicy.Effect.NONE, DraftLockPolicy.effectForErrorCode(it), it) }
        }
        assertEquals(fixture["sign_out_order"]!!.arr.map { it.str }, DraftLockPolicy.signOutOrder.map { it.wire })
    }
}

class CapabilityGateTest {
    @Test
    fun cases() {
        val fixture = Fixtures.json("capability-gate.json")
        for (item in fixture["cases"]!!.arr) {
            val c = item.obj
            val local = c["local"]!!.obj
            val result = CapabilityGate.evaluate(
                c["build_includes_sdk"].bool!!,
                c["server"]!!.obj["reasons"]!!.arr.map { it.str!! },
                CapabilityGate.Local(
                    CapabilityGate.Registration.valueOf(local["registration"].str!!.uppercase()),
                    CapabilityGate.Permission.valueOf(local["permission"].str!!.uppercase()),
                    local["device_available"].bool!!,
                    CapabilityGate.Stream.valueOf(local["stream"].str!!.uppercase()),
                    local["recording"].bool!!,
                    local["was_connected"].bool ?: false,
                    local["error"].str,
                ),
            )
            val expect = c["expect"]!!.obj
            assertEquals(expect["state"].str, result.state.wire, c["name"].str)
            assertEquals(expect["reasons"]!!.arr.map { it.str }, result.reasons, c["name"].str)
            assertEquals(expect["allow_capture"].bool, result.allowCapture, c["name"].str)
            assertTrue(result.showCameraAndUpload)
        }
        for (row in fixture["status_freshness"]!!.arr) {
            assertEquals(row.obj["may_show_ready"].bool, CapabilityGate.mayShowReady(row.obj["last_status_age_seconds"].long!!))
        }
    }
}

class ErrorPolicyTest {
    @Test
    fun codesBackoffAndRefresh() {
        val fixture = Fixtures.json("error-policy.json")
        for (row in fixture["codes"]!!.arr) {
            assertEquals(row.obj["action"].str, ErrorPolicy.action(row.obj["code"].str!!).wire, row.obj["code"].str)
        }
        assertEquals(fixture["switch_endpoint_terminal_codes"]!!.arr.map { it.str }.toSet(), ErrorPolicy.switchTerminalCodes)
        val backoff = fixture["backoff"]!!.obj
        for (row in backoff["schedule_without_jitter"]!!.arr) {
            assertEquals(row.obj["delay_seconds"].long!!.toDouble(), Backoff.delaySeconds(row.obj["attempt"].int!!))
        }
        for (row in backoff["retry_after_cases"]!!.arr) {
            assertEquals(
                row.obj["delay_seconds"].long!!.toDouble(),
                Backoff.delaySeconds(row.obj["attempt"].int!!, row.obj["retry_after_seconds"].long!!.toDouble()),
            )
        }
        for (row in fixture["refresh"]!!.obj["cases"]!!.arr) {
            val r = row.obj
            val outcome = when (val o = r["outcome"].str!!) {
                "success" -> RefreshPolicy.Outcome.Success
                "network_error" -> RefreshPolicy.Outcome.NetworkError
                else -> RefreshPolicy.Outcome.Http(o.removePrefix("http_").toInt())
            }
            assertEquals(r["action"].str, RefreshPolicy.action(outcome, r["elapsed_seconds"].long!!).wire, r["name"].str)
        }
    }
}

class LocalMediaTest {
    @Test
    fun encryptedDraftsRoundTripRangesAndDetectTampering() {
        val dir = Files.createTempDirectory("atlas").toFile()
        val bytes = ByteArray(10_000) { (it % 251).toByte() }
        val plain = dir.resolve("plain").apply { writeBytes(bytes) }
        val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
        val sealed = EncryptedFile.seal(plain, dir.resolve("enc"), key, chunkSize = 1024)
        assertEquals(10_000L, sealed.byteSize)
        assertEquals(EnrollmentProof.sha256Hex(bytes), sealed.sha256Hex)
        for ((offset, length) in listOf(0 to 10_000, 1000 to 3000, 9999 to 1, 1024 to 1024)) {
            val out = dir.resolve("part-$offset")
            EncryptedFile.decryptRange(dir.resolve("enc"), offset.toLong(), length.toLong(), out, key)
            assertArrayEquals(bytes.copyOfRange(offset, offset + length), out.readBytes())
        }
        val tampered = dir.resolve("enc").readBytes().also { it[40] = (it[40].toInt() xor 0xFF).toByte() }
        dir.resolve("bad").writeBytes(tampered)
        assertThrows(EncryptedFile.Failure::class.java) { EncryptedFile.decryptRange(dir.resolve("bad"), 0, 100, dir.resolve("x"), key) }
        val other = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
        assertThrows(EncryptedFile.Failure::class.java) { EncryptedFile.decryptRange(dir.resolve("enc"), 0, 100, dir.resolve("y"), other) }
    }

    @Test
    fun clipClockCountdown() {
        val clock = ClipClock()
        assertEquals("0:07 / 1:00", clock.display(7.4).elapsedText)
        assertNull(clock.display(49.0).countdown)
        assertEquals(10, clock.display(50.0).countdown)
        assertEquals(1, clock.display(59.9).countdown)
        assertTrue(clock.display(60.0).shouldStop)
    }
}
