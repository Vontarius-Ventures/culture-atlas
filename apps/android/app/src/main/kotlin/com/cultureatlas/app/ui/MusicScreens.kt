package com.cultureatlas.app.ui

import android.Manifest
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.RadioButton
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.cultureatlas.app.AppGraph
import com.cultureatlas.capture.core.policy.AudioPolicy
import com.cultureatlas.capture.core.policy.CapabilityGate
import com.cultureatlas.capture.core.policy.ClipClock
import com.cultureatlas.capture.core.store.DraftRecord
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Screen 19: Music Mode recorder. Audio-only. Never starts CameraX or a
 * camera preview. Microphone permission only.
 */
@Composable
fun MusicScreen(graph: AppGraph, onBack: () -> Unit) {
    val controller = graph.controller
    val capabilities by controller.capabilities.collectAsState()
    val musicMatch = CapabilityGate.musicMatch(capabilities)
    val audio = graph.audio
    val recording by audio.recording.collectAsState()
    val captureState by audio.state.collectAsState()
    val routes by audio.routes.collectAsState()
    val selected by audio.selected.collectAsState()
    val amplitude by audio.amplitude.collectAsState()
    var startedAt by remember { mutableStateOf<Long?>(null) }
    var elapsed by remember { mutableStateOf(0.0) }
    var review by remember { mutableStateOf<DraftRecord?>(null) }
    var kept by remember { mutableStateOf<DraftRecord?>(null) }
    val scope = rememberCoroutineScope()
    val clock = remember { ClipClock(limitSeconds = AudioPolicy.MAX_SECONDS) }
    // System Back matches the Back button: a recording in progress is never abandoned by a swipe.
    BackHandler { if (!recording) onBack() }
    val micPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) {
            audio.refreshRoutes()
        } else {
            controller.message.value = AudioPolicy.MICROPHONE_RATIONALE
        }
    }
    val importer = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri != null) {
            val type = graph.app.contentResolver.getType(uri)
            controller.importFile(uri, type)
        }
    }
    LaunchedEffect(Unit) { audio.refreshRoutes() }
    LaunchedEffect(recording) {
        while (recording) {
            audio.peekAmplitude()
            delay(100)
        }
    }
    LaunchedEffect(startedAt) {
        while (startedAt != null) {
            elapsed = (System.currentTimeMillis() - startedAt!!) / 1000.0
            delay(250)
        }
    }
    val display = clock.display(elapsed)
    val stateText = when (captureState) {
        AudioPolicy.CaptureState.RECORDING -> AudioPolicy.RECORDING_LABEL
        AudioPolicy.CaptureState.FINALIZING -> AudioPolicy.FINALIZING_LABEL
        AudioPolicy.CaptureState.PERMISSION_REQUESTED -> "Microphone permission needed"
        AudioPolicy.CaptureState.ROUTE_CHECK -> "Checking the microphone in use"
        AudioPolicy.CaptureState.LOCAL_DRAFT -> "Saved on this phone"
        AudioPolicy.CaptureState.IDLE -> AudioPolicy.IDLE_LABEL
    }
    val levelPercent = ((amplitude / 32767f) * 100f).toInt().coerceIn(0, 100)
    Column(
        Modifier.padding(16.dp).verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            TextButton(onClick = { if (!recording) onBack() }) { Text("Back") }
            Text(
                AudioPolicy.CAMERA_OFF_LABEL,
                color = AtlasColors.olive,
                modifier = Modifier.semantics { contentDescription = "Camera off. Music Mode does not use the camera." },
            )
        }
        Text("Music", style = MaterialTheme.typography.headlineSmall.copy(fontFamily = FontFamily.Serif))
        Text("Keep a little of what you hear.", color = AtlasColors.muted)
        Text(AudioPolicy.MICROPHONE_RATIONALE, color = AtlasColors.muted)
        Text("Microphone", style = MaterialTheme.typography.titleMedium)
        if (!AudioPolicy.glassesMicrophoneAvailable(selected?.verifiedGlasses == true)) {
            Text(AudioPolicy.GLASSES_UNAVAILABLE, color = AtlasColors.muted)
        }
        if (routes.isEmpty()) {
            Text("This phone", color = AtlasColors.ink)
        } else {
            routes.forEach { route ->
                Row(
                    Modifier
                        .fillMaxWidth()
                        .heightIn(min = 48.dp)
                        .selectable(selected = selected?.id == route.id, enabled = !recording) { audio.select(route) },
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    RadioButton(selected = selected?.id == route.id, onClick = null, enabled = !recording)
                    Text(route.label, Modifier.padding(start = 8.dp))
                }
            }
        }
        selected?.let { Text("Input in use: ${it.label}. Route: ${it.wire}.", color = AtlasColors.muted) }
        LevelMeter(levelPercent = levelPercent, recording = recording)
        Text(
            if (startedAt != null) "${display.elapsedText}" else "0:00 / 2:00",
            style = MaterialTheme.typography.headlineMedium,
            modifier = Modifier.semantics {
                liveRegion = LiveRegionMode.Polite
                contentDescription = if (recording) display.spokenText else "Elapsed time 0 of 2 minutes. Not recording. Camera off."
            },
        )
        Text(
            "$stateText. ${AudioPolicy.CAMERA_OFF_LABEL}.",
            modifier = Modifier.semantics {
                liveRegion = LiveRegionMode.Polite
                contentDescription = captureState.spoken
            },
        )
        if (recording) {
            Button(
                onClick = { controller.stopRecording() },
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).semantics {
                    contentDescription = "Stop recording audio. Camera is off."
                },
            ) { Text(AudioPolicy.STOP_LABEL) }
        } else {
            Button(
                onClick = {
                    if (!audio.microphonePermitted) {
                        micPermission.launch(Manifest.permission.RECORD_AUDIO)
                    } else {
                        scope.launch {
                            startedAt = System.currentTimeMillis()
                            elapsed = 0.0
                            review = controller.recordAudio()
                            startedAt = null
                        }
                    }
                },
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).semantics {
                    contentDescription = "Start recording audio. Camera stays off. Microphone permission only."
                },
            ) { Text(AudioPolicy.RECORD_LABEL) }
        }
        Text(AudioPolicy.SPEECH_OFF_COPY, color = AtlasColors.muted)
        OutlinedButton(
            onClick = { importer.launch("audio/*") },
            enabled = !recording,
            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
        ) { Text("Upload an audio file") }
        kept?.let { draft ->
            Text(AudioPolicy.KEEP_COPY)
            if (musicMatch.available) {
                Button(
                    onClick = {
                        scope.launch {
                            controller.exploreMusic(draft)
                            kept = null
                            onBack()
                        }
                    },
                    modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
                ) { Text(AudioPolicy.EXPLORE_LABEL) }
            } else {
                Text(musicMatch.message, color = AtlasColors.muted)
            }
            TextButton(onClick = { kept = null; onBack() }) { Text("Stay on this phone") }
        }
    }
    review?.let { draft ->
        AudioReviewDialog(
            onKeep = {
                controller.keep(draft)
                review = null
                kept = draft.copy(status = DraftRecord.Status.KEPT_LOCAL)
            },
            onDelete = {
                controller.discard(draft)
                review = null
            },
            interrupted = draft.interrupted,
            routeLabel = selected?.label ?: "This phone",
        )
    }
}

