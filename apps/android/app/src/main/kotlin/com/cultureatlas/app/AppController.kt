package com.cultureatlas.app

import android.net.Uri
import com.cultureatlas.app.upload.UploadWorker
import com.cultureatlas.capture.core.commands.CommandRunner
import com.cultureatlas.capture.core.commands.RemoteCaptureExecutor
import com.cultureatlas.capture.core.contract.ArmRequest
import com.cultureatlas.capture.core.contract.AtlasContract
import com.cultureatlas.capture.core.contract.Capabilities
import com.cultureatlas.capture.core.contract.CreateCaptureSessionRequest
import com.cultureatlas.capture.core.contract.DeviceStatusRequest
import com.cultureatlas.capture.core.contract.MediaKind
import com.cultureatlas.capture.core.contract.MediaSource
import com.cultureatlas.capture.core.policy.CommandLocalState
import com.cultureatlas.capture.core.policy.CommandProcessor
import com.cultureatlas.capture.core.store.DraftRecord
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.io.File
import java.time.Instant
import java.util.UUID

/**
 * App state for one signed-in account: capture, drafts, uploads, arming and
 * remote commands. The Android counterpart of the iOS CaptureController,
 * implemented independently against the same fixtures.
 */
class AppController(private val graph: AppGraph) : RemoteCaptureExecutor {
    sealed interface Phase {
        data object SignedOut : Phase
        data class AwaitingEmail(val email: String) : Phase
        data class SignedIn(val accountId: String) : Phase
    }

    data class Armed(
        val sessionId: String,
        val generation: Int,
        val mode: MediaKind,
        val source: MediaSource,
        val expiresAt: Instant,
        val agents: List<String>,
    )

    private val _phase = MutableStateFlow<Phase>(Phase.SignedOut)
    val phase: StateFlow<Phase> = _phase
    private val _drafts = MutableStateFlow<List<DraftRecord>>(emptyList())
    val drafts: StateFlow<List<DraftRecord>> = _drafts
    private val _lockedDraftsExist = MutableStateFlow(false)
    val lockedDraftsExist: StateFlow<Boolean> = _lockedDraftsExist
    private val _capabilities = MutableStateFlow<Capabilities?>(null)
    val capabilities: StateFlow<Capabilities?> = _capabilities
    private val _armed = MutableStateFlow<Armed?>(null)
    val armed: StateFlow<Armed?> = _armed
    val message = MutableStateFlow<String?>(null)

    private val commands = CommandRunner(graph.api, graph.receipts, this, graph.scope)
    private var heartbeat: Job? = null
    private var armTimer: Job? = null
    private var recordingCommandId: String? = null
    private var foreground = false

    val signedInAccount: String? get() = (_phase.value as? Phase.SignedIn)?.accountId

    init {
        graph.scope.launch { graph.draftsChanged.collect { reloadDrafts() } }
    }

    suspend fun launch() {
        val account = graph.sessions.currentAccountId
        if (account != null) becomeSignedIn(account) else reloadDrafts()
    }

    // Sign-in

    suspend fun sendLink(email: String) {
        try {
            graph.accounts.startSignIn(email)
            _phase.value = Phase.AwaitingEmail(email)
            message.value = "Check your email for a sign-in link. Open it on this phone."
        } catch (e: Exception) {
            message.value = "We couldn't send the link. Check your connection and try again."
        }
    }

    suspend fun handleLink(uri: Uri) {
        try {
            val account = graph.accounts.completeSignIn(uri.toString())
            becomeSignedIn(account)
        } catch (e: Exception) {
            message.value = "That sign-in link didn't work. Request a new one."
        }
    }

    private suspend fun becomeSignedIn(account: String) {
        _phase.value = Phase.SignedIn(account)
        // Drafts waiting for this account (and only this account) resume.
        for (draft in graph.drafts.drafts(account).filter { it.status == DraftRecord.Status.LOCKED }) {
            graph.drafts.update(draft.id, account) {
                it.copy(status = if (it.uploadId == null) DraftRecord.Status.QUEUED else DraftRecord.Status.UPLOADING)
            }
        }
        graph.drafts.drafts(account).filter { it.isPending }.forEach { UploadWorker.enqueue(graph.app, it) }
        reloadDrafts()
        _capabilities.value = runCatching { graph.api.capabilities() }.getOrNull()
        commands.reconcileAfterLaunch(account)
        recoverInterruptedRecordings(account)
        if (foreground) startHeartbeat()
    }

