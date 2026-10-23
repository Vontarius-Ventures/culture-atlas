package com.cultureatlas.app.ui

import android.Manifest
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.grid.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.cultureatlas.app.notify.ReadyNoticeCenter
import com.cultureatlas.capture.core.contract.CollectionMember
import com.cultureatlas.capture.core.contract.CollectionSummary
import com.cultureatlas.capture.core.contract.CreateCollectionRequest
import com.cultureatlas.capture.core.contract.DiscoveryCard
import com.cultureatlas.capture.core.contract.ItemDetailResponse
import com.cultureatlas.capture.core.contract.TasteCategory
import com.cultureatlas.capture.core.net.AtlasApi
import com.cultureatlas.capture.core.net.AtlasClientException
import com.cultureatlas.capture.core.net.addCollectionItem
import com.cultureatlas.capture.core.net.collection
import com.cultureatlas.capture.core.net.collections
import com.cultureatlas.capture.core.net.createCollection
import com.cultureatlas.capture.core.net.discoverRelated
import com.cultureatlas.capture.core.net.discoveries
import com.cultureatlas.capture.core.net.item
import com.cultureatlas.capture.core.onboarding.OnboardingCopy
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.min
import kotlin.math.sin

/** Living interest feed from GET /v1/discoveries. Visual-first: licensed pictures when we have them, typographic posters otherwise — never a stand-in portrait of a person or film. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FeedScreen(api: AtlasApi, notices: ReadyNoticeCenter) {
    var pool by remember { mutableStateOf<List<DiscoveryCard>>(emptyList()) }
    var shown by remember { mutableStateOf<List<DiscoveryCard>>(emptyList()) }
    var exampleFeed by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(true) }
    var refreshing by remember { mutableStateOf(false) }
    var adding by remember { mutableStateOf<DiscoveryCard?>(null) }
    var opened by remember { mutableStateOf<DiscoveryCard?>(null) }
    val exploring by notices.exploring.collectAsState()
    val toast by notices.toast.collectAsState()
    val scope = rememberCoroutineScope()
    suspend fun load(refresh: Boolean = false) {
        runCatching { api.discoveries(refresh) }
            .onSuccess { feed ->
                exampleFeed = feed.isExampleFeed
                if (feed.items.isEmpty()) {
                    message = if (pool.isEmpty()) {
                        "Still looking for things that match your interests. Pull to try again."
                    } else {
                        "Nothing new yet. Still showing what you had."
                    }
                } else {
                    val incomingIds = feed.items.map { it.id }.toSet()
                    val keepOnScreen = shown.map { it.id }.toSet()
                    pool = feed.items + pool.filter { it.id in keepOnScreen && it.id !in incomingIds }
                    if (pool.any { it.image != null }) {
                        pool = pool.filter { it.image != null || it.id in keepOnScreen }
                    }
                    if (shown.isEmpty() || refresh) shown = mosaic(pool)
                    message = null
                }
            }
            .onFailure {
                if (it is AtlasClientException.Server && it.code == "onboarding_required") {
                    pool = emptyList()
                    shown = emptyList()
                    message = "Finish picking your interests to see suggestions."
                } else if (pool.isEmpty()) {
                    message = "Suggestions aren't available right now. Pull to try again."
                } else {
                    message = "Couldn't refresh. Still showing what you had."
                }
            }
        loading = false
        refreshing = false
    }
    LaunchedEffect(Unit) { load() }
    LaunchedEffect(Unit) {
        while (true) {
            delay(8_000)
            load(refresh = false)
        }
    }
    LaunchedEffect(pool, shown) {
        while (true) {
            delay(6_000)
            val waiting = pool.filter { card -> shown.none { it.id == card.id } }
            if (waiting.isNotEmpty() && shown.isNotEmpty()) {
                val incomingIds = pool.take(24).map { it.id }.toSet()
                val fresh = waiting.filter { it.id in incomingIds }.ifEmpty { waiting }
                val pictured = fresh.filter { it.image != null }
                val incoming = when {
                    pictured.isNotEmpty() -> pictured.random()
                    shown.any { it.image != null } -> null
                    else -> waiting.random()
                } ?: continue
                val imageless = shown.indices.filter { shown[it].image == null }
                val visible = shown.indices.take(minOf(4, shown.size))
                val outIdx = (imageless.ifEmpty { visible }).random()
                shown = shown.toMutableList().also { it[outIdx] = incoming }
            }
        }
    }
    if (opened != null) {
        FeedCardDetail(
            api = api,
            card = opened!!,
            notices = notices,
            onBack = { opened = null },
            onAddToBoard = { adding = opened },
            onOpenRelated = { opened = it },
        )
        adding?.let { card ->
            AddToBoardDialog(api = api, card = card, onDismiss = { adding = null }, onAdded = { adding = null })
        }
        return
    }
    PullToRefreshBox(
        isRefreshing = refreshing,
        onRefresh = {
            refreshing = true
            scope.launch { load(refresh = true) }
        },
    ) {
        LazyVerticalGrid(
            columns = GridCells.Fixed(2),
            modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp),
            contentPadding = PaddingValues(bottom = 72.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            item(span = { GridItemSpan(2) }) {
                Column(Modifier.padding(top = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Feed", Modifier.semantics { heading() }, style = MaterialTheme.typography.headlineMedium.copy(fontFamily = FontFamily.Serif))
                    Text("A feed of what you're into. Pull down for more.", color = AtlasColors.muted, style = MaterialTheme.typography.bodySmall)
                    if (exampleFeed) {
                        Text("These are example results until your personal feed is ready.", color = AtlasColors.muted, style = MaterialTheme.typography.bodySmall)
                    }
                    if (exploring.isNotEmpty()) {
                        AnalysisLookingBanner()
                    } else if (toast != null) {
                        AnalysisReadyBanner()
                    }
                    if (loading && shown.isEmpty()) Text("Loading…", color = AtlasColors.muted)
                    message?.let { Text(it, color = AtlasColors.muted) }
                    if (!loading && shown.isEmpty() && message == null) {
                        Text("No suggestions yet", style = MaterialTheme.typography.titleMedium.copy(fontFamily = FontFamily.Serif))
                        Text("Finish picking your interests, then pull to refresh.", color = AtlasColors.muted)
                    }
                }
            }
            itemsIndexed(shown, key = { index, _ -> index }) { index, card ->
                FeedCardTile(card = card, phase = index, onOpen = { opened = card })
            }
        }
    }
    adding?.let { card ->
        AddToBoardDialog(api = api, card = card, onDismiss = { adding = null }, onAdded = { adding = null })
    }
}

private fun mosaic(pool: List<DiscoveryCard>): List<DiscoveryCard> {
    val pictured = pool.filter { it.image != null }
    if (pictured.isEmpty()) return pool.take(4)
    return pictured.take(4)
}

@Composable
private fun prefersReducedMotion(): Boolean {
    val context = LocalContext.current
    return remember(context) {
        Settings.Global.getFloat(
            context.contentResolver,
            Settings.Global.ANIMATOR_DURATION_SCALE,
            1f,
        ) == 0f
    }
}

@Composable
private fun FeedCardTile(card: DiscoveryCard, onOpen: () -> Unit, phase: Int = 0) {
    val reduceMotion = prefersReducedMotion()
    val infinite = rememberInfiniteTransition(label = "feed-float")
    val drift by infinite.animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(4200), RepeatMode.Reverse),
        label = "drift",
    )
    val y = if (reduceMotion) 0.dp else (sin((drift + phase * 0.18f) * 2f * PI.toFloat()) * 5f).dp
    Box(
        Modifier
            .fillMaxWidth()
            .clipToBounds()
            .clickable(onClick = onOpen)
            .semantics(mergeDescendants = true) {
                contentDescription = if (card.isExample) "${card.title}. Example result" else card.title
            },
    ) {
    Column(
        Modifier.offset(y = y),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        FeedCardVisual(card, Modifier.fillMaxWidth().aspectRatio(4f / 5f).clip(RoundedCornerShape(14.dp)))
        Text(card.title, style = MaterialTheme.typography.titleSmall.copy(fontFamily = FontFamily.Serif), maxLines = 2)
        if (card.isExample) Text("Example result", color = AtlasColors.muted, style = MaterialTheme.typography.labelSmall)
    }
    }
}

@Composable
private fun FeedCardVisual(card: DiscoveryCard, modifier: Modifier) {
    val imageUrl = card.image?.resolved(AtlasApiBase)
    if (imageUrl != null) {
        RemoteImage(imageUrl, modifier, contentDescription = card.image?.alt ?: card.title)
    } else {
        Box(modifier.background(posterFill(card.category)), contentAlignment = Alignment.BottomStart) {
            Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                card.category?.let {
                    Text(OnboardingCopy.group(it), color = Color.White.copy(alpha = 0.8f), style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.SemiBold)
                }
                Text(card.title, color = Color.White, style = MaterialTheme.typography.titleMedium.copy(fontFamily = FontFamily.Serif), maxLines = 4)
                card.subtitle?.let { Text(it, color = Color.White.copy(alpha = 0.75f), style = MaterialTheme.typography.bodySmall, maxLines = 2) }
            }
        }
    }
}

private fun posterFill(category: TasteCategory?): Color = when (category) {
    TasteCategory.WEAR -> AtlasColors.olive
    TasteCategory.PLAY -> AtlasColors.posterPlay
    TasteCategory.WATCH -> AtlasColors.posterWatch
    TasteCategory.EAT -> AtlasColors.posterEat
    null -> AtlasColors.ink
}

/** Pinch to zoom. Focus is a separate tool: arm it, drag a box, then confirm. Analysis runs only on the owner's own captures — suggestion cards fail closed. */
@Composable
private fun FeedCardDetail(
    api: AtlasApi,
    card: DiscoveryCard,
    notices: ReadyNoticeCenter,
    onBack: () -> Unit,
    onAddToBoard: () -> Unit,
    onOpenRelated: (DiscoveryCard) -> Unit,
) {
    var scale by remember { mutableFloatStateOf(1f) }
    var highlight by remember { mutableStateOf<Rect?>(null) }
    var focusArmed by remember { mutableStateOf(false) }
    var showFocusHint by remember { mutableStateOf(false) }
    var looking by remember { mutableStateOf(false) }
    var analysisNote by remember { mutableStateOf<String?>(null) }
    var detail by remember { mutableStateOf<ItemDetailResponse?>(null) }
    var detailNote by remember { mutableStateOf<String?>(null) }
    var related by remember { mutableStateOf<List<DiscoveryCard>>(emptyList()) }
    var relatedState by remember { mutableStateOf("none") }
    val exploring by notices.exploring.collectAsState()
    val toast by notices.toast.collectAsState()
    val scope = rememberCoroutineScope()
    val uriHandler = LocalUriHandler.current
    val askNotifications = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {}
    val inFlight = looking || card.id.lowercase() in exploring
    val shownCard = detail?.item ?: card
    LaunchedEffect(card.id) {
        runCatching { api.item(card.id) }
            .onSuccess {
                detail = it
                related = it.related
                relatedState = it.relatedState
                detailNote = null
                if (it.relatedState == "none") {
                    runCatching { api.discoverRelated(card.id) }
                        .onSuccess { relatedState = "pending" }
                }
            }
            .onFailure {
                if (detail == null) detailNote = "Couldn't load details right now. The card you opened is still here."
            }
        if (relatedState == "pending") {
            repeat(12) {
                delay(2_500)
                val loaded = runCatching { api.item(card.id) }.getOrNull() ?: return@LaunchedEffect
                detail = loaded
                related = loaded.related
                relatedState = loaded.relatedState
                if (loaded.relatedState != "pending") return@LaunchedEffect
            }
            if (related.isEmpty()) relatedState = "none"
        }
    }
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        TextButton(onClick = onBack) { Text("Back") }
        Box(
            Modifier
                .fillMaxWidth()
                .aspectRatio(4f / 5f)
                .clip(RoundedCornerShape(16.dp))
                .graphicsLayer { scaleX = scale; scaleY = scale }
                .pointerInput(focusArmed) {
                    awaitEachGesture {
                        val down = awaitFirstDown(requireUnconsumed = false)
                        var start = down.position
                        var twoFinger = false
                        do {
                            val event = awaitPointerEvent()
                            event.changes.forEach { it.consume() }
                            val pressed = event.changes.filter { it.pressed }
                            if (pressed.size >= 2) {
                                twoFinger = true
                                scale = (scale * event.calculateZoom()).coerceIn(1f, 4f)
                            } else if (focusArmed && !twoFinger && pressed.size == 1) {
                                val current = pressed.first().position
                                val originX = min(start.x, current.x)
                                val originY = min(start.y, current.y)
                                val width = abs(current.x - start.x).coerceAtLeast(24f)
                                val height = abs(current.y - start.y).coerceAtLeast(24f)
                                val bounds = Size(size.width.toFloat(), size.height.toFloat())
                                val rect = Rect(originX, originY, originX + width, originY + height)
                                    .intersect(Rect(Offset.Zero, bounds))
                                if (!rect.isEmpty) highlight = rect
                            }
                        } while (event.changes.any { it.pressed })
                        if (scale < 1.05f) scale = 1f
                    }
                }
                .drawWithContent {
                    drawContent()
                    highlight?.let { rect ->
                        drawRect(
                            color = AtlasColors.olive.copy(alpha = 0.18f),
                            topLeft = Offset(rect.left, rect.top),
                            size = Size(rect.width, rect.height),
                        )
                        drawRect(
                            color = AtlasColors.olive,
                            topLeft = Offset(rect.left, rect.top),
                            size = Size(rect.width, rect.height),
                            style = Stroke(width = 2.dp.toPx()),
                        )
                    }
                },
        ) {
            FeedCardVisual(shownCard, Modifier.fillMaxSize())
        }
        Text(shownCard.title, style = MaterialTheme.typography.headlineSmall.copy(fontFamily = FontFamily.Serif))
        shownCard.subtitle?.let { Text(it, color = AtlasColors.muted) }
        detail?.detail?.let { Text(it, color = AtlasColors.muted) }
        if (shownCard.isExample) Text("Example result", color = AtlasColors.muted, style = MaterialTheme.typography.bodySmall)
        detail?.description?.let { Text(it) }
        (detail?.reason ?: detail?.whyThis?.text)?.let {
            Text(it, color = AtlasColors.muted, style = MaterialTheme.typography.bodySmall)
        }
        detail?.destinationUrl?.let { url ->
            TextButton(onClick = { uriHandler.openUri(url) }) { Text("Open source") }
        }
        if (!detail?.references.isNullOrEmpty()) {
            Text("References", style = MaterialTheme.typography.labelLarge)
            detail!!.references.forEach { ref ->
                Text(
                    if (ref.qualified) ref.name else "Resembles ${ref.name}",
                    color = AtlasColors.muted,
                    style = MaterialTheme.typography.bodySmall,
                )
            }
        }
        if (inFlight) {
            AnalysisLookingBanner()
        } else if (toast != null) {
            AnalysisReadyBanner()
        }
        analysisNote?.let { Text(it, color = AtlasColors.muted, style = MaterialTheme.typography.bodySmall) }
        detailNote?.let { Text(it, color = AtlasColors.muted, style = MaterialTheme.typography.bodySmall) }
        if (focusArmed) {
            Text("Focus is on. Drag a box on the picture, then confirm. Pinch still zooms.", color = AtlasColors.muted, style = MaterialTheme.typography.bodySmall)
            OutlinedButton(
                onClick = {
                    focusArmed = false
                    highlight = null
                    showFocusHint = false
                },
                modifier = Modifier.fillMaxWidth(),
            ) { Text("Cancel focus") }
            if (highlight != null) {
                Button(
                    onClick = {
                        looking = true
                        analysisNote = null
                        scope.launch {
                            if (card.kind != "capture") {
                                delay(900)
                                looking = false
                                analysisNote = "Analysis looks at photos you capture. This card is a suggestion, so nothing was sent."
                                focusArmed = false
                                return@launch
                            }
                            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU) {
                                askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
                            }
                            looking = false
                            val started = notices.explore(card.id)
                            looking = started
                            if (!started) {
                                analysisNote = "Exploring isn't available right now. The picture is still on this phone."
                            }
                            focusArmed = false
                        }
                    },
                    modifier = Modifier.fillMaxWidth(),
                ) { Text("Look at this area") }
            }
        } else {
            OutlinedButton(
                onClick = {
                    focusArmed = true
                    showFocusHint = true
                },
                modifier = Modifier.fillMaxWidth(),
            ) { Text("Focus on an area") }
            Text(
                if (showFocusHint) {
                    "This looks at a region of a photo you captured. Suggestion cards are not analyzed."
                } else {
                    "Pinch to zoom. Use Focus on an area when you want to look at part of a picture."
                },
                color = AtlasColors.muted,
                style = MaterialTheme.typography.bodySmall,
            )
        }
        Button(onClick = onAddToBoard, modifier = Modifier.fillMaxWidth()) { Text("Add to a board") }
        Text("Similar", style = MaterialTheme.typography.titleMedium.copy(fontFamily = FontFamily.Serif))
        when {
            relatedState == "pending" && related.isEmpty() -> {
                AnalysisLookingBanner()
                Text("Looking for similar suggestions.", color = AtlasColors.muted, style = MaterialTheme.typography.bodySmall)
            }
            related.isEmpty() -> Text("No similar suggestions yet.", color = AtlasColors.muted, style = MaterialTheme.typography.bodySmall)
            else -> {
                if (relatedState == "pending") {
                    Text("Looking for more like this.", color = AtlasColors.muted, style = MaterialTheme.typography.bodySmall)
                }
                val reduceMotion = prefersReducedMotion()
                val infinite = rememberInfiniteTransition(label = "related-float")
                val drift by infinite.animateFloat(
                    initialValue = 0f,
                    targetValue = 1f,
                    animationSpec = infiniteRepeatable(tween(3500), RepeatMode.Reverse),
                    label = "drift",
                )
                val rail = related.filter { it.image != null }.ifEmpty { related }
                Row(
                    Modifier.horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    rail.forEachIndexed { index, relatedCard ->
                        val y = if (reduceMotion) 0.dp else (sin((drift + index * 0.2f) * 2f * PI.toFloat()) * 8f).dp
                        Box(Modifier.width(140.dp).clipToBounds()) {
                            Column(Modifier.offset(y = y)) {
                                FeedCardTile(card = relatedCard, phase = index, onOpen = { onOpenRelated(relatedCard) })
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun AnalysisLookingBanner() {
    val infinite = rememberInfiniteTransition(label = "looking")
    val pulse by infinite.animateFloat(
        initialValue = 0.55f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(500), RepeatMode.Reverse),
        label = "pulse",
    )
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(AtlasColors.quiet)
            .padding(10.dp)
            .semantics { liveRegion = LiveRegionMode.Polite },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Box(Modifier.size(14.dp).clip(CircleShape).background(AtlasColors.olive.copy(alpha = pulse)))
        Text("Looking…", color = AtlasColors.olive, style = MaterialTheme.typography.titleSmall.copy(fontFamily = FontFamily.Serif))
    }
}

@Composable
private fun AnalysisReadyBanner() {
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(AtlasColors.quiet)
            .padding(10.dp)
            .semantics { liveRegion = LiveRegionMode.Polite },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text("✓", color = AtlasColors.olive, fontWeight = FontWeight.Bold)
        Text("Ready", color = AtlasColors.olive, style = MaterialTheme.typography.titleSmall.copy(fontFamily = FontFamily.Serif))
    }
}

@Composable
private fun AddToBoardDialog(api: AtlasApi, card: DiscoveryCard, onDismiss: () -> Unit, onAdded: () -> Unit) {
    var boards by remember { mutableStateOf<List<CollectionSummary>>(emptyList()) }
    var newName by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    LaunchedEffect(Unit) {
        boards = runCatching { api.collections() }.getOrNull()?.collections.orEmpty()
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Add to a board") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(value = newName, onValueChange = { newName = it }, label = { Text("New board name") })
                error?.let { Text(it, color = AtlasColors.muted) }
                boards.forEach { board ->
                    TextButton(onClick = {
                        scope.launch {
                            runCatching { api.addCollectionItem(board.id, card.id) }
                                .onSuccess { onAdded() }
                                .onFailure { error = "Couldn't add that to a board. Try again." }
                        }
                    }) { Text(board.name) }
                }
            }
        },
        confirmButton = {
            Button(
                onClick = {
                    val trimmed = newName.trim()
                    if (trimmed.isEmpty()) return@Button
                    scope.launch {
                        runCatching {
                            val created = api.createCollection(CreateCollectionRequest(trimmed))
                            api.addCollectionItem(created.id, card.id)
                        }.onSuccess { onAdded() }
                            .onFailure { error = "Couldn't add that to a board. Try again." }
                    }
                },
                enabled = newName.trim().isNotEmpty(),
            ) { Text("Create and add") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

@Composable
fun BoardsScreen(api: AtlasApi, notices: ReadyNoticeCenter, onBack: () -> Unit) {
    var collections by remember { mutableStateOf<List<CollectionSummary>>(emptyList()) }
    var message by remember { mutableStateOf<String?>(null) }
    var newName by remember { mutableStateOf("") }
    var openId by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    suspend fun load() {
        runCatching { api.collections() }
            .onSuccess {
                collections = it.collections
                message = null
            }
            .onFailure {
                collections = emptyList()
                message = "Boards aren't available right now. Try again."
            }
    }
    LaunchedEffect(Unit) { load() }
    val open = collections.find { it.id == openId }
    if (open != null) {
        BoardDetailScreen(api = api, notices = notices, board = open, onBack = { openId = null })
        return
    }
    Column(Modifier.padding(16.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        TextButton(onClick = onBack) { Text("Back") }
        Text("Boards", style = MaterialTheme.typography.headlineMedium.copy(fontFamily = FontFamily.Serif))
        Text("Boards are private collections you build from suggestions and captures.", color = AtlasColors.muted)
        OutlinedTextField(value = newName, onValueChange = { newName = it }, label = { Text("Board name") }, modifier = Modifier.fillMaxWidth())
        Button(
            onClick = {
                val trimmed = newName.trim()
                if (trimmed.isEmpty()) return@Button
                scope.launch {
                    runCatching { api.createCollection(CreateCollectionRequest(trimmed)) }
                        .onSuccess {
                            newName = ""
                            collections = listOf(it) + collections
                        }
                        .onFailure { message = "Couldn't create that board. Try a different name." }
                }
            },
            enabled = newName.trim().isNotEmpty(),
        ) { Text("Create board") }
        message?.let { Text(it, color = AtlasColors.muted) }
        if (collections.isEmpty() && message == null) {
            Text("No boards yet. Create a board, then add suggestions from Feed.", color = AtlasColors.muted)
        }
        collections.chunked(2).forEach { row ->
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                row.forEach { board ->
                    Column(
                        Modifier.weight(1f).clickable { openId = board.id },
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        BoardCover(board)
                        Text(board.name, style = MaterialTheme.typography.titleSmall.copy(fontFamily = FontFamily.Serif), maxLines = 2)
                        Text("${board.itemCount} ${if (board.itemCount == 1) "item" else "items"}", color = AtlasColors.muted, style = MaterialTheme.typography.labelSmall)
                    }
                }
                if (row.size == 1) Spacer(Modifier.weight(1f))
            }
        }
    }
}

@Composable
internal fun BoardCover(board: CollectionSummary) {
    val urls = board.cover.mapNotNull { it.resolved(AtlasApiBase) }.take(4)
    Box(Modifier.fillMaxWidth().aspectRatio(1f).clip(RoundedCornerShape(14.dp)).background(AtlasColors.quiet)) {
        when {
            urls.isEmpty() -> {}
            urls.size == 1 -> RemoteImage(urls[0], Modifier.fillMaxSize(), contentDescription = board.name)
            else -> {
                Column {
                    urls.chunked(2).forEach { pair ->
                        Row(Modifier.weight(1f)) {
                            pair.forEach { url ->
                                RemoteImage(url, Modifier.weight(1f).fillMaxSize(), contentDescription = null)
                            }
                            if (pair.size == 1) Spacer(Modifier.weight(1f))
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun BoardDetailScreen(api: AtlasApi, notices: ReadyNoticeCenter, board: CollectionSummary, onBack: () -> Unit) {
    var members by remember { mutableStateOf<List<CollectionMember>>(emptyList()) }
    var message by remember { mutableStateOf<String?>(null) }
    var opened by remember { mutableStateOf<DiscoveryCard?>(null) }
    var adding by remember { mutableStateOf<DiscoveryCard?>(null) }
    LaunchedEffect(board.id) {
        runCatching { api.collection(board.id) }
            .onSuccess {
                members = it.items
                message = null
            }
            .onFailure { message = "This board isn't available right now." }
    }
    opened?.let { card ->
        FeedCardDetail(
            api = api,
            card = card,
            notices = notices,
            onBack = { opened = null },
            onAddToBoard = { adding = card },
            onOpenRelated = { opened = it },
        )
        adding?.let { addCard ->
            AddToBoardDialog(api = api, card = addCard, onDismiss = { adding = null }, onAdded = { adding = null })
        }
        return
    }
    Column(Modifier.padding(16.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        TextButton(onClick = onBack) { Text("Back") }
        Text(board.name, style = MaterialTheme.typography.headlineMedium.copy(fontFamily = FontFamily.Serif))
        message?.let { Text(it, color = AtlasColors.muted) }
        if (members.isEmpty() && message == null) {
            Text("Nothing on this board yet. Add suggestions from Feed.", color = AtlasColors.muted)
        }
        members.chunked(2).forEach { row ->
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                row.forEach { member ->
                    Box(Modifier.weight(1f)) {
                        FeedCardTile(card = member.item, onOpen = { opened = member.item })
                    }
                }
                if (row.size == 1) Spacer(Modifier.weight(1f))
            }
        }
    }
}
