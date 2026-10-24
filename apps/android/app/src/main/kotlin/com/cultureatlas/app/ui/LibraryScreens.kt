package com.cultureatlas.app.ui

import android.Manifest
import android.provider.Settings
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.Crossfade
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.rememberScrollableState
import androidx.compose.foundation.gestures.scrollable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
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
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.withFrameNanos
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
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
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import com.cultureatlas.app.notify.ReadyNoticeCenter
import com.cultureatlas.capture.core.contract.CollectionMember
import com.cultureatlas.capture.core.contract.CollectionSummary
import com.cultureatlas.capture.core.contract.CreateCollectionRequest
import com.cultureatlas.capture.core.contract.DiscoveryCard
import com.cultureatlas.capture.core.contract.TasteCategory
import com.cultureatlas.capture.core.feed.FeedConveyor
import com.cultureatlas.capture.core.net.AtlasApi
import com.cultureatlas.capture.core.net.addCollectionItem
import com.cultureatlas.capture.core.net.collection
import com.cultureatlas.capture.core.net.collections
import com.cultureatlas.capture.core.net.createCollection
import com.cultureatlas.capture.core.net.discoverRelated
import com.cultureatlas.capture.core.net.discoveries
import com.cultureatlas.capture.core.net.item
import com.cultureatlas.capture.core.onboarding.OnboardingCopy
import com.cultureatlas.capture.core.result.ReferenceCopy
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.math.abs
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Living interest feed from GET /v1/discoveries. Visual-first: licensed pictures when we have them,
 * typographic posters otherwise — never a stand-in portrait of a person or film.
 *
 * The grid is a conveyor ([FeedConveyor]): two columns drift slowly upward at slightly different
 * speeds; cards enter from below and leave off the top, and the next waiting card joins the
 * bottom of that column. Cards never overlap. Touching pauses the drift (it resumes 2s after
 * release). Reduce Motion: no drift; cards swap in place with a crossfade.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FeedScreen(feed: FeedModel, notices: ReadyNoticeCenter, onOpen: (DiscoveryCard) -> Unit) {
    val exploring by notices.exploring.collectAsState()
    val toast by notices.toast.collectAsState()
    val scope = rememberCoroutineScope()
    val haptics = rememberHaptics()
    // The pool lives in [feed]: coming back to this tab resumes the drift, it never starts empty.
    LaunchedEffect(Unit) {
        if (!feed.loadedOnce || feed.pool.isEmpty()) feed.load()
        // Right after onboarding this is how the seed's real cards replace the examples (no reload).
        while (true) {
            delay(feed.pollMillis)
            feed.load(refresh = false)
        }
    }
    PullToRefreshBox(
        isRefreshing = feed.refreshing,
        onRefresh = {
            haptics.tick()
            feed.refreshing = true
            scope.launch { feed.load(refresh = true) }
        },
    ) {
        // A scrollable that consumes nothing: a pull anywhere (header, empty state, or back past
        // the conveyor's oldest card) reaches pull-to-refresh, so refresh is always available.
        Column(
            Modifier
                .fillMaxSize()
                .scrollable(rememberScrollableState { 0f }, Orientation.Vertical)
                .padding(horizontal = 16.dp),
        ) {
            Column(
                Modifier.padding(top = 16.dp, bottom = 12.dp).animateContentSize(),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text("Feed", Modifier.semantics { heading() }, style = MaterialTheme.typography.headlineMedium.copy(fontFamily = FontFamily.Serif))
                Text("A feed of what you're into. Pull down for more.", color = AtlasColors.muted, style = MaterialTheme.typography.bodySmall)
                AnimatedVisibility(visible = feed.exampleFeed, enter = fadeIn() + expandVertically(), exit = fadeOut() + shrinkVertically()) {
                    Text("These are example results until your personal feed is ready.", color = AtlasColors.muted, style = MaterialTheme.typography.bodySmall)
                }
                AnimatedVisibility(visible = exploring.isNotEmpty() || toast != null, enter = fadeIn() + expandVertically(), exit = fadeOut() + shrinkVertically()) {
                    if (exploring.isNotEmpty()) AnalysisLookingBanner() else AnalysisReadyBanner()
                }
                feed.message?.let { Text(it, color = AtlasColors.muted) }
                if (!feed.loading && feed.pool.isEmpty() && feed.message == null) {
                    Text("No suggestions yet", style = MaterialTheme.typography.titleMedium.copy(fontFamily = FontFamily.Serif))
                    Text("Finish picking your interests, then pull to refresh.", color = AtlasColors.muted)
                }
            }
            Box(Modifier.weight(1f).fillMaxWidth()) {
                DriftingCards(
                    conveyor = feed.conveyor,
                    cards = feed.pool,
                    orientation = Orientation.Vertical,
                    lanes = 2,
                    speeds = FEED_LANE_SPEEDS,
                    rotateWhenStill = true,
                    modifier = Modifier.fillMaxSize(),
                    onOpen = onOpen,
                )
                // First load: two columns of soft placeholders instead of a word.
                androidx.compose.animation.AnimatedVisibility(
                    visible = feed.loading && feed.pool.isEmpty(),
                    enter = fadeIn(),
                    exit = fadeOut(tween(420)),
                ) {
                    FeedSkeleton()
                }
            }
        }
    }
}