    fun reloadDrafts() {
        val account = signedInAccount
        _drafts.value = account?.let { graph.drafts.drafts(it) } ?: emptyList()
        _lockedDraftsExist.value = graph.drafts.hasLockedDrafts(account)
    }

    // Sign-out (DraftLockPolicy.signOutOrder)

    suspend fun signOut(deleteDrafts: Boolean) {
        val account = signedInAccount ?: return
        graph.camera.stopRecording()
        graph.glasses.stopClip()
        graph.camera.stop()
        graph.glasses.stopStream()
        stopArming()
        heartbeat?.cancel()
        commands.stop()
        UploadWorker.cancelAll(graph.app, account)
        for (draft in graph.drafts.drafts(account).filter { it.isPending }) {
            graph.drafts.update(draft.id, account) { it.copy(status = DraftRecord.Status.LOCKED) }
        }
        if (deleteDrafts) graph.drafts.deleteAll(account)
        // While the session is still valid: stop ready-notice wake-ups for this phone.
        graph.notices.signingOut()
        graph.accounts.signOut()
        _phase.value = Phase.SignedOut
        reloadDrafts()
    }

    // Lifecycle and heartbeat

    fun onForeground(isForeground: Boolean) {
        foreground = isForeground
        if (signedInAccount == null) return
        graph.notices.onForeground(isForeground)
        if (isForeground) {
            startHeartbeat()
        } else {
            // Background disarms (server and local) and stops recording safely.
            graph.camera.stopRecording()
            graph.glasses.stopClip()
            _armed.value = null
            commands.stop()
            heartbeat?.cancel()
            heartbeat = null
            graph.scope.launch { runCatching { reportStatus("background") } }
        }
    }

    private fun startHeartbeat() {
        if (heartbeat?.isActive == true) return
        heartbeat = graph.scope.launch {
            while (isActive) {
                runCatching { reportStatus("foreground") }
                delay(AtlasContract.HEARTBEAT_INTERVAL_SECONDS * 1000)
            }
        }
    }

    private suspend fun reportStatus(appState: String) {
        val account = signedInAccount ?: return
        val cameraOk = graph.camera.cameraPermitted
        graph.api.reportStatus(
            DeviceStatusRequest(
                sequence = graph.vault.installations.nextStatusSequence(account),
                capabilities = mapOf("photo" to cameraOk, "video" to cameraOk),
                readiness = if (cameraOk) "ready" else "user_action_required",
                appState = appState,
            ),
        )
    }

    // Local capture

    private fun newDraft(kind: MediaKind, source: MediaSource, contentType: String, captureId: String? = null): DraftRecord? {
        val account = signedInAccount ?: return null
        return DraftRecord.new(account, kind, source, contentType, Instant.now().toString(), captureId).also { graph.drafts.save(it) }
    }

    suspend fun capturePhoto(source: MediaSource, captureId: String? = null): DraftRecord? {
        if (!graph.drafts.hasRoom(20_000_000)) {
            message.value = "Your phone is out of space. Free some space to keep capturing."
            return null
        }
        val draft = newDraft(MediaKind.PHOTO, source, "image/jpeg", captureId) ?: return null
        val plain = File(graph.drafts.draftDir(draft), "capture.tmp")
        return try {
            if (source == MediaSource.META_GLASSES) graph.glasses.capturePhoto(plain) else graph.camera.capturePhoto(plain)
            graph.drafts.ingest(plain, draft).also { reloadDrafts() }
        } catch (e: Exception) {
            graph.drafts.delete(draft)
            message.value = "The photo wasn't saved. Try again."
            null
        }
    }

