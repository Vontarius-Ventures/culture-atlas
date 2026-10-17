package com.cultureatlas.app

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import androidx.lifecycle.lifecycleScope
import com.cultureatlas.app.ui.AtlasApp
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    private val graph get() = (application as CultureAtlasApplication).graph

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val controller = graph.controller
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) = controller.onForeground(true)
            override fun onStop(owner: LifecycleOwner) = controller.onForeground(false)
        })
        lifecycleScope.launch { controller.launch() }
        handle(intent)
        setContent { AtlasApp(graph, this) }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handle(intent)
    }

    /** Verified App Link: https://app.cultureatlas.com/identity/callback#… */
    private fun handle(intent: Intent?) {
        val data = intent?.data ?: return
        if (data.host == "app.cultureatlas.com" && data.path == "/identity/callback") {
            lifecycleScope.launch { graph.controller.handleLink(data) }
        }
    }
}