@Composable
private fun FeedSkeleton() {
    BoxWithConstraints(Modifier.fillMaxSize().semantics { contentDescription = "Loading suggestions" }) {
        val laneWidth = (maxWidth - TILE_GAP) / 2
        Row(horizontalArrangement = Arrangement.spacedBy(TILE_GAP)) {
            repeat(2) { lane ->
                Column(
                    Modifier.width(laneWidth).offset(y = if (lane == 1) 48.dp else 0.dp),
                    verticalArrangement = Arrangement.spacedBy(TILE_GAP),
                ) {
                    repeat(3) {
                        Shimmer(Modifier.fillMaxWidth().aspectRatio(4f / 5f).clip(RoundedCornerShape(14.dp)))
                        Shimmer(Modifier.width(laneWidth * 0.7f).height(14.dp).clip(RoundedCornerShape(7.dp)))
                    }
                }
            }
        }
    }
}

/** dp per second, per column. Staggered so the columns never move in lockstep. */
private val FEED_LANE_SPEEDS = listOf(12.dp, 15.5.dp)
private val RAIL_SPEED = listOf(14.dp)
private val TILE_GAP = 12.dp
private val RAIL_TILE_WIDTH = 140.dp

private fun feedConveyor() = FeedConveyor<DiscoveryCard>(idOf = { it.id }, picturedOf = { it.image != null })

/** Caption area under the 4:5 picture. Fixed, so every tile is the same height and the conveyor can space them exactly. */
@Composable
private fun tileCaptionHeight(): Dp = 62.dp * LocalDensity.current.fontScale.coerceAtLeast(1f)

@Composable
private fun tileHeight(width: Dp): Dp = width * 1.25f + 8.dp + tileCaptionHeight()

/**
 * Renders a [FeedConveyor]: cards drift along [orientation] on the frame clock and are placed
 * with layout-phase offsets (no recomposition per frame). Keys are card ids. The user's drag or
 * fling scrolls the conveyor and pauses its drift; whatever it cannot consume (a pull back past
 * the oldest card) goes to the parent, so pull-to-refresh keeps working.
 */