    suspend fun recordClip(
        source: MediaSource,
        captureId: String? = null,
        maxSeconds: Int = AtlasContract.CLIP_MAX_SECONDS,
    ): Pair<DraftRecord?, CommandProcessor.Outcome> {
        if (!graph.drafts.hasRoom(300_000_000)) return null to CommandProcessor.Outcome.STORAGE_FULL
        val draft = newDraft(MediaKind.VIDEO, source, "video/mp4", captureId) ?: return null to CommandProcessor.Outcome.DEVICE_UNAVAILABLE
        val target = graph.drafts.recordingFile(draft)
        return try {
            val (seconds, interrupted, audio) = if (source == MediaSource.META_GLASSES) {
                val clip = graph.glasses.recordClip(target, graph.drafts.segmentDir(draft), maxSeconds)
                Triple(clip.durationSeconds, clip.interrupted, false) // glasses audio is off by default
            } else {
                val clip = graph.camera.recordClip(target, maxSeconds)
                Triple(clip.durationSeconds, clip.interrupted, clip.audioPresent)
            }
            val saved = graph.drafts.ingest(target, draft.copy(durationSeconds = seconds, interrupted = interrupted, audioPresent = audio))
            reloadDrafts()
            saved to if (interrupted) CommandProcessor.Outcome.INTERRUPTED_WITH_FILE else CommandProcessor.Outcome.SAVED
        } catch (e: com.cultureatlas.app.capture.PhoneCameraController.CameraError) {
            graph.drafts.delete(draft)
            null to if (e.reason == com.cultureatlas.app.capture.PhoneCameraController.CameraError.Reason.STORAGE_FULL) {
                CommandProcessor.Outcome.STORAGE_FULL
            } else {
                CommandProcessor.Outcome.INTERRUPTED_WITHOUT_FILE
            }
        } catch (e: Exception) {
            graph.drafts.delete(draft)
            null to CommandProcessor.Outcome.INTERRUPTED_WITHOUT_FILE
        }
    }

    fun stopRecording() {
        graph.camera.stopRecording()
        graph.glasses.stopClip()
    }

    /** Crash mid-recording: keep a non-empty file (or closed glasses segments) as an interrupted clip. */
    private fun recoverInterruptedRecordings(account: String) {
        for (draft in graph.drafts.drafts(account).filter { it.kind == MediaKind.VIDEO && it.byteSize == 0L }) {
            val target = graph.drafts.recordingFile(draft)
            val segments = graph.drafts.segmentDir(draft)
            val recovered = (target.exists() && target.length() > 0) ||
                com.cultureatlas.app.capture.SegmentedClipEncoder.recover(segments, target)
            if (recovered) graph.drafts.ingest(target, draft.copy(interrupted = true)) else graph.drafts.delete(draft)
        }
        reloadDrafts()
    }

    fun keep(draft: DraftRecord, allowCellular: Boolean = false) {
        val updated = graph.drafts.update(draft.id, draft.ownerAccountId) {
            it.copy(status = DraftRecord.Status.QUEUED, allowCellular = allowCellular)
        } ?: return
        UploadWorker.enqueue(graph.app, updated)
        reloadDrafts()
    }

    fun discard(draft: DraftRecord) {
        androidx.work.WorkManager.getInstance(graph.app).cancelUniqueWork("upload-${draft.id}")
        graph.drafts.delete(draft)
        reloadDrafts()
    }

    fun retry(draft: DraftRecord) {
        val updated = graph.drafts.update(draft.id, draft.ownerAccountId) {
            it.copy(status = if (it.uploadId == null) DraftRecord.Status.QUEUED else DraftRecord.Status.UPLOADING, attempts = 0, nextAttemptAtEpochMs = null)
        } ?: return
        UploadWorker.enqueue(graph.app, updated)
        reloadDrafts()
    }

    /** Each picked file is an independent draft; one failure never blocks siblings. */
    fun importFile(uri: Uri, mime: String?) {
        val account = signedInAccount ?: return
        val contentType = when (mime) {
            "image/jpeg", "image/png", "image/webp", "video/mp4", "video/quicktime", "video/webm" -> mime
            else -> {
                message.value = "This file type isn't supported yet. Use JPEG, PNG, WebP, MP4, MOV or WebM."
                return
            }
        }
        val kind = if (contentType.startsWith("image/")) MediaKind.PHOTO else MediaKind.VIDEO
        val draft = DraftRecord.new(account, kind, MediaSource.UPLOAD, contentType, Instant.now().toString())
            .copy(status = DraftRecord.Status.QUEUED)
        try {
            graph.drafts.save(draft)
            val plain = File(graph.drafts.draftDir(draft), "import.tmp")
            graph.app.contentResolver.openInputStream(uri)?.use { input -> plain.outputStream().use { input.copyTo(it) } }
                ?: error("unreadable")
            UploadWorker.enqueue(graph.app, graph.drafts.ingest(plain, draft))
        } catch (e: Exception) {
            graph.drafts.delete(draft)
            message.value = "That file couldn't be added."
        }
        reloadDrafts()
    }

