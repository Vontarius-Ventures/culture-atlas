package com.cultureatlas.app.ui

import android.os.Build
import android.view.HapticFeedbackConstants
import android.view.View
import androidx.compose.animation.AnimatedVisibilityScope
import androidx.compose.animation.ExperimentalSharedTransitionApi
import androidx.compose.animation.SharedTransitionScope
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.LocalIndication
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import coil.request.CachePolicy
import coil.request.ImageRequest
import com.cultureatlas.capture.core.net.PrivateMediaPolicy

/*
 * The app's motion vocabulary: haptics, pressed-scale tiles, card → detail
 * shared bounds, crossfading images over a poster or a soft shimmer, and the
 * tab icons. Everything here degrades to a still, working UI (no shared scope,
 * animations off, an image that fails) — never to a blank screen.
 */

// Haptics

/** Light, purposeful feedback: a tick for selection, confirm for a save, reject for a refusal. */
class Haptics(private val view: View) {
    fun tick() {
        view.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
    }

    fun press() {
        view.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
    }

    fun confirm() {
        view.performHapticFeedback(
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) HapticFeedbackConstants.CONFIRM else HapticFeedbackConstants.VIRTUAL_KEY,
        )
    }

    fun reject() {
        view.performHapticFeedback(
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) HapticFeedbackConstants.REJECT else HapticFeedbackConstants.LONG_PRESS,
        )
    }
}

@Composable
fun rememberHaptics(): Haptics {
    val view = LocalView.current
    return remember(view) { Haptics(view) }
}

// Press feedback

/** Scales the element down a touch while pressed and springs back on release. */
fun Modifier.pressScale(source: MutableInteractionSource, pressed: Float = 0.965f): Modifier = composed {
    val isPressed by source.collectIsPressedAsState()
    val scale by animateFloatAsState(
        targetValue = if (isPressed) pressed else 1f,
        animationSpec = spring(dampingRatio = 0.55f, stiffness = Spring.StiffnessMediumLow),
        label = "press-scale",
    )
    graphicsLayer {
        scaleX = scale
        scaleY = scale
    }
}

/** A tappable tile: pressed scale, ripple and a light haptic, in one modifier. */
fun Modifier.tappable(enabled: Boolean = true, onClick: () -> Unit): Modifier = composed {
    val source = remember { MutableInteractionSource() }
    val haptics = rememberHaptics()
    this
        .pressScale(source)
        .clickable(
            interactionSource = source,
            indication = LocalIndication.current,
            enabled = enabled,
            onClick = {
                haptics.press()
                onClick()
            },
        )
}

// Card → detail shared bounds

@OptIn(ExperimentalSharedTransitionApi::class)
val LocalSharedScope = staticCompositionLocalOf<SharedTransitionScope?> { null }
val LocalNavVisibility = staticCompositionLocalOf<AnimatedVisibilityScope?> { null }

/**
 * The card's picture morphs between a feed tile, a Similar rail tile or a
 * board tile and the detail hero. A no-op outside the navigation host.
 */
@OptIn(ExperimentalSharedTransitionApi::class)
@Composable
fun Modifier.sharedCard(id: String): Modifier {
    val shared = LocalSharedScope.current ?: return this
    val visibility = LocalNavVisibility.current ?: return this
    return with(shared) {
        this@sharedCard.sharedElement(
            state = rememberSharedContentState(key = "card-$id"),
            animatedVisibilityScope = visibility,
            boundsTransform = { _, _ -> tween<Rect>(durationMillis = 420, easing = FastOutSlowInEasing) },
        )
    }
}

// Images

/**
 * Crossfades a remote picture in over [placeholder] (a typographic poster or a
 * soft shimmer). A picture that fails leaves the placeholder, never a blank.
 * The owner's own media (`/v2/media/…`) is fetched with the bearer token by
 * the app ImageLoader and kept out of the disk cache.
 */
@Composable
fun AtlasImage(
    url: String?,
    modifier: Modifier,
    contentDescription: String?,
    placeholder: (@Composable () -> Unit)? = null,
) {
    var loaded by remember(url) { mutableStateOf(false) }
    Box(modifier) {
        if (placeholder != null) placeholder() else Shimmer(Modifier.fillMaxSize(), running = !loaded && url != null)
        if (url != null) {
            val context = LocalContext.current
            val request = remember(url) {
                ImageRequest.Builder(context)
                    .data(url)
                    .crossfade(360)
                    .apply {
                        if (PrivateMediaPolicy.isPrivate(url, AtlasApiBase)) diskCachePolicy(CachePolicy.DISABLED)
                    }
                    .build()
            }
            AsyncImage(
                model = request,
                contentDescription = contentDescription,
                modifier = Modifier.fillMaxSize(),
                contentScale = ContentScale.Crop,
                onSuccess = { loaded = true },
            )
        }
    }
}

/** A slow, low-contrast sweep while something loads. Still when [running] is false. */
@Composable
fun Shimmer(modifier: Modifier, running: Boolean = true) {
    if (!running) {
        Box(modifier.background(AtlasColors.quiet))
        return
    }
    val transition = rememberInfiniteTransition(label = "shimmer")
    val x by transition.animateFloat(
        initialValue = -1f,
        targetValue = 2f,
        animationSpec = infiniteRepeatable(tween(1400, easing = FastOutSlowInEasing), RepeatMode.Restart),
        label = "shimmer-x",
    )
    Box(
        modifier.background(
            Brush.linearGradient(
                colors = listOf(AtlasColors.quiet, AtlasColors.paper.copy(alpha = 0.9f), AtlasColors.quiet),
                start = androidx.compose.ui.geometry.Offset(x * 600f, 0f),
                end = androidx.compose.ui.geometry.Offset(x * 600f + 400f, 400f),
            ),
        ),
    )
}

