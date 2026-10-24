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
import com.cultureatlas.capture.core.contract.StyleRegion
import com.cultureatlas.capture.core.net.analysisResult
import com.cultureatlas.capture.core.net.captureResult
import com.cultureatlas.capture.core.net.mediaEntry
import com.cultureatlas.capture.core.net.retryStyle
import com.cultureatlas.capture.core.net.setCity
import com.cultureatlas.capture.core.net.startAnalysis
import com.cultureatlas.capture.core.result.AnalysisReading
import com.cultureatlas.capture.core.result.AnalysisResultCopy
import com.cultureatlas.capture.core.result.AnalysisResultReader
import com.cultureatlas.capture.core.result.LibraryTileCopy
import com.cultureatlas.capture.core.result.RailState
import com.cultureatlas.capture.core.result.ReferenceCopy
import com.cultureatlas.capture.core.result.StyleCopy
import com.cultureatlas.capture.core.result.StyleReader
import com.cultureatlas.capture.core.result.StyleState
import androidx.compose.foundation.clickable
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.ui.semantics.stateDescription
import java.util.UUID
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
@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
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
    // Style reading and rails (design F.4).
    var highlighted by remember { mutableStateOf<StyleRegion?>(null) }
    var capturePolls by remember { mutableIntStateOf(0) }
    var retrying by remember { mutableStateOf(false) }
    var retryNote by remember { mutableStateOf<String?>(null) }
    var cityOpen by remember { mutableStateOf(false) }
    var citySaving by remember { mutableStateOf(false) }
    var cityError by remember { mutableStateOf<String?>(null) }
    var cityNote by remember { mutableStateOf<String?>(null) }
    var pulse by remember { mutableStateOf<String?>(null) }
    val toast by notices.toast.collectAsState()
    val scope = rememberCoroutineScope()
    val haptics = rememberHaptics()
    val uriHandler = LocalUriHandler.current
    val askNotifications = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {}

    // The compiled capture: references, the style reading and the rails. Sections publish
    // progressively, so it is polled every 1.5 s until every section and rail is terminal (R-16c).
    // An older capture (no sections, no rails) keeps the old rule: stop once recommendations land.
    val loadCapture: suspend (String) -> Unit = load@{ captureId ->
        var legacyPolls = 0
        repeat(CAPTURE_POLL_LIMIT) {
            val c = runCatching { api.captureResult(captureId) }
            c.onSuccess {
                capture = it
                when (StyleReader.isSettled(it)) {
                    true -> return@load
                    null -> if (it.recommendations.isNotEmpty() || it.jobId == null || ++legacyPolls >= 8) return@load
                    false -> Unit
                }
            }
            c.onFailure { error ->
                // Not readable from a phone yet (native owner bridge): show what /v2 returned.
                if (error is AtlasClientException.Server) return@load
            }
            delay(if (capture?.rails != null || capture?.analysis?.sections?.isNotEmpty() == true) 1_500 else 3_000)
        }
    }

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
            done.captureId?.let { loadCapture(it) }
        }
        runCatching { api.mediaEntry(mediaId) }.onSuccess { library.update(it) }
    }
    val finishedCaptureId = analysis?.takeIf { it.state == AnalysisState.COMPLETE || it.state == AnalysisState.PARTIAL }?.captureId
    // After "Try again" the style stage re-runs: poll the capture again until it settles.
    LaunchedEffect(capturePolls) {
        if (capturePolls > 0) finishedCaptureId?.let { loadCapture(it) }
    }

    val kind = media?.media?.kind
    val isAudio = kind != null && kind != "photo" && kind != "video"
    val reading = analysis?.let { AnalysisResultReader.read(it) } ?: AnalysisReading.Nothing
    val working = resolving || starting || analysis?.state?.let { AnalysisResultCopy.isWorking(it) } == true ||
        (currentId != null && analysis == null)
    val scroll = rememberScrollState()
    val badge = StyleReader.experimental(capture, analysis?.experimental)
    val styleState = capture?.let { StyleReader.state(it) }
        ?: if (isAudio) StyleState.ABSENT else StyleReader.previewState(analysis?.result)
    val styleReading = capture?.let { AnalysisResultReader.readStyle(it) }
    val stylePreview = analysis?.let { AnalysisResultReader.readStylePreview(it) }
    val rails = capture?.let { StyleReader.rails(it, experimental = badge != null) }.orEmpty()
    val railKeys = rails.map { it.key }
    val requesters = remember(railKeys) { railKeys.associateWith { BringIntoViewRequester() } }
    val retryKey = remember(finishedCaptureId) { UUID.randomUUID() }
    val styleActions = StyleActions(
        onHighlight = { highlighted = it },
        onRetry = finishedCaptureId?.let { captureId ->
            {
                haptics.press()
                retrying = true
                scope.launch {
                    runCatching { api.retryStyle(captureId, retryKey) }
                        .onSuccess {
                            // 202: only the style stage re-runs; poll again until it lands.
                            capture = capture?.let { c ->
                                c.copy(analysis = c.analysis?.copy(sections = c.analysis!!.sections + ("style" to "running")))
                            }
                            capturePolls++
                        }
                        .onFailure { error ->
                            haptics.reject()
                            retryNote = if ((error as? AtlasClientException.Server)?.code == "retry_used") StyleCopy.RETRY_USED
                            else "Couldn't try again right now."
                        }
                    retrying = false
                }
            }
        },
        onShowRail = { key ->
            scope.launch {
                requesters[key]?.bringIntoView()
                pulse = key
                delay(900)
                pulse = null
            }
        },
    )

    val cityPanel: @Composable () -> Unit = {
        AddCityPanel(
            saving = citySaving,
            error = cityError,
            onSave = { city ->
                citySaving = true
                cityError = null
                scope.launch {
                    runCatching { api.setCity(city) }
                        .onSuccess {
                            haptics.confirm()
                            cityOpen = false
                            cityNote = "City saved. Places with this style show up from your next photo."
                        }
                        .onFailure { cityError = "Couldn't save the city. Try again." }
                    citySaving = false
                }
            },
            onDismiss = { cityOpen = false },
        )
    }

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
            ResultHero(media, isAudio, scanning = working && currentId != null, highlighted = highlighted, onClearHighlight = { highlighted = null })
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
                // The analysis screen always carries the label; the style card carries it once shown.
                if (badge != null && styleState == StyleState.ABSENT) ExperimentalBadgeButton(badge)
                capture?.analysis?.interpretation?.let { Text(it) }
                StyleReadingSection(
                    state = styleState,
                    reading = styleReading,
                    preview = stylePreview,
                    badge = badge,
                    highlighted = highlighted,
                    actions = styleActions,
                    retryNote = retryNote,
                    retrying = retrying,
                )
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
                capture?.let { c -> CaptureReferences(c) }
                if (rails.isNotEmpty()) {
                    StyleRails(
                        rails,
                        onOpenCard = onOpenCard,
                        onAddCity = {
                            cityError = null
                            cityOpen = true
                        },
                        pulse = pulse,
                        requesters = requesters,
                        cityOpen = cityOpen,
                        cityPanel = cityPanel,
                    )
                }
                cityNote?.let { Text(it, color = AtlasColors.muted, style = MaterialTheme.typography.bodySmall) }
                val finished = analysis?.state == AnalysisState.COMPLETE || analysis?.state == AnalysisState.PARTIAL
                if (finished && rails.none { it.cards.isNotEmpty() || it.state == RailState.RUNNING }) {
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
private fun ResultHero(
    media: LibraryEntry?,
    isAudio: Boolean,
    scanning: Boolean,
    highlighted: StyleRegion? = null,
    onClearHighlight: () -> Unit = {},
) {
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
            }
            // Evidence region of a tapped style claim; tapping the photo clears it.
            .styleRegionOverlay(highlighted, media?.media?.width, media?.media?.height)
            .then(
                if (highlighted != null) {
                    Modifier
                        .clickable(onClickLabel = "Clear highlight", onClick = onClearHighlight)
                        .semantics { stateDescription = StyleReader.regionDescription(highlighted) }
                } else {
                    Modifier
                },
            ),
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

/** Sourced references of the compiled capture. Suggestions render as rails ([StyleRails]). */
@Composable
private fun CaptureReferences(capture: CaptureResultResponse) {
    if (capture.references.isEmpty()) return
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text("References", style = MaterialTheme.typography.labelLarge)
        capture.references.forEach { ref ->
            Text(ReferenceCopy.phrase(ref), color = AtlasColors.muted, style = MaterialTheme.typography.bodySmall)
            ReferenceCopy.attribution(ref)?.let { Text(it, color = AtlasColors.muted, style = MaterialTheme.typography.labelSmall) }
        }
    }
}

/** Polls of the compiled capture at 1.5 s: covers the 180 s video deadline. */
private const val CAPTURE_POLL_LIMIT = 120
