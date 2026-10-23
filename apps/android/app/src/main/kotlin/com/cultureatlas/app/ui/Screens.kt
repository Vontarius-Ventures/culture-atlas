package com.cultureatlas.app.ui

import android.Manifest
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.view.PreviewView
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.text.style.TextOverflow
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
import com.cultureatlas.capture.core.contract.CollectionSummary
import com.cultureatlas.capture.core.contract.LibraryEntry
import com.cultureatlas.capture.core.contract.MediaKind
import com.cultureatlas.capture.core.contract.MediaSource
import com.cultureatlas.capture.core.net.AtlasApi
import com.cultureatlas.capture.core.net.collections
import com.cultureatlas.capture.core.policy.AudioPolicy
import com.cultureatlas.capture.core.policy.CapabilityGate
import com.cultureatlas.capture.core.policy.ClipClock
import com.cultureatlas.capture.core.result.LibraryPages
import com.cultureatlas.capture.core.result.LibraryTileCopy
import com.cultureatlas.capture.core.store.DraftRecord
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Library: boards, what is still on this phone, then the server library as a
 * photo grid that pages in as you scroll (`GET /v2/library`). A tile opens the
 * native result screen; nothing here leaves the app.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LibraryScreen(
    controller: AppController,
    notices: ReadyNoticeCenter,
    api: AtlasApi,
    library: LibraryModel,
    onBoards: () -> Unit,
    onBoard: (CollectionSummary) -> Unit,
    onOpenMedia: (LibraryEntry) -> Unit,
    onCapture: () -> Unit,
) {
    val drafts by controller.drafts.collectAsState()
    val locked by controller.lockedDraftsExist.collectAsState()
    var boards by remember { mutableStateOf<List<CollectionSummary>?>(null) }
    val scope = rememberCoroutineScope()
    val haptics = rememberHaptics()
    val grid = rememberLazyGridState()
    val pages = library.pages
    val committed = drafts.count { it.status == DraftRecord.Status.COMMITTED }
    LaunchedEffect(Unit) { boards = runCatching { api.collections() }.getOrNull()?.collections ?: boards.orEmpty() }
    // New uploads land in the grid as soon as they commit.
    LaunchedEffect(committed) { library.refresh() }
    LaunchedEffect(grid) {
        snapshotFlow { grid.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0 }
            .collect { last ->
                val info = grid.layoutInfo
                if (LibraryPages.shouldLoadMore(last, info.totalItemsCount, library.pages.hasMore, library.loadingMore)) {
                    library.loadMore()
                }
            }
    }
    val pending = LibraryPages.pendingDrafts(drafts, pages.ids) { it.assetId }
    PullToRefreshBox(
        isRefreshing = library.refreshing,
        onRefresh = {
            haptics.tick()
            library.refreshing = true
            scope.launch {
                boards = runCatching { api.collections() }.getOrNull()?.collections ?: boards
                library.refresh()
            }
        },
    ) {
        LazyVerticalGrid(
            columns = GridCells.Fixed(3),
            state = grid,
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 16.dp, bottom = 24.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            item(key = "header", span = { GridItemSpan(maxLineSpan) }) {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.padding(bottom = 8.dp)) {
                    Text("Library", Modifier.semantics { heading() }, style = MaterialTheme.typography.headlineMedium.copy(fontFamily = FontFamily.Serif))
                    Text("Your library is private. Choose what to explore.", color = AtlasColors.muted)
                }
            }
            item(key = "boards", span = { GridItemSpan(maxLineSpan) }) {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(bottom = 12.dp)) {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                        Text("Boards", style = MaterialTheme.typography.titleMedium.copy(fontFamily = FontFamily.Serif))
                        TextButton(onClick = onBoards) { Text("See all") }
                    }
                    val shown = boards
                    when {
                        shown == null -> Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                            repeat(3) { Shimmer(Modifier.size(120.dp).clip(RoundedCornerShape(14.dp))) }
                        }
                        shown.isEmpty() -> Text("Boards you build from Feed show up here.", color = AtlasColors.muted)
                        else -> LazyRow(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                            items(shown, key = { it.id }) { board ->
                                Column(Modifier.width(120.dp).tappable { onBoard(board) }, verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                    BoardCover(board)
                                    Text(board.name, style = MaterialTheme.typography.titleSmall.copy(fontFamily = FontFamily.Serif), maxLines = 1, overflow = TextOverflow.Ellipsis)
                                }
                            }
                        }
                    }
                }
            }
            if (pending.isNotEmpty()) {
                item(key = "phone-title", span = { GridItemSpan(maxLineSpan) }) {
                    Text("On this phone", Modifier.padding(top = 4.dp), style = MaterialTheme.typography.titleMedium.copy(fontFamily = FontFamily.Serif))
                }
                items(pending, key = { "draft-${it.id}" }, span = { GridItemSpan(maxLineSpan) }) { draft ->
                    Box(Modifier.animateItem()) { DraftRow(controller, notices, draft) }
                }
            }
            if (locked) item(key = "locked", span = { GridItemSpan(maxLineSpan) }) { LockedDraftsNotice() }
            item(key = "library-title", span = { GridItemSpan(maxLineSpan) }) {
                Row(Modifier.fillMaxWidth().padding(top = 12.dp, bottom = 4.dp), verticalAlignment = Alignment.Bottom) {
                    Text("In your library", Modifier.weight(1f), style = MaterialTheme.typography.titleMedium.copy(fontFamily = FontFamily.Serif))
                    if (pages.entries.isNotEmpty()) {
                        Text("${pages.entries.size}${if (pages.hasMore) "+" else ""}", color = AtlasColors.muted, style = MaterialTheme.typography.labelMedium)
                    }
                }
            }
            when {
                !pages.loadedOnce && library.message == null -> items(9, key = { "skeleton-$it" }) {
                    Shimmer(Modifier.aspectRatio(1f).clip(RoundedCornerShape(10.dp)))
                }
                pages.entries.isEmpty() -> item(key = "empty", span = { GridItemSpan(maxLineSpan) }) {
                    Column(verticalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.padding(vertical = 8.dp)) {
                        Text(
                            library.message ?: "Nothing here yet. Take a photo, record music, or upload files from your phone.",
                            color = AtlasColors.muted,
                        )
                        if (library.message == null) {
                            OutlinedButton(onClick = onCapture, modifier = Modifier.heightIn(min = 48.dp)) { Text("Capture something") }
                        }
                    }
                }
                else -> {
                    items(pages.entries, key = { it.media.id }) { entry ->
                        LibraryTile(entry, Modifier.animateItem()) { onOpenMedia(entry) }
                    }
                    if (library.loadingMore) {
                        items(3, key = { "more-$it" }) { Shimmer(Modifier.aspectRatio(1f).clip(RoundedCornerShape(10.dp))) }
                    }
                    library.message?.let { text ->
                        item(key = "library-message", span = { GridItemSpan(maxLineSpan) }) { Text(text, color = AtlasColors.muted) }
                    }
                }
            }
        }
    }
}

