package com.cultureatlas.app.ui

import android.Manifest
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.view.PreviewView
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import com.cultureatlas.app.AppController
import com.cultureatlas.app.AppGraph
import com.cultureatlas.app.notify.ReadyNoticeCenter
import com.cultureatlas.capture.core.contract.AgentConnection
import com.cultureatlas.capture.core.contract.MediaKind
import com.cultureatlas.capture.core.contract.MediaSource
import com.cultureatlas.capture.core.policy.CapabilityGate
import com.cultureatlas.capture.core.policy.ClipClock
import com.cultureatlas.capture.core.store.DraftRecord
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@Composable
fun LibraryScreen(controller: AppController, notices: ReadyNoticeCenter) {
    val drafts by controller.drafts.collectAsState()
    val locked by controller.lockedDraftsExist.collectAsState()
    LazyColumn(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item {
            Text("Library", style = MaterialTheme.typography.headlineMedium.copy(fontFamily = FontFamily.Serif))
            Text("Your library is private. Choose what to explore.", color = AtlasColors.muted)
            Text("Uploading does not start analysis.", color = AtlasColors.muted)
        }
        if (drafts.isEmpty()) item { Text("Nothing here yet. Take a photo or video, or upload files from your phone.") }
        items(drafts, key = { it.id }) { DraftRow(controller, notices, it) }
        if (locked) item { LockedDraftsNotice() }
    }
}

@Composable
private fun DraftRow(controller: AppController, notices: ReadyNoticeCenter, draft: DraftRecord) {
    val exploring by notices.exploring.collectAsState()
    val scope = rememberCoroutineScope()
    // Asked at the moment of use: the user just chose to explore a photo.
    val askNotifications = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {}
    Column(Modifier.fillMaxWidth().semantics(mergeDescendants = true) {}) {
        Row {
            Text(if (draft.kind == MediaKind.PHOTO) "Photo" else "Video", Modifier.padding(end = 8.dp))
            draft.durationSeconds?.let { Text(ClipClock.clock(it.toInt()), color = AtlasColors.muted) }
        }
        // Status is always in words, never colour alone.
        Text("${sourceText(draft.source)} · ${statusText(draft)}", color = AtlasColors.muted)
        if (draft.interrupted) Text("Recording was interrupted. The part before the interruption was kept.")
        when (draft.status) {
            DraftRecord.Status.AWAITING_REVIEW -> Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = { controller.keep(draft) }) { Text("Keep") }
                OutlinedButton(onClick = { controller.discard(draft) }) { Text(if (draft.kind == MediaKind.PHOTO) "Retake" else "Delete") }
            }
            DraftRecord.Status.QUEUED -> if (!draft.allowCellular) {
                TextButton(onClick = { controller.keep(draft, allowCellular = true) }) { Text("Upload using mobile data") }
            }
            DraftRecord.Status.COMMITTED -> {
                val assetId = draft.assetId
                if (draft.kind == MediaKind.PHOTO && assetId != null) {
                    // The user starts exploring; screen 17 tells them when it is ready.
                    if (assetId.lowercase() in exploring) {
                        Text(
                            "Looking at your photo. This takes a few seconds.",
                            color = AtlasColors.muted,
                            modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                        )
                    } else {
                        TextButton(onClick = {
                            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU) {
                                askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
                            }
                            scope.launch {
                                if (!notices.explore(assetId)) {
                                    controller.message.value = "Exploring isn't available right now. Your photo is safe in your library."
                                }
                            }
                        }) { Text("Explore this photo") }
                    }
                }
            }
            DraftRecord.Status.FAILED, DraftRecord.Status.REJECTED -> Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (draft.status == DraftRecord.Status.FAILED) Button(onClick = { controller.retry(draft) }) { Text("Retry") }
                OutlinedButton(onClick = { controller.discard(draft) }) { Text("Delete from this phone") }
            }
            else -> Unit
        }
        HorizontalDivider(Modifier.padding(top = 8.dp))
    }
}

private fun sourceText(source: MediaSource) = when (source) {
    MediaSource.PHONE_CAMERA -> "This camera"
    MediaSource.META_GLASSES -> "Meta glasses (Experimental)"
    MediaSource.UPLOAD -> "Uploaded file"
}

