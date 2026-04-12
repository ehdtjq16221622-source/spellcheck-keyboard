package com.spellcheck.keyboard

import android.content.Context
import android.content.SharedPreferences
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

object TrialManager {
    data class SubscriptionSnapshot(
        val isSubscribed: Boolean = false,
        val expiryTimeMillis: Long? = null
    )

    private const val PREFS_NAME = "trial"
    private const val KEY_SUBSCRIBED = "subscribed"
    private const val KEY_SUBSCRIPTION_EXPIRY = "subscription_expiry"

    private var prefs: SharedPreferences? = null
    private val _state = MutableStateFlow(SubscriptionSnapshot())

    val state: StateFlow<SubscriptionSnapshot> = _state.asStateFlow()

    fun init(context: Context) {
        if (prefs == null) {
            prefs = context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            publish()
        }
    }

    val isSubscribed: Boolean
        get() = prefs?.getBoolean(KEY_SUBSCRIBED, false) ?: false

    val subscriptionExpiryTimeMillis: Long?
        get() {
            val value = prefs?.getLong(KEY_SUBSCRIPTION_EXPIRY, 0L) ?: 0L
            return value.takeIf { it > 0L }
        }

    fun setSubscription(active: Boolean, expiryTimeMillis: Long?) {
        prefs?.edit()?.apply {
            putBoolean(KEY_SUBSCRIBED, active)
            if (expiryTimeMillis != null) {
                putLong(KEY_SUBSCRIPTION_EXPIRY, expiryTimeMillis)
            } else {
                remove(KEY_SUBSCRIPTION_EXPIRY)
            }
            apply()
        }
        publish()
    }

    fun clearSubscription() = setSubscription(false, null)

    // Legacy accessors kept to avoid breaking existing call sites while the product moves to credits.
    val isInTrial: Boolean
        get() = false

    val canUseAI: Boolean
        get() = isSubscribed

    val remainingTrialDays: Int
        get() = 0

    private fun publish() {
        _state.value = SubscriptionSnapshot(
            isSubscribed = isSubscribed,
            expiryTimeMillis = subscriptionExpiryTimeMillis
        )
    }
}
