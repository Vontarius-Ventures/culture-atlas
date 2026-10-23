package com.cultureatlas.app.ui

import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.ContentTransform
import androidx.compose.animation.ExperimentalSharedTransitionApi
import androidx.compose.animation.SharedTransitionLayout
import androidx.compose.animation.SizeTransform
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.slideOutVertically
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
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBarItemDefaults
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
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
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
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.cultureatlas.app.AppController
import com.cultureatlas.app.AppGraph
import com.cultureatlas.app.BuildConfig
import com.cultureatlas.app.notify.AtlasMessagingService
import com.cultureatlas.app.onboarding.OnboardingController
import com.cultureatlas.capture.core.contract.CollectionSummary
import com.cultureatlas.capture.core.contract.DiscoveryCard
import com.cultureatlas.capture.core.contract.LibraryEntry
import com.cultureatlas.capture.core.nav.BackStack
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
    /** Typographic poster fills when a feed card has no licensed image. */
    val posterPlay = Color(0xFF475161)
    val posterWatch = Color(0xFF38332E)
    val posterEat = Color(0xFF6B4738)
}

enum class Tab { FEED, CAPTURE, LIBRARY, SETTINGS }

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
                // Nothing of the previous account's private pictures stays in memory.
                graph.imageLoader.memoryCache?.clear()
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
            // Keeps the last toast while it slides away.
            var shownToast by remember { mutableStateOf(toast) }
            if (toast != null) shownToast = toast
            AnimatedVisibility(
                visible = toast != null,
                modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 72.dp),
                enter = slideInVertically(spring(dampingRatio = 0.75f, stiffness = Spring.StiffnessMediumLow)) { it } + fadeIn(),
                exit = slideOutVertically(tween(220)) { it } + fadeOut(tween(180)),
            ) {
                shownToast?.let { t ->
                    ReadyToastBar(
                        ReadyNoticeCopy.TITLE, ReadyNoticeCopy.OPEN, ReadyNoticeCopy.DISMISS,
                        onOpen = { graph.notices.open(t) },
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

/** A screen pushed above the tab roots. Back pops one; Similar cards stack. */
sealed interface Screen {
    data object Camera : Screen
    data object Music : Screen
    data object Glasses : Screen
    data object Taste : Screen
    data object Boards : Screen
    data class Board(val board: CollectionSummary) : Screen
    data class Card(val card: DiscoveryCard) : Screen
    /** The native analysis result. [entry] is set when opened from a Library tile. */
    data class Result(val mediaId: String, val analysisId: String?, val entry: LibraryEntry? = null) : Screen
}

/** Camera, music and glasses are full-bleed; a card or a result reads best without the bar too. */
private fun Screen?.showsTabBar(): Boolean = this == null || this is Screen.Boards || this is Screen.Board || this is Screen.Taste

private fun Screen.stateKey(depth: Int): String = "$depth:" + when (this) {
    is Screen.Card -> "card:${card.id}"
    is Screen.Board -> "board:${board.id}"
    is Screen.Result -> "result:$mediaId:${analysisId.orEmpty()}"
    else -> toString()
}

internal data class NavFrame<R>(val tab: Tab, val screen: R?, val depth: Int)

private val Tab.label: String
    get() = when (this) {
        Tab.FEED -> "Feed"
        Tab.CAPTURE -> "Capture"
        Tab.LIBRARY -> "Library"
        Tab.SETTINGS -> "Settings"
    }

private val Tab.icon: ImageVector
    get() = when (this) {
        Tab.FEED -> AtlasIcons.Feed
        Tab.CAPTURE -> AtlasIcons.Camera
        Tab.LIBRARY -> AtlasIcons.Library
        Tab.SETTINGS -> AtlasIcons.Settings
    }

/**
 * Push slides in from the trailing edge over a gently receding screen; Back
 * reverses it with the leaving screen on top; a tab switch is a soft crossfade.
 */
private fun shellTransition(direction: BackStack.Direction): ContentTransform {
    val ease = FastOutSlowInEasing
    return when (direction) {
        BackStack.Direction.FORWARD -> ContentTransform(
            targetContentEnter = slideInHorizontally(tween(380, easing = ease)) { it / 4 } + fadeIn(tween(260, delayMillis = 40)),
            initialContentExit = slideOutHorizontally(tween(380, easing = ease)) { -it / 12 } + fadeOut(tween(200)),
            sizeTransform = SizeTransform(clip = false),
        )
        BackStack.Direction.BACK -> ContentTransform(
            targetContentEnter = slideInHorizontally(tween(340, easing = ease)) { -it / 12 } + fadeIn(tween(240)),
            initialContentExit = slideOutHorizontally(tween(340, easing = ease)) { it / 4 } + fadeOut(tween(220, delayMillis = 60)),
            targetContentZIndex = -1f,
            sizeTransform = SizeTransform(clip = false),
        )
        BackStack.Direction.NONE -> ContentTransform(
            targetContentEnter = fadeIn(tween(240, delayMillis = 60)) + scaleIn(tween(320, easing = ease), initialScale = 0.985f),
            initialContentExit = fadeOut(tween(140)),
            sizeTransform = SizeTransform(clip = false),
        )
    }
}

/** Feed, Capture, Library, Settings with Material Symbols icons; the selected icon lifts with a spring. */
@Composable
internal fun AtlasTabBar(selected: Tab, onSelect: (Tab) -> Unit) {
    NavigationBar(containerColor = AtlasColors.quiet) {
        Tab.entries.forEach { t ->
            val isSelected = selected == t
            val lift by animateFloatAsState(
                targetValue = if (isSelected) 1.12f else 1f,
                animationSpec = spring(dampingRatio = 0.45f, stiffness = Spring.StiffnessMedium),
                label = "tab-icon",
            )
            NavigationBarItem(
                selected = isSelected,
                onClick = { onSelect(t) },
                icon = {
                    Icon(
                        t.icon,
                        contentDescription = null,
                        modifier = Modifier.size(24.dp).graphicsLayer { scaleX = lift; scaleY = lift },
                    )
                },
                label = { Text(t.label) },
                colors = NavigationBarItemDefaults.colors(
                    selectedIconColor = AtlasColors.ink,
                    selectedTextColor = AtlasColors.ink,
                    indicatorColor = AtlasColors.paper,
                    unselectedIconColor = AtlasColors.muted,
                    unselectedTextColor = AtlasColors.muted,
                ),
            )
        }
    }
}

@OptIn(ExperimentalSharedTransitionApi::class)
@Composable
private fun SignedInShell(graph: AppGraph, activity: ComponentActivity) {
    var nav by remember { mutableStateOf(BackStack<Tab, Screen>(tab = Tab.FEED, home = Tab.FEED)) }
    var direction by remember { mutableStateOf(BackStack.Direction.NONE) }
    fun go(step: BackStack.Step<Tab, Screen>) {
        if (step.stack == nav) return
        direction = step.direction
        nav = step.stack
    }
    val haptics = rememberHaptics()
    // Feed and Library state outlive their tabs: switching back resumes, never reloads from empty.
    val feed = remember(graph) { FeedModel(graph.api) }
    val library = remember(graph) { LibraryModel(graph.api) }
    val openRequest by graph.notices.openRequest.collectAsState()
    LaunchedEffect(openRequest) {
        val route = openRequest ?: return@LaunchedEffect
        go(nav.push(Screen.Result(route.mediaId, route.analysisId)))
        graph.notices.consumeOpenRequest()
    }
    val armed by graph.controller.armed.collectAsState()
    Scaffold(
        containerColor = AtlasColors.paper,
        topBar = { armed?.let { RemoteArmBanner(graph.controller, it) } },
        bottomBar = {
            AnimatedVisibility(
                visible = nav.top.showsTabBar(),
                enter = slideInVertically(tween(280)) { it } + fadeIn(tween(200)),
                exit = slideOutVertically(tween(240)) { it } + fadeOut(tween(160)),
            ) {
                AtlasTabBar(selected = nav.tab) { t ->
                    haptics.tick()
                    go(nav.selectTab(t))
                }
            }
        },
    ) { padding ->
        AtlasNavHost(
            nav = nav,
            direction = direction,
            onBack = { go(nav.back()) },
            stateKey = { screen, depth -> screen.stateKey(depth) },
            modifier = Modifier.padding(padding).fillMaxSize().background(AtlasColors.paper),
        ) { frame ->
                        val screen = frame.screen
                        if (screen == null) {
                            run {
                                when (frame.tab) {
                                    Tab.FEED -> FeedScreen(feed, graph.notices, onOpen = { go(nav.push(Screen.Card(it))) })
                                    Tab.LIBRARY -> LibraryScreen(
                                        graph.controller,
                                        graph.notices,
                                        graph.api,
                                        library,
                                        onBoards = { go(nav.push(Screen.Boards)) },
                                        onBoard = { go(nav.push(Screen.Board(it))) },
                                        onOpenMedia = { entry -> go(nav.push(Screen.Result(entry.media.id, null, entry))) },
                                        onCapture = { go(nav.selectTab(Tab.CAPTURE)) },
                                    )
                                    Tab.CAPTURE -> CaptureSourceScreen(
                                        graph.controller,
                                        onCamera = { go(nav.push(Screen.Camera)) },
                                        onMusic = { go(nav.push(Screen.Music)) },
                                        onGlasses = { go(nav.push(Screen.Glasses)) },
                                    )
                                    Tab.SETTINGS -> SettingsScreen(
                                        graph.controller,
                                        onGlasses = { go(nav.push(Screen.Glasses)) },
                                        onTaste = { go(nav.push(Screen.Taste)) },
                                    )
                                }
                            }
                        } else {
                            val back = { go(nav.back()) }
                            run {
                                when (screen) {
                                    Screen.Camera -> CameraScreen(graph, activity, onBack = back)
                                    Screen.Music -> MusicScreen(graph, onBack = back)
                                    Screen.Glasses -> GlassesScreen(graph, activity, onBack = back, onUseCamera = { go(nav.replaceTop(Screen.Camera)) })
                                    Screen.Taste -> TasteSettingsScreen(graph.onboarding, onBack = back)
                                    Screen.Boards -> BoardsScreen(graph.api, onBack = back, onOpenBoard = { go(nav.push(Screen.Board(it))) })
                                    is Screen.Board -> BoardDetailScreen(
                                        graph.api,
                                        screen.board,
                                        onBack = back,
                                        onOpenCard = { go(nav.push(Screen.Card(it))) },
                                    )
                                    is Screen.Card -> FeedCardDetail(
                                        api = graph.api,
                                        card = screen.card,
                                        notices = graph.notices,
                                        feed = feed,
                                        onBack = back,
                                        onOpenRelated = { go(nav.push(Screen.Card(it))) },
                                    )
                                    is Screen.Result -> AnalysisResultScreen(
                                        api = graph.api,
                                        notices = graph.notices,
                                        mediaId = screen.mediaId,
                                        analysisId = screen.analysisId,
                                        entry = screen.entry,
                                        library = library,
                                        onBack = back,
                                        onOpenCard = { go(nav.push(Screen.Card(it))) },
                                        onFeed = { go(nav.selectTab(Tab.FEED)) },
                                    )
                                }
                            }
                        }
        }
    }
}

/**
 * The shell's screen host: system Back pops [nav] (via [onBack]) while it has
 * somewhere to go, screens change with [shellTransition], card pictures morph
 * through the shared scope, and each tab root / stack entry keeps its own
 * saveable state (scroll position) so Back lands exactly where you were.
 */
@OptIn(ExperimentalSharedTransitionApi::class)
@Composable
internal fun <R : Any> AtlasNavHost(
    nav: BackStack<Tab, R>,
    direction: BackStack.Direction,
    onBack: () -> Unit,
    stateKey: (R, Int) -> String,
    modifier: Modifier = Modifier,
    content: @Composable (NavFrame<R>) -> Unit,
) {
    val states = rememberSaveableStateHolder()
    BackHandler(enabled = nav.handlesBack, onBack = onBack)
    SharedTransitionLayout(modifier) {
        AnimatedContent(
            targetState = NavFrame(nav.tab, nav.top, nav.depth),
            transitionSpec = { shellTransition(direction) },
            label = "shell",
        ) { frame ->
            CompositionLocalProvider(
                LocalSharedScope provides this@SharedTransitionLayout,
                LocalNavVisibility provides this@AnimatedContent,
            ) {
                Box(Modifier.fillMaxSize().background(AtlasColors.paper)) {
                    val key = frame.screen?.let { stateKey(it, frame.depth) } ?: frame.tab.name
                    states.SaveableStateProvider(key) { content(frame) }
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
        // Debug builds talk to a development server whose mailbox is a local
        // folder; release builds use the production server, which sends through Resend.
        if (BuildConfig.DEBUG) {
            Text(
                "This test build doesn't send email. After you tap, the sign-in link opens on this phone.",
                color = AtlasColors.muted,
                style = MaterialTheme.typography.bodySmall,
            )
        }
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
