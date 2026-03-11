package com.spellcheck.keyboard

import android.content.Context
import android.content.SharedPreferences

object TrialManager {
    private const val PREFS_NAME = "trial"
    private const val KEY_INSTALL_TIME = "install_time"
    private const val KEY_SUBSCRIBED = "subscribed"
    private const val TRIAL_MS = 7L * 24 * 60 * 60 * 1000

    private lateinit var prefs: SharedPreferences

    fun init(context: Context) {
        prefs = context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        if (!prefs.contains(KEY_INSTALL_TIME)) {
            prefs.edit().putLong(KEY_INSTALL_TIME, System.currentTimeMillis()).apply()
        }
    }

    val isInTrial: Boolean
        get() {
            val t = prefs.getLong(KEY_INSTALL_TIME, System.currentTimeMillis())
            return System.currentTimeMillis() < t + TRIAL_MS
        }

    val isSubscribed: Boolean
        get() = prefs.getBoolean(KEY_SUBSCRIBED, false)

    fun setSubscribed(v: Boolean) = prefs.edit().putBoolean(KEY_SUBSCRIBED, v).apply()

    val canUseAI: Boolean get() = isInTrial || isSubscribed

    val remainingTrialDays: Int
        get() {
            val t = prefs.getLong(KEY_INSTALL_TIME, System.currentTimeMillis())
            val remaining = (t + TRIAL_MS - System.currentTimeMillis()) / (24 * 60 * 60 * 1000)
            return maxOf(0, remaining.toInt())
        }
}
