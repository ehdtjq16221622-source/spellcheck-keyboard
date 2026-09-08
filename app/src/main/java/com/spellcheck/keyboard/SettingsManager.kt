package com.spellcheck.keyboard

import android.content.Context
import android.content.SharedPreferences

object SettingsManager {
    private const val PREFS_NAME = "settings"
    private var prefs: SharedPreferences? = null

    private fun normalizeDefaultMode(value: String): String = when {
        value.contains("천") -> "천지인"
        else -> "두벌식"
    }

    fun normalizeFormalLevel(level: String): String = when {
        level == "smart" || level.contains("스마트") -> "smart"
        level == "polite" || level.contains("존댓말") -> "polite"
        level == "formal" || level.contains("격") -> "formal"
        level == "business" || level.contains("비즈니스") || level.contains("사내") -> "business"
        level == "customer" || level.contains("고객") -> "customer"
        level == "parent" || level.contains("공문") || level.contains("학부모") -> "parent"
        level == "dating" || level.contains("친근") || level.contains("소개팅") -> "dating"
        level == "custom" || level.contains("커스텀") -> "custom"
        else -> "smart"
    }

    private fun normalizeKeyboardTheme(value: String): String = when {
        value.contains("커") -> "커스텀"
        value.contains("핑") -> "핑크"
        value.contains("블") -> "블랙"
        else -> "화이트"
    }

    private fun normalizeCustomImageMode(value: String): String = when {
        value.contains("블") -> "블러"
        value.contains("바") -> "바둑판"
        value.contains("타") -> "타일"
        else -> "꽉채우기"
    }

    private fun normalizeCustomKeyTextColor(value: String): String = when {
        value.contains("밝") -> "밝음"
        else -> "어둠"
    }

    private fun normalizeChromeTheme(value: String): String = when {
        value.contains("블") -> "블랙"
        else -> "화이트"
    }

    private fun normalizeAppTheme(value: String): String = when {
        value.contains("라") -> "라이트"
        value.contains("다") -> "다크"
        else -> "시스템"
    }

    fun init(context: Context) {
        if (prefs == null) {
            prefs = context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        }
    }

    var vibrationEnabled: Boolean
        get() = prefs?.getBoolean("vibration", true) ?: true
        set(v) { prefs?.edit()?.putBoolean("vibration", v)?.apply() }

    var vibrationIntensity: Float
        get() = (prefs?.getFloat("vibration_intensity", 0.7f) ?: 0.7f).coerceIn(0f, 1f)
        set(v) { prefs?.edit()?.putFloat("vibration_intensity", v.coerceIn(0f, 1f))?.apply() }

    var doubleSpacePeriod: Boolean
        get() = prefs?.getBoolean("double_space_period", true) ?: true
        set(v) { prefs?.edit()?.putBoolean("double_space_period", v)?.apply() }

    var keyPopup: Boolean
        get() = prefs?.getBoolean("key_popup", false) ?: false
        set(v) { prefs?.edit()?.putBoolean("key_popup", v)?.apply() }

    var numberRowEnabled: Boolean
        get() = prefs?.getBoolean("number_row_enabled", false) ?: false
        set(v) { prefs?.edit()?.putBoolean("number_row_enabled", v)?.apply() }

    var formalDefault: Boolean
        get() = prefs?.getBoolean("formal_default", false) ?: false
        set(v) { prefs?.edit()?.putBoolean("formal_default", v)?.apply() }

    var defaultMode: String
        get() = normalizeDefaultMode(prefs?.getString("default_mode", "두벌식") ?: "두벌식")
        set(v) { prefs?.edit()?.putString("default_mode", normalizeDefaultMode(v))?.apply() }

    var includePunct: Boolean
        get() = prefs?.getBoolean("include_punct", true) ?: true
        set(v) { prefs?.edit()?.putBoolean("include_punct", v)?.apply() }

    // Keep this in the same range as the iOS keyboard. The value is stored in
    // milliseconds so the keyboard service can schedule it without rounding.
    var autoCorrectEnabled: Boolean
        get() = prefs?.getBoolean("auto_correct_enabled", true) ?: true
        set(v) { prefs?.edit()?.putBoolean("auto_correct_enabled", v)?.apply() }

    var autoCorrectDelayMs: Long
        get() = (prefs?.getLong("auto_correct_delay_ms", 1500L) ?: 1500L)
            .coerceIn(1000L, 3000L)
        set(v) { prefs?.edit()?.putLong("auto_correct_delay_ms", v.coerceIn(1000L, 3000L))?.apply() }

    var includeDialect: Boolean
        get() = prefs?.getBoolean("include_dialect", false) ?: false
        set(v) { prefs?.edit()?.putBoolean("include_dialect", v)?.apply() }

    var formalLevel: String
        get() = normalizeFormalLevel(prefs?.getString("formal_level", "smart") ?: "smart")
        set(v) { prefs?.edit()?.putString("formal_level", normalizeFormalLevel(v))?.apply() }

    var customTonePrompt: String
        get() = prefs?.getString("custom_tone_prompt", "") ?: ""
        set(v) { prefs?.edit()?.putString("custom_tone_prompt", v.take(500))?.apply() }

    var translateLang: String
        get() = prefs?.getString("translate_lang", "en") ?: "en"
        set(v) { prefs?.edit()?.putString("translate_lang", v)?.apply() }

    var toneOrder: List<String>
        get() = (prefs?.getString("tone_order", null)
            ?.split(',')
            ?.filter { it.isNotBlank() }
            ?: listOf("smart", "polite", "formal", "business", "customer", "parent", "dating", "custom"))
        set(v) { prefs?.edit()?.putString("tone_order", v.joinToString(","))?.apply() }