/** A square tile: the picture, a play badge with the length for a video, and the explore state in words. */
@Composable
private fun LibraryTile(entry: LibraryEntry, modifier: Modifier = Modifier, onOpen: () -> Unit) {
    val status = LibraryTileCopy.status(entry)
    val working = entry.media.analysisStatus == "queued" || entry.media.analysisStatus == "running"
    val pulse = rememberInfiniteTransition(label = "tile-looking")
    val dot by pulse.animateFloat(
        initialValue = 0.45f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(600), RepeatMode.Reverse),
        label = "tile-dot",
    )
    Box(
        modifier
            .aspectRatio(1f)
            .clip(RoundedCornerShape(10.dp))
            .tappable(onClick = onOpen)
            .semantics(mergeDescendants = true) {
                contentDescription = "${if (entry.media.kind == "video") "Video" else "Photo"}. $status"
            },
    ) {
        AtlasImage(
            LibraryTileCopy.picturePath(entry)?.let { AtlasApiBase + it },
            Modifier.fillMaxSize(),
            contentDescription = null,
        )
        if (entry.media.kind == "video") {
            Row(
                Modifier
                    .align(Alignment.BottomStart)
                    .padding(6.dp)
                    .clip(RoundedCornerShape(8.dp))
                    .background(Color.Black.copy(alpha = 0.45f))
                    .padding(horizontal = 6.dp, vertical = 2.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                Icon(AtlasIcons.Play, contentDescription = null, tint = Color.White, modifier = Modifier.size(12.dp))
                entry.media.durationMs?.let {
                    Text(ClipClock.clock(it / 1000), color = Color.White, style = MaterialTheme.typography.labelSmall)
                }
            }
        }
        if (working || entry.media.analysisStatus == "complete") {
            Box(
                Modifier
                    .align(Alignment.TopEnd)
                    .padding(6.dp)
                    .size(10.dp)
                    .clip(CircleShape)
                    .background(Color.White.copy(alpha = 0.9f))
                    .padding(2.dp)
                    .clip(CircleShape)
                    .background(AtlasColors.olive.copy(alpha = if (working) dot else 1f)),
            )
        }
    }
}

