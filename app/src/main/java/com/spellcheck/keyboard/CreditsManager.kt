package com.spellcheck.keyboard

import android.annotation.SuppressLint
import android.content.Context
import android.content.SharedPreferences
import android.provider.Settings
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

object CreditsManager {

    data class Snapshot(
        val freeCredits: Int = DAILY_FREE,
        val paidCredits: Int = 0
    ) {
        val totalCredits: Int get() = freeCredits + paidCredits
    }

    private const val PREFS = "credits"
    private const val KEY_LEGACY_CREDITS = "credits"
    private const val KEY_FREE_CREDITS = "free_credits"
    private const val KEY_PAID_CREDITS = "paid_credits"
    private const val KEY_LAST_DATE = "last_date"
    private const val DAILY_FREE = 50

    const val COST_CORRECT = 10
    const val COST_TRANSLATE = 20
    const val COST_FORMAL = 30
    const val PLAN1_DAILY_CREDITS = 5000
    const val PLAN2_DAILY_CREDITS = 10000
    const val MONTHLY_SUBSCRIPTION_CREDITS = 5000
    const val REWARDED_AD_CREDITS = 500

    private var prefs: SharedPreferences? = null
    private var appContext: Context? = null
    private val _state = MutableStateFlow(Snapshot())

    val state: StateFlow<Snapshot> = _state.asStateFlow()

    @get:SuppressLint("HardwareIds")
    val deviceId: String
        get() = Settings.Secure.getString(
            appContext?.contentResolver,
            Settings.Secure.ANDROID_ID
        ) ?: "unknown"

    fun init(context: Context) {
        appContext = context.applicationContext
        prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        migrateLegacyCreditsIfNeeded()
        resetFreeCreditsIfNewDay()
        publishSnapshot()
    }

    val credits: Int
        get() = currentSnapshot().totalCredits

    fun canAfford(cost: Int): Boolean = currentSnapshot().totalCredits >= cost

    fun deduct(cost: Int) {
        val snapshot = currentSnapshot()
        if (snapshot.totalCredits < cost) return

        var remainingCost = cost
        val nextFree = (snapshot.freeCredits - remainingCost).coerceAtLeast(0).also {
            remainingCost = (remainingCost - snapshot.freeCredits).coerceAtLeast(0)
        }
        val nextPaid = (snapshot.paidCredits - remainingCost).coerceAtLeast(0)

        saveSnapshot(nextFree, nextPaid)
    }

    fun addCredits(amount: Int) {
        val snapshot = currentSnapshot()
        saveSnapshot(snapshot.freeCredits, snapshot.paidCredits + amount)
    }

    fun syncFromServer(remaining: Int) {
        val freeCredits = minOf(remaining, DAILY_FREE)
        val paidCredits = (remaining - freeCredits).coerceAtLeast(0)
        syncFromServer(freeCredits, paidCredits)
    }

    fun syncFromServer(freeCredits: Int, paidCredits: Int) {
        saveSnapshot(
            freeCredits = freeCredits.coerceAtLeast(0),
            paidCredits = paidCredits.coerceAtLeast(0),
            syncDateToToday = true
        )
    }

    private fun currentSnapshot(): Snapshot {
        resetFreeCreditsIfNewDay()
        return Snapshot(
            freeCredits = prefs?.getInt(KEY_FREE_CREDITS, DAILY_FREE) ?: DAILY_FREE,
            paidCredits = prefs?.getInt(KEY_PAID_CREDITS, 0) ?: 0
        )
    }

    private fun migrateLegacyCreditsIfNeeded() {
        val sharedPrefs = prefs ?: return
        if (sharedPrefs.contains(KEY_FREE_CREDITS) || sharedPrefs.contains(KEY_PAID_CREDITS)) {
            return
        }

        val legacyTotal = sharedPrefs.getInt(KEY_LEGACY_CREDITS, DAILY_FREE)
        val freeCredits = minOf(legacyTotal, DAILY_FREE)
        val paidCredits = (legacyTotal - freeCredits).coerceAtLeast(0)
        val savedDate = sharedPrefs.getString(KEY_LAST_DATE, today()) ?: today()

        sharedPrefs.edit()
            .putInt(KEY_FREE_CREDITS, freeCredits)
            .putInt(KEY_PAID_CREDITS, paidCredits)
            .putString(KEY_LAST_DATE, savedDate)
            .remove(KEY_LEGACY_CREDITS)
            .apply()
    }

    private fun resetFreeCreditsIfNewDay() {
        val sharedPrefs = prefs ?: return
        val today = today()
        if (sharedPrefs.getString(KEY_LAST_DATE, "") == today) {
            return
        }

        sharedPrefs.edit()
            .putInt(KEY_FREE_CREDITS, DAILY_FREE)
            .putString(KEY_LAST_DATE, today)
            .apply()
    }

    private fun saveSnapshot(
        freeCredits: Int,
        paidCredits: Int,
        syncDateToToday: Boolean = false
    ) {
        prefs?.edit()?.apply {
            putInt(KEY_FREE_CREDITS, freeCredits)
            putInt(KEY_PAID_CREDITS, paidCredits)
            if (syncDateToToday) {
                putString(KEY_LAST_DATE, today())
            }
            apply()
        }
        publishSnapshot()
    }

    private fun publishSnapshot() {
        _state.value = currentSnapshot()
    }

    private fun today(): String =
        SimpleDateFormat("yyyy-MM-dd", Locale.getDefault()).format(Date())
}
