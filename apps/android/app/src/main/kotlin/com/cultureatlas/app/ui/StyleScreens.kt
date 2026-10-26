package com.cultureatlas.app.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.MutableTransitionState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ClipOp
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.cultureatlas.capture.core.contract.DiscoveryCard
import com.cultureatlas.capture.core.contract.StyleRegion
import com.cultureatlas.capture.core.net.CITY_MAX_LENGTH
import com.cultureatlas.capture.core.result.AestheticChip
import com.cultureatlas.capture.core.result.DetailRow
import com.cultureatlas.capture.core.result.ExperimentalBadge
import com.cultureatlas.capture.core.result.PresentedRail
import com.cultureatlas.capture.core.result.PresentedSubject
import com.cultureatlas.capture.core.result.RailState
import com.cultureatlas.capture.core.result.StyleCopy
import com.cultureatlas.capture.core.result.StylePresentation
import com.cultureatlas.capture.core.result.StylePreviewPresentation
import com.cultureatlas.capture.core.result.StyleReader
import com.cultureatlas.capture.core.result.StyleState
import kotlinx.coroutines.delay

/*
 * Style reading and style rails on the native result screen
 * (prp/2026-10-23-style-analysis/design.md F.1 / F.4).
 *
 * Every word drawn here is a server string or a D.4 copy key; nothing is worded on the phone.
 * Certainty is carried by a solid (asserted) or dashed (resembles) border plus the server's own
 * "Resembles …" words; the coarse strength band is only an accessibility label.
 */

private val Ivory = Color(0xFFFFFDF7)
private const val FADE_MS = 200
private const val DIM_MS = 180

// ---- Experimental label ---------------------------------------------------------------------

/** The quiet `Experimental` badge. Tapping it shows the note (design D.4 §1, §4). */
@Composable
fun ExperimentalBadgeButton(badge: ExperimentalBadge, modifier: Modifier = Modifier) {
    var open by rememberSaveable { mutableStateOf(false) }
    Column(modifier, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        ExperimentalPill(badge, open) { open = !open }
        ExperimentalNote(badge, open)
    }
}

/** The badge itself: a quiet pill button (#EEEAE2, 14 sp). */
@Composable
private fun ExperimentalPill(badge: ExperimentalBadge, open: Boolean, onToggle: () -> Unit) {
    Box(
        Modifier
            .clip(RoundedCornerShape(50))
            .background(AtlasColors.quiet)
            .clickable(role = Role.Button, onClickLabel = if (open) "Hide note" else "Show note", onClick = onToggle)
            .heightIn(min = 32.dp)
            .padding(horizontal = 12.dp, vertical = 6.dp)
            .semantics { stateDescription = if (open) "Note shown" else "Note hidden" },
        contentAlignment = Alignment.Center,
    ) {
        Text(badge.label, color = AtlasColors.ink, fontSize = 14.sp)
    }
}

@Composable
private fun ExperimentalNote(badge: ExperimentalBadge, open: Boolean) {
    AnimatedVisibility(open, enter = fadeIn(tween(180)), exit = fadeOut(tween(160))) {
        Text(
            badge.note,
            color = AtlasColors.muted,
            style = MaterialTheme.typography.bodySmall,
            modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
        )
    }
}

// ---- Region overlay on the capture image -----------------------------------------------------

/**
 * Draws the evidence region over a picture shown with ContentScale.Crop: everything outside dims
 * to 40% black over 180 ms; the region gets a 2 dp ivory outline with a 1 dp olive inner line.
 * [imageWidth]/[imageHeight] are the picture's pixel size (regions are normalized to it); when
 * unknown the picture is assumed to fill the box.
 */
