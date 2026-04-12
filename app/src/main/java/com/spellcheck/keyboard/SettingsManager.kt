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
        level.contains("격") -> "격식체"
        level.contains("사내") -> "사내 메시지"
        level.contains("고객") -> "고객 안내"
        level.contains("공문") || level.contains("학부모") -> "공문 안내"
        level.contains("친근") || level.contains("소개팅") -> "친근체"
        else -> "존댓말"
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

    var doubleSpacePeriod: Boolean
        get() = prefs?.getBoolean("double_space_period", false) ?: false
        set(v) { prefs?.edit()?.putBoolean("double_space_period", v)?.apply() }

    var keyPopup: Boolean
        get() = prefs?.getBoolean("key_popup", true) ?: true
        set(v) { prefs?.edit()?.putBoolean("key_popup", v)?.apply() }

    var formalDefault: Boolean
        get() = prefs?.getBoolean("formal_default", false) ?: false
        set(v) { prefs?.edit()?.putBoolean("formal_default", v)?.apply() }

    var defaultMode: String
        get() = normalizeDefaultMode(prefs?.getString("default_mode", "두벌식") ?: "두벌식")
        set(v) { prefs?.edit()?.putString("default_mode", normalizeDefaultMode(v))?.apply() }

    var includePunct: Boolean
        get() = prefs?.getBoolean("include_punct", true) ?: true
        set(v) { prefs?.edit()?.putBoolean("include_punct", v)?.apply() }

    var includeDialect: Boolean
        get() = prefs?.getBoolean("include_dialect", false) ?: false
        set(v) { prefs?.edit()?.putBoolean("include_dialect", v)?.apply() }

    var formalLevel: String
        get() = normalizeFormalLevel(prefs?.getString("formal_level", "존댓말") ?: "존댓말")
        set(v) { prefs?.edit()?.putString("formal_level", normalizeFormalLevel(v))?.apply() }

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
        get() = prefs?.getInt("custom_image_overlay", 30) ?: 30
        set(v) { prefs?.edit()?.putInt("custom_image_overlay", v)?.apply() }

    var customKeyTextColor: String
        get() = normalizeCustomKeyTextColor(prefs?.getString("custom_key_text_color", "어둠") ?: "어둠")
        set(v) { prefs?.edit()?.putString("custom_key_text_color", normalizeCustomKeyTextColor(v))?.apply() }

    var customButtonOpacity: Int
        get() = prefs?.getInt("custom_button_opacity", 30) ?: 30
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
        get() = prefs?.getBoolean("sound_enabled", false) ?: false
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
}