private fun statusText(draft: DraftRecord) = when (draft.status) {
    DraftRecord.Status.AWAITING_REVIEW -> "Not kept yet"
    DraftRecord.Status.QUEUED -> if (draft.allowCellular) "Waiting to upload" else "Waiting for Wi-Fi"
    DraftRecord.Status.UPLOADING -> "Uploading"
    DraftRecord.Status.VERIFYING -> "Checking on the server"
    DraftRecord.Status.COMMITTED -> "In your library"
    DraftRecord.Status.LOCKED -> "Waiting for its account"
    DraftRecord.Status.REJECTED -> "Not accepted"
    DraftRecord.Status.FAILED -> "Upload paused"
}

/** Screen 02: This camera, Meta glasses (Experimental), Upload files. */
@Composable
fun CaptureSourceScreen(controller: AppController, onCamera: () -> Unit, onGlasses: () -> Unit) {
    val capabilities by controller.capabilities.collectAsState()
    val camera = CapabilityGate.phoneCamera(capabilities)
    val context = androidx.compose.ui.platform.LocalContext.current
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(20)) { uris ->
        uris.forEach { uri -> controller.importFile(uri, context.contentResolver.getType(uri)) }
    }
    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Keep what catches your eye.", style = MaterialTheme.typography.headlineSmall.copy(fontFamily = FontFamily.Serif))
        Text("Your library is private. Choose what to explore.", color = AtlasColors.muted)
        Button(onClick = onCamera, enabled = camera.photo || camera.video, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
            Text("This camera")
        }
        OutlinedButton(onClick = onGlasses, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
            Text("Meta glasses · Experimental")
        }
        OutlinedButton(
            onClick = { picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageAndVideo)) },
            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
        ) { Text("Upload files") }
        Text("Uploading does not start analysis.", color = AtlasColors.muted)
    }
}

/** Screen 03: preview, photo/video, microphone state, elapsed/limit + countdown, Stop, Keep review. */
@Composable
fun CameraScreen(graph: AppGraph, activity: ComponentActivity, onBack: () -> Unit) {
    val controller = graph.controller
    val camera = graph.camera
    val running by camera.running.collectAsState()
    val recording by camera.recording.collectAsState()
    val microphoneOn by camera.microphoneOn.collectAsState()
    val armed by controller.armed.collectAsState()
    val capabilities by controller.capabilities.collectAsState()
    var mode by remember { mutableStateOf(MediaKind.PHOTO) }
    var startedAt by remember { mutableStateOf<Long?>(null) }
    var elapsed by remember { mutableStateOf(0.0) }
    var review by remember { mutableStateOf<DraftRecord?>(null) }
    var showArm by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val cameraPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) scope.launch { runCatching { camera.start(activity) } } else {
            controller.message.value = "Camera access is off. Turn it on in Settings, or upload files instead."
        }
    }
    val micPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        camera.setMicrophone(granted)
    }
    LaunchedEffect(Unit) {
        if (camera.cameraPermitted) runCatching { camera.start(activity) } else cameraPermission.launch(Manifest.permission.CAMERA)
    }
    LaunchedEffect(startedAt) {
        while (startedAt != null) {
            elapsed = (System.currentTimeMillis() - startedAt!!) / 1000.0
            delay(500)
        }
    }
    Column(Modifier.padding(16.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        TextButton(onClick = { if (!recording) { camera.stop(); onBack() } }) { Text("Back") }
        AndroidView(
            factory = { PreviewView(it).also { view -> camera.preview.setSurfaceProvider(view.surfaceProvider) } },
            modifier = Modifier.fillMaxWidth().aspectRatio(3f / 4f).semantics { contentDescription = "Camera preview" },
        )
        startedAt?.let {
            val display = ClipClock().display(elapsed)
            Text(
                "Recording on this phone · ${display.elapsedText}" + (display.countdown?.let { left -> " · $left s left" } ?: ""),
                modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite; contentDescription = display.spokenText },
            )
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = { mode = MediaKind.PHOTO }, enabled = !recording) { Text(if (mode == MediaKind.PHOTO) "Photo ✓" else "Photo") }
            OutlinedButton(onClick = { mode = MediaKind.VIDEO }, enabled = !recording && capabilities?.flag("camera_video") == true) {
                Text(if (mode == MediaKind.VIDEO) "Video ✓" else "Video")
            }
        }
        if (mode == MediaKind.VIDEO) {
            Row {
                Text(if (microphoneOn) "Microphone on" else "Microphone off", Modifier.padding(end = 12.dp))
                Switch(
                    checked = microphoneOn,
                    enabled = !recording,
                    onCheckedChange = { on ->
                        if (on && !camera.setMicrophone(true)) micPermission.launch(Manifest.permission.RECORD_AUDIO) else camera.setMicrophone(on)
                    },
                )
            }
            if (!microphoneOn) Text("Video records without sound.", color = AtlasColors.muted)
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = { runCatching { camera.flip() } }, enabled = !recording) { Text("Flip camera") }
            when {
                mode == MediaKind.PHOTO -> Button(onClick = { scope.launch { review = controller.capturePhoto(MediaSource.PHONE_CAMERA) } }, enabled = running) {
                    Text("Take photo")
                }
                recording -> Button(onClick = { controller.stopRecording() }) { Text("Stop") }
                else -> Button(
                    onClick = {
                        scope.launch {
                            startedAt = System.currentTimeMillis()
                            review = controller.recordClip(MediaSource.PHONE_CAMERA).first
                            startedAt = null
                        }
                    },
                    enabled = running,
                ) { Text("Record video") }
            }
        }
        Row {
            Text("Allow remote capture", Modifier.padding(end = 12.dp))
            Switch(
                checked = armed != null,
                enabled = running,
                onCheckedChange = { on -> if (on) showArm = true else scope.launch { controller.stopArming() } },
            )
        }
    }
    review?.let { ReviewDialog(controller, it) { review = null } }
    if (showArm) RemoteArmDialog(controller, MediaSource.PHONE_CAMERA) { showArm = false }
}