// Icons (Material Symbols geometry, drawn locally: no icon-pack dependency)

private fun icon(name: String, vararg paths: String): ImageVector =
    ImageVector.Builder(name = name, defaultWidth = 24.dp, defaultHeight = 24.dp, viewportWidth = 24f, viewportHeight = 24f)
        .apply { paths.forEach { addPath(pathData = addPathNodes(it), fill = SolidColor(Color.Black)) } }
        .build()

object AtlasIcons {
    val Feed: ImageVector by lazy {
        icon("feed", "M3,13h8V3H3v10zM3,21h8v-6H3v6zM13,21h8V11h-8v10zM13,3v6h8V3h-8z")
    }
    val Camera: ImageVector by lazy {
        icon(
            "camera",
            "M12,15.2a3.2,3.2 0,1 0,0 -6.4a3.2,3.2 0,1 0,0 6.4z",
            "M9,2L7.17,4H4c-1.1,0 -2,0.9 -2,2v12c0,1.1 0.9,2 2,2h16c1.1,0 2,-0.9 2,-2V6c0,-1.1 -0.9,-2 -2,-2h-3.17L15,2H9zM12,17c-2.76,0 -5,-2.24 -5,-5s2.24,-5 5,-5 5,2.24 5,5 -2.24,5 -5,5z",
        )
    }
    val Library: ImageVector by lazy {
        icon(
            "photo_library",
            "M22,16V4c0,-1.1 -0.9,-2 -2,-2H8c-1.1,0 -2,0.9 -2,2v12c0,1.1 0.9,2 2,2h12c1.1,0 2,-0.9 2,-2zM11,12l2.03,2.71L16,11l4,5H8l3,-4zM2,6v14c0,1.1 0.9,2 2,2h14v-2H4V6H2z",
        )
    }
    val Settings: ImageVector by lazy {
        icon(
            "settings",
            "M19.14,12.94c0.04,-0.3 0.06,-0.61 0.06,-0.94c0,-0.32 -0.02,-0.64 -0.07,-0.94l2.03,-1.58c0.18,-0.14 0.23,-0.41 0.12,-0.61l-1.92,-3.32c-0.12,-0.22 -0.37,-0.29 -0.59,-0.22l-2.39,0.96c-0.5,-0.38 -1.03,-0.7 -1.62,-0.94L14.4,2.81c-0.04,-0.24 -0.24,-0.41 -0.48,-0.41h-3.84c-0.24,0 -0.43,0.17 -0.47,0.41L9.25,5.35C8.66,5.59 8.12,5.92 7.63,6.29L5.24,5.33c-0.22,-0.08 -0.47,0 -0.59,0.22L2.74,8.87C2.62,9.08 2.66,9.34 2.86,9.48l2.03,1.58C4.84,11.36 4.8,11.69 4.8,12s0.02,0.64 0.07,0.94l-2.03,1.58c-0.18,0.14 -0.23,0.41 -0.12,0.61l1.92,3.32c0.12,0.22 0.37,0.29 0.59,0.22l2.39,-0.96c0.5,0.38 1.03,0.7 1.62,0.94l0.36,2.54c0.05,0.24 0.24,0.41 0.48,0.41h3.84c0.24,0 0.44,-0.17 0.47,-0.41l0.36,-2.54c0.59,-0.24 1.13,-0.56 1.62,-0.94l2.39,0.96c0.22,0.08 0.47,0 0.59,-0.22l1.92,-3.32c0.12,-0.22 0.07,-0.47 -0.12,-0.61L19.14,12.94zM12,15.6c-1.98,0 -3.6,-1.62 -3.6,-3.6s1.62,-3.6 3.6,-3.6s3.6,1.62 3.6,3.6S13.98,15.6 12,15.6z",
        )
    }
    val Back: ImageVector by lazy { icon("arrow_back", "M20,11H7.83l5.59,-5.59L12,4l-8,8 8,8 1.41,-1.41L7.83,13H20v-2z") }
    val Play: ImageVector by lazy { icon("play", "M8,5v14l11,-7z") }
    val Glasses: ImageVector by lazy {
        icon(
            "visibility",
            "M12,4.5C7,4.5 2.73,7.61 1,12c1.73,4.39 6,7.5 11,7.5s9.27,-3.11 11,-7.5c-1.73,-4.39 -6,-7.5 -11,-7.5zM12,17c-2.76,0 -5,-2.24 -5,-5s2.24,-5 5,-5 5,2.24 5,5 -2.24,5 -5,5zM12,9c-1.66,0 -3,1.34 -3,3s1.34,3 3,3 3,-1.34 3,-3 -1.34,-3 -3,-3z",
        )
    }
    val Upload: ImageVector by lazy { icon("upload", "M9,16h6v-6h4l-7,-7 -7,7h4zM5,18h14v2H5z") }
    val Music: ImageVector by lazy {
        icon("music_note", "M12,3v10.55c-0.59,-0.34 -1.27,-0.55 -2,-0.55c-2.21,0 -4,1.79 -4,4s1.79,4 4,4 4,-1.79 4,-4V7h4V3h-6z")
    }
}
