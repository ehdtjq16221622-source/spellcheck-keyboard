package com.spellcheck.keyboard

import android.content.Context
import android.content.SharedPreferences

object SettingsManager {
    private const val PREFS_NAME = "settings"
    private lateinit var prefs: SharedPreferences

    fun init(context: Context) {
        prefs = context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    }

    var vibrationEnabled: Boolean
        get() = prefs.getBoolean("vibration", true)
        set(v) = prefs.edit().putBoolean("vibration", v).apply()

    var doubleSpacePeriod: Boolean
        get() = prefs.getBoolean("double_space_period", false)
        set(v) = prefs.edit().putBoolean("double_space_period", v).apply()

    var keyPopup: Boolean
        get() = prefs.getBoolean("key_popup", true)
        set(v) = prefs.edit().putBoolean("key_popup", v).apply()

    var formalDefault: Boolean
        get() = prefs.getBoolean("formal_default", false)
        set(v) = prefs.edit().putBoolean("formal_default", v).apply()

    var defaultMode: String
        get() = prefs.getString("default_mode", "두벌식") ?: "두벌식"
        set(v) = prefs.edit().putString("default_mode", v).apply()

    // 교정 수준: 구두점(쉼표·마침표) 포함 여부 (기본: 포함)
    var includePunct: Boolean
        get() = prefs.getBoolean("include_punct", true)
        set(v) = prefs.edit().putBoolean("include_punct", v).apply()

    // 교정 수준: 사투리 표준어 교정 포함 여부 (기본: 제외)
    var includeDialect: Boolean
        get() = prefs.getBoolean("include_dialect", false)
        set(v) = prefs.edit().putBoolean("include_dialect", v).apply()

    // 회사말투 레벨: "엄격 격식체" / "적당한 존댓말" / "스마트 교정"
    var formalLevel: String
        get() = prefs.getString("formal_level", "적당한 존댓말") ?: "적당한 존댓말"
        set(v) = prefs.edit().putString("formal_level", v).apply()

    // 회사말투 사용 시 구두점 교정 포함 여부 (기본: 포함)
    var formalIncludePunct: Boolean
        get() = prefs.getBoolean("formal_include_punct", true)
        set(v) = prefs.edit().putBoolean("formal_include_punct", v).apply()

    // 키보드 테마: "화이트" / "블랙" / "핑크" / "커스텀"
    var keyboardTheme: String
        get() = prefs.getString("keyboard_theme", "화이트") ?: "화이트"
        set(v) = prefs.edit().putString("keyboard_theme", v).apply()

    // 커스텀 배경 이미지 파일 경로
    var customImagePath: String
        get() = prefs.getString("custom_image_path", "") ?: ""
        set(v) = prefs.edit().putString("custom_image_path", v).apply()

    // 커스텀 배경 표시 모드: "꽉채우기" / "타일" / "미러타일" / "늘리기" / "가운데" / "블러"
    var customImageMode: String
        get() = prefs.getString("custom_image_mode", "꽉채우기") ?: "꽉채우기"
        set(v) = prefs.edit().putString("custom_image_mode", v).apply()

    // 오버레이 투명도 (0~100, 기본 30 = 30% 어두운 레이어)
    var customImageOverlay: Int
        get() = prefs.getInt("custom_image_overlay", 30)
        set(v) = prefs.edit().putInt("custom_image_overlay", v).apply()

    // 커스텀 배경 사용 시 키 텍스트 색상: "어둠" / "밝음"
    var customKeyTextColor: String
        get() = prefs.getString("custom_key_text_color", "어둠") ?: "어둠"
        set(v) = prefs.edit().putString("custom_key_text_color", v).apply()
}
