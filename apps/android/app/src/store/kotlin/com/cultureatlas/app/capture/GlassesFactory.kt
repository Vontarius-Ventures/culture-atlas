package com.cultureatlas.app.capture

import android.content.Context

/** Store flavor: no Meta SDK in this build. */
object GlassesFactory {
    fun create(context: Context): GlassesAdapter = UnavailableGlasses()
}