@Composable
fun ReviewDialog(controller: AppController, draft: DraftRecord, onDone: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDone,
        title = { Text(if (draft.kind == MediaKind.PHOTO) "Keep this photo?" else "Keep this video?") },
        text = {
            Column {
                Text("Saved on this phone. Keeping it uploads it to your private library.")
                if (draft.interrupted) Text("Recording was interrupted. The part before the interruption was kept.")
            }
        },
        confirmButton = { Button(onClick = { controller.keep(draft); onDone() }) { Text("Keep") } },
        dismissButton = {
            TextButton(onClick = { controller.discard(draft); onDone() }) {
                Text(if (draft.kind == MediaKind.PHOTO) "Retake" else "Delete")
            }
        },
    )
}

/** Local permission: duration (<= 10 min) and individually chosen agents; nothing preselected. */
@Composable
fun RemoteArmDialog(controller: AppController, source: MediaSource, onDone: () -> Unit) {
    var minutes by remember { mutableStateOf(10) }
    var mode by remember { mutableStateOf(MediaKind.PHOTO) }
    var agents by remember { mutableStateOf<List<AgentConnection>?>(null) }
    var selected by remember { mutableStateOf(setOf<String>()) }
    val scope = rememberCoroutineScope()
    LaunchedEffect(Unit) { agents = controller.agentNames() ?: emptyList() }
    AlertDialog(
        onDismissRequest = onDone,
        title = { Text("Request capture while I allow it") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Allow selected devices and agents to request capture for 10 minutes")
                Text("Capture also requires permission on your phone.", color = AtlasColors.muted)
                Row {
                    OutlinedButton(onClick = { mode = MediaKind.PHOTO }) { Text(if (mode == MediaKind.PHOTO) "Photos ✓" else "Photos") }
                    OutlinedButton(onClick = { mode = MediaKind.VIDEO }) { Text(if (mode == MediaKind.VIDEO) "Videos ✓" else "Videos") }
                }
                Row {
                    TextButton(onClick = { minutes = (minutes - 1).coerceAtLeast(1) }) { Text("−") }
                    Text("For $minutes minutes", Modifier.padding(12.dp))
                    TextButton(onClick = { minutes = (minutes + 1).coerceAtMost(10) }) { Text("+") }
                }
                val list = agents
                if (list != null && list.isEmpty()) {
                    Text("Choose which agents can ask for capture in Settings → Agents on the web, then try again.")
                }
                list.orEmpty().filter { "devices:command" in it.scopes }.forEach { agent ->
                    Row {
                        Checkbox(
                            checked = agent.id in selected,
                            onCheckedChange = { on -> selected = if (on) selected + agent.id else selected - agent.id },
                        )
                        Text(agent.clientName, Modifier.padding(top = 12.dp))
                    }
                }
            }
        },
        confirmButton = {
            Button(
                enabled = selected.isNotEmpty(),
                onClick = { scope.launch { controller.arm(source, mode, minutes, selected.toList()); onDone() } },
            ) { Text("Allow") }
        },
        dismissButton = { TextButton(onClick = onDone) { Text("Cancel") } },
    )
}

