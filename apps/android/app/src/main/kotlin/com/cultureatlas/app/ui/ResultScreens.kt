package com.cultureatlas.app.ui

import android.Manifest
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.cultureatlas.app.notify.ReadyNoticeCenter
import com.cultureatlas.capture.core.contract.AnalysisResultResponse
import com.cultureatlas.capture.core.contract.AnalysisState
import com.cultureatlas.capture.core.contract.CaptureResultResponse
import com.cultureatlas.capture.core.contract.DiscoveryCard
import com.cultureatlas.capture.core.contract.LibraryEntry
import com.cultureatlas.capture.core.net.AtlasApi
import com.cultureatlas.capture.core.net.AtlasClientException
import com.cultureatlas.capture.core.net.analysisResult
import com.cultureatlas.capture.core.net.captureResult
import com.cultureatlas.capture.core.net.mediaEntry
import com.cultureatlas.capture.core.net.startAnalysis
import com.cultureatlas.capture.core.result.AnalysisReading
import com.cultureatlas.capture.core.result.AnalysisResultCopy
import com.cultureatlas.capture.core.result.AnalysisResultReader
import com.cultureatlas.capture.core.result.LibraryTileCopy
import com.cultureatlas.capture.core.result.ReferenceCopy
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * The analysis result, in the app (screen 17's "Open" lands here, as does a
 * Library tile). Shows only what the server published: the guardrailed
 * candidates of a photo or video, or the Qloo-resolved artist of a recording,
 * and — when the compiled capture is readable — its sourced references and
 * Qloo recommendations. While the work runs, a slow scan line passes over the
 * picture and the page polls; nothing here ever opens the browser on its own.
 */