@Composable
private fun DraftRow(controller: AppController, notices: ReadyNoticeCenter, draft: DraftRecord) {
    val exploring by notices.exploring.collectAsState()
    val capabilities by controller.capabilities.collectAsState()
    val scope = rememberCoroutineScope()
    // Asked at the moment of use: the user just chose to explore a photo.
    val askNotifications = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {}
    Column(Modifier.fillMaxWidth().semantics(mergeDescendants = true) {}) {
        Row {
            Text(kindText(draft.kind), Modifier.padding(end = 8.dp))
            draft.durationSeconds?.let { Text(ClipClock.clock(it.toInt()), color = AtlasColors.muted) }
        }
        // Status is always in words, never colour alone.
        Text("${sourceText(draft)} · ${statusText(draft)}", color = AtlasColors.muted)
        if (draft.interrupted) Text("Recording was interrupted. The part before the interruption was kept.")
        if (draft.kind == MediaKind.AUDIO) Text(AudioPolicy.CAMERA_OFF_LABEL, color = AtlasColors.muted)
        when (draft.status) {
            DraftRecord.Status.AWAITING_REVIEW -> Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = { controller.keep(draft) }) { Text("Keep") }
                OutlinedButton(onClick = { controller.discard(draft) }) {
                    Text(if (draft.kind == MediaKind.PHOTO) "Retake" else "Delete")
                }
            }
            DraftRecord.Status.KEPT_LOCAL -> Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = {
                    if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU) {
                        askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
                    }
                    scope.launch { controller.exploreMusic(draft) }
                }) { Text(AudioPolicy.EXPLORE_LABEL) }
                OutlinedButton(onClick = { controller.discard(draft) }) { Text("Delete") }
            }
            DraftRecord.Status.QUEUED -> {
                if (draft.kind == MediaKind.AUDIO && draft.exploreAfterCommit) {
                    Text("Uploading so we can explore this recording.", color = AtlasColors.muted)
                }
                if (!draft.allowCellular) {
                    TextButton(onClick = { controller.keep(draft, allowCellular = true) }) { Text("Upload using mobile data") }
                }
            }
            DraftRecord.Status.COMMITTED -> {
                val assetId = draft.assetId
                val watching = assetId?.lowercase() in exploring || draft.id.lowercase() in exploring
                val photoAnalysis = CapabilityGate.photoAnalysis(capabilities)
                if (draft.kind == MediaKind.PHOTO && assetId != null) {
                    // The user starts exploring; screen 17 tells them when it is ready.
                    if (watching) {
                        Text(
                            "Looking at your photo. This takes a few seconds.",
                            color = AtlasColors.muted,
                            modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                        )
                    } else if (!photoAnalysis.available) {
                        Text(photoAnalysis.message, color = AtlasColors.muted)
                    } else {
                        TextButton(onClick = {
                            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU) {
                                askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
                            }
                            scope.launch {
                                if (!notices.explore(assetId)) {
                                    controller.message.value = CapabilityGate.photoAnalysisMessage(
                                        capabilities?.availability?.get("analysis")?.reasons.orEmpty(),
                                    )
                                }
                            }
                        }) { Text("Explore this photo") }
                    }
                }
                if (draft.kind == MediaKind.AUDIO && assetId != null) {
                    if (watching) {
                        Text(
                            "Looking at your recording. This takes a few seconds.",
                            color = AtlasColors.muted,
                            modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                        )
                    } else {
                        TextButton(onClick = {
                            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU) {
                                askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
                            }
                            scope.launch { controller.exploreMusic(draft) }
                        }) { Text(AudioPolicy.EXPLORE_LABEL) }
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

private fun kindText(kind: MediaKind) = when (kind) {
    MediaKind.PHOTO -> "Photo"
    MediaKind.VIDEO -> "Video"
    MediaKind.AUDIO -> "Audio"
}

private fun sourceText(draft: DraftRecord) = when (draft.source) {
    MediaSource.PHONE_CAMERA -> "This camera"
    MediaSource.PHONE_MICROPHONE -> draft.sourceRoute?.let { "${AudioPolicy.labelForInput(it, false)} · $it" } ?: "This phone"
    MediaSource.META_GLASSES -> if (draft.kind == MediaKind.AUDIO) {
        draft.sourceRoute?.let { "Glasses microphone · $it" } ?: "Glasses microphone · Verified input"
    } else {
        "Meta glasses (Experimental)"
    }
    MediaSource.UPLOAD -> "Uploaded file"
}

private fun statusText(draft: DraftRecord) = when (draft.status) {
    DraftRecord.Status.AWAITING_REVIEW -> "Not kept yet"
    DraftRecord.Status.KEPT_LOCAL -> "Saved on this phone"
    DraftRecord.Status.QUEUED -> if (draft.allowCellular) "Waiting to upload" else "Waiting for Wi-Fi"
    DraftRecord.Status.UPLOADING -> "Uploading"
    DraftRecord.Status.VERIFYING -> "Checking on the server"
    DraftRecord.Status.COMMITTED -> "In your library"
    DraftRecord.Status.LOCKED -> "Waiting for its account"
    DraftRecord.Status.REJECTED -> "Not accepted"
    DraftRecord.Status.FAILED -> "Upload paused"
}

/** Screen 02: This camera, Music, Meta glasses (Experimental), Upload files — as large, pressable source cards. */
@Composable
fun CaptureSourceScreen(controller: AppController, onCamera: () -> Unit, onMusic: () -> Unit, onGlasses: () -> Unit) {
    val capabilities by controller.capabilities.collectAsState()
    val camera = CapabilityGate.phoneCamera(capabilities)
    val context = androidx.compose.ui.platform.LocalContext.current
    val haptics = rememberHaptics()
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(20)) { uris ->
        if (uris.isNotEmpty()) haptics.confirm()
        uris.forEach { uri -> controller.importFile(uri, context.contentResolver.getType(uri)) }
    }
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("Keep what catches your eye, or a little of what you hear.", style = MaterialTheme.typography.headlineSmall.copy(fontFamily = FontFamily.Serif))
        Text("Your library is private. Choose what to explore.", color = AtlasColors.muted)
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            SourceCard(
                title = "This camera",
                caption = "Photo or a short video",
                icon = AtlasIcons.Camera,
                fill = AtlasColors.olive,
                enabled = camera.photo || camera.video,
                modifier = Modifier.weight(1f),
                onClick = onCamera,
            )
            SourceCard(
                title = "Music",
                caption = "Name what's playing",
                icon = AtlasIcons.Music,
                fill = AtlasColors.posterPlay,
                modifier = Modifier.weight(1f),
                onClick = onMusic,
            )
        }
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            SourceCard(
                title = "Meta glasses",
                caption = "Experimental",
                icon = AtlasIcons.Glasses,
                fill = AtlasColors.posterWatch,
                modifier = Modifier.weight(1f),
                onClick = onGlasses,
            )
            SourceCard(
                title = "Upload files",
                caption = "From this phone",
                icon = AtlasIcons.Upload,
                fill = AtlasColors.posterEat,
                modifier = Modifier.weight(1f),
                onClick = { picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageAndVideo)) },
            )
        }
        Text("Uploading does not start analysis.", color = AtlasColors.muted)
    }
}