    // Remote arming (explicit, local, at most 10 minutes; never restored)

    suspend fun arm(source: MediaSource, mode: MediaKind, minutes: Int, agents: List<String>) {
        val account = signedInAccount ?: return
        try {
            val session = graph.api.createSession(
                CreateCaptureSessionRequest(source, mode, localSessionId = UUID.randomUUID().toString()),
            )
            reportStatus("foreground") // the server arms only a fresh, ready, foreground phone
            val seconds = (minutes * 60).coerceIn(1, AtlasContract.REMOTE_ARM_MAX_SECONDS)
            val response = graph.api.arm(session.sessionId, ArmRequest(true, seconds, agents))
            val armedState = Armed(
                response.sessionId, response.generation, mode, source,
                response.remoteArmExpiresAt?.let(Instant::parse) ?: Instant.now().plusSeconds(seconds.toLong()), agents,
            )
            _armed.value = armedState
            commands.start(account)
            armTimer?.cancel()
            armTimer = graph.scope.launch {
                while (isActive) {
                    delay(1_000)
                    if (_armed.value?.expiresAt?.isBefore(Instant.now()) == true) stopArming()
                }
            }
        } catch (e: Exception) {
            message.value = "This phone couldn't be armed. Open the camera, check permissions and try again."
        }
    }

    /** Stop is always available locally; the server call is best effort. */
    suspend fun stopArming() {
        val current = _armed.value ?: return
        _armed.value = null
        armTimer?.cancel()
        commands.stop()
        runCatching { graph.api.arm(current.sessionId, ArmRequest(false, 1, emptyList())) }
        runCatching { graph.api.endSession(current.sessionId, "user_stopped") }
    }

    // RemoteCaptureExecutor

    override suspend fun localState(): CommandLocalState {
        val armedState = _armed.value
        return CommandLocalState(
            armedSessionId = armedState?.sessionId,
            armedGeneration = armedState?.generation,
            armExpiresAt = armedState?.expiresAt,
            sessionMode = armedState?.mode,
            sourceReady = if (armedState?.source == MediaSource.META_GLASSES) {
                graph.glasses.localState.value.stream == com.cultureatlas.capture.core.policy.CapabilityGate.Stream.STREAMING
            } else {
                graph.camera.running.value
            },
            recordingCommandId = recordingCommandId,
            storageOk = graph.drafts.hasRoom(300_000_000),
        )
    }

    override suspend fun draftSaved(captureId: String): Boolean {
        val account = signedInAccount ?: return false
        return graph.drafts.drafts(account).any { it.id == captureId.lowercase() && it.byteSize > 0 }
    }

    override suspend fun capturePhoto(captureId: String, commandId: String, sessionId: String): CommandProcessor.Outcome {
        val source = _armed.value?.source ?: return CommandProcessor.Outcome.DEVICE_UNAVAILABLE
        val draft = capturePhoto(source, captureId) ?: return CommandProcessor.Outcome.DEVICE_UNAVAILABLE
        queueRemote(draft, commandId, sessionId)
        return CommandProcessor.Outcome.SAVED
    }

    override suspend fun startVideo(captureId: String, commandId: String, sessionId: String, seconds: Int): CommandProcessor.Outcome {
        val source = _armed.value?.source ?: return CommandProcessor.Outcome.DEVICE_UNAVAILABLE
        recordingCommandId = commandId
        try {
            val (draft, outcome) = recordClip(source, captureId, seconds)
            draft?.let { queueRemote(it, commandId, sessionId) }
            return outcome
        } finally {
            recordingCommandId = null
        }
    }

    override suspend fun stopVideo() = stopRecording()

    override suspend fun resultAssetId(captureId: String): String? {
        val account = signedInAccount ?: return null
        graph.uploadEngine.run(captureId.lowercase(), account)
        return graph.drafts.drafts(account).firstOrNull { it.id == captureId.lowercase() }?.assetId
    }

    /** Remote captures were requested while armed: they upload after the local save. */
    private fun queueRemote(draft: DraftRecord, commandId: String, sessionId: String) {
        graph.drafts.update(draft.id, draft.ownerAccountId) {
            it.copy(status = DraftRecord.Status.QUEUED, captureSessionId = sessionId, commandId = commandId)
        }?.let { UploadWorker.enqueue(graph.app, it) }
    }

    suspend fun agentNames() = runCatching { graph.api.agentConnections().connections }.getOrNull()
}