@Composable
private fun LevelMeter(levelPercent: Int, recording: Boolean) {
    val bars = 16
    val active = ((levelPercent / 100f) * bars).toInt()
    Row(
        Modifier
            .fillMaxWidth()
            .height(48.dp)
            .semantics {
                contentDescription = if (recording) {
                    "Microphone level $levelPercent percent. Recording audio. Camera off."
                } else {
                    "Microphone level meter. Not recording. Camera off."
                }
            },
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalAlignment = Alignment.Bottom,
    ) {
        repeat(bars) { index ->
            Box(
                Modifier
                    .width(12.dp)
                    .height((((index + 1) / bars.toFloat()) * 48).dp)
                    .background(if (index < active) AtlasColors.olive else AtlasColors.line),
            )
        }
    }
}

@Composable
private fun AudioReviewDialog(onKeep: () -> Unit, onDelete: () -> Unit, interrupted: Boolean, routeLabel: String) {
    AlertDialog(
        onDismissRequest = onDelete,
        title = { Text("Keep this recording?") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Recorded with $routeLabel. Camera stayed off.")
                Text(AudioPolicy.KEEP_COPY)
                if (interrupted) Text("Recording was interrupted. The part before the interruption was kept.")
            }
        },
        confirmButton = { Button(onClick = onKeep) { Text("Keep") } },
        dismissButton = { TextButton(onClick = onDelete) { Text("Delete") } },
    )
}