@Composable
private fun SourceCard(
    title: String,
    caption: String,
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    fill: Color,
    modifier: Modifier,
    enabled: Boolean = true,
    onClick: () -> Unit,
) {
    Column(
        modifier
            .aspectRatio(1f)
            .clip(RoundedCornerShape(18.dp))
            .background(if (enabled) fill else AtlasColors.quiet)
            .tappable(enabled = enabled, onClick = onClick)
            .semantics(mergeDescendants = true) { contentDescription = "$title. $caption" }
            .padding(16.dp),
        verticalArrangement = Arrangement.SpaceBetween,
    ) {
        Icon(icon, contentDescription = null, tint = if (enabled) Color.White.copy(alpha = 0.9f) else AtlasColors.muted, modifier = Modifier.size(28.dp))
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(title, color = if (enabled) Color.White else AtlasColors.muted, style = MaterialTheme.typography.titleMedium.copy(fontFamily = FontFamily.Serif))
            Text(caption, color = if (enabled) Color.White.copy(alpha = 0.75f) else AtlasColors.muted, style = MaterialTheme.typography.bodySmall)
        }
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
    val haptics = rememberHaptics()
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
    // System Back behaves like the Back button: never mid-recording, and the camera is released.
    BackHandler {
        if (!recording) {
            camera.stop()
            onBack()
        }
    }
    DisposableEffect(Unit) {
        onDispose { if (!camera.recording.value) camera.stop() }
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
            OutlinedButton(onClick = { haptics.tick(); mode = MediaKind.PHOTO }, enabled = !recording) { Text(if (mode == MediaKind.PHOTO) "Photo ✓" else "Photo") }
            OutlinedButton(onClick = { haptics.tick(); mode = MediaKind.VIDEO }, enabled = !recording && CapabilityGate.phoneCamera(capabilities).video) {
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
                        haptics.tick()
                        if (on && !camera.setMicrophone(true)) micPermission.launch(Manifest.permission.RECORD_AUDIO) else camera.setMicrophone(on)
                    },
                )
            }
            if (!microphoneOn) Text("Video records without sound.", color = AtlasColors.muted)
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = { runCatching { camera.flip() } }, enabled = !recording && running) { Text("Flip camera") }
            when {
                mode == MediaKind.PHOTO -> Button(onClick = { haptics.confirm(); scope.launch { review = controller.capturePhoto(MediaSource.PHONE_CAMERA) } }, enabled = running) {
                    Text("Take photo")
                }
                recording -> Button(onClick = { haptics.confirm(); controller.stopRecording() }) { Text("Stop") }
                else -> Button(
                    onClick = {
                        haptics.press()
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
                onCheckedChange = { on ->
                    haptics.tick()
                    if (on) showArm = true else scope.launch { controller.stopArming() }
                },
            )
        }
    }
    review?.let { ReviewDialog(controller, it) { review = null } }
    if (showArm) RemoteArmDialog(controller, MediaSource.PHONE_CAMERA) { showArm = false }
}

@Composable
fun ReviewDialog(controller: AppController, draft: DraftRecord, onDone: () -> Unit) {
    val haptics = rememberHaptics()
    AlertDialog(
        onDismissRequest = onDone,
        title = {
            Text(
                when (draft.kind) {
                    MediaKind.PHOTO -> "Keep this photo?"
                    MediaKind.VIDEO -> "Keep this video?"
                    MediaKind.AUDIO -> "Keep this recording?"
                },
            )
        },
        text = {
            Column {
                Text("Saved on this phone. Keeping it uploads it to your private library.")
                if (draft.interrupted) Text("Recording was interrupted. The part before the interruption was kept.")
            }
        },
        confirmButton = { Button(onClick = { haptics.confirm(); controller.keep(draft); onDone() }) { Text("Keep") } },
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
    val haptics = rememberHaptics()
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
        Text("Translations aren't available in this version.", color = AtlasColors.muted)
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