@Composable
fun Modifier.styleRegionOverlay(region: StyleRegion?, imageWidth: Int?, imageHeight: Int?): Modifier {
    val dim by animateFloatAsState(if (region != null) 0.4f else 0f, tween(DIM_MS), label = "region-dim")
    var last by remember { mutableStateOf<StyleRegion?>(null) }
    if (region != null) last = region
    val shown = last
    return this.drawWithContent {
        drawContent()
        if (dim <= 0f || shown == null) return@drawWithContent
        val rect = mapRegion(shown, size, imageWidth, imageHeight) ?: return@drawWithContent
        clipRect(rect.left, rect.top, rect.right, rect.bottom, clipOp = ClipOp.Difference) {
            drawRect(Color.Black.copy(alpha = dim))
        }
        val alpha = dim / 0.4f
        val outer = 2.dp.toPx()
        val inner = 1.dp.toPx()
        drawRect(
            Ivory.copy(alpha = alpha),
            topLeft = Offset(rect.left - outer / 2, rect.top - outer / 2),
            size = Size(rect.width + outer, rect.height + outer),
            style = Stroke(outer),
        )
        drawRect(
            AtlasColors.olive.copy(alpha = alpha),
            topLeft = Offset(rect.left + inner, rect.top + inner),
            size = Size((rect.width - 2 * inner).coerceAtLeast(0f), (rect.height - 2 * inner).coerceAtLeast(0f)),
            style = Stroke(inner),
        )
    }
}

/** Normalized image region → box pixels for a centre-cropped picture. */
internal fun mapRegion(region: StyleRegion, box: Size, imageWidth: Int?, imageHeight: Int?): Rect? {
    if (!region.drawable || box.width <= 0f || box.height <= 0f) return null
    val iw = imageWidth?.takeIf { it > 0 }?.toFloat()
    val ih = imageHeight?.takeIf { it > 0 }?.toFloat()
    val (sw, sh, dx, dy) = if (iw != null && ih != null) {
        val s = maxOf(box.width / iw, box.height / ih)
        val w = iw * s
        val h = ih * s
        listOf(w, h, (box.width - w) / 2f, (box.height - h) / 2f)
    } else {
        listOf(box.width, box.height, 0f, 0f)
    }
    val rect = Rect(
        dx + region.x.toFloat() * sw,
        dy + region.y.toFloat() * sh,
        dx + (region.x + region.w).toFloat() * sw,
        dy + (region.y + region.h).toFloat() * sh,
    ).intersect(Rect(Offset.Zero, box))
    return rect.takeIf { !it.isEmpty }
}

// ---- Style reading card ------------------------------------------------------------------------

/** Callbacks of the style card; all optional so previews and tests can omit them. */
class StyleActions(
    val onHighlight: (StyleRegion?) -> Unit = {},
    val onRetry: (() -> Unit)? = null,
    val onShowRail: (String) -> Unit = {},
)

