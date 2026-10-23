package com.cultureatlas.app.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.foundation.LocalIndication
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.cultureatlas.app.BuildConfig
import com.cultureatlas.app.onboarding.OnboardingController
import com.cultureatlas.capture.core.contract.OnboardingCatalogEntry
import com.cultureatlas.capture.core.contract.OnboardingImage
import com.cultureatlas.capture.core.contract.OnboardingPick
import com.cultureatlas.capture.core.contract.SeedCategoryState
import com.cultureatlas.capture.core.contract.TasteCategory
import com.cultureatlas.capture.core.onboarding.OnboardingCopy
import com.cultureatlas.capture.core.onboarding.OnboardingPolicy
import kotlinx.coroutines.launch

// Screen 14 (taste picks) on a phone: three steps with a step indicator, no
// bottom navigation, built against
// specs/capture-platform-v2/design/html/14-taste-picks.html at 390/320 px.
// Selection is an olive outline plus a check, never colour alone; every pick
// is a toggle; the counter is a polite live region.

internal val AtlasApiBase = "https://${BuildConfig.ATLAS_API_HOST}"

@Composable
fun OnboardingFlowScreen(onboarding: OnboardingController) {
    val step by onboarding.step.collectAsState()
    LaunchedEffect(Unit) { if (onboarding.catalog.value == null) onboarding.loadCatalog() }
    Column(Modifier.fillMaxSize().background(AtlasColors.paper)) {
        StepHeader(onboarding, step)
        Column(
            Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 20.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp),
        ) {
            when (step) {
                1 -> ImagePickStep(onboarding, settings = false)
                2 -> ChipPickStep(onboarding, settings = false)
                else -> ExclusionStep(onboarding)
            }
        }
        PickBar(onboarding, step)
    }
}

@Composable
private fun StepHeader(onboarding: OnboardingController, step: Int) {
    Row(Modifier.fillMaxWidth().heightIn(min = 52.dp).padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
        if (step > 1) TextButton(onClick = { onboarding.step.value = step - 1 }) { Text("← ${OnboardingCopy.BACK}") }
        Spacer(Modifier.weight(1f))
        Text(OnboardingCopy.step(step), color = AtlasColors.muted, style = MaterialTheme.typography.bodySmall)
        Row(Modifier.padding(start = 12.dp).clearAndSetSemantics {}, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            for (n in 1..3) {
                Box(Modifier.size(width = 22.dp, height = 4.dp).clip(CircleShape).background(if (n == step) AtlasColors.ink else AtlasColors.line))
            }
        }
    }
}

/** Sticky bar: progress, counter (live region) and the primary action. */
@Composable
private fun PickBar(onboarding: OnboardingController, step: Int) {
    val picks by onboarding.picksCount.collectAsState()
    val completing by onboarding.completing.collectAsState()
    val counter = OnboardingPolicy.counter(picks)
    Column(Modifier.fillMaxWidth().background(AtlasColors.paper)) {
        HorizontalDivider(color = AtlasColors.line)
        Column(Modifier.padding(horizontal = 16.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    repeat(OnboardingPolicy.MIN_PICKS) { i ->
                        Box(Modifier.size(width = 28.dp, height = 6.dp).clip(CircleShape).background(if (i < counter.progress) AtlasColors.olive else AtlasColors.line))
                    }
                }
                Text(
                    counter.text,
                    Modifier.padding(start = 12.dp).semantics { liveRegion = LiveRegionMode.Polite },
                    style = MaterialTheme.typography.titleMedium.copy(fontFamily = FontFamily.Serif),
                    color = if (counter.canComplete) AtlasColors.olive else AtlasColors.ink,
                )
                Spacer(Modifier.weight(1f))
                if (step < 3) {
                    if (counter.canComplete) {
                        Button(
                            onClick = { onboarding.step.value = step + 1 },
                            modifier = Modifier.heightIn(min = 48.dp),
                            colors = ButtonDefaults.buttonColors(
                                containerColor = AtlasColors.olive,
                                contentColor = AtlasColors.paper,
                            ),
                        ) { Text("${OnboardingCopy.NEXT} →") }
                    } else {
                        OutlinedButton(onClick = { onboarding.step.value = step + 1 }, modifier = Modifier.heightIn(min = 48.dp)) {
                            Text("${OnboardingCopy.NEXT} →")
                        }
                    }
                }
            }
            if (step == 3) {
                if (!counter.canComplete) Text(OnboardingCopy.PRIMARY_DISABLED, color = AtlasColors.muted, style = MaterialTheme.typography.bodySmall)
                Button(
                    onClick = { onboarding.buildFeed() },
                    enabled = counter.canComplete && !completing,
                    modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
                ) { Text(OnboardingCopy.PRIMARY) }
            }
        }
    }
}