/** Screens 04/05/09 for the Experimental glasses path. */
@Composable
fun GlassesScreen(graph: AppGraph, activity: ComponentActivity, onBack: () -> Unit, onUseCamera: () -> Unit) {
    val controller = graph.controller
    val glasses = graph.glasses
    val local by glasses.localState.collectAsState()
    val preview by glasses.preview.collectAsState()
    val capabilities by controller.capabilities.collectAsState()
    val armed by controller.armed.collectAsState()
    var review by remember { mutableStateOf<DraftRecord?>(null) }
    var showArm by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val result = CapabilityGate.evaluate(
        glasses.buildIncludesSdk,
        capabilities?.availability?.get("meta_glasses")?.reasons ?: listOf("temporarily_disabled"),
        local,
    )
    fun perform(work: suspend () -> Unit) = scope.launch {
        try {
            work()
        } catch (e: Exception) {
            controller.message.value = "That didn't work. Check that Meta AI is installed and your glasses are nearby, then try again."
        }
    }
    Column(Modifier.padding(16.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        TextButton(onClick = onBack) { Text("Back") }
        Text("Meta glasses · Experimental", style = MaterialTheme.typography.headlineSmall.copy(fontFamily = FontFamily.Serif))
        Text(stateText(result.state), Modifier.semantics { liveRegion = LiveRegionMode.Polite })
        Text(
            "Glasses capture is tested on a limited set of devices and app releases. Some glasses models may not support every function. Your camera and uploads always work without glasses.",
            color = AtlasColors.muted,
        )
        when (result.state) {
            CapabilityGate.GlassesState.UNAVAILABLE -> {
                Text("Glasses capture is not enabled for this app release. Your camera and uploads are ready to use.")
                result.reasons.forEach { Text("• ${reasonText(it)}") }
                Button(onClick = onUseCamera) { Text("Use this camera") }
            }
            CapabilityGate.GlassesState.NOT_CONNECTED, CapabilityGate.GlassesState.DISCONNECTED, CapabilityGate.GlassesState.ERROR -> {
                Button(onClick = { perform { glasses.startRegistration(activity) } }) { Text("Connect with Meta AI") }
                if (result.state == CapabilityGate.GlassesState.DISCONNECTED) {
                    Text("Your glasses disconnected. Recordings in progress were saved up to the disconnection.")
                }
            }
            CapabilityGate.GlassesState.REGISTERING -> Text("Finish connecting in the Meta AI app, then return here.")
            CapabilityGate.GlassesState.AWAITING_PERMISSION -> {
                Text("Connected glasses still need camera permission in Meta AI.")
                Button(onClick = { perform { glasses.ensureCameraPermission(activity) } }) { Text("Allow camera in Meta AI") }
            }
            CapabilityGate.GlassesState.CONNECTING -> Button(onClick = { perform { glasses.startStream() } }) { Text("Start preview") }
            CapabilityGate.GlassesState.READY, CapabilityGate.GlassesState.RECORDING -> {
                preview?.let { Image(it.asImageBitmap(), contentDescription = "Glasses preview", modifier = Modifier.fillMaxWidth()) }
                Text("Audio is off for glasses capture.", color = AtlasColors.muted)
                Button(enabled = result.allowCapture && !local.recording, onClick = { perform { review = controller.capturePhoto(MediaSource.META_GLASSES) } }) {
                    Text("Take test photo")
                }
                if (local.recording) {
                    Button(onClick = { controller.stopRecording() }) { Text("Stop") }
                } else {
                    OutlinedButton(onClick = { perform { review = controller.recordClip(MediaSource.META_GLASSES).first } }) { Text("Record video") }
                }
                Row {
                    Text("Allow remote capture", Modifier.padding(end = 12.dp))
                    Switch(checked = armed != null, onCheckedChange = { on -> if (on) showArm = true else scope.launch { controller.stopArming() } })
                }
                OutlinedButton(onClick = { perform { glasses.unregister(activity) } }) { Text("Disconnect glasses") }
            }
        }
    }
    review?.let { ReviewDialog(controller, it) { review = null } }
    if (showArm) RemoteArmDialog(controller, MediaSource.META_GLASSES) { showArm = false }
}

private fun stateText(state: CapabilityGate.GlassesState) = when (state) {
    CapabilityGate.GlassesState.UNAVAILABLE -> "Unavailable"
    CapabilityGate.GlassesState.NOT_CONNECTED -> "Not connected"
    CapabilityGate.GlassesState.REGISTERING -> "Connecting with Meta AI"
    CapabilityGate.GlassesState.AWAITING_PERMISSION -> "Waiting for camera permission"
    CapabilityGate.GlassesState.CONNECTING -> "Connecting"
    CapabilityGate.GlassesState.READY -> "Ready"
    CapabilityGate.GlassesState.RECORDING -> "Recording"
    CapabilityGate.GlassesState.DISCONNECTED -> "Disconnected"
    CapabilityGate.GlassesState.ERROR -> "Needs attention: update the glasses software in Meta AI"
}

/** Screen 09: each reason explained separately. */
private fun reasonText(reason: String) = when (reason) {
    "build_unsupported" -> "This version of the app doesn't include glasses support."
    "release_channel_ineligible" -> "Glasses capture isn't permitted in this app release yet."
    "rollout_unavailable" -> "Glasses capture isn't available for your account yet."
    "device_unsupported" -> "This phone or glasses model isn't supported yet."
    "temporarily_disabled" -> "Glasses capture is temporarily turned off."
    else -> "Glasses capture is unavailable."
}

@Composable
fun SettingsScreen(controller: AppController, onGlasses: () -> Unit, onTaste: () -> Unit) {
    var confirm by remember { mutableStateOf(false) }
    val drafts by controller.drafts.collectAsState()
    val pending = drafts.count { it.status != DraftRecord.Status.COMMITTED }
    val scope = rememberCoroutineScope()
    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Settings", style = MaterialTheme.typography.headlineMedium.copy(fontFamily = FontFamily.Serif))
        OutlinedButton(onClick = onGlasses) { Text("Meta glasses (Experimental)") }
        // Screen 18: picks grouped by category, add more, exclusions.
        OutlinedButton(onClick = onTaste) { Text(com.cultureatlas.capture.core.onboarding.OnboardingCopy.TASTE_TITLE) }
        Text("Uploads use Wi-Fi unless you choose mobile data for an item.", color = AtlasColors.muted)
        Button(onClick = { confirm = true }) { Text("Sign out or switch account") }
    }
    if (confirm) {
        AlertDialog(
            onDismissRequest = { confirm = false },
            title = { Text("Sign out") },
            text = {
                Text(
                    if (pending == 0) {
                        "Capture and remote access stop on this phone."
                    } else {
                        "$pending item(s) haven't finished uploading. Kept items stay encrypted on this phone and only appear again after you sign back in to this account."
                    },
                )
            },
            confirmButton = { Button(onClick = { confirm = false; scope.launch { controller.signOut(deleteDrafts = false) } }) { Text("Keep on this device") } },
            dismissButton = { TextButton(onClick = { confirm = false; scope.launch { controller.signOut(deleteDrafts = true) } }) { Text("Delete local drafts") } },
        )
    }
}