/**
 * The "Style reading" card (F.1 §2): header with the Experimental badge, summary, subject tabs,
 * aesthetic chips, palette, details (first three, then "Show all details"), mood and Qloo links.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun StyleReadingSection(
    state: StyleState,
    reading: StylePresentation?,
    preview: StylePreviewPresentation?,
    badge: ExperimentalBadge?,
    highlighted: StyleRegion?,
    actions: StyleActions,
    retryNote: String? = null,
    retrying: Boolean = false,
    modifier: Modifier = Modifier,
) {
    if (state == StyleState.ABSENT) return
    Column(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(16.dp))
            .border(1.dp, AtlasColors.line, RoundedCornerShape(16.dp))
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        var noteOpen by rememberSaveable { mutableStateOf(false) }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(
                StyleCopy.TITLE,
                Modifier.semantics { heading() },
                style = MaterialTheme.typography.titleLarge.copy(fontFamily = FontFamily.Serif, fontSize = 20.sp),
            )
            badge?.let { ExperimentalPill(it, noteOpen) { noteOpen = !noteOpen } }
        }
        badge?.let { ExperimentalNote(it, noteOpen) }
        when (state) {
            StyleState.READING -> if (preview != null) StylePreviewBody(preview) else StyleSkeleton()
            StyleState.READY -> if (reading != null) StyleReadingBody(reading, highlighted, actions) else StyleSkeleton()
            StyleState.EMPTY -> Text(StyleCopy.EMPTY, color = AtlasColors.muted)
            StyleState.HELD -> Text(StyleCopy.LIMIT, color = AtlasColors.muted)
            StyleState.FAILED -> {
                Text(StyleCopy.FAILED, color = AtlasColors.muted)
                actions.onRetry?.let { retry ->
                    OutlinedButton(onClick = retry, enabled = !retrying && retryNote == null, modifier = Modifier.heightIn(min = 48.dp)) {
                        Text(StyleCopy.TRY_AGAIN)
                    }
                }
            }
            StyleState.ABSENT -> Unit
        }
        retryNote?.let { Text(it, color = AtlasColors.muted, style = MaterialTheme.typography.bodySmall) }
    }
}

/** Static placeholder (no shimmer): header, three pill outlines and five swatch circles. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun StyleSkeleton() {
    Column(
        verticalArrangement = Arrangement.spacedBy(12.dp),
        modifier = Modifier.semantics(mergeDescendants = true) { contentDescription = StyleCopy.READING },
    ) {
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf(96, 132, 84).forEach { w ->
                Box(Modifier.width(w.dp).height(32.dp).border(1.dp, AtlasColors.quiet, CircleShape))
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            repeat(5) { Box(Modifier.size(28.dp).clip(CircleShape).background(AtlasColors.quiet)) }
        }
        Text(StyleCopy.READING, color = AtlasColors.muted, style = MaterialTheme.typography.bodySmall)
    }
}

/** The compact `/v2` preview (E.3) shown while the full reading loads. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun StylePreviewBody(preview: StylePreviewPresentation) {
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        preview.summary?.let { Text(it, fontSize = 16.sp) }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            preview.chips.forEach { StyleChip(it, onLongPressShowRail = null, onHighlight = null) }
        }
        if (preview.swatches.isNotEmpty()) {
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                preview.swatches.forEach { argb ->
                    Box(Modifier.size(28.dp).clip(CircleShape).background(Color(argb)).border(1.dp, AtlasColors.line, CircleShape))
                }
            }
        }
        Text(StyleCopy.READING, color = AtlasColors.muted, style = MaterialTheme.typography.bodySmall)
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun StyleReadingBody(reading: StylePresentation, highlighted: StyleRegion?, actions: StyleActions) {
    val haptics = rememberHaptics()
    val reduceMotion = prefersReducedMotion()
    var selected by rememberSaveable { mutableStateOf(0) }
    val subjects = reading.subjects
    val index = selected.coerceIn(0, (subjects.size - 1).coerceAtLeast(0))
    // The first landing of the reading ticks once (F.1 §5).
    LaunchedEffect(Unit) { haptics.tick() }

    // A claim that disappears after display (stage-2 veto) is announced once.
    var lastPaths by remember { mutableStateOf<Set<String>?>(null) }
    var updated by remember { mutableStateOf(false) }
    val paths = remember(reading) {
        reading.subjects.flatMap { s -> s.chips.mapNotNull { it.path } + s.detailGroups.flatMap { g -> g.rows.map { it.path } } }.toSet()
    }
    LaunchedEffect(paths) {
        val before = lastPaths
        if (before != null && !paths.containsAll(before)) updated = true
        lastPaths = paths
    }

    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        reading.summary?.let { Text(it, fontSize = 16.sp) }
        if (subjects.size >= 2) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                subjects.forEachIndexed { i, s ->
                    val on = i == index
                    Box(
                        Modifier
                            .clip(CircleShape)
                            .background(if (on) AtlasColors.ink else AtlasColors.quiet)
                            .clickable(role = Role.Tab) {
                                selected = i
                                haptics.tick()
                                s.region?.let { actions.onHighlight(it) }
                            }
                            .heightIn(min = 40.dp)
                            .padding(horizontal = 14.dp, vertical = 10.dp)
                            .semantics { stateDescription = if (on) "Selected" else "Not selected" },
                    ) {
                        Text(s.label ?: "Item ${i + 1}", color = if (on) AtlasColors.paper else AtlasColors.ink, fontSize = 14.sp)
                    }
                }
            }
            // Selecting a subject outlines it on the photo for 1.2 s.
            LaunchedEffect(index, highlighted) {
                if (highlighted != null && highlighted == subjects.getOrNull(index)?.region) {
                    delay(1_200)
                    actions.onHighlight(null)
                }
            }
        }
        subjects.getOrNull(index)?.let { SubjectBody(it, highlighted, actions, reduceMotion) }
        if (updated) {
            Text(
                StyleCopy.UPDATED,
                color = AtlasColors.muted,
                style = MaterialTheme.typography.labelSmall,
                modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
            )
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun SubjectBody(subject: PresentedSubject, highlighted: StyleRegion?, actions: StyleActions, reduceMotion: Boolean) {
    var showAll by rememberSaveable(subject.id) { mutableStateOf(false) }
    val clipboard = LocalClipboardManager.current
    val haptics = rememberHaptics()
    fun toggle(region: StyleRegion?) {
        actions.onHighlight(if (region == null || region == highlighted) null else region)
    }
    Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
        if (subject.chips.isNotEmpty()) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                FadingItems(subject.chips, key = { it.path ?: it.text }, reduceMotion = reduceMotion, staggerMs = 40) { chip ->
                    StyleChip(
                        chip,
                        onLongPressShowRail = subject.railKey?.let { key -> { actions.onShowRail(key) } },
                        onHighlight = chip.region?.let { r -> { toggle(r) } },
                    )
                }
            }
        }
        subject.brand?.let { brand ->
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(brand.name, style = MaterialTheme.typography.bodyLarge.copy(fontFamily = FontFamily.Serif))
                brand.attribution?.let { Text(it, color = AtlasColors.muted, style = MaterialTheme.typography.labelSmall) }
            }
        }
        if (subject.palette.isNotEmpty()) {
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.Top) {
                subject.palette.forEach { swatch ->
                    Column(
                        Modifier
                            .clickable(role = Role.Button, onClickLabel = "Copy colour name") {
                                clipboard.setText(AnnotatedString(swatch.name))
                                haptics.tick()
                            }
                            .semantics(mergeDescendants = true) { contentDescription = swatch.name },
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        Box(
                            Modifier.height(28.dp).width(swatch.sizeDp.dp)
                                .clip(CircleShape)
                                .background(Color(swatch.argb))
                                .border(1.dp, AtlasColors.line, CircleShape),
                        )
                        Text(swatch.name, fontSize = 13.sp, color = AtlasColors.muted)
                    }
                }
            }
        }
        if (subject.detailGroups.isNotEmpty()) {
            val groups = if (showAll) subject.detailGroups else subject.detailPreview()
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                groups.forEach { group ->
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(group.title, style = MaterialTheme.typography.labelLarge, color = AtlasColors.muted)
                        FadingItems(group.rows, key = { it.path }, reduceMotion = reduceMotion, staggerMs = 0) { row ->
                            DetailRowView(row, highlighted) { toggle(row.region) }
                        }
                    }
                }
                if (!showAll && subject.detailCount > StyleReader.MAX_DETAIL_PREVIEW) {
                    TextButton(onClick = { showAll = true }) { Text(StyleCopy.SHOW_DETAILS) }
                }
            }
        }
        subject.moodLine?.let { Text(it, color = AtlasColors.muted, style = MaterialTheme.typography.bodyMedium) }
        subject.qlooLinks?.let { Text(it, color = AtlasColors.muted, style = MaterialTheme.typography.bodySmall) }
    }
}

@Composable
private fun DetailRowView(row: DetailRow, highlighted: StyleRegion?, onLocate: () -> Unit) {
    val region = row.region
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 32.dp)
            .then(
                if (region != null) {
                    Modifier.clickable(role = Role.Button, onClickLabel = "Show on the photo", onClick = onLocate)
                } else {
                    Modifier
                },
            )
            .semantics(mergeDescendants = true) {
                StyleCopy.strengthLabel(row.strength)?.let { stateDescription = it }
                if (region != null) {
                    contentDescription = "${row.text}. ${if (region == highlighted) StyleReader.regionDescription(region) else "Show on the photo"}"
                }
            },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        // A resemblance uses secondary text and its own words ("Resembles", "Looks like"), never colour alone.
        Text(row.text, Modifier.weight(1f), color = if (row.asserted) AtlasColors.ink else AtlasColors.muted)
        if (region != null) {
            Icon(
                AtlasIcons.Locate,
                contentDescription = null,
                tint = if (region == highlighted) AtlasColors.olive else AtlasColors.muted,
                modifier = Modifier.size(20.dp),
            )
        }
    }
}

/**
 * An aesthetic chip: a fully rounded pill with a solid olive border (asserted) or a dashed one
 * (resembles). A wording upgrade cross-fades dashed → solid over 200 ms with no layout shift.
 * Long-press offers "Show more like this style".
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun StyleChip(chip: AestheticChip, onLongPressShowRail: (() -> Unit)?, onHighlight: (() -> Unit)?) {
    val solid by animateFloatAsState(if (chip.asserted) 1f else 0f, tween(FADE_MS), label = "chip-border")
    var menu by remember { mutableStateOf(false) }
    val haptics = rememberHaptics()
    Box {
        Box(
            Modifier
                .clip(CircleShape)
                .drawBehind {
                    val stroke = 1.5.dp.toPx()
                    val radius = CornerRadius(size.height / 2, size.height / 2)
                    val inset = stroke / 2
                    val tl = Offset(inset, inset)
                    val sz = Size(size.width - stroke, size.height - stroke)
                    if (solid < 1f) {
                        drawRoundRect(
                            AtlasColors.olive.copy(alpha = 1f - solid), tl, sz, radius,
                            style = Stroke(stroke, pathEffect = PathEffect.dashPathEffect(floatArrayOf(6.dp.toPx(), 4.dp.toPx()))),
                        )
                    }
                    if (solid > 0f) drawRoundRect(AtlasColors.olive.copy(alpha = solid), tl, sz, radius, style = Stroke(stroke))
                }
                .combinedClickable(
                    enabled = onHighlight != null || onLongPressShowRail != null,
                    role = Role.Button,
                    onClick = { onHighlight?.invoke() },
                    onLongClick = onLongPressShowRail?.let {
                        {
                            haptics.tick()
                            menu = true
                        }
                    },
                    onLongClickLabel = onLongPressShowRail?.let { StyleCopy.SHOW_MORE_LIKE_THIS_STYLE },
                )
                .heightIn(min = 36.dp)
                .padding(horizontal = 14.dp, vertical = 8.dp)
                .semantics {
                    StyleCopy.strengthLabel(chip.strength)?.let { stateDescription = it }
                },
            contentAlignment = Alignment.Center,
        ) {
            Text(chip.text, color = AtlasColors.ink, fontSize = 14.sp)
        }
        if (onLongPressShowRail != null) {
            DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                DropdownMenuItem(
                    text = { Text(StyleCopy.SHOW_MORE_LIKE_THIS_STYLE) },
                    onClick = {
                        menu = false
                        onLongPressShowRail()
                    },
                )
            }
        }
    }
}

/**
 * Renders [items] keyed by [key]; items that appear fade in with a 12 dp rise (staggered), items
 * that vanish (a retracted claim) fade out over 200 ms instead of popping. Reduce Motion renders
 * instantly.
 */