@Composable
private fun DriftingCards(
    conveyor: FeedConveyor<DiscoveryCard>,
    cards: List<DiscoveryCard>,
    orientation: Orientation,
    lanes: Int,
    speeds: List<Dp>,
    rotateWhenStill: Boolean,
    modifier: Modifier,
    tileWidth: Dp? = null,
    onOpen: (DiscoveryCard) -> Unit,
) {
    val reduceMotion = prefersReducedMotion()
    val density = LocalDensity.current
    var version by remember { mutableIntStateOf(conveyor.version) }
    var motion by remember { mutableLongStateOf(0L) }
    fun sync() {
        if (version != conveyor.version) version = conveyor.version
    }
    var touching by remember { mutableStateOf(false) }
    val scrollState = rememberScrollableState { delta ->
        // Dragging toward the near edge (up / left) moves the conveyor forward.
        val consumed = conveyor.scrollBy(-delta)
        if (consumed != 0f) motion++
        sync()
        -consumed
    }
    LaunchedEffect(scrollState.isScrollInProgress) {
        if (scrollState.isScrollInProgress) conveyor.hold() else if (!touching) conveyor.release()
    }
    LaunchedEffect(reduceMotion, rotateWhenStill) {
        if (reduceMotion) {
            if (!rotateWhenStill) return@LaunchedEffect
            while (true) {
                delay(6_000)
                if (!touching && !scrollState.isScrollInProgress && conveyor.rotate() != null) sync()
            }
        } else {
            var last = -1L
            while (true) {
                withFrameNanos { now ->
                    if (last >= 0) {
                        val wasPaused = conveyor.isPaused
                        conveyor.tick((now - last) / 1_000_000_000.0)
                        if (!wasPaused || !conveyor.isPaused) motion++
                        sync()
                    }
                    last = now
                }
            }
        }
    }
    BoxWithConstraints(
        modifier
            .clipToBounds()
            .pointerInput(conveyor) {
                // A finger resting on the feed holds it still, so a moving card is easy to tap.
                awaitEachGesture {
                    awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
                    touching = true
                    conveyor.hold()
                    do {
                        val event = awaitPointerEvent(PointerEventPass.Initial)
                    } while (event.changes.any { it.pressed })
                    touching = false
                    if (!scrollState.isScrollInProgress) conveyor.release()
                }
            }
            .scrollable(scrollState, orientation),
    ) {
        val vertical = orientation == Orientation.Vertical
        val laneWidth = tileWidth ?: ((maxWidth - TILE_GAP * (lanes - 1)) / lanes)
        val height = tileHeight(laneWidth)
        val extent = with(density) { (if (vertical) height else laneWidth).toPx() }
        val gap = with(density) { TILE_GAP.toPx() }
        val viewport = with(density) { (if (vertical) maxHeight else maxWidth).toPx() }
        val speedsPx = with(density) { speeds.map { it.toPx() } }
        val laneStride = with(density) { (laneWidth + TILE_GAP).roundToPx() }
        remember(lanes, extent, gap, viewport, speedsPx) {
            // Guard against unbounded constraints (the conveyor needs a finite viewport).
            if (viewport > 0f && viewport.isFinite() && extent.isFinite()) conveyor.configure(lanes, extent, gap, viewport, speedsPx, stagger = extent * 0.42f)
            true
        }
        remember(cards) {
            conveyor.setPool(cards)
            true
        }
        // Reading `version` subscribes this scope to structure changes (cards added, removed or swapped).
        if (version >= 0) {
            for (entry in conveyor.entries()) {
                val card = entry.card
                key(if (reduceMotion) "slot-${entry.key}" else card.id) {
                    Box(
                        Modifier
                            .size(laneWidth, height)
                            .offset {
                                motion // re-run placement every drift frame without recomposing
                                val along = conveyor.positionOf(entry).roundToInt()
                                val across = entry.lane * laneStride
                                if (vertical) IntOffset(across, along) else IntOffset(along, across)
                            },
                    ) {
                        if (reduceMotion) {
                            Crossfade(targetState = card, label = "feed-swap") { shown ->
                                FeedCardTile(card = shown, onOpen = { onOpen(shown) })
                            }
                        } else {
                            FeedCardTile(card = card, onOpen = { onOpen(card) })
                        }
                    }
                }
            }
        }
        SideEffect { sync() }
    }
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

/** A fixed-height tile: 4:5 picture (or poster) plus a fixed caption area, so tiles never overlap. */
@Composable
internal fun FeedCardTile(card: DiscoveryCard, onOpen: () -> Unit, modifier: Modifier = Modifier) {
    Column(
        modifier
            .fillMaxWidth()
            .tappable(onClick = onOpen)
            .semantics(mergeDescendants = true) {
                contentDescription = if (card.isExample) "${card.title}. Example result" else card.title
            },
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        FeedCardVisual(
            card,
            Modifier
                .fillMaxWidth()
                .aspectRatio(4f / 5f)
                .sharedCard(card.id)
                .clip(RoundedCornerShape(14.dp)),
        )
        Column(Modifier.height(tileCaptionHeight()).clipToBounds()) {
            Text(card.title, style = MaterialTheme.typography.titleSmall.copy(fontFamily = FontFamily.Serif), maxLines = 2, overflow = TextOverflow.Ellipsis)
            if (card.isExample) Text("Example result", color = AtlasColors.muted, style = MaterialTheme.typography.labelSmall, maxLines = 1)
        }
    }
}

/**
 * Licensed picture crossfading in over the card's typographic poster: the
 * poster shows while the picture loads and stays if it fails. A card without
 * a picture is only the poster — never a stand-in portrait.
 */
@Composable
internal fun FeedCardVisual(card: DiscoveryCard, modifier: Modifier) {
    val imageUrl = card.image?.resolved(AtlasApiBase)
    AtlasImage(
        url = imageUrl,
        modifier = modifier,
        contentDescription = card.image?.alt ?: card.title,
        placeholder = { CardPoster(card, Modifier.fillMaxSize(), quiet = imageUrl != null) },
    )
}

@Composable
private fun CardPoster(card: DiscoveryCard, modifier: Modifier, quiet: Boolean) {
    Box(modifier.background(posterFill(card.category)), contentAlignment = Alignment.BottomStart) {
        // While a picture is on its way the poster's words stay soft, so the crossfade reads as one image.
        Column(
            Modifier.padding(14.dp).graphicsLayer { alpha = if (quiet) 0.55f else 1f },
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            card.category?.let {
                Text(OnboardingCopy.group(it), color = Color.White.copy(alpha = 0.8f), style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.SemiBold)
            }
            Text(card.title, color = Color.White, style = MaterialTheme.typography.titleMedium.copy(fontFamily = FontFamily.Serif), maxLines = 4)
            card.subtitle?.let { Text(it, color = Color.White.copy(alpha = 0.75f), style = MaterialTheme.typography.bodySmall, maxLines = 2) }
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

/** Back affordance for pushed screens: an arrow plus the screen's name, fading in as you scroll. */
@Composable
internal fun AtlasTopBar(title: String?, onBack: () -> Unit, titleAlpha: Float = 1f) {
    Row(
        Modifier.fillMaxWidth().height(56.dp).padding(horizontal = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        IconButton(onClick = onBack, modifier = Modifier.semantics { contentDescription = "Back" }) {
            Icon(AtlasIcons.Back, contentDescription = null, tint = AtlasColors.ink)
        }
        if (title != null) {
            Text(
                title,
                Modifier.weight(1f).graphicsLayer { alpha = titleAlpha },
                style = MaterialTheme.typography.titleMedium.copy(fontFamily = FontFamily.Serif),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

/**
 * Pinch to zoom. Focus is a separate tool: arm it, drag a box, then confirm. Analysis runs only on
 * the owner's own captures — suggestion cards fail closed. Order matches iOS: details, references,
 * Similar, then the focus tool and Add to a board. Back with focus armed leaves focus first.
 */
@Composable
fun FeedCardDetail(
    api: AtlasApi,
    card: DiscoveryCard,
    notices: ReadyNoticeCenter,
    feed: FeedModel,
    onBack: () -> Unit,
    onOpenRelated: (DiscoveryCard) -> Unit,
) {
    var scale by remember { mutableFloatStateOf(1f) }
    var highlight by remember { mutableStateOf<Rect?>(null) }
    var focusArmed by remember { mutableStateOf(false) }
    var showFocusHint by remember { mutableStateOf(false) }
    var looking by remember { mutableStateOf(false) }
    var analysisNote by remember { mutableStateOf<String?>(null) }
    val cached = remember(card.id) { feed.cachedDetail(card.id) }
    var detail by remember { mutableStateOf(cached) }
    var detailNote by remember { mutableStateOf<String?>(null) }
    var related by remember { mutableStateOf(cached?.related.orEmpty()) }
    var relatedState by remember { mutableStateOf(cached?.relatedState ?: "none") }
    var adding by remember { mutableStateOf(false) }
    val exploring by notices.exploring.collectAsState()
    val toast by notices.toast.collectAsState()
    val scope = rememberCoroutineScope()
    val haptics = rememberHaptics()
    val uriHandler = LocalUriHandler.current
    val askNotifications = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {}
    val inFlight = looking || card.id.lowercase() in exploring
    val shownCard = detail?.item ?: card
    val scroll = rememberScrollState()
    BackHandler(enabled = focusArmed) {
        focusArmed = false
        highlight = null
        showFocusHint = false
    }
    LaunchedEffect(card.id) {
        runCatching { api.item(card.id) }
            .onSuccess {
                detail = it
                related = it.related
                relatedState = it.relatedState
                detailNote = null
                feed.rememberDetail(it)
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
                feed.rememberDetail(loaded)
                if (loaded.relatedState != "pending") return@LaunchedEffect
            }
            if (related.isEmpty()) relatedState = "none"
        }
    }
    Column(Modifier.fillMaxSize()) {
        // The title joins the bar once the big title has scrolled away.
        val titleAlpha = ((scroll.value - 420f) / 160f).coerceIn(0f, 1f)
        AtlasTopBar(shownCard.title, onBack, titleAlpha)
        Column(
            Modifier.fillMaxSize().verticalScroll(scroll).padding(start = 16.dp, end = 16.dp, bottom = 32.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Box(
                Modifier
                    .fillMaxWidth()
                    .aspectRatio(4f / 5f)
                    .sharedCard(card.id)
                    .clip(RoundedCornerShape(16.dp))
                    .graphicsLayer { scaleX = scale; scaleY = scale }
                    .pointerInput(focusArmed) {
                        awaitEachGesture {
                            val down = awaitFirstDown(requireUnconsumed = false)
                            val start = down.position
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
            // Sourced detail arrives after the card: it fades in rather than popping the layout.
            Column(Modifier.animateContentSize(tween(320)), verticalArrangement = Arrangement.spacedBy(12.dp)) {
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
                        // Qualified means a resemblance (same phrasing as the web result page).
                        Text(ReferenceCopy.phrase(ref), color = AtlasColors.muted, style = MaterialTheme.typography.bodySmall)
                        ReferenceCopy.attribution(ref)?.let {
                            Text(it, color = AtlasColors.muted, style = MaterialTheme.typography.labelSmall)
                        }
                    }
                }
            }
            Text("Similar", style = MaterialTheme.typography.titleMedium.copy(fontFamily = FontFamily.Serif))
            Crossfade(targetState = relatedState == "pending" && related.isEmpty(), label = "similar") { waiting ->
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    when {
                        waiting -> {
                            AnalysisLookingBanner()
                            Text("Looking for similar suggestions.", color = AtlasColors.muted, style = MaterialTheme.typography.bodySmall)
                        }
                        related.isEmpty() -> Text("No similar suggestions yet.", color = AtlasColors.muted, style = MaterialTheme.typography.bodySmall)
                        else -> {
                            if (relatedState == "pending") {
                                Text("Looking for more like this.", color = AtlasColors.muted, style = MaterialTheme.typography.bodySmall)
                            }
                            // Same conveyor as the feed: one horizontal lane drifting left through the cached related cards.
                            val rail = related.filter { it.image != null }.ifEmpty { related }
                            val railConveyor = remember(card.id) { feedConveyor() }
                            DriftingCards(
                                conveyor = railConveyor,
                                cards = rail,
                                orientation = Orientation.Horizontal,
                                lanes = 1,
                                speeds = RAIL_SPEED,
                                rotateWhenStill = false,
                                tileWidth = RAIL_TILE_WIDTH,
                                modifier = Modifier.fillMaxWidth().height(tileHeight(RAIL_TILE_WIDTH)),
                                onOpen = onOpenRelated,
                            )
                        }
                    }
                }
            }
            AnimatedVisibility(visible = inFlight || toast != null, enter = fadeIn() + expandVertically(), exit = fadeOut() + shrinkVertically()) {
                if (inFlight) AnalysisLookingBanner() else AnalysisReadyBanner()
            }
            analysisNote?.let { Text(it, color = AtlasColors.muted, style = MaterialTheme.typography.bodySmall) }
            detailNote?.let { Text(it, color = AtlasColors.muted, style = MaterialTheme.typography.bodySmall) }
            Column(Modifier.animateContentSize(tween(260)), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                if (focusArmed) {
                    Text("Focus is on. Drag a box on the picture, then confirm. Pinch still zooms.", color = AtlasColors.muted, style = MaterialTheme.typography.bodySmall)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedButton(
                            onClick = {
                                haptics.tick()
                                focusArmed = false
                                highlight = null
                                showFocusHint = false
                            },
                            modifier = Modifier.weight(1f),
                        ) { Text("Cancel focus") }
                        if (highlight != null) {
                            Button(
                                onClick = {
                                    haptics.press()
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
                                        if (started) haptics.confirm() else haptics.reject()
                                        if (!started) {
                                            analysisNote = "Exploring isn't available right now. The picture is still on this phone."
                                        }
                                        focusArmed = false
                                    }
                                },
                                modifier = Modifier.weight(1f),
                            ) { Text("Look at this area") }
                        }
                    }
                } else {
                    OutlinedButton(
                        onClick = {
                            haptics.tick()
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
            }
            Button(
                onClick = {
                    haptics.press()
                    adding = true
                },
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
            ) { Text("Add to a board") }
        }
    }
    if (adding) {
        AddToBoardDialog(api = api, card = card, onDismiss = { adding = false }, onAdded = { adding = false })
    }
}

@Composable
internal fun AnalysisLookingBanner() {
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
internal fun AnalysisReadyBanner() {
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
    var savedTo by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val haptics = rememberHaptics()
    LaunchedEffect(Unit) {
        boards = runCatching { api.collections() }.getOrNull()?.collections.orEmpty()
    }
    // A short, visible "Added" beat before the dialog closes.
    LaunchedEffect(savedTo) {
        if (savedTo != null) {
            delay(650)
            onAdded()
        }
    }
    fun saved(name: String) {
        haptics.confirm()
        savedTo = name
    }
    fun failed() {
        haptics.reject()
        error = "Couldn't add that to a board. Try again."
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Add to a board") },
        text = {
            Crossfade(targetState = savedTo, label = "board-saved") { name ->
                if (name != null) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Text("✓", color = AtlasColors.olive, fontWeight = FontWeight.Bold)
                        Text("Added to $name", style = MaterialTheme.typography.titleSmall.copy(fontFamily = FontFamily.Serif))
                    }
                } else {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedTextField(value = newName, onValueChange = { newName = it }, label = { Text("New board name") })
                        error?.let { Text(it, color = AtlasColors.muted) }
                        boards.forEach { board ->
                            TextButton(onClick = {
                                scope.launch {
                                    runCatching { api.addCollectionItem(board.id, card.id) }
                                        .onSuccess { saved(board.name) }
                                        .onFailure { failed() }
                                }
                            }) { Text(board.name) }
                        }
                    }
                }
            }
        },
        confirmButton = {
            if (savedTo == null) {
                Button(
                    onClick = {
                        val trimmed = newName.trim()
                        if (trimmed.isEmpty()) return@Button
                        scope.launch {
                            runCatching {
                                val created = api.createCollection(CreateCollectionRequest(trimmed))
                                api.addCollectionItem(created.id, card.id)
                            }.onSuccess { saved(trimmed) }
                                .onFailure { failed() }
                        }
                    },
                    enabled = newName.trim().isNotEmpty(),
                ) { Text("Create and add") }
            }
        },
        dismissButton = { if (savedTo == null) TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

@Composable
fun BoardsScreen(api: AtlasApi, onBack: () -> Unit, onOpenBoard: (CollectionSummary) -> Unit) {
    var collections by remember { mutableStateOf<List<CollectionSummary>>(emptyList()) }
    var loaded by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }
    var newName by remember { mutableStateOf("") }
    val scope = rememberCoroutineScope()
    val haptics = rememberHaptics()
    LaunchedEffect(Unit) {
        runCatching { api.collections() }
            .onSuccess {
                collections = it.collections
                message = null
            }
            .onFailure { if (collections.isEmpty()) message = "Boards aren't available right now. Try again." }
        loaded = true
    }
    Column(Modifier.fillMaxSize()) {
        AtlasTopBar(null, onBack)
        Column(
            Modifier.padding(horizontal = 16.dp).verticalScroll(rememberScrollState()).padding(bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
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
                                haptics.confirm()
                                newName = ""
                                collections = listOf(it) + collections
                            }
                            .onFailure {
                                haptics.reject()
                                message = "Couldn't create that board. Try a different name."
                            }
                    }
                },
                enabled = newName.trim().isNotEmpty(),
            ) { Text("Create board") }
            message?.let { Text(it, color = AtlasColors.muted) }
            if (loaded && collections.isEmpty() && message == null) {
                Text("No boards yet. Create a board, then add suggestions from Feed.", color = AtlasColors.muted)
            }
            if (!loaded) {
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    repeat(2) { Shimmer(Modifier.weight(1f).aspectRatio(1f).clip(RoundedCornerShape(14.dp))) }
                }
            }
            collections.chunked(2).forEach { row ->
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    row.forEach { board ->
                        key(board.id) {
                            Column(
                                Modifier.weight(1f).tappable { onOpenBoard(board) },
                                verticalArrangement = Arrangement.spacedBy(8.dp),
                            ) {
                                BoardCover(board)
                                Text(board.name, style = MaterialTheme.typography.titleSmall.copy(fontFamily = FontFamily.Serif), maxLines = 2)
                                Text("${board.itemCount} ${if (board.itemCount == 1) "item" else "items"}", color = AtlasColors.muted, style = MaterialTheme.typography.labelSmall)
                            }
                        }
                    }
                    if (row.size == 1) Spacer(Modifier.weight(1f))
                }
            }
        }
    }
}

@Composable
internal fun BoardCover(board: CollectionSummary, modifier: Modifier = Modifier) {
    val urls = board.cover.mapNotNull { it.resolved(AtlasApiBase) }.take(4)
    Box(modifier.fillMaxWidth().aspectRatio(1f).clip(RoundedCornerShape(14.dp)).background(AtlasColors.quiet)) {
        when {
            urls.isEmpty() -> Text(
                board.name.take(1).uppercase(),
                Modifier.align(Alignment.Center),
                color = AtlasColors.muted,
                style = MaterialTheme.typography.headlineMedium.copy(fontFamily = FontFamily.Serif),
            )
            urls.size == 1 -> AtlasImage(urls[0], Modifier.fillMaxSize(), contentDescription = board.name)
            else -> {
                Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    urls.chunked(2).forEach { pair ->
                        Row(Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                            pair.forEach { url ->
                                AtlasImage(url, Modifier.weight(1f).fillMaxSize(), contentDescription = null)
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
fun BoardDetailScreen(api: AtlasApi, board: CollectionSummary, onBack: () -> Unit, onOpenCard: (DiscoveryCard) -> Unit) {
    var members by remember { mutableStateOf<List<CollectionMember>>(emptyList()) }
    var loaded by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(board.id) {
        runCatching { api.collection(board.id) }
            .onSuccess {
                members = it.items
                message = null
            }
            .onFailure { message = "This board isn't available right now." }
        loaded = true
    }
    Column(Modifier.fillMaxSize()) {
        AtlasTopBar(null, onBack)
        Column(
            Modifier.padding(horizontal = 16.dp).verticalScroll(rememberScrollState()).padding(bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(board.name, style = MaterialTheme.typography.headlineMedium.copy(fontFamily = FontFamily.Serif))
            message?.let { Text(it, color = AtlasColors.muted) }
            if (loaded && members.isEmpty() && message == null) {
                Text("Nothing on this board yet. Add suggestions from Feed.", color = AtlasColors.muted)
            }
            if (!loaded) {
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    repeat(2) { Shimmer(Modifier.weight(1f).aspectRatio(4f / 5f).clip(RoundedCornerShape(14.dp))) }
                }
            }
            members.chunked(2).forEach { row ->
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    row.forEach { member ->
                        key(member.membershipId) {
                            Box(Modifier.weight(1f)) {
                                FeedCardTile(card = member.item, onOpen = { onOpenCard(member.item) })
                            }
                        }
                    }
                    if (row.size == 1) Spacer(Modifier.weight(1f))
                }
            }
        }
    }
}