    var translateFavorites: List<String>
        get() = (prefs?.getString("translate_favorites", null)
            ?.split(',')
            ?.filter { it.isNotBlank() }
            ?: listOf("ko", "en", "ja", "zh", "zh-Hant", "es", "fr", "de", "vi", "th"))
        set(v) { prefs?.edit()?.putString("translate_favorites", v.joinToString(","))?.apply() }

    var formalIncludePunct: Boolean
        get() = prefs?.getBoolean("formal_include_punct", true) ?: true
        set(v) { prefs?.edit()?.putBoolean("formal_include_punct", v)?.apply() }

    var keyboardTheme: String
        get() = normalizeKeyboardTheme(prefs?.getString("keyboard_theme", "화이트") ?: "화이트")
        set(v) { prefs?.edit()?.putString("keyboard_theme", normalizeKeyboardTheme(v))?.apply() }

    var customImagePath: String
        get() = prefs?.getString("custom_image_path", "") ?: ""
        set(v) { prefs?.edit()?.putString("custom_image_path", v)?.apply() }

    var customImageMode: String
        get() = normalizeCustomImageMode(prefs?.getString("custom_image_mode", "꽉채우기") ?: "꽉채우기")
        set(v) { prefs?.edit()?.putString("custom_image_mode", normalizeCustomImageMode(v))?.apply() }

    var customImageOverlay: Int
        get() = prefs?.getInt("custom_image_overlay", 70) ?: 70
        set(v) { prefs?.edit()?.putInt("custom_image_overlay", v)?.apply() }

    var customKeyTextColor: String
        get() = normalizeCustomKeyTextColor(prefs?.getString("custom_key_text_color", "어둠") ?: "어둠")
        set(v) { prefs?.edit()?.putString("custom_key_text_color", normalizeCustomKeyTextColor(v))?.apply() }

    var customButtonOpacity: Int
        get() = prefs?.getInt("custom_button_opacity", 80) ?: 80
        set(v) { prefs?.edit()?.putInt("custom_button_opacity", v)?.apply() }

    var customChromeTheme: String
        get() = normalizeChromeTheme(prefs?.getString("custom_chrome_theme", "화이트") ?: "화이트")
        set(v) { prefs?.edit()?.putString("custom_chrome_theme", normalizeChromeTheme(v))?.apply() }

    var customImageScale: Float
        get() = prefs?.getFloat("custom_image_scale", 1.0f) ?: 1.0f
        set(v) { prefs?.edit()?.putFloat("custom_image_scale", v)?.apply() }

    var customBlurAmount: Int
        get() = prefs?.getInt("custom_blur_amount", 12) ?: 12
        set(v) { prefs?.edit()?.putInt("custom_blur_amount", v)?.apply() }

    var customImageOffsetX: Float
        get() = prefs?.getFloat("custom_image_offset_x", 0f) ?: 0f
        set(v) { prefs?.edit()?.putFloat("custom_image_offset_x", v)?.apply() }

    var customImageOffsetY: Float
        get() = prefs?.getFloat("custom_image_offset_y", 0f) ?: 0f
        set(v) { prefs?.edit()?.putFloat("custom_image_offset_y", v)?.apply() }

    var soundEnabled: Boolean
        get() = prefs?.getBoolean("sound_enabled", true) ?: true
        set(v) { prefs?.edit()?.putBoolean("sound_enabled", v)?.apply() }

    var appTheme: String
        get() = normalizeAppTheme(prefs?.getString("app_theme", "시스템") ?: "시스템")
        set(v) { prefs?.edit()?.putString("app_theme", normalizeAppTheme(v))?.apply() }

    var keyboardBodyWidthPx: Int
        get() = prefs?.getInt("keyboard_body_width_px", 0) ?: 0
        set(v) { prefs?.edit()?.putInt("keyboard_body_width_px", v)?.apply() }

    var keyboardBodyHeightPx: Int
        get() = prefs?.getInt("keyboard_body_height_px", 0) ?: 0
        set(v) { prefs?.edit()?.putInt("keyboard_body_height_px", v)?.apply() }

    // Match the iOS keyboard studio appearance controls.
    var keyboardHeightPercent: Int
        get() = (prefs?.getInt("keyboard_height_percent", 100) ?: 100).coerceIn(80, 130)
        set(v) { prefs?.edit()?.putInt("keyboard_height_percent", v.coerceIn(80, 130))?.apply() }

    var keyFontSizePercent: Int
        get() = (prefs?.getInt("key_font_size_percent", 100) ?: 100).coerceIn(80, 120)
        set(v) { prefs?.edit()?.putInt("key_font_size_percent", v.coerceIn(80, 120))?.apply() }

    var keyCornerRadius: Int
        get() = (prefs?.getInt("key_corner_radius", 8) ?: 8).coerceIn(0, 16)
        set(v) { prefs?.edit()?.putInt("key_corner_radius", v.coerceIn(0, 16))?.apply() }

    var keyHorizontalSpacing: Int
        get() = (prefs?.getInt("key_horizontal_spacing", 5) ?: 5).coerceIn(0, 12)
        set(v) { prefs?.edit()?.putInt("key_horizontal_spacing", v.coerceIn(0, 12))?.apply() }

    var keyVerticalSpacing: Int
        get() = (prefs?.getInt("key_vertical_spacing", 12) ?: 12).coerceIn(4, 18)
        set(v) { prefs?.edit()?.putInt("key_vertical_spacing", v.coerceIn(4, 18))?.apply() }

    var keyShadowLevel: String
        get() = prefs?.getString("key_shadow_level", "기본") ?: "기본"
        set(v) { prefs?.edit()?.putString("key_shadow_level", v)?.apply() }
}