@Composable
private fun <T> FadingItems(
    items: List<T>,
    key: (T) -> String,
    reduceMotion: Boolean,
    staggerMs: Int,
    content: @Composable (T) -> Unit,
) {
    class Entry(val key: String, var item: T, val state: MutableTransitionState<Boolean>)
    // A plain list: reconciliation is idempotent, and reading each transition state below is what
    // recomposes this when an exit finishes.
    val entries = remember { mutableListOf<Entry>() }
    // New keys enter, missing keys leave (kept in place until their fade ends).
    val wanted = items.map(key).toSet()
    items.forEach { item ->
        val k = key(item)
        val existing = entries.firstOrNull { it.key == k }
        if (existing == null) {
            entries.add(Entry(k, item, MutableTransitionState(reduceMotion).apply { targetState = true }))
        } else {
            existing.item = item
            existing.state.targetState = true
        }
    }
    entries.filter { it.key !in wanted }.forEach { it.state.targetState = false }
    entries.removeAll { it.key !in wanted && it.state.isIdle && !it.state.currentState }
    entries.toList().forEachIndexed { i, e ->
        val delayMs = if (reduceMotion) 0 else (i.coerceAtMost(7) * staggerMs)
        AnimatedVisibility(
            visibleState = e.state,
            enter = if (reduceMotion) fadeIn(tween(0)) else fadeIn(tween(FADE_MS, delayMs)) + slideInVertically(tween(FADE_MS, delayMs)) { 12 },
            exit = if (reduceMotion) fadeOut(tween(0)) else fadeOut(tween(FADE_MS)),
        ) {
            content(e.item)
        }
    }
}

