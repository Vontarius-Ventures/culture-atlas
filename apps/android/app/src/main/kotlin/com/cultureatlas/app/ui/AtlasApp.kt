package com.cultureatlas.app.ui

import androidx.activity.ComponentActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.lightColorScheme
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.cultureatlas.app.AppController
import com.cultureatlas.app.AppGraph
import com.cultureatlas.app.notify.AtlasMessagingService
import com.cultureatlas.app.onboarding.OnboardingController
import com.cultureatlas.capture.core.notify.ReadyNoticeCopy
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.time.Duration
import java.time.Instant

/** specs/capture-platform-v2/design/tokens.css */
object AtlasColors {
    val paper = Color(0xFFF8F6F1)
    val ink = Color(0xFF252823)
    val muted = Color(0xFF606459)
    val olive = Color(0xFF566347)
    val quiet = Color(0xFFEEEAE2)
    val line = Color(0xFFDCDDD3)
}

enum class Tab { LIBRARY, CAPTURE, SETTINGS }

@Composable
fun AtlasApp(graph: AppGraph, activity: ComponentActivity) {
    val controller = graph.controller
    val phase by controller.phase.collectAsState()
    val message by controller.message.collectAsState()
    MaterialTheme(
        colorScheme = lightColorScheme(
            primary = AtlasColors.olive, background = AtlasColors.paper, surface = AtlasColors.paper,
            onBackground = AtlasColors.ink, onSurface = AtlasColors.ink,
        ),
    ) {
        val gate by graph.onboarding.gate.collectAsState()
        val sessionEnded by graph.onboarding.sessionEnded.collectAsState()
        LaunchedEffect(phase) {
            if (phase is AppController.Phase.SignedIn) {
                val flag = runCatching { graph.api.capabilities() }.getOrNull()?.flag("onboarding_required") ?: true
                graph.onboarding.evaluate(flag)
                AtlasMessagingService.registerCurrentToken(graph.app, graph.notices)
            } else {
                graph.onboarding.reset()
            }
        }
        LaunchedEffect(sessionEnded) { if (sessionEnded) controller.signOut(deleteDrafts = false) }
        Box(Modifier.fillMaxSize()) {
            when (phase) {
                is AppController.Phase.SignedIn -> when (gate) {
                    OnboardingController.Gate.CHECKING -> Box(Modifier.fillMaxSize().background(AtlasColors.paper))
                    // Screen 14: required after sign-up, no bottom navigation.
                    OnboardingController.Gate.ONBOARDING -> OnboardingFlowScreen(graph.onboarding)
                    OnboardingController.Gate.BUILDING -> BuildingFeedScreen(graph.onboarding)
                    OnboardingController.Gate.RETRY -> {
                        val scope = rememberCoroutineScope()
                        OnboardingRetryScreen {
                            scope.launch {
                                val flag = runCatching { graph.api.capabilities() }.getOrNull()?.flag("onboarding_required") ?: true
                                graph.onboarding.evaluate(flag)
                            }
                        }
                    }
                    OnboardingController.Gate.DONE -> SignedInShell(graph, activity)
                }
                else -> SignInScreen(controller)
            }
            val toast by graph.notices.toast.collectAsState()
            toast?.let { t ->
                Box(Modifier.align(Alignment.BottomCenter).padding(bottom = 72.dp)) {
                    ReadyToastBar(
                        ReadyNoticeCopy.TITLE, ReadyNoticeCopy.OPEN, ReadyNoticeCopy.DISMISS,
                        onOpen = { graph.notices.open(t.resultPath) },
                        onDismiss = { graph.notices.dismissToast() },
                    )
                }
            }
        }
        val onboardingMessage by graph.onboarding.message.collectAsState()
        onboardingMessage?.let { text ->
            AlertDialog(
                onDismissRequest = { graph.onboarding.message.value = null },
                confirmButton = { TextButton(onClick = { graph.onboarding.message.value = null }) { Text("OK") } },
                text = { Text(text) },
            )
        }
        message?.let { text ->
            AlertDialog(
                onDismissRequest = { controller.message.value = null },
                confirmButton = { TextButton(onClick = { controller.message.value = null }) { Text("OK") } },
                text = { Text(text) },
            )
        }
    }
}