@Composable
fun AnalysisResultScreen(
    api: AtlasApi,
    notices: ReadyNoticeCenter,
    mediaId: String,
    analysisId: String?,
    entry: LibraryEntry?,
    library: LibraryModel,
    onBack: () -> Unit,
    onOpenCard: (DiscoveryCard) -> Unit,
    onFeed: () -> Unit,
) {
    var media by remember { mutableStateOf(entry) }
    var currentId by rememberSaveable { mutableStateOf(analysisId) }
    var analysis by remember { mutableStateOf<AnalysisResultResponse?>(null) }
    var capture by remember { mutableStateOf<CaptureResultResponse?>(null) }
    var resolving by remember { mutableStateOf(analysisId == null) }
    var starting by remember { mutableStateOf(false) }
    var note by remember { mutableStateOf<String?>(null) }
    val toast by notices.toast.collectAsState()
    val scope = rememberCoroutineScope()
    val haptics = rememberHaptics()
    val uriHandler = LocalUriHandler.current
    val askNotifications = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {}

    LaunchedEffect(mediaId) {
        runCatching { api.mediaEntry(mediaId) }.onSuccess {
            media = it
            library.update(it)
        }
        // From a Library tile: an analysis already asked for is found again (the server reuses the
        // same request, so this never spends a second allowance). Nothing new is started here.
        val m = media
        if (currentId == null && m != null && m.media.analysisStatus in setOf("queued", "running", "complete")) {
            currentId = runCatching {
                api.startAnalysis(m.media.id, m.generation, mode = LibraryTileCopy.analysisMode(m.media.kind))
            }.getOrNull()?.analysisId
        }
        resolving = false
    }
    LaunchedEffect(currentId) {
        val id = currentId ?: return@LaunchedEffect
        var wait = 1_500L
        while (true) {
            val next = runCatching { api.analysisResult(mediaId, id) }.getOrNull()
            if (next != null) analysis = next
            val state = analysis?.state
            if (state != null && !AnalysisResultCopy.isWorking(state)) break
            delay(wait)
            wait = (wait * 3 / 2).coerceAtMost(5_000L)
        }
        // Seen here: no separate "ready" toast for this one.
        if (toast?.analysisId == id) notices.dismissToast()
        val done = analysis
        if (done != null && (done.state == AnalysisState.COMPLETE || done.state == AnalysisState.PARTIAL)) {
            haptics.confirm()
            done.captureId?.let { captureId ->
                // References and recommendations are compiled after the vision read; poll briefly.
                repeat(8) {
                    val c = runCatching { api.captureResult(captureId) }
                    c.onSuccess {
                        capture = it
                        if (it.recommendations.isNotEmpty() || it.jobId == null) return@LaunchedEffect
                    }
                    c.onFailure { error ->
                        // Refused (an older server without the bridged read, or not found): show what /v2 returned.
                        if (error is AtlasClientException.Server) return@LaunchedEffect
                    }
                    delay(3_000)
                }
            }
        }
        runCatching { api.mediaEntry(mediaId) }.onSuccess { library.update(it) }
    }

    val kind = media?.media?.kind
    val isAudio = kind != null && kind != "photo" && kind != "video"
    val reading = analysis?.let { AnalysisResultReader.read(it) } ?: AnalysisReading.Nothing
    val working = resolving || starting || analysis?.state?.let { AnalysisResultCopy.isWorking(it) } == true ||
        (currentId != null && analysis == null)
    val scroll = rememberScrollState()

    Column(Modifier.fillMaxSize()) {
        AtlasTopBar(
            when (kind) {
                "video" -> "Your video"
                "photo" -> "Your photo"
                null -> null
                else -> "Your recording"
            },
            onBack,
        )
        Column(
            Modifier.fillMaxSize().verticalScroll(scroll).padding(start = 16.dp, end = 16.dp, bottom = 32.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            ResultHero(media, isAudio, scanning = working && currentId != null)
            val headline = when {
                currentId == null && !working -> if (isAudio) "Explore this recording" else if (kind == "video") "Explore this video" else "Explore this photo"
                analysis == null -> AnalysisResultCopy.LOOKING
                else -> AnalysisResultCopy.headline(analysis!!.state, reading)
            }
            AnimatedContent(
                targetState = headline,
                transitionSpec = { (fadeIn(tween(320)) + slideInVertically(tween(320)) { it / 3 }) togetherWith fadeOut(tween(160)) },
                label = "result-headline",
            ) { text ->
                Text(
                    text,
                    Modifier.semantics {
                        heading()
                        liveRegion = LiveRegionMode.Polite
                    },
                    style = MaterialTheme.typography.headlineSmall.copy(fontFamily = FontFamily.Serif),
                )
            }
            Column(Modifier.animateContentSize(tween(320)), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                analysis?.let { a -> AnalysisResultCopy.detail(a)?.let { Text(it, color = AtlasColors.muted) } }
                when (val r = reading) {
                    is AnalysisReading.Vision -> {
                        if (r.seen.isNotEmpty()) SeenList(r)
                        else if (analysis?.state?.let { !AnalysisResultCopy.isWorking(it) } == true) {
                            Text(AnalysisResultCopy.NOTHING_NAMED, color = AtlasColors.muted)
                        }
                        r.note?.let { Text(it, color = AtlasColors.muted, style = MaterialTheme.typography.bodySmall) }
                    }
                    is AnalysisReading.Music -> ArtistList(r)
                    AnalysisReading.Nothing -> Unit
                }
                capture?.let { c -> CaptureSuggestions(c, onOpenCard) }
                val finished = analysis?.state == AnalysisState.COMPLETE || analysis?.state == AnalysisState.PARTIAL
                if (finished && capture?.recommendations.isNullOrEmpty()) {
                    Text(AnalysisResultCopy.SUGGESTIONS_IN_FEED, color = AtlasColors.muted)
                    OutlinedButton(onClick = { haptics.tick(); onFeed() }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
                        Text(AnalysisResultCopy.OPEN_FEED)
                    }
                }
                note?.let { Text(it, color = AtlasColors.muted, style = MaterialTheme.typography.bodySmall) }
                // Not explored yet (from the Library): the user starts it, never this screen.
                val m = media
                if (currentId == null && !resolving && m != null) {
                    if (LibraryTileCopy.canExplore(m)) {
                        Text(
                            "Exploring looks closely at this ${if (m.media.kind == "video") "video" else "photo"} and finds things you might like. Uploading alone never does.",
                            color = AtlasColors.muted,
                        )
                        Button(
                            onClick = {
                                haptics.press()
                                starting = true
                                note = null
                                if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU) {
                                    askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
                                }
                                scope.launch {
                                    runCatching { api.startAnalysis(m.media.id, m.generation, mode = LibraryTileCopy.analysisMode(m.media.kind)) }
                                        .onSuccess {
                                            haptics.confirm()
                                            notices.watch(m.media.id, it.analysisId)
                                            currentId = it.analysisId
                                        }
                                        .onFailure { error ->
                                            haptics.reject()
                                            note = when ((error as? AtlasClientException.Server)?.code) {
                                                "quota_exceeded" -> "You've reached today's exploring allowance. Try again tomorrow."
                                                "service_unavailable" -> "Exploring isn't available right now. Your capture is safe in your library."
                                                "conflict" -> "This is still being prepared. Try again in a moment."
                                                else -> "Couldn't start exploring. Try again."
                                            }
                                        }
                                    starting = false
                                }
                            },
                            enabled = !starting,
                            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
                        ) { Text(if (m.media.kind == "video") "Explore this video" else "Explore this photo") }
                    } else {
                        Text(LibraryTileCopy.status(m), color = AtlasColors.muted)
                    }
                }
                if (finished) {
                    notices.resultUri(analysis?.resultUrl)?.let { uri ->
                        TextButton(onClick = { uriHandler.openUri(uri.toString()) }) {
                            Text("Open the full page on the web", color = AtlasColors.muted)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun ResultHero(media: LibraryEntry?, isAudio: Boolean, scanning: Boolean) {
    val shape = RoundedCornerShape(16.dp)
    val transition = rememberInfiniteTransition(label = "scan")
    val sweep by transition.animateFloat(
        initialValue = -0.2f,
        targetValue = 1.2f,
        animationSpec = infiniteRepeatable(tween(2200, easing = LinearEasing), RepeatMode.Reverse),
        label = "scan-y",
    )
    val scanAlpha by androidx.compose.animation.core.animateFloatAsState(if (scanning) 1f else 0f, tween(500), label = "scan-alpha")
    Box(
        Modifier
            .fillMaxWidth()
            .aspectRatio(if (isAudio) 16f / 9f else 4f / 5f)
            .clip(shape)
            .drawWithContent {
                drawContent()
                if (scanAlpha > 0f) {
                    val y = size.height * sweep
                    drawRect(
                        brush = Brush.verticalGradient(
                            colors = listOf(Color.Transparent, AtlasColors.olive.copy(alpha = 0.32f * scanAlpha), Color.Transparent),
                            startY = y - 80f,
                            endY = y + 80f,
                        ),
                        topLeft = Offset(0f, y - 80f),
                        size = androidx.compose.ui.geometry.Size(size.width, 160f),
                    )
                }
            },
    ) {
        val path = media?.let { LibraryTileCopy.picturePath(it) }
        if (isAudio) {
            Box(Modifier.fillMaxSize().background(AtlasColors.ink), contentAlignment = Alignment.BottomStart) {
                Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Icon(AtlasIcons.Music, contentDescription = null, tint = Color.White.copy(alpha = 0.85f), modifier = Modifier.size(28.dp))
                    Text("Music Mode", color = Color.White, style = MaterialTheme.typography.titleLarge.copy(fontFamily = FontFamily.Serif))
                    Text("Recorded on this phone · camera off", color = Color.White.copy(alpha = 0.7f), style = MaterialTheme.typography.bodySmall)
                }
            }
        } else {
            AtlasImage(path?.let { AtlasApiBase + it }, Modifier.fillMaxSize(), contentDescription = media?.media?.title ?: "Your capture")
        }
    }
}

/** Candidates appear one after another, each with its kind in words. */
@Composable
private fun SeenList(reading: AnalysisReading.Vision) {
    var revealed by remember(reading.seen) { mutableIntStateOf(0) }
    LaunchedEffect(reading.seen) {
        while (revealed < reading.seen.size) {
            delay(90)
            revealed++
        }
    }
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(AnalysisResultCopy.SEEN_TITLE, Modifier.semantics { heading() }, style = MaterialTheme.typography.titleMedium.copy(fontFamily = FontFamily.Serif))
        reading.seen.forEachIndexed { index, seen ->
            AnimatedVisibility(
                visible = index < revealed,
                enter = fadeIn(tween(260)) + slideInVertically(tween(320, easing = FastOutSlowInEasing)) { it / 2 },
            ) {
                Row(
                    Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(12.dp))
                        .background(AtlasColors.quiet)
                        .padding(horizontal = 14.dp, vertical = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Box(
                        Modifier.size(8.dp).clip(CircleShape)
                            .background(if (seen.resembles) AtlasColors.muted else AtlasColors.olive),
                    )
                    Text(seen.phrase, Modifier.weight(1f), style = MaterialTheme.typography.bodyLarge.copy(fontFamily = FontFamily.Serif))
                    seen.typeLabel?.let { Text(it, color = AtlasColors.muted, style = MaterialTheme.typography.labelMedium) }
                }
            }
        }
        if (reading.video && reading.framesTotal > 0) {
            Text(
                "Read from ${reading.framesLooked} of ${reading.framesTotal} moments in the video.",
                color = AtlasColors.muted,
                style = MaterialTheme.typography.bodySmall,
            )
        }
    }
}

@Composable
private fun ArtistList(reading: AnalysisReading.Music) {
    if (reading.artists.isEmpty()) return
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        reading.artists.forEach { artist ->
            Row(
                Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(12.dp))
                    .background(AtlasColors.quiet)
                    .padding(horizontal = 14.dp, vertical = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Icon(AtlasIcons.Music, contentDescription = null, tint = AtlasColors.olive, modifier = Modifier.size(20.dp))
                Text(artist.name, Modifier.weight(1f), style = MaterialTheme.typography.bodyLarge.copy(fontFamily = FontFamily.Serif), fontWeight = FontWeight.Medium)
                Text("Artist", color = AtlasColors.muted, style = MaterialTheme.typography.labelMedium)
            }
        }
        Text("Matched through Qloo. Suggestions from this artist join your Feed.", color = AtlasColors.muted, style = MaterialTheme.typography.bodySmall)
    }
}

@Composable
private fun CaptureSuggestions(capture: CaptureResultResponse, onOpenCard: (DiscoveryCard) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        capture.analysis?.interpretation?.let { Text(it) }
        if (capture.references.isNotEmpty()) {
            Text("References", style = MaterialTheme.typography.labelLarge)
            capture.references.forEach { ref ->
                Text(ReferenceCopy.phrase(ref), color = AtlasColors.muted, style = MaterialTheme.typography.bodySmall)
                ReferenceCopy.attribution(ref)?.let { Text(it, color = AtlasColors.muted, style = MaterialTheme.typography.labelSmall) }
            }
        }
        if (capture.recommendations.isNotEmpty()) {
            Text(AnalysisResultCopy.SUGGESTIONS_TITLE, Modifier.semantics { heading() }, style = MaterialTheme.typography.titleMedium.copy(fontFamily = FontFamily.Serif))
            LazyRow(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                items(capture.recommendations, key = { it.id }) { card ->
                    Box(Modifier.width(140.dp)) { FeedCardTile(card = card, onOpen = { onOpenCard(card) }) }
                }
            }
        }
    }
}
