package com.cultureatlas.app.ui

import android.app.Application
import androidx.activity.ComponentActivity
import androidx.compose.foundation.clickable
import androidx.compose.material3.Text
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.cultureatlas.capture.core.nav.BackStack
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * System Back through the real shell host (AtlasNavHost + BackHandler + AnimatedContent):
 * Similar history walks back card by card, another tab returns to Feed first, the Feed root
 * lets the system close the app, and a screen's saved state survives a push and pop.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = Application::class)
class ShellNavigationTest {
    @get:Rule
    val rule = createAndroidComposeRule<ComponentActivity>()

    private sealed interface Route {
        data class Card(val title: String) : Route
    }

    private var nav by mutableStateOf(BackStack<Tab, Route>(tab = Tab.FEED, home = Tab.FEED))
    private var direction by mutableStateOf(BackStack.Direction.NONE)

    private fun go(step: BackStack.Step<Tab, Route>) {
        direction = step.direction
        nav = step.stack
    }

    private fun systemBack() {
        rule.runOnIdle { rule.activity.onBackPressedDispatcher.onBackPressed() }
        rule.waitForIdle()
    }

    private fun host() {
        rule.setContent {
            AtlasNavHost(nav = nav, direction = direction, onBack = { go(nav.back()) }, stateKey = { r, d -> "$d:$r" }) { frame ->
                when (val screen = frame.screen) {
                    null -> {
                        var taps by rememberSaveable { mutableIntStateOf(0) }
                        Text("root ${frame.tab} taps=$taps", Modifier.clickable { taps++ })
                    }
                    is Route.Card -> Text("card ${screen.title}")
                }
            }
        }
    }

    @Test
    fun backWalksSimilarHistoryThenLetsTheSystemClose() {
        host()
        rule.runOnIdle { go(nav.push(Route.Card("A"))) }
        rule.runOnIdle { go(nav.push(Route.Card("B"))) } // a Similar card opened from A
        rule.onNodeWithText("card B").assertIsDisplayed()

        systemBack()
        rule.onNodeWithText("card A").assertIsDisplayed()
        rule.onNodeWithText("card B").assertDoesNotExist()

        systemBack()
        rule.onNodeWithText("root FEED taps=0").assertIsDisplayed()
        rule.runOnIdle {
            assertTrue(nav.atRoot)
            // Nothing in-app handles Back on the Feed root: the system closes the activity.
            assertFalse(rule.activity.onBackPressedDispatcher.hasEnabledCallbacks())
        }
    }

    @Test
    fun backFromAnotherTabRootReturnsToFeed() {
        host()
        rule.runOnIdle { go(nav.selectTab(Tab.LIBRARY)) }
        rule.onNodeWithText("root LIBRARY taps=0").assertIsDisplayed()
        rule.runOnIdle { assertTrue(rule.activity.onBackPressedDispatcher.hasEnabledCallbacks()) }
        systemBack()
        rule.onNodeWithText("root FEED taps=0").assertIsDisplayed()
    }

    @Test
    fun rootStateSurvivesOpeningACardAndComingBack() {
        host()
        rule.onNodeWithText("root FEED taps=0").performClick()
        rule.onNodeWithText("root FEED taps=1").performClick()
        rule.onNodeWithText("root FEED taps=2").assertIsDisplayed()
        rule.runOnIdle { go(nav.push(Route.Card("A"))) }
        rule.onNodeWithText("card A").assertIsDisplayed()
        systemBack()
        rule.onNodeWithText("root FEED taps=2").assertIsDisplayed()
        rule.runOnIdle { assertEquals(0, nav.depth) }
    }
}