@Composable
private fun SignedInShell(graph: AppGraph, activity: ComponentActivity) {
    var tab by remember { mutableStateOf(Tab.LIBRARY) }
    var subScreen by remember { mutableStateOf<String?>(null) }
    val armed by graph.controller.armed.collectAsState()
    Scaffold(
        topBar = { armed?.let { RemoteArmBanner(graph.controller, it) } },
        bottomBar = {
            // Camera screens suppress the bottom bar (SCREEN-CONTRACT).
            if (subScreen == null) {
                NavigationBar(containerColor = AtlasColors.quiet) {
                    NavigationBarItem(selected = tab == Tab.LIBRARY, onClick = { tab = Tab.LIBRARY }, icon = {}, label = { Text("Library") })
                    NavigationBarItem(selected = tab == Tab.CAPTURE, onClick = { tab = Tab.CAPTURE }, icon = {}, label = { Text("Capture") })
                    NavigationBarItem(selected = tab == Tab.SETTINGS, onClick = { tab = Tab.SETTINGS }, icon = {}, label = { Text("Settings") })
                }
            }
        },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize().background(AtlasColors.paper)) {
            when (subScreen) {
                "camera" -> CameraScreen(graph, activity, onBack = { subScreen = null })
                "music" -> MusicScreen(graph, onBack = { subScreen = null })
                "glasses" -> GlassesScreen(graph, activity, onBack = { subScreen = null }, onUseCamera = { subScreen = "camera" })
                "taste" -> TasteSettingsScreen(graph.onboarding, onBack = { subScreen = null })
                else -> when (tab) {
                    Tab.LIBRARY -> LibraryScreen(graph.controller, graph.notices)
                    Tab.CAPTURE -> CaptureSourceScreen(
                        graph.controller,
                        onCamera = { subScreen = "camera" },
                        onMusic = { subScreen = "music" },
                        onGlasses = { subScreen = "glasses" },
                    )
                    Tab.SETTINGS -> SettingsScreen(graph.controller, onGlasses = { subScreen = "glasses" }, onTaste = { subScreen = "taste" })
                }
            }
        }
    }
}

@Composable
private fun SignInScreen(controller: AppController) {
    var email by remember { mutableStateOf("") }
    var sending by remember { mutableStateOf(false) }
    val phase by controller.phase.collectAsState()
    val locked by controller.lockedDraftsExist.collectAsState()
    val scope = rememberCoroutineScope()
    Column(
        Modifier.fillMaxSize().background(AtlasColors.paper).padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text("culture atlas", style = MaterialTheme.typography.headlineLarge.copy(fontFamily = FontFamily.Serif))
        Text("Keep what catches your eye.", style = MaterialTheme.typography.titleLarge.copy(fontFamily = FontFamily.Serif))
        Text("Sign in with your email to capture and keep photos and videos in your private library.", color = AtlasColors.muted)
        OutlinedTextField(value = email, onValueChange = { email = it }, label = { Text("Email address") }, modifier = Modifier.fillMaxWidth())
        Button(
            onClick = { sending = true; scope.launch { controller.sendLink(email.trim()); sending = false } },
            enabled = !sending && email.contains('@'),
            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
        ) { Text(if (sending) "Sending…" else "Email me a sign-in link") }
        (phase as? AppController.Phase.AwaitingEmail)?.let {
            Text(
                "We sent a link to ${it.email} if it can sign in. Open it on this phone.",
                modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
            )
        }
        if (locked) LockedDraftsNotice()
    }
}

@Composable
fun LockedDraftsNotice() {
    Text(
        "Some captures on this phone belong to another account. Sign in to that account to see and upload them.",
        color = AtlasColors.muted,
        style = MaterialTheme.typography.bodySmall,
    )
}

@Composable
private fun RemoteArmBanner(controller: AppController, armed: AppController.Armed) {
    var left by remember { mutableStateOf(Duration.between(Instant.now(), armed.expiresAt).seconds.coerceAtLeast(0)) }
    val scope = rememberCoroutineScope()
    androidx.compose.runtime.LaunchedEffect(armed) {
        while (true) {
            left = Duration.between(Instant.now(), armed.expiresAt).seconds.coerceAtLeast(0)
            delay(1_000)
        }
    }
    Row(
        Modifier.fillMaxWidth().background(AtlasColors.quiet).padding(12.dp)
            .semantics { liveRegion = LiveRegionMode.Polite },
    ) {
        Text("Remote capture allowed · %d:%02d left".format(left / 60, left % 60), Modifier.weight(1f))
        Spacer(Modifier.padding(4.dp))
        Button(onClick = { scope.launch { controller.stopArming() } }) { Text("Stop") }
    }
}
