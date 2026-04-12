package com.spellcheck.keyboard

import android.content.res.Configuration

object KeyboardSizing {
    fun scaleFactor(configuration: Configuration): Float {
        val smallestWidthDp = configuration.smallestScreenWidthDp
        return when {
            smallestWidthDp >= 900 -> 1.60f
            smallestWidthDp >= 720 -> 1.52f
            smallestWidthDp >= 600 -> 1.42f
            else -> 1.22f
        }
    }

    fun textScaleFactor(layoutScale: Float): Float {
        return 1f + ((layoutScale - 1f) * 0.8f)
    }
}