@Composable
fun ImagePickStep(onboarding: OnboardingController, settings: Boolean) {
    val catalog by onboarding.catalog.collectAsState()
    val picks by onboarding.picks.collectAsState()
    val busy by onboarding.busy.collectAsState()
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(OnboardingCopy.IMAGES_TITLE, Modifier.semantics { heading() }, style = MaterialTheme.typography.headlineSmall.copy(fontFamily = FontFamily.Serif))
        if (!settings) Text(OnboardingCopy.HINT, color = AtlasColors.muted)
    }
    // Interleave Wear / Play / Watch / Eat so the first screen is not five Wear photos.
    val images = catalog?.images?.let(OnboardingPolicy::mixImages) ?: return
    // Two columns on a phone (390/320 px), as in the mockup.
    Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
        images.chunked(2).forEach { row ->
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                row.forEach { entry ->
                    PickTile(
                        entry = entry,
                        picked = onboarding.isPicked(entry, picks),
                        enabled = entry.id !in busy,
                        modifier = Modifier.weight(1f),
                        onToggle = { onboarding.toggle(entry, settings) },
                    )
                }
                if (row.size == 1) Spacer(Modifier.weight(1f))
            }
        }
    }
}

@Composable
private fun PickTile(entry: OnboardingCatalogEntry, picked: Boolean, enabled: Boolean, modifier: Modifier, onToggle: () -> Unit) {
    val haptics = rememberHaptics()
    val source = remember { MutableInteractionSource() }
    val ring by animateDpAsState(if (picked) 3.dp else 0.dp, spring(dampingRatio = 0.6f), label = "pick-ring")
    Column(
        modifier
            .pressScale(source)
            .toggleable(
                value = picked,
                enabled = enabled,
                role = Role.Checkbox,
                interactionSource = source,
                indication = LocalIndication.current,
                onValueChange = {
                    haptics.tick()
                    onToggle()
                },
            )
            .semantics(mergeDescendants = true) {
                contentDescription = entry.image?.alt?.let { "${entry.label}. $it" } ?: entry.label
            },
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Box(contentAlignment = Alignment.TopEnd) {
            RemoteImage(
                entry.image,
                Modifier.fillMaxWidth().aspectRatio(4f / 5f).clip(RoundedCornerShape(12.dp))
                    .border(BorderStroke(ring, if (ring > 0.dp) AtlasColors.olive else AtlasColors.paper), RoundedCornerShape(12.dp)),
            )
            // The check pops in with a little spring; leaving fades quickly.
            androidx.compose.animation.AnimatedVisibility(
                visible = picked,
                enter = scaleIn(spring(dampingRatio = 0.5f, stiffness = Spring.StiffnessMedium)) + fadeIn(),
                exit = scaleOut(tween(140)) + fadeOut(tween(140)),
            ) {
                Box(Modifier.padding(8.dp).size(28.dp).clip(CircleShape).background(AtlasColors.olive), contentAlignment = Alignment.Center) {
                    Text("✓", color = AtlasColors.paper, fontWeight = FontWeight.Bold)
                }
            }
        }
        Text(entry.label, fontWeight = if (picked) FontWeight.SemiBold else FontWeight.Normal)
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ChipPickStep(onboarding: OnboardingController, settings: Boolean) {
    val catalog by onboarding.catalog.collectAsState()
    val picks by onboarding.picks.collectAsState()
    val busy by onboarding.busy.collectAsState()
    Text(OnboardingCopy.CHIPS_TITLE, Modifier.semantics { heading() }, style = MaterialTheme.typography.headlineSmall.copy(fontFamily = FontFamily.Serif))
    catalog?.let { c ->
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            OnboardingPolicy.mixChips(c.chips).forEach { entry ->
                Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(OnboardingCopy.group(entry.category), color = AtlasColors.muted, style = MaterialTheme.typography.labelSmall)
                    PillToggle(entry.label, onboarding.isPicked(entry, picks), enabled = entry.id !in busy) { onboarding.toggle(entry, settings) }
                }
            }
        }
    }
    SearchBlock(onboarding, settings)
}

