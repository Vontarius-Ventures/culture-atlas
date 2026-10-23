package com.cultureatlas.app.capture

import android.content.Context

/** Experimental flavor: the Meta Wearables DAT adapter. */
object GlassesFactory {
    fun create(context: Context): GlassesAdapter = MetaGlassesAdapter(context.applicationContext, MetaDatBinding(context.applicationContext))
}