// ---- Rails -----------------------------------------------------------------------------------

/**
 * Rails in the server's order (F.1 §3): serif title, the attributes that drove it, the
 * experimental caption where R-17 places it, cards with their reason (two lines max), and honest
 * running / empty / failed states. [pulse] briefly highlights one rail header after "Show more
 * like this style"; [requesters] let the screen scroll a rail into view.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun StyleRails(
    rails: List<PresentedRail>,
    onOpenCard: (DiscoveryCard) -> Unit,
    onAddCity: () -> Unit,
    pulse: String?,
    requesters: Map<String, BringIntoViewRequester>,
    cityOpen: Boolean = false,
    cityPanel: @Composable () -> Unit = {},
) {
    val cityRail = rails.firstOrNull { it.offerCity }?.key
    Column(verticalArrangement = Arrangement.spacedBy(20.dp)) {
        rails.forEach { rail ->
            val requester = requesters[rail.key]
            Column(
                Modifier.then(if (requester != null) Modifier.bringIntoViewRequester(requester) else Modifier),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                rail.caption?.let {
                    Text(it, color = AtlasColors.muted, fontSize = 14.sp)
                }
                val glow by animateFloatAsState(if (pulse == rail.key) 1f else 0f, tween(if (pulse == rail.key) 220 else 600), label = "rail-pulse")
                Column(
                    Modifier
                        .clip(RoundedCornerShape(8.dp))
                        .background(AtlasColors.olive.copy(alpha = 0.12f * glow))
                        .padding(vertical = 2.dp)
                        .semantics(mergeDescendants = true) { heading() },
                ) {
                    Text(rail.title, style = MaterialTheme.typography.titleMedium.copy(fontFamily = FontFamily.Serif))
                    rail.subtitle?.let { Text(it, color = AtlasColors.muted, style = MaterialTheme.typography.bodySmall) }
                }
                when (rail.state) {
                    RailState.READY -> LazyRow(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        items(rail.cards, key = { "${rail.key}:${it.id}" }) { card -> RailCard(card) { onOpenCard(card) } }
                    }
                    RailState.RUNNING -> {
                        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                            repeat(3) {
                                Box(Modifier.width(140.dp).height(176.dp).clip(RoundedCornerShape(12.dp)).background(AtlasColors.quiet))
                            }
                        }
                        rail.message?.let { Text(it, color = AtlasColors.muted, style = MaterialTheme.typography.bodySmall) }
                    }
                    RailState.EMPTY, RailState.FAILED -> {
                        rail.message?.let { Text(it, color = AtlasColors.muted, style = MaterialTheme.typography.bodySmall) }
                        if (rail.offerCity && rail.key == cityRail && cityOpen) {
                            cityPanel()
                        } else if (rail.offerCity) {
                            OutlinedButton(onClick = onAddCity, modifier = Modifier.heightIn(min = 48.dp)) { Text(StyleCopy.ADD_CITY) }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun RailCard(card: DiscoveryCard, onOpen: () -> Unit) {
    Column(Modifier.width(140.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        FeedCardTile(card = card, onOpen = onOpen)
        card.reason?.trim()?.takeIf { it.isNotEmpty() }?.let {
            Text(it, color = AtlasColors.muted, fontSize = 14.sp, maxLines = 2, overflow = TextOverflow.Ellipsis, lineHeight = 18.sp)
        }
    }
}

/**
 * One-field panel for the city that place rails need (C.6), opened in place under the rail that
 * asked for it. The value goes in the request body only.
 */