@Composable
private fun SearchBlock(onboarding: OnboardingController, settings: Boolean) {
    val text by onboarding.searchText.collectAsState()
    val results by onboarding.searchResults.collectAsState()
    val unavailable by onboarding.searchUnavailable.collectAsState()
    val added by onboarding.searchPicked.collectAsState()
    val busy by onboarding.busy.collectAsState()
    Column(Modifier.padding(top = 12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(OnboardingCopy.SEARCH_PLACEHOLDER, style = MaterialTheme.typography.titleMedium.copy(fontFamily = FontFamily.Serif))
        OutlinedTextField(
            value = text,
            onValueChange = onboarding::onSearchText,
            label = { Text(OnboardingCopy.SEARCH_PLACEHOLDER) },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        if (unavailable) {
            Text(OnboardingCopy.SEARCH_UNAVAILABLE, color = AtlasColors.muted, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
        } else if (results.isNotEmpty()) {
            Column(Modifier.border(1.dp, AtlasColors.line, RoundedCornerShape(12.dp)).padding(4.dp)) {
                results.forEach { result ->
                    val isAdded = result.picked || result.resultId in added
                    Row(
                        Modifier.fillMaxWidth().heightIn(min = 52.dp)
                            .toggleable(value = isAdded, enabled = !isAdded && result.resultId !in busy, role = Role.Checkbox) { onboarding.add(result, settings) }
                            .border(if (isAdded) 2.dp else 0.dp, if (isAdded) AtlasColors.olive else AtlasColors.paper, RoundedCornerShape(10.dp))
                            .padding(horizontal = 12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(result.name, fontWeight = FontWeight.Medium)
                        Text(result.typeLabel, Modifier.padding(start = 12.dp), color = AtlasColors.muted)
                        Spacer(Modifier.weight(1f))
                        if (isAdded) {
                            Text("✓ ${OnboardingCopy.SEARCH_ADDED}", color = AtlasColors.olive, fontWeight = FontWeight.SemiBold)
                        } else {
                            Text("+ ${OnboardingCopy.SEARCH_ADD}", color = AtlasColors.muted)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun ExclusionStep(onboarding: OnboardingController) {
    Row(verticalAlignment = Alignment.Bottom) {
        Text(OnboardingCopy.EXCLUSIONS_TITLE, Modifier.semantics { heading() }, style = MaterialTheme.typography.headlineSmall.copy(fontFamily = FontFamily.Serif))
        Text(OnboardingCopy.EXCLUSIONS_OPTIONAL, Modifier.padding(start = 8.dp), color = AtlasColors.muted, style = MaterialTheme.typography.bodySmall)
    }
    Text(OnboardingCopy.EXCLUSIONS_NOTE, color = AtlasColors.muted)
    ExclusionEditor(onboarding)
}

/** Suggestion pills plus "Something else"; shared by onboarding and Settings → Taste. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ExclusionEditor(onboarding: OnboardingController) {
    val catalog by onboarding.catalog.collectAsState()
    val exclusions by onboarding.exclusions.collectAsState()
    var other by remember { mutableStateOf("") }
    val suggestions = catalog?.exclusionSuggestions.orEmpty()
    val custom = exclusions.filter { term -> suggestions.none { it.equals(term, ignoreCase = true) } }
    FlowRow(
        Modifier.semantics { contentDescription = "Foods to leave out" },
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        (suggestions + custom).forEach { term ->
            PillToggle(OnboardingPolicy.label(term), exclusions.any { it.equals(term, ignoreCase = true) }) { onboarding.toggleExclusion(term) }
        }
    }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedTextField(value = other, onValueChange = { other = it }, label = { Text(OnboardingCopy.EXCLUSIONS_OTHER) }, singleLine = true, modifier = Modifier.weight(1f))
        OutlinedButton(
            onClick = { if (onboarding.addOtherExclusion(other) == null) other = "" },
            enabled = other.isNotBlank(),
            modifier = Modifier.heightIn(min = 48.dp),
        ) { Text(OnboardingCopy.SEARCH_ADD) }
    }
}

/** Filter-pill toggle: olive outline and a check when selected (not colour alone). */
@Composable
fun PillToggle(label: String, selected: Boolean, enabled: Boolean = true, onToggle: () -> Unit) {
    val haptics = rememberHaptics()
    val source = remember { MutableInteractionSource() }
    val fill by animateColorAsState(if (selected) AtlasColors.quiet else AtlasColors.paper, tween(200), label = "pill-fill")
    val edge by animateColorAsState(if (selected) AtlasColors.olive else AtlasColors.line, tween(200), label = "pill-edge")
    Row(
        Modifier
            .heightIn(min = 48.dp)
            .pressScale(source)
            .clip(RoundedCornerShape(50))
            .background(fill)
            .border(if (selected) 2.dp else 1.dp, edge, RoundedCornerShape(50))
            .toggleable(
                value = selected,
                enabled = enabled,
                role = Role.Checkbox,
                interactionSource = source,
                indication = LocalIndication.current,
                onValueChange = {
                    haptics.tick()
                    onToggle()
                },
            )
            .padding(horizontal = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (selected) Text("✓ ", color = AtlasColors.olive, fontWeight = FontWeight.Bold)
        Text(label, color = if (selected) AtlasColors.olive else AtlasColors.ink)
    }
}

// Screen 15: Building your feed

@Composable
fun BuildingFeedScreen(onboarding: OnboardingController) {
    val picks by onboarding.picks.collectAsState()
    val seed by onboarding.seed.collectAsState()
    val action by onboarding.seedAction.collectAsState()
    Column(
        Modifier.fillMaxSize().background(AtlasColors.paper).verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(20.dp),
    ) {
        // Quiet collage of what was picked (decorative).
        Column(Modifier.clearAndSetSemantics {}, verticalArrangement = Arrangement.spacedBy(8.dp)) {
            picks.take(6).chunked(3).forEach { row ->
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    row.forEach { pick -> CollageCell(pick, Modifier.weight(1f)) }
                    repeat(3 - row.size) { Spacer(Modifier.weight(1f)) }
                }
            }
        }
        Text(OnboardingCopy.BUILDING_TITLE, Modifier.semantics { heading() }, style = MaterialTheme.typography.headlineMedium.copy(fontFamily = FontFamily.Serif))
        Text(OnboardingCopy.BUILDING_LEDE, color = AtlasColors.muted)
        seed?.categories?.forEach { row ->
            Row(Modifier.fillMaxWidth().heightIn(min = 44.dp).semantics(mergeDescendants = true) {}, verticalAlignment = Alignment.CenterVertically) {
                Text(OnboardingCopy.group(row.category))
                Spacer(Modifier.weight(1f))
                val ready = row.state == SeedCategoryState.READY
                Text(
                    if (ready) OnboardingCopy.BUILDING_CATEGORY_READY else OnboardingCopy.BUILDING_CATEGORY_LOOKING,
                    color = if (ready) AtlasColors.olive else AtlasColors.muted,
                )
            }
            HorizontalDivider(color = AtlasColors.line)
        }
        if (action == OnboardingPolicy.SeedAction.BACKGROUND) {
            Text(OnboardingCopy.BUILDING_UNAVAILABLE, Modifier.semantics { liveRegion = LiveRegionMode.Polite })
            Button(onClick = { onboarding.finish() }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text(OnboardingCopy.SEE_FEED) }
        }
    }
}

@Composable
private fun CollageCell(pick: OnboardingPick, modifier: Modifier) {
    Box(modifier.aspectRatio(1f).clip(RoundedCornerShape(10.dp)).background(AtlasColors.quiet), contentAlignment = Alignment.Center) {
        if (pick.image != null) {
            RemoteImage(pick.image, Modifier.fillMaxSize())
        } else {
            Text(pick.label, Modifier.padding(6.dp), style = MaterialTheme.typography.bodySmall)
        }
    }
}

// Screen 18: Settings → Taste

@Composable
fun TasteSettingsScreen(onboarding: OnboardingController, onBack: () -> Unit) {
    val picks by onboarding.picks.collectAsState()
    var addingMore by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    LaunchedEffect(Unit) { onboarding.loadTaste() }
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        TextButton(
            onClick = {
                if (addingMore) {
                    addingMore = false
                    scope.launch { onboarding.loadTaste() }
                } else {
                    onBack()
                }
            },
        ) {
            Text("← ${if (addingMore) OnboardingCopy.TASTE_DONE else OnboardingCopy.BACK}")
        }
        if (addingMore) {
            Text(OnboardingCopy.TASTE_ADD_MORE, Modifier.semantics { heading() }, style = MaterialTheme.typography.headlineMedium.copy(fontFamily = FontFamily.Serif))
            ImagePickStep(onboarding, settings = true)
            ChipPickStep(onboarding, settings = true)
            return@Column
        }
        Text(OnboardingCopy.TASTE_TITLE, Modifier.semantics { heading() }, style = MaterialTheme.typography.headlineMedium.copy(fontFamily = FontFamily.Serif))
        Text(OnboardingCopy.TASTE_LEDE, color = AtlasColors.muted)
        OutlinedButton(onClick = { addingMore = true }) { Text(OnboardingCopy.TASTE_ADD_MORE) }
        (TasteCategory.entries.map { it as TasteCategory? } + listOf(null)).forEach { category ->
            val inCategory = onboarding.picksIn(category, picks)
            if (inCategory.isNotEmpty()) {
                category?.let { Text(OnboardingCopy.group(it), Modifier.semantics { heading() }, style = MaterialTheme.typography.titleMedium.copy(fontFamily = FontFamily.Serif)) }
                inCategory.forEach { pick ->
                    Row(Modifier.fillMaxWidth().heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(pick.label, Modifier.weight(1f))
                        // Removing below 3 is allowed here; the minimum applies only to finishing onboarding.
                        TextButton(
                            onClick = { onboarding.remove(pick) },
                            modifier = Modifier.semantics { contentDescription = OnboardingCopy.tasteRemove(pick.label) },
                        ) { Text("✕") }
                    }
                }
            }
        }
        Text(OnboardingCopy.EXCLUSIONS_TITLE, Modifier.semantics { heading() }, style = MaterialTheme.typography.titleMedium.copy(fontFamily = FontFamily.Serif))
        Text(OnboardingCopy.EXCLUSIONS_NOTE, color = AtlasColors.muted, style = MaterialTheme.typography.bodySmall)
        ExclusionEditor(onboarding)
        Button(onClick = { scope.launch { onboarding.saveExclusions() } }, modifier = Modifier.heightIn(min = 48.dp)) { Text(OnboardingCopy.TASTE_SAVE) }
    }
}

/** The questionnaire is required, so a failed state check offers Retry, never a skip. */
@Composable
fun OnboardingRetryScreen(onRetry: () -> Unit) {
    Column(Modifier.fillMaxSize().background(AtlasColors.paper).padding(16.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Text(OnboardingCopy.IMAGES_TITLE, style = MaterialTheme.typography.headlineSmall.copy(fontFamily = FontFamily.Serif))
        Text("We couldn't reach culture atlas. Check your connection and try again.", color = AtlasColors.muted)
        Button(onClick = onRetry, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("Try again") }
    }
}

// Images: catalog assets are public paths on the API host ("/samples/…"). Loaded by the app's
// Coil ImageLoader (memory + disk cache, request sizing) and crossfaded in over a soft shimmer.

@Composable
fun RemoteImage(image: OnboardingImage?, modifier: Modifier) {
    RemoteImage(image?.resolved(AtlasApiBase), modifier)
}

@Composable
fun RemoteImage(url: String?, modifier: Modifier, contentDescription: String? = null) {
    AtlasImage(url, modifier, contentDescription)
}

/** Polite toast: "Your photo is ready" with Open and Dismiss (screen 17). */
@Composable
fun ReadyToastBar(title: String, open: String, dismiss: String, onOpen: () -> Unit, onDismiss: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(16.dp).clip(RoundedCornerShape(14.dp)).background(AtlasColors.quiet)
            .padding(horizontal = 16.dp, vertical = 8.dp)
            .semantics { liveRegion = LiveRegionMode.Polite },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(title, Modifier.weight(1f), fontWeight = FontWeight.Medium)
        Button(onClick = onOpen, modifier = Modifier.heightIn(min = 48.dp)) { Text(open) }
        Spacer(Modifier.width(8.dp))
        TextButton(onClick = onDismiss, modifier = Modifier.semantics { contentDescription = dismiss }) { Text("✕") }
    }
}