@Composable
fun AddCityPanel(saving: Boolean, error: String?, onSave: (String) -> Unit, onDismiss: () -> Unit) {
    var city by rememberSaveable { mutableStateOf("") }
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(AtlasColors.quiet)
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(StyleCopy.ADD_CITY, style = MaterialTheme.typography.titleMedium.copy(fontFamily = FontFamily.Serif))
        OutlinedTextField(
            value = city,
            onValueChange = { city = it.take(CITY_MAX_LENGTH) },
            singleLine = true,
            label = { Text("City") },
            keyboardOptions = KeyboardOptions.Default,
            modifier = Modifier.fillMaxWidth(),
        )
        error?.let { Text(it, color = AtlasColors.muted, style = MaterialTheme.typography.bodySmall) }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            TextButton(onClick = onDismiss) { Text("Cancel") }
            TextButton(onClick = { onSave(city) }, enabled = !saving && city.isNotBlank()) { Text("Save") }
        }
    }
}

/** Small text tag beside the reason in feed card detail, and under the capture button (D.4 §5). */
@Composable
fun ExperimentalTag(text: String = StyleCopy.BADGE) {
    Text(
        text,
        color = AtlasColors.muted,
        fontSize = 12.sp,
        modifier = Modifier.clip(RoundedCornerShape(50)).background(AtlasColors.quiet).padding(horizontal = 8.dp, vertical = 2.dp),
    )
}
