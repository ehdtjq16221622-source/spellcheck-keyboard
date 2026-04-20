package com.spellcheck.keyboard

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.BitmapShader
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.RenderEffect
import android.graphics.Shader
import android.graphics.drawable.BitmapDrawable
import android.media.AudioManager
import android.inputmethodservice.InputMethodService
import android.text.InputType
import android.view.ViewTreeObserver
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.ExtractedTextRequest
import android.widget.Button
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.PopupWindow
import android.animation.Animator
import android.animation.AnimatorListenerAdapter
import android.animation.ObjectAnimator
import android.util.TypedValue
import android.widget.TextView
import android.view.WindowManager
import kotlin.math.abs
import kotlin.math.roundToInt

private typealias KeyboardThemeSpec = KeyboardThemeApplicator.Spec
private typealias KeyboardKeyRole = KeyboardThemeApplicator.KeyRole

class KeyboardService : InputMethodService() {

    enum class InputMode { DUBEOLSIK, CHEONJIIN, ENGLISH, SYMBOL, SYMBOL2, SYMBOL3, DUBEOL_SYMBOL, DUBEOL_SYMBOL2 }
    private enum class SuggestionMode { CORRECTION, TRANSLATION, NO_CREDITS }

    private lateinit var keyboardView: View
    private val dubeolsikComposer = HangulComposer()
    private val cheonjiinComposer = CheonjiinComposer()
    private val handler = Handler(Looper.getMainLooper())

    // Run InputConnection work on a separate thread to avoid blocking the main thread.
    private val icThread = android.os.HandlerThread("ICThread").also { it.start() }
    private val icHandler = Handler(icThread.looper)

    private fun postIC(block: () -> Unit) = icHandler.post(block)

    private var inputMode = InputMode.DUBEOLSIK
    private var prevInputMode = InputMode.DUBEOLSIK  // mode before entering symbol keyboard
    private var lastKoreanMode = InputMode.DUBEOLSIK  // last active Korean mode for mode cycling
    private var isServiceActive = false
    private var isFormalMode = false
    private var isShiftOn = false       // English shift
    private var isCapsLock = false      // English caps lock (shift 더블탭)
    private var lastShiftTapTime = 0L   // 더블탭 감지용
    private var isDubeolShift = false   // Dubeolsik double-consonant shift
    private var correctedText = ""
    private var translatedText = ""
    private var suggestionMode = SuggestionMode.CORRECTION
    private var selectedTranslationLang = "en"

    private val formalOptionButtons = mapOf(
        R.id.btnFormal_jondaemal to "존댓말",
        R.id.btnFormal_gyeoksik  to "격식체",
        R.id.btnFormal_sanae     to "사내 메시지",
        R.id.btnFormal_gogaek    to "고객 안내",
        R.id.btnFormal_hakbumo   to "공문 안내",
        R.id.btnFormal_sogaeting to "친근체"
    )
    private val langButtons = mapOf(
        R.id.btn_lang_ko to "ko",
        R.id.btn_lang_en to "en",
        R.id.btn_lang_zh to "zh",
        R.id.btn_lang_ja to "ja"
    )

    // Cache selection to reduce repeated getExtractedText IPC calls while typing.
    private var cachedSelStart = -1
    private var cachedSelEnd = -1

    // Cache the currently applied theme state to avoid reapplying on every redraw.
    private var appliedTheme: String = ""
    private var appliedCustomPath: String = ""
    private var appliedCustomMode: String = ""

    private var lastConsonant: Char = ' ' 
    private var lastConsonantTime: Long = 0
    private val DOUBLE_TAP_MS = 400L
    private val doubleConsonantMap = mapOf(
        'ㄱ' to 'ㄲ', 'ㄷ' to 'ㄸ', 'ㅂ' to 'ㅃ', 'ㅅ' to 'ㅆ', 'ㅈ' to 'ㅉ'
    )

    // Cheonjiin consonant cycling state.
    private var lastCJKeyId: Int = 0
    private var lastCJKeyTime: Long = 0
    private var lastCJCycleIdx: Int = 0
    private val cjCycleLists = mapOf(
        'ㄱ' to listOf('ㄱ', 'ㅋ', 'ㄲ'),
        'ㄴ' to listOf('ㄴ', 'ㄹ'),
        'ㄷ' to listOf('ㄷ', 'ㅌ', 'ㄸ'),
        'ㅂ' to listOf('ㅂ', 'ㅍ', 'ㅃ'),
        'ㅅ' to listOf('ㅅ', 'ㅎ', 'ㅆ'),
        'ㅈ' to listOf('ㅈ', 'ㅊ', 'ㅉ'),
        'ㅇ' to listOf('ㅇ', 'ㅁ')
    )

    // .,?! ?쒗솚 ?낅젰
    private val punctCycleList = listOf('.', ',', '?', '!')
    private var lastPunctCycleIdx = -1
    private var lastPunctCycleTime = 0L
    private val punctBtnResetRunnable = Runnable {
        keyboardView.findViewById<android.widget.TextView>(R.id.key_cj_punct)?.text = ".,?!"
    }

    private var lastSpaceTime = 0L

    // custom image bitmap cache to avoid re-reading file on every keyboard show
    private var cachedBitmapPath = ""
    private var cachedBitmap: Bitmap? = null
    private var appliedBackgroundBitmap: Bitmap? = null
    private var customThemeRenderVersion = 0

    // React to settings changes while the keyboard is open.
    private val settingsChangeListener = android.content.SharedPreferences.OnSharedPreferenceChangeListener { _, key ->
        if (!isServiceActive) return@OnSharedPreferenceChangeListener
        handler.post {
            when (key) {
                "keyboard_theme", "custom_image_path", "custom_image_mode",
                "custom_image_overlay", "custom_key_text_color", "custom_button_opacity", "custom_chrome_theme",
                "custom_image_scale", "custom_blur_amount",
                "custom_image_offset_x", "custom_image_offset_y" -> {
                    customThemeRenderVersion++
                    clearAppliedBackgroundBitmap()
                    cachedBitmap?.recycle()
                    cachedBitmap = null
                    cachedBitmapPath = ""
                    appliedTheme = ""  // force re-apply
                    if (::keyboardView.isInitialized) applyTheme()
                }
                "formal_default" -> {
                    isFormalMode = false
                    if (::keyboardView.isInitialized) {
                        keyboardView.findViewById<View>(R.id.formalOptionsRow)?.visibility = View.GONE
                    }
                }
            }
        }
    }

    // Repeated delete while the delete key is held down.
    private val deleteRepeatStartDelayMs = 240L
    private val deleteRepeatIntervalMs = 72L
    private val keyPreviewMinIntervalMs = 240L
    private val keyPreviewDismissDelayMs = 45L
    private val keyVibrationDurationMs = 6L
    private val rapidTypingThresholdMs = 55L
    private val rapidTypingBurstHoldMs = 140L
    private val deleteRepeatRunnable = object : Runnable {
        override fun run() {
            onBackspace()
            handler.postDelayed(this, deleteRepeatIntervalMs)
        }
    }

    // Auto-correction runs after a short idle delay.
    private val autoCorrectRunnable = Runnable { performAutoCorrect() }
    private val keyPreviewDismissRunnable = Runnable { keyPreviewPopup?.dismiss() }

    // Key preview popup
    private var keyPreviewPopup: PopupWindow? = null
    private var keyPreviewTextView: TextView? = null
    private var lastKeyPreviewTime = 0L
    private var lastKeyDownTime = 0L
    private var rapidTypingBurstUntil = 0L

    // Vibration
    @Suppress("DEPRECATION")
    private val vibrator by lazy { getSystemService(Context.VIBRATOR_SERVICE) as Vibrator }
    private val audioManager by lazy { getSystemService(Context.AUDIO_SERVICE) as AudioManager }

    // ACTION_DOWN + POINTER_DOWN 처리 (멀티터치 타이핑 지원)
    private fun View.onKeyDown(block: (View) -> Unit) {
        setOnTouchListener { v, event ->
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN, MotionEvent.ACTION_POINTER_DOWN -> {
                    val now = System.currentTimeMillis()
                    if (now - lastKeyDownTime < rapidTypingThresholdMs) {
                        rapidTypingBurstUntil = now + rapidTypingBurstHoldMs
                    }
                    lastKeyDownTime = now
                    v.isPressed = true
                    block(v)
                    true
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_POINTER_UP, MotionEvent.ACTION_CANCEL -> {
                    v.isPressed = false
                    true
                }
                MotionEvent.ACTION_MOVE -> true
                else -> false
            }
        }
    }

    override fun onCreate() {
        super.onCreate()
        isServiceActive = true
        SettingsManager.init(this)
        TrialManager.init(this)
        CreditsManager.init(this)
        val prefs = getSharedPreferences("settings", android.content.Context.MODE_PRIVATE)
        prefs.registerOnSharedPreferenceChangeListener(settingsChangeListener)
    }

    override fun onCreateInputView(): View {
        keyboardView = layoutInflater.inflate(R.layout.keyboard_view, null)
        @Suppress("DEPRECATION")
        keyboardView.setOnApplyWindowInsetsListener { v, insets ->
            val bottom = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                insets.getInsets(android.view.WindowInsets.Type.systemBars()).bottom
            } else {
                insets.systemWindowInsetBottom
            }
            val body = v.findViewById<View>(R.id.keyboardBody)
            v.setPadding(0, 0, 0, 0)
            if (body != null) {
                body.setPaddingRelative(body.paddingStart, body.paddingTop, body.paddingEnd, bottom)
            } else {
                v.setPadding(0, 0, 0, bottom)
            }
            insets
        }
        applyAdaptiveKeyboardSizing()
        val koreanMode = when (SettingsManager.defaultMode) {
            "천지인" -> InputMode.CHEONJIIN
            else -> InputMode.DUBEOLSIK
        }
        inputMode = koreanMode
        prevInputMode = koreanMode
        lastKoreanMode = koreanMode
        isFormalMode = false
        positionChromeRows()
        applyTheme()
        setupButtons()
        updateKeyboardMode()
        return keyboardView
    }

    private fun positionChromeRows() {
        val root = keyboardView as? LinearLayout ?: return
        val langRow = root.findViewById<View>(R.id.langSelectRow) ?: return
        val formalRow = root.findViewById<View>(R.id.formalOptionsRow) ?: return
        val params = langRow.layoutParams ?: return
        root.removeView(langRow)
        val formalIndex = root.indexOfChild(formalRow)
        val insertIndex = if (formalIndex >= 0) formalIndex else root.childCount
        root.addView(langRow, insertIndex, params)
    }

    private fun applyAdaptiveKeyboardSizing() {
        val layoutScale = KeyboardSizing.scaleFactor(resources.configuration)
        if (layoutScale <= 1.01f) return
        val textScale = KeyboardSizing.textScaleFactor(layoutScale)
        scaleKeyboardView(keyboardView, layoutScale, textScale)
    }

    private fun scaleKeyboardView(view: View, layoutScale: Float, textScale: Float) {
        scaleLayoutParams(view, layoutScale)
        scalePadding(view, layoutScale)

        if (view is TextView) {
            view.setTextSize(TypedValue.COMPLEX_UNIT_PX, view.textSize * textScale)
        }

        if (view is ViewGroup) {
            view.clipChildren = false
            view.clipToPadding = false
            for (i in 0 until view.childCount) {
                scaleKeyboardView(view.getChildAt(i), layoutScale, textScale)
            }
        }
    }

    private fun scaleLayoutParams(view: View, layoutScale: Float) {
        val lp = view.layoutParams ?: return

        fun scaled(value: Int): Int {
            if (value <= 0) return value
            return (value * layoutScale).roundToInt().coerceAtLeast(1)
        }

        if (lp.width > 0) lp.width = scaled(lp.width)
        if (lp.height > 0) lp.height = scaled(lp.height)

        if (lp is ViewGroup.MarginLayoutParams) {
            lp.leftMargin = scaled(lp.leftMargin)
            lp.topMargin = scaled(lp.topMargin)
            lp.rightMargin = scaled(lp.rightMargin)
            lp.bottomMargin = scaled(lp.bottomMargin)
            lp.marginStart = scaled(lp.marginStart)
            lp.marginEnd = scaled(lp.marginEnd)
        }

        view.layoutParams = lp
    }

    private fun scalePadding(view: View, layoutScale: Float) {
        fun scaled(value: Int): Int = (value * layoutScale).roundToInt()

        view.setPaddingRelative(
            scaled(view.paddingStart),
            scaled(view.paddingTop),
            scaled(view.paddingEnd),
            scaled(view.paddingBottom)
        )
    }

    private fun resolveCanonicalHeight(view: View?): Int {
        if (view == null) return 0
        val lpHeight = view.layoutParams?.height ?: 0
        if (lpHeight > 0) return lpHeight
        if (view is ViewGroup) {
            var total = view.paddingTop + view.paddingBottom
            for (i in 0 until view.childCount) {
                total += resolveCanonicalHeight(view.getChildAt(i))
            }
            return total
        }
        return 0
    }

    private fun applyStableKeyboardHeight() {
        val topVisibleHeight = listOf(
            R.id.suggestionBar,
            R.id.langSelectRow,
            R.id.formalOptionsRow,
            R.id.toolbar
        ).sumOf { id ->
            keyboardView.findViewById<View>(id)?.takeIf { it.visibility == View.VISIBLE }?.let(::resolveCanonicalHeight) ?: 0
        }

        val rowNumbersHeight = resolveCanonicalHeight(keyboardView.findViewById(R.id.rowNumbers))
        val bottomRowHeight = resolveCanonicalHeight(keyboardView.findViewById(R.id.bottomRow))

        val bodyHeight = listOf(
            rowNumbersHeight + resolveCanonicalHeight(keyboardView.findViewById(R.id.container_dubeolsik)) + bottomRowHeight,
            rowNumbersHeight + resolveCanonicalHeight(keyboardView.findViewById(R.id.container_english)) + bottomRowHeight,
            rowNumbersHeight + resolveCanonicalHeight(keyboardView.findViewById(R.id.container_cheonjiin)),
            resolveCanonicalHeight(keyboardView.findViewById(R.id.container_symbols)),
            resolveCanonicalHeight(keyboardView.findViewById(R.id.container_symbols2)),
            resolveCanonicalHeight(keyboardView.findViewById(R.id.container_symbols3)),
            resolveCanonicalHeight(keyboardView.findViewById(R.id.container_dubeol_sym1)),
            resolveCanonicalHeight(keyboardView.findViewById(R.id.container_dubeol_sym2))
        ).maxOrNull() ?: 0

        keyboardView.minimumHeight = topVisibleHeight + bodyHeight
        keyboardView.requestLayout()
    }

    private fun recycleBitmap(bitmap: Bitmap?) {
        if (bitmap != null && !bitmap.isRecycled) bitmap.recycle()
    }

    private fun clearAppliedBackgroundBitmap() {
        val oldBitmap = appliedBackgroundBitmap ?: return
        appliedBackgroundBitmap = null
        if (::keyboardView.isInitialized) {
            val background = keyboardBackgroundHost().background
            if (background is BitmapDrawable && background.bitmap === oldBitmap) {
                keyboardBackgroundHost().background = null
            }
        }
        recycleBitmap(oldBitmap)
    }

    private fun keyboardBackgroundHost(): View {
        return keyboardView.findViewById(R.id.keyboardBody) ?: keyboardView
    }

    private fun setKeyboardBackgroundBitmap(bitmap: Bitmap) {
        val oldBitmap = appliedBackgroundBitmap
        appliedBackgroundBitmap = bitmap
        keyboardBackgroundHost().background = BitmapDrawable(resources, bitmap)
        if (oldBitmap !== bitmap) recycleBitmap(oldBitmap)
    }

    private fun scaleBitmapToSize(src: Bitmap, w: Int, h: Int): Bitmap {
        if (src.width == w && src.height == h) return src.copy(Bitmap.Config.ARGB_8888, false)
        val result = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(result)
        val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
        val dst = android.graphics.Rect(0, 0, w, h)
        canvas.drawBitmap(src, null, dst, paint)
        return result
    }

    private fun builtInThemeSpec(theme: String) = KeyboardThemeApplicator.builtInSpec(theme)
    private fun customThemeSpec(textColor: Int, buttonAlpha: Int, chromeTheme: String) = KeyboardThemeApplicator.customSpec(textColor, buttonAlpha, chromeTheme)
    private fun currentThemeSpec(): KeyboardThemeSpec {
        val theme = SettingsManager.keyboardTheme
        return if (theme == "커스텀") {
            val textColor = if (SettingsManager.customKeyTextColor == "밝음") Color.WHITE else Color.parseColor("#1C1C1E")
            val btnAlpha = (SettingsManager.customButtonOpacity * 255 / 100).coerceIn(0, 255)
            customThemeSpec(textColor, btnAlpha, SettingsManager.customChromeTheme)
        } else {
            builtInThemeSpec(theme)
        }
    }

    private fun applyImeWindowBackground(color: Int) {
        val imeWindow = window.window ?: return
        imeWindow.setBackgroundDrawable(ColorDrawable(color))
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            imeWindow.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS)
            imeWindow.navigationBarColor = color
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                imeWindow.isNavigationBarContrastEnforced = false
            }
        }
    }

    private fun applyTheme() {
        val theme = SettingsManager.keyboardTheme
        if (theme == "커스텀") {
            applyCustomImageTheme()
            return
        }

        customThemeRenderVersion++
        clearAppliedBackgroundBitmap()

        val spec = builtInThemeSpec(theme)
        applyImeWindowBackground(spec.background)
        keyboardView.setBackgroundColor(spec.background)
        keyboardBackgroundHost().setBackgroundColor(spec.background)
        applyContainerBackgrounds(spec.background, includeBody = true)
        applyKeyboardChrome(spec)
        applyKeyboardKeyStyles(spec)
        updateDubeolShift()
        updateFormalOptionHighlight()
        updateLangHighlight()
    }

    private fun applyContainerBackgrounds(bgColor: Int, includeBody: Boolean = true) = KeyboardThemeApplicator.applyContainerBackgrounds(keyboardView, bgColor, includeBody)

    private fun applyCustomImageTheme() {
        val renderVersion = ++customThemeRenderVersion
        val path = SettingsManager.customImagePath
        if (path.isEmpty()) {
            clearAppliedBackgroundBitmap()
            val fallbackColor = Color.parseColor("#F9F9FE")
            applyImeWindowBackground(fallbackColor)
            keyboardView.setBackgroundColor(fallbackColor)
            keyboardBackgroundHost().setBackgroundColor(fallbackColor)
            return
        }

        val backgroundHost = keyboardBackgroundHost()
        val layoutScale = KeyboardSizing.scaleFactor(resources.configuration)
        val fallbackBodyHeight = (222f * resources.displayMetrics.density * layoutScale).roundToInt()
        val targetWidth = (SettingsManager.keyboardBodyWidthPx.takeIf { it > 0 }
            ?: backgroundHost.width.takeIf { it > 0 }
            ?: resources.displayMetrics.widthPixels).coerceAtLeast(720)
        val targetHeight = (SettingsManager.keyboardBodyHeightPx.takeIf { it > 0 }
            ?: backgroundHost.height.takeIf { it > 0 }
            ?: fallbackBodyHeight).coerceAtLeast(360)

        // Use cached bitmap to avoid re-reading file on every keyboard show
        val srcBitmap: Bitmap = if (path == cachedBitmapPath && cachedBitmap != null) {
            cachedBitmap!!
        } else {
            val bmp = decodeSampledBitmap(this, path, targetWidth * 2, targetHeight * 2)
            if (bmp == null) {
                clearAppliedBackgroundBitmap()
                val fallbackColor = Color.parseColor("#F9F9FE")
                applyImeWindowBackground(fallbackColor)
                keyboardView.setBackgroundColor(fallbackColor)
                keyboardBackgroundHost().setBackgroundColor(fallbackColor)
                return
            }
            cachedBitmapPath = path
            cachedBitmap = bmp
            bmp
        }

        val mode = SettingsManager.customImageMode
        val overlayAlpha = SettingsManager.customImageOverlay
        val textColor = if (SettingsManager.customKeyTextColor == "밝음") Color.WHITE
                        else Color.parseColor("#1C1C1E")

        val btnOpacity = SettingsManager.customButtonOpacity
        val btnAlpha = (btnOpacity * 255 / 100).coerceIn(0, 255)
        val imgScale = SettingsManager.customImageScale
        val blurAmount = SettingsManager.customBlurAmount
        val offsetX = SettingsManager.customImageOffsetX
        val offsetY = SettingsManager.customImageOffsetY

        fun applyWithSize() {
            val host = keyboardBackgroundHost()
            val w = host.width.takeIf { it > 0 } ?: return
            val h = host.height.takeIf { it > 0 } ?: return
            // Save the measured keyboard body size so crop/preview can use the real aspect ratio.
            if (w > 0) SettingsManager.keyboardBodyWidthPx = w
            if (h > 0) SettingsManager.keyboardBodyHeightPx = h

            // Process the bitmap off the main thread.
            Thread {
                var processed: Bitmap? = null
                try {
                    processed = when (mode) {
                        "꽉채우기" -> {
                            if (imgScale == 1.0f && abs(offsetX) < 0.001f && abs(offsetY) < 0.001f) {
                                scaleBitmapToSize(srcBitmap, w, h)
                            } else {
                                centerCropBitmap(srcBitmap, w, h, imgScale, offsetX, offsetY)
                            }
                        }
                        "타일"     -> tileBitmap(srcBitmap, w, h, mirror = false, scale = imgScale)
                        "바둑판"   -> badukBitmap(srcBitmap, w, h, scale = imgScale)
                        "블러"     -> {
                            val base = if (imgScale == 1.0f && abs(offsetX) < 0.001f && abs(offsetY) < 0.001f) {
                                scaleBitmapToSize(srcBitmap, w, h)
                            } else {
                                centerCropBitmap(srcBitmap, w, h, imgScale, offsetX, offsetY)
                            }
                            blurBitmap(base, blurAmount)
                        }
                        else       -> centerCropBitmap(srcBitmap, w, h, imgScale, offsetX, offsetY)
                    }
                    val finalBitmap = applyOverlay(processed, overlayAlpha)
                    if (finalBitmap !== processed) {
                        recycleBitmap(processed)
                        processed = null
                    }

                    // Apply the processed bitmap on the main thread.
                    handler.post {
                        if (!isServiceActive || renderVersion != customThemeRenderVersion) {
                            recycleBitmap(finalBitmap)
                            return@post
                        }
                        val chromeColor = customThemeSpec(textColor, btnAlpha, SettingsManager.customChromeTheme).chromeBackground
                        applyImeWindowBackground(chromeColor)
                        keyboardView.setBackgroundColor(chromeColor)
                        setKeyboardBackgroundBitmap(finalBitmap)
                        applyContainerBackgrounds(Color.TRANSPARENT, includeBody = false)
                        val spec = customThemeSpec(textColor, btnAlpha, SettingsManager.customChromeTheme)
                        applyKeyboardChrome(spec)
                        applyKeyboardKeyStyles(spec)
                        updateDubeolShift()
                        updateFormalOptionHighlight()
                        updateLangHighlight()
                    }
                } catch (_: Throwable) {
                    recycleBitmap(processed)
                }
            }.start()
        }

        if (backgroundHost.width > 0 && backgroundHost.height > 0) {
            applyWithSize()
        } else {
            backgroundHost.viewTreeObserver.addOnGlobalLayoutListener(object : ViewTreeObserver.OnGlobalLayoutListener {
                override fun onGlobalLayout() {
                    if (backgroundHost.width <= 0 || backgroundHost.height <= 0) return
                    backgroundHost.viewTreeObserver.removeOnGlobalLayoutListener(this)
                    applyWithSize()
                }
            })
        }
    }

    // Center-crop with optional zoom and normalized offsets.
    private fun centerCropBitmap(src: Bitmap, w: Int, h: Int, scale: Float = 1.0f, offsetX: Float = 0f, offsetY: Float = 0f): Bitmap {
        val srcRatio = src.width.toFloat() / src.height
        val dstRatio = w.toFloat() / h
        if (abs(srcRatio - dstRatio) < 0.01f && abs(scale - 1f) < 0.001f && abs(offsetX) < 0.001f && abs(offsetY) < 0.001f) {
            return Bitmap.createScaledBitmap(src, w, h, true)
        }
        val (baseW, baseH) = if (srcRatio > dstRatio)
            (src.height * dstRatio).toInt() to src.height
        else
            src.width to (src.width / dstRatio).toInt()
        // Larger scale means a tighter crop.
        val cropW = (baseW / scale.coerceAtLeast(0.1f)).toInt().coerceIn(1, src.width)
        val cropH = (baseH / scale.coerceAtLeast(0.1f)).toInt().coerceIn(1, src.height)
        val centerX = (src.width - cropW) / 2
        val centerY = (src.height - cropH) / 2
        val maxOffX = centerX
        val maxOffY = centerY
        val x = (centerX + (offsetX * maxOffX)).toInt().coerceIn(0, (src.width - cropW).coerceAtLeast(0))
        val y = (centerY + (offsetY * maxOffY)).toInt().coerceIn(0, (src.height - cropH).coerceAtLeast(0))
        val cropped = Bitmap.createBitmap(src, x, y, cropW, cropH)
        val result = Bitmap.createScaledBitmap(cropped, w, h, true)
        if (cropped !== src) cropped.recycle()
        return result
    }

    // 媛?대뜲 諛곗튂 (?⑤뵫)
    private fun centerBitmap(src: Bitmap, w: Int, h: Int): Bitmap {
        val result = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(result)
        canvas.drawColor(Color.parseColor("#F9F9FE"))
        val scale = minOf(w.toFloat() / src.width, h.toFloat() / src.height)
        val scaledW = (src.width * scale).toInt()
        val scaledH = (src.height * scale).toInt()
        val left = (w - scaledW) / 2f
        val top = (h - scaledH) / 2f
        val scaled = Bitmap.createScaledBitmap(src, scaledW, scaledH, true)
        canvas.drawBitmap(scaled, left, top, null)
        if (scaled !== src) scaled.recycle()
        return result
    }

    // ???諛섎났
    private fun isLightColor(color: Int): Boolean {
        val r = Color.red(color) / 255.0
        val g = Color.green(color) / 255.0
        val b = Color.blue(color) / 255.0

        fun channel(v: Double): Double =
            if (v <= 0.03928) v / 12.92 else Math.pow((v + 0.055) / 1.055, 2.4)

        val luminance = 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
        return luminance > 0.5
    }

    private fun tileBitmap(src: Bitmap, w: Int, h: Int, mirror: Boolean, scale: Float = SettingsManager.customImageScale): Bitmap {
        val tileSize = ((minOf(w, h) / 3f) * scale.coerceAtLeast(0.5f)).roundToInt().coerceAtLeast(1)
        val tile = Bitmap.createScaledBitmap(src, tileSize, tileSize, true)
        val result = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(result)
        val paint = Paint()
        val shader = BitmapShader(
            tile,
            if (mirror) Shader.TileMode.MIRROR else Shader.TileMode.REPEAT,
            if (mirror) Shader.TileMode.MIRROR else Shader.TileMode.REPEAT
        )
        paint.shader = shader
        canvas.drawRect(0f, 0f, w.toFloat(), h.toFloat(), paint)
        if (tile !== src) tile.recycle()
        return result
    }

    // 釉붾윭: ?ㅼ슫?ㅼ??????낆뒪耳??(?뚰봽?몄썾??釉붾윭, API 臾닿?)
    // amount 1 ??嫄곗쓽 ?놁쓬, amount 25 ??理쒕? 釉붾윭
    private fun blurBitmap(src: Bitmap, amount: Int = 12): Bitmap {
        val downScale = (1f - amount.toFloat() / 26f).coerceAtLeast(0.04f)
        val small = Bitmap.createScaledBitmap(
            src, (src.width * downScale).toInt().coerceAtLeast(1),
            (src.height * downScale).toInt().coerceAtLeast(1), true
        )
        val result = Bitmap.createScaledBitmap(small, src.width, src.height, true)
        if (small !== src) small.recycle()
        return result
    }

    // ?ㅻ쾭?덉씠 (諛섑닾紐??대몢???덉씠??
    private fun applyOverlay(src: Bitmap, alphaPercent: Int): Bitmap {
        if (alphaPercent == 0) return src
        val result = src.copy(Bitmap.Config.ARGB_8888, true)
        val canvas = Canvas(result)
        val paint = Paint()
        paint.color = Color.argb((alphaPercent * 2.55f).toInt(), 0, 0, 0)
        canvas.drawRect(0f, 0f, result.width.toFloat(), result.height.toFloat(), paint)
        return result
    }

    // 諛붾몣?? 珥섏킌??寃⑹옄 ???(??쇰낫???묒? ?ш린濡?諛섎났)
    private fun badukBitmap(src: Bitmap, w: Int, h: Int, scale: Float = SettingsManager.customImageScale): Bitmap {
        val tileSize = ((minOf(w, h) / 5f) * scale.coerceAtLeast(0.5f)).roundToInt().coerceAtLeast(1)
        val tile = Bitmap.createScaledBitmap(src, tileSize, tileSize, true)
        val result = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(result)
        val paint = Paint()
        var y = 0
        while (y < h) {
            var x = 0
            while (x < w) {
                canvas.drawBitmap(tile, x.toFloat(), y.toFloat(), paint)
                x += tileSize
            }
            y += tileSize
        }
        if (tile !== src) tile.recycle()
        return result
    }

    private fun createKeyDrawable(fill: Int, pressedFill: Int, radiusDp: Float = 6f, strokeColor: Int? = null, strokeWidthDp: Float = 0f) = KeyboardThemeApplicator.createKeyDrawable(resources.displayMetrics.density, fill, pressedFill, radiusDp, strokeColor, strokeWidthDp)

    private fun applyKeyboardChrome(spec: KeyboardThemeSpec) = KeyboardThemeApplicator.applyChrome(keyboardView, spec, resources.displayMetrics.density)

    private fun isDescendantOf(view: View, ancestorId: Int) = KeyboardThemeApplicator.isDescendantOf(view, ancestorId)

    private fun isChromeView(view: View) = KeyboardThemeApplicator.isChromeView(view)

    private fun keyRoleOf(view: View) = KeyboardThemeApplicator.keyRoleOf(view)

    private fun applyKeyboardKeyStyles(spec: KeyboardThemeSpec) = KeyboardThemeApplicator.applyKeyStyles(keyboardView, spec, resources.displayMetrics.density)

    private fun updateFormalOptionHighlight() {
        val spec = currentThemeSpec()
        val current = SettingsManager.normalizeFormalLevel(SettingsManager.formalLevel)
        formalOptionButtons.forEach { (id, level) ->
            val btn = keyboardView.findViewById<Button>(id) ?: return@forEach
            if (level == current) {
                btn.background = createKeyDrawable(spec.selectedFill, spec.selectedPressedFill, radiusDp = 4f)
                btn.setTextColor(spec.selectedText)
            } else {
                btn.background = createKeyDrawable(
                    fill = spec.outlineFill,
                    pressedFill = spec.chromeBackground,
                    radiusDp = 4f,
                    strokeColor = spec.outlineStroke,
                    strokeWidthDp = 1f
                )
                btn.setTextColor(spec.outlineText)
            }
        }
    }

    private fun updateLangHighlight() {
        val spec = currentThemeSpec()
        langButtons.forEach { (id, lang) ->
            val btn = keyboardView.findViewById<Button>(id) ?: return@forEach
            if (lang == selectedTranslationLang) {
                btn.background = createKeyDrawable(spec.selectedFill, spec.selectedPressedFill, radiusDp = 4f)
                btn.setTextColor(spec.selectedText)
            } else {
                btn.background = createKeyDrawable(
                    fill = spec.outlineFill,
                    pressedFill = spec.chromeBackground,
                    radiusDp = 4f,
                    strokeColor = spec.outlineStroke,
                    strokeWidthDp = 1f
                )
                btn.setTextColor(spec.outlineText)
            }
        }
        keyboardView.findViewById<Button>(R.id.btnTranslate)?.text = "번역"
    }

    private fun isSensitiveInputField(info: EditorInfo? = currentInputEditorInfo): Boolean {
        val editorInfo = info ?: return false
        if ((editorInfo.imeOptions and EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING) != 0) return true

        val inputType = editorInfo.inputType
        val inputClass = inputType and InputType.TYPE_MASK_CLASS
        val variation = inputType and InputType.TYPE_MASK_VARIATION
        return when (inputClass) {
            InputType.TYPE_CLASS_TEXT -> variation == InputType.TYPE_TEXT_VARIATION_PASSWORD ||
                variation == InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD ||
                variation == InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD
            InputType.TYPE_CLASS_NUMBER -> variation == InputType.TYPE_NUMBER_VARIATION_PASSWORD
            else -> false
        }
    }

    private fun prepareAiAction(showBlockedMessage: Boolean): Boolean {
        handler.removeCallbacks(autoCorrectRunnable)
        if (!isSensitiveInputField()) return true

        correctedText = ""
        translatedText = ""
        keyboardView.findViewById<View>(R.id.langSelectRow)?.visibility = View.GONE
        if (showBlockedMessage) {
            suggestionMode = SuggestionMode.CORRECTION
            showSuggestion("비밀번호 등 민감한 입력 칸에서는 AI 기능을 사용할 수 없습니다.", false)
        } else {
            hideSuggestionBar()
        }
        return false
    }

    override fun onUpdateSelection(
        oldSelStart: Int, oldSelEnd: Int,
        newSelStart: Int, newSelEnd: Int,
        candidatesStart: Int, candidatesEnd: Int
    ) {
        super.onUpdateSelection(oldSelStart, oldSelEnd, newSelStart, newSelEnd, candidatesStart, candidatesEnd)
        cachedSelStart = newSelStart
        cachedSelEnd = newSelEnd
    }

    override fun onStartInputView(info: EditorInfo?, restarting: Boolean) {
        super.onStartInputView(info, restarting)
        val theme = SettingsManager.keyboardTheme
        val path  = SettingsManager.customImagePath
        val mode  = SettingsManager.customImageMode
        if (theme != appliedTheme || path != appliedCustomPath || mode != appliedCustomMode) {
            applyTheme()
            appliedTheme = theme
            appliedCustomPath = path
            appliedCustomMode = mode
        }
        if (!restarting) {
            val newMode = when (SettingsManager.defaultMode) {
                "천지인" -> InputMode.CHEONJIIN
                else -> InputMode.DUBEOLSIK
            }
            if (inputMode != newMode) {
                commitComposing()
                inputMode = newMode
                lastKoreanMode = newMode
                prevInputMode = newMode
                updateKeyboardMode()
            }
        }
        if (isSensitiveInputField(info)) {
            keyboardView.findViewById<View>(R.id.langSelectRow)?.visibility = View.GONE
            hideSuggestionBar()
        }
    }

    private fun setupButtons() {
        // Translation toggle
        keyboardView.findViewById<Button>(R.id.btnTranslate).onKeyDown {
            vibrateKey()
            if (!prepareAiAction(showBlockedMessage = true)) return@onKeyDown
            val row = keyboardView.findViewById<View>(R.id.langSelectRow)
            if (row.visibility == View.VISIBLE) {
                row.visibility = View.GONE
            } else {
                row.visibility = View.VISIBLE
                updateLangHighlight()
            }
        }

        // Translation language buttons
        for ((id, lang) in langButtons) {
            keyboardView.findViewById<Button>(id)?.onKeyDown {
                vibrateKey()
                selectedTranslationLang = lang
                keyboardView.findViewById<View>(R.id.langSelectRow).visibility = View.GONE
                updateLangHighlight()
                performTranslation(lang)
            }
        }
        keyboardView.findViewById<Button>(R.id.btn_lang_cancel)?.onKeyDown {
            vibrateKey()
            keyboardView.findViewById<View>(R.id.langSelectRow).visibility = View.GONE
        }

        val formalOptionsRow = keyboardView.findViewById<View>(R.id.formalOptionsRow)
        formalOptionsRow.visibility = View.GONE
        keyboardView.findViewById<Button>(R.id.btnFormalToggle)?.setOnClickListener {
            vibrateKey()
            isFormalMode = !isFormalMode
            formalOptionsRow.visibility = if (isFormalMode) View.VISIBLE else View.GONE
            if (isFormalMode) scheduleAutoCorrect()
        }

        // Close tone row
        keyboardView.findViewById<Button>(R.id.btnFormal_close)?.setOnClickListener {
            vibrateKey()
            isFormalMode = false
            formalOptionsRow.visibility = View.GONE
        }

        // 말투 옵션 버튼
        updateFormalOptionHighlight()
        formalOptionButtons.forEach { (id, level) ->
            keyboardView.findViewById<Button>(id)?.setOnClickListener {
                vibrateKey()
                SettingsManager.formalLevel = level
                updateFormalOptionHighlight()
                scheduleAutoCorrect()
            }
        }

        // Apply correction/translation result
        val applyAction = View.OnClickListener {
            vibrateKey()
            val textToApply = if (suggestionMode == SuggestionMode.TRANSLATION) translatedText else correctedText
            if (textToApply.isNotBlank()) {
                commitComposing()
                val ic = currentInputConnection ?: return@OnClickListener
                ic.beginBatchEdit()
                ic.performContextMenuAction(android.R.id.selectAll)
                ic.commitText(textToApply, 1)
                ic.endBatchEdit()
            }
            hideSuggestionBar()
        }
        keyboardView.findViewById<Button>(R.id.btnApply).setOnClickListener(applyAction)
        keyboardView.findViewById<TextView>(R.id.tvSuggestion).setOnClickListener {
            if (correctedText.isNotEmpty() || translatedText.isNotEmpty()) applyAction.onClick(it)
        }

        // Rewarded-ad button
        keyboardView.findViewById<Button>(R.id.btnWatchAd)?.setOnClickListener {
            vibrateKey()
            hideSuggestionBar()
            RewardedAdActivity.start(this)
        }

        // Close suggestion bar
        keyboardView.findViewById<Button>(R.id.btnCloseSuggestion).onKeyDown {
            vibrateKey()
            hideSuggestionBar()
            keyboardView.findViewById<View>(R.id.langSelectRow).visibility = View.GONE
        }

        // Mode switch
        keyboardView.findViewById<View>(R.id.key_mode).onKeyDown {
            vibrateKey()
            cycleInputMode()
        }

        val numMap = mapOf(
            R.id.key_num_1 to "1", R.id.key_num_2 to "2", R.id.key_num_3 to "3",
            R.id.key_num_4 to "4", R.id.key_num_5 to "5", R.id.key_num_6 to "6",
            R.id.key_num_7 to "7", R.id.key_num_8 to "8", R.id.key_num_9 to "9",
            R.id.key_num_0 to "0"
        )
        for ((id, num) in numMap) {
            keyboardView.findViewById<Button>(id)?.onKeyDown { view ->
                vibrateKey()
                showKeyPreview(view, num)
                lastCJKeyId = 0
                commitComposing()
                currentInputConnection?.commitText(num, 1)
            }
        }

        // ===== Dubeolsik =====
        val dubeolsikMap = mapOf(
            R.id.key_bieup to 'ㅂ', R.id.key_jieut to 'ㅈ', R.id.key_digeut to 'ㄷ',
            R.id.key_giyeok to 'ㄱ', R.id.key_siot to 'ㅅ', R.id.key_yo to 'ㅛ',
            R.id.key_yeo to 'ㅕ', R.id.key_ya to 'ㅑ', R.id.key_ae to 'ㅐ',
            R.id.key_e to 'ㅔ', R.id.key_mieum to 'ㅁ', R.id.key_nieun to 'ㄴ',
            R.id.key_ieung to 'ㅇ', R.id.key_rieul to 'ㄹ', R.id.key_hieut to 'ㅎ',
            R.id.key_o to 'ㅗ', R.id.key_eo to 'ㅓ', R.id.key_a to 'ㅏ',
            R.id.key_i to 'ㅣ', R.id.key_kieuk to 'ㅋ', R.id.key_tieut to 'ㅌ',
            R.id.key_chieut to 'ㅊ', R.id.key_pieup2 to 'ㅍ', R.id.key_yu to 'ㅠ',
            R.id.key_u to 'ㅜ', R.id.key_eu to 'ㅡ'
        )
        for ((id, jamo) in dubeolsikMap) {
            keyboardView.findViewById<Button>(id)?.onKeyDown { view ->
                onDubeolsikJamo(jamo, view)
            }
        }
        setupDeleteButton(R.id.key_delete)

        // Dubeolsik shift
        keyboardView.findViewById<View>(R.id.key_shift)?.onKeyDown {
            vibrateKey()
            isDubeolShift = !isDubeolShift
            updateDubeolShift()
        }

        // ===== Cheonjiin =====
        // Combined consonant keys
        val cjCombinedKeys = mapOf(
            R.id.key_cj_gk to 'ㄱ', R.id.key_cj_nr to 'ㄴ', R.id.key_cj_dt to 'ㄷ',
            R.id.key_cj_bp to 'ㅂ', R.id.key_cj_sh to 'ㅅ', R.id.key_cj_jch to 'ㅈ',
            R.id.key_cj_om to 'ㅇ'
        )
        for ((id, primary) in cjCombinedKeys) {
            keyboardView.findViewById<View>(id)?.onKeyDown { view ->
                onCJCombinedKey(id, primary, view)
            }
        }
        val cheonjiinVowels = mapOf(
            R.id.key_cj_dot to 'ㆍ',
            R.id.key_cj_eu to 'ㅡ',
            R.id.key_cj_i to 'ㅣ'
        )
        for ((id, vowel) in cheonjiinVowels) {
            keyboardView.findViewById<Button>(id)?.onKeyDown { view ->
                lastCJKeyId = 0
                onCheonjiinInput(vowel, view)
            }
        }
        // Cheonjiin bottom row actions
        keyboardView.findViewById<View>(R.id.key_cj_enter)?.onKeyDown {
            vibrateKey(); lastCJKeyId = 0; commitComposing(); sendDefaultEditorAction(true)
        }
        keyboardView.findViewById<Button>(R.id.key_cj_space)?.onKeyDown {
            vibrateKey(); lastCJKeyId = 0
            val now = System.currentTimeMillis()
            // 종성 플러시 후에도 반드시 스페이스 커밋 (네이버 동작과 동일)
            val flushed = cheonjiinComposer.flushIfJong()
            if (flushed != null) {
                val ic = currentInputConnection ?: return@onKeyDown
                ic.beginBatchEdit()
                try {
                    ic.commitText(flushed, 1)
                    ic.finishComposingText()
                    ic.commitText(" ", 1)
                } finally {
                    ic.endBatchEdit()
                }
                lastSpaceTime = now
                scheduleAutoCorrect()
                return@onKeyDown
            }
            if (SettingsManager.doubleSpacePeriod && now - lastSpaceTime < 300L) {
                commitComposing()
                currentInputConnection?.deleteSurroundingText(1, 0)
                currentInputConnection?.commitText(". ", 1)
                lastSpaceTime = 0
            } else {
                commitComposing()
                currentInputConnection?.commitText(" ", 1)
                lastSpaceTime = now
            }
            scheduleAutoCorrect()
        }
        keyboardView.findViewById<Button>(R.id.key_cj_punct)?.onKeyDown {
            lastCJKeyId = 0
            onPunctCycle()
        }
        keyboardView.findViewById<Button>(R.id.key_cj_quote)?.onKeyDown {
            vibrateKey(); lastCJKeyId = 0; commitComposing()
            currentInputConnection?.commitText("'", 1)
        }
        keyboardView.findViewById<Button>(R.id.key_cj_num)?.onKeyDown {
            vibrateKey(); lastCJKeyId = 0; switchToSymbol()
        }
        keyboardView.findViewById<View>(R.id.key_cj_mode)?.onKeyDown {
            vibrateKey(); lastCJKeyId = 0; cycleInputMode()
        }
        setupDeleteButton(R.id.key_cj_delete)

        // ===== ?곸뼱 ??=====
        val englishMap = mapOf(
            R.id.key_en_q to 'q', R.id.key_en_w to 'w', R.id.key_en_e to 'e',
            R.id.key_en_r to 'r', R.id.key_en_t to 't', R.id.key_en_y to 'y',
            R.id.key_en_u to 'u', R.id.key_en_i to 'i', R.id.key_en_o to 'o',
            R.id.key_en_p to 'p', R.id.key_en_a to 'a', R.id.key_en_s to 's',
            R.id.key_en_d to 'd', R.id.key_en_f to 'f', R.id.key_en_g to 'g',
            R.id.key_en_h to 'h', R.id.key_en_j to 'j', R.id.key_en_k to 'k',
            R.id.key_en_l to 'l', R.id.key_en_z to 'z', R.id.key_en_x to 'x',
            R.id.key_en_c to 'c', R.id.key_en_v to 'v', R.id.key_en_b to 'b',
            R.id.key_en_n to 'n', R.id.key_en_m to 'm'
        )
        for ((id, letter) in englishMap) {
            keyboardView.findViewById<Button>(id)?.also { btn ->
                btn.isAllCaps = false
                btn.onKeyDown { view ->
                    vibrateKey()
                    val ch = if (isShiftOn) letter.uppercaseChar() else letter
                    showKeyPreview(view, ch.toString())
                    currentInputConnection?.commitText(ch.toString(), 1)
                    if (isShiftOn && !isCapsLock) { isShiftOn = false; updateEnglishShift() }
                    scheduleAutoCorrect()
                }
            }
        }
        keyboardView.findViewById<ImageButton>(R.id.key_en_shift).onKeyDown {
            vibrateKey()
            val now = System.currentTimeMillis()
            when {
                isCapsLock -> {
                    // CapsLock 해제
                    isCapsLock = false
                    isShiftOn = false
                }
                isShiftOn && now - lastShiftTapTime < 300L -> {
                    // 300ms 내 두 번째 탭 → CapsLock 활성화
                    isCapsLock = true
                    isShiftOn = true
                }
                else -> {
                    // 일반 Shift 토글
                    isShiftOn = !isShiftOn
                }
            }
            lastShiftTapTime = now
            updateEnglishShift()
        }
        setupDeleteButton(R.id.key_en_delete)

        // ===== 怨듭쑀 ?섎떒 踰꾪듉 =====
        keyboardView.findViewById<Button>(R.id.key_space).onKeyDown {
            vibrateKey()
            val now = System.currentTimeMillis()
            if (SettingsManager.doubleSpacePeriod && now - lastSpaceTime < 300L) {
                commitComposing()
                currentInputConnection?.deleteSurroundingText(1, 0)
                currentInputConnection?.commitText(". ", 1)
                lastSpaceTime = 0
            } else {
                commitComposing()
                currentInputConnection?.commitText(" ", 1)
                lastSpaceTime = now
            }
            scheduleAutoCorrect()
        }

        keyboardView.findViewById<Button>(R.id.key_period).onKeyDown {
            vibrateKey()
            commitComposing()
            currentInputConnection?.commitText(".", 1)
            lastSpaceTime = 0
            scheduleAutoCorrect()
        }

        keyboardView.findViewById<Button>(R.id.key_quote)?.onKeyDown {
            vibrateKey()
            commitComposing()
            currentInputConnection?.commitText("'", 1)
        }

        // !#1 / ABC 踰꾪듉 ???뱀닔臾몄옄 ?ㅻ낫???좉?
        keyboardView.findViewById<Button>(R.id.key_num_mode)?.onKeyDown {
            vibrateKey()
            switchToSymbol()
        }

        setupSymbolKeys()

        keyboardView.findViewById<View>(R.id.key_enter).onKeyDown {
            vibrateKey()
            commitComposing()
            sendDefaultEditorAction(true)
        }
    }

    private fun vibrateKey() {
        if (System.currentTimeMillis() < rapidTypingBurstUntil) return
        if (SettingsManager.vibrationEnabled) {
            try {
                val feedbackConstant = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
                    HapticFeedbackConstants.KEYBOARD_TAP
                } else {
                    HapticFeedbackConstants.VIRTUAL_KEY
                }
                val performed = keyboardView.performHapticFeedback(feedbackConstant)
                if (!performed) {
                    if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
                        vibrator.vibrate(VibrationEffect.createOneShot(keyVibrationDurationMs, VibrationEffect.DEFAULT_AMPLITUDE))
                    } else {
                        @Suppress("DEPRECATION")
                        vibrator.vibrate(keyVibrationDurationMs)
                    }
                }
            } catch (e: Exception) { }
        }
        if (SettingsManager.soundEnabled) {
            try { audioManager.playSoundEffect(AudioManager.FX_KEYPRESS_STANDARD, -1f) } catch (e: Exception) { }
        }
    }

    private fun showKeyPreview(anchor: View, text: String) {
        if (!SettingsManager.keyPopup) return
        val now = System.currentTimeMillis()
        if (now < rapidTypingBurstUntil) return
        // Skip preview popups during very fast repeated input.
        if (now - lastKeyPreviewTime < keyPreviewMinIntervalMs) {
            handler.removeCallbacks(keyPreviewDismissRunnable)
            handler.post { keyPreviewPopup?.dismiss() }
            return
        }
        lastKeyPreviewTime = now
        // Post popup work so text commit/composition happens first.
        handler.post {
        val density = resources.displayMetrics.density
        val layoutScale = KeyboardSizing.scaleFactor(resources.configuration)
        val textScale = KeyboardSizing.textScaleFactor(layoutScale)
        val w = (58 * density * layoutScale).roundToInt()
        val h = (50 * density * layoutScale).roundToInt()

        // Reuse the popup TextView to avoid allocations during typing.
        val tv = keyPreviewTextView ?: TextView(this).apply {
            textSize = 18.5f * textScale
            gravity = Gravity.CENTER
            setTextColor(Color.parseColor("#222222"))
            background = android.graphics.drawable.GradientDrawable().apply {
                setColor(Color.WHITE)
                cornerRadius = 16 * density * layoutScale
                setStroke((1 * density).toInt(), Color.parseColor("#CCCCCC"))
            }
            setPadding(
                (16 * density * layoutScale).roundToInt(), (8 * density * layoutScale).roundToInt(),
                (16 * density * layoutScale).roundToInt(), (8 * density * layoutScale).roundToInt()
            )
        }.also { keyPreviewTextView = it }

        tv.text = text

        val popup = keyPreviewPopup ?: PopupWindow(tv, w, h, false).apply {
            elevation = 8f
        }.also { keyPreviewPopup = it }

        try {
            val xOff = (anchor.width - w) / 2
            val yOff = -(anchor.height + h + (4 * density * layoutScale).roundToInt())
            if (popup.isShowing) {
                popup.update(anchor, xOff, yOff, w, h)
            } else {
                popup.showAsDropDown(anchor, xOff, yOff)
            }
            handler.removeCallbacks(keyPreviewDismissRunnable)
            handler.postDelayed(keyPreviewDismissRunnable, keyPreviewDismissDelayMs)
        } catch (e: Exception) { }
        }
    }

    private fun setupDeleteButton(id: Int) {
        keyboardView.findViewById<View>(id)?.setOnTouchListener { _, event ->
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN, MotionEvent.ACTION_POINTER_DOWN -> {
                    vibrateKey()
                    onBackspace()
                    handler.postDelayed(deleteRepeatRunnable, deleteRepeatStartDelayMs)
                    true
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_POINTER_UP, MotionEvent.ACTION_CANCEL -> {
                    handler.removeCallbacks(deleteRepeatRunnable)
                    true
                }
                MotionEvent.ACTION_MOVE -> true
                else -> false
            }
        }
    }

    // ?먮쾶???낅젰 (?띿옄????踰??곗냽 吏??+ shift 吏??
    private fun onDubeolsikJamo(jamo: Char, anchor: View? = null) {
        vibrateKey()

        // When shift is on, try to emit a double consonant directly.
        if (isDubeolShift) {
            val shifted = doubleConsonantMap[jamo]
            if (shifted != null) {
                anchor?.let { showKeyPreview(it, shifted.toString()) }
                isDubeolShift = false
                updateDubeolShift()
                onHangulInput(shifted, dubeolsikComposer)
                scheduleAutoCorrect()
                return
            }
            isDubeolShift = false
            updateDubeolShift()
        }

        anchor?.let { showKeyPreview(it, jamo.toString()) }
        val now = System.currentTimeMillis()
        val doubled = doubleConsonantMap[jamo]

        if (doubled != null && jamo == lastConsonant && now - lastConsonantTime < DOUBLE_TAP_MS
            && dubeolsikComposer.isComposingConsonantOnly()) {
            val result = dubeolsikComposer.upgradeToDouble(doubled)
            val ic = currentInputConnection ?: return
            ic.beginBatchEdit()
            if (result.committed.isNotEmpty()) ic.commitText(result.committed, 1)
            if (result.composing != null) ic.setComposingText(result.composing.toString(), 1)
            else ic.finishComposingText()
            ic.endBatchEdit()
            lastConsonant = ' '
            return
        }

        lastConsonant = jamo
        lastConsonantTime = now
        onHangulInput(jamo, dubeolsikComposer)
        scheduleAutoCorrect()
    }

    private fun updateDubeolShift() {
        val btn = keyboardView.findViewById<ImageButton>(R.id.key_shift) ?: return
        val spec = currentThemeSpec()
        if (isDubeolShift) {
            btn.background = createKeyDrawable(spec.selectedFill, spec.selectedPressedFill)
            btn.backgroundTintList = null
            btn.imageTintList = ColorStateList.valueOf(spec.selectedText)
        } else {
            btn.background = createKeyDrawable(spec.functionFill, spec.functionPressedFill)
            btn.backgroundTintList = null
            btn.imageTintList = ColorStateList.valueOf(spec.functionIconTint)
        }
        // ?띿옄???띾え???쒓컖???쒖떆
        val shiftMap = mapOf(
            R.id.key_bieup  to Pair("ㅂ", "ㅃ"),
            R.id.key_jieut  to Pair("ㅈ", "ㅉ"),
            R.id.key_digeut to Pair("ㄷ", "ㄸ"),
            R.id.key_giyeok to Pair("ㄱ", "ㄲ"),
            R.id.key_siot   to Pair("ㅅ", "ㅆ"),
            R.id.key_ae     to Pair("ㅐ", "ㅒ"),
            R.id.key_e      to Pair("ㅔ", "ㅖ")
        )
        for ((id, labels) in shiftMap) {
            keyboardView.findViewById<Button>(id)?.text = if (isDubeolShift) labels.second else labels.first
        }
    }

    // 泥쒖????낅젰
    private fun onCheonjiinInput(key: Char, anchor: View? = null) {
        vibrateKey()
        anchor?.let { showKeyPreview(it, key.toString()) }
        val result = cheonjiinComposer.input(key)
        val committed = result.committed
        val composing = result.composing?.toString()
        postIC {
            val ic = currentInputConnection ?: return@postIC
            ic.beginBatchEdit()
            try {
                when {
                    committed == "\b" -> ic.deleteSurroundingText(1, 0)
                    committed.isNotEmpty() -> ic.commitText(committed, 1)
                }
                if (composing != null) ic.setComposingText(composing, 1)
                else ic.finishComposingText()
            } finally {
                ic.endBatchEdit()
            }
        }
        scheduleAutoCorrect()
    }

    // 泥쒖???寃고빀 ?먯쓬 ??(?쒗솚: ?기넂?뗢넂?꿎넂?기넂...)
    private fun onCJCombinedKey(keyId: Int, primary: Char, anchor: View) {
        val now = System.currentTimeMillis()
        val cycleList = cjCycleLists[primary] ?: listOf(primary)

        if (keyId == lastCJKeyId && now - lastCJKeyTime < DOUBLE_TAP_MS) {
            // 媛숈? ???곗냽 ?????ㅼ쓬 ?쒗솚 ?먯쓬?쇰줈 援먯껜
            lastCJCycleIdx = (lastCJCycleIdx + 1) % cycleList.size
            val nextChar = cycleList[lastCJCycleIdx]

            val backResult = cheonjiinComposer.backspace()
            val ic = currentInputConnection ?: return
            ic.beginBatchEdit()
            if (backResult.committed == "\b") {
                ic.finishComposingText(); ic.deleteSurroundingText(1, 0)
            } else {
                if (backResult.composing != null) ic.setComposingText(backResult.composing.toString(), 1)
                else ic.finishComposingText()
            }
            ic.endBatchEdit()

            onCheonjiinInput(nextChar, anchor)
            lastCJKeyTime = now
        } else {
            // ?????먮뒗 ?쒓컙 珥덇낵 ??泥?踰덉㎏ ?먯쓬遺???쒖옉
            lastCJKeyId = keyId
            lastCJKeyTime = now
            lastCJCycleIdx = 0
            onCheonjiinInput(primary, anchor)
        }
    }

    private fun onHangulInput(jamo: Char, composer: HangulComposer) {
        // 컴포저는 메인 스레드에서 즉시 처리 (상태 업데이트)
        val result = composer.input(jamo)
        val committed = result.committed
        val composing = result.composing?.toString()
        // IC IPC는 백그라운드 스레드로 → 메인 스레드 블로킹 제거로 빠른 연타 누락 방지
        postIC {
            val ic = currentInputConnection ?: return@postIC
            ic.beginBatchEdit()
            try {
                when {
                    committed == "\b" -> ic.deleteSurroundingText(1, 0)
                    committed.isNotEmpty() -> ic.commitText(committed, 1)
                }
                if (composing != null) ic.setComposingText(composing, 1)
                else ic.finishComposingText()
            } finally {
                ic.endBatchEdit()
            }
        }
    }

    private fun onBackspace() {
        val ic = currentInputConnection ?: return
        when (inputMode) {
            InputMode.DUBEOLSIK -> {
                if (dubeolsikComposer.isComposing()) {
                    val result = dubeolsikComposer.backspace()
                    ic.beginBatchEdit()
                    if (result.committed == "\b") {
                        ic.finishComposingText(); ic.deleteSurroundingText(1, 0)
                    } else {
                        if (result.composing != null) ic.setComposingText(result.composing.toString(), 1)
                        else ic.finishComposingText()
                    }
                    ic.endBatchEdit()
                } else deleteSelectedOrPrevChar(ic)
            }
            InputMode.CHEONJIIN -> {
                if (cheonjiinComposer.isComposing()) {
                    val result = cheonjiinComposer.backspace()
                    ic.beginBatchEdit()
                    if (result.committed == "\b") {
                        ic.finishComposingText(); ic.deleteSurroundingText(1, 0)
                    } else {
                        if (result.composing != null) ic.setComposingText(result.composing.toString(), 1)
                        else ic.finishComposingText()
                    }
                    ic.endBatchEdit()
                } else deleteSelectedOrPrevChar(ic)
            }
            InputMode.ENGLISH, InputMode.SYMBOL, InputMode.SYMBOL2, InputMode.SYMBOL3,
            InputMode.DUBEOL_SYMBOL, InputMode.DUBEOL_SYMBOL2 -> deleteSelectedOrPrevChar(ic)
        }
    }

    private fun deleteSelectedOrPrevChar(ic: android.view.inputmethod.InputConnection) {
        if (cachedSelStart >= 0 && cachedSelStart != cachedSelEnd) {
            ic.commitText("", 1)  // ?좏깮???띿뒪????젣
        } else {
            ic.deleteSurroundingText(1, 0)
        }
    }

    private fun commitComposing() {
        when (inputMode) {
            InputMode.DUBEOLSIK -> {
                if (dubeolsikComposer.isComposing()) {
                    val text = dubeolsikComposer.flush()
                    if (text.isNotEmpty()) {
                        currentInputConnection?.commitText(text, 1)  // replaces composing, no double-commit
                    } else {
                        currentInputConnection?.finishComposingText()
                    }
                }
            }
            InputMode.CHEONJIIN -> {
                if (cheonjiinComposer.isComposing()) {
                    val text = cheonjiinComposer.flush()
                    if (text.isNotEmpty()) {
                        currentInputConnection?.commitText(text, 1)
                    } else {
                        currentInputConnection?.finishComposingText()
                    }
                }
            }
            InputMode.ENGLISH, InputMode.SYMBOL, InputMode.SYMBOL2, InputMode.SYMBOL3,
            InputMode.DUBEOL_SYMBOL, InputMode.DUBEOL_SYMBOL2 -> {}
        }
    }

    private fun cycleInputMode() {
        commitComposing()
        if (isDubeolShift) { isDubeolShift = false; updateDubeolShift() }
        inputMode = when (inputMode) {
            InputMode.DUBEOLSIK, InputMode.CHEONJIIN -> {
                lastKoreanMode = inputMode  // remember current Korean mode
                InputMode.ENGLISH
            }
            InputMode.ENGLISH -> lastKoreanMode  // return to same Korean mode we left
            InputMode.SYMBOL, InputMode.SYMBOL2, InputMode.SYMBOL3,
            InputMode.DUBEOL_SYMBOL, InputMode.DUBEOL_SYMBOL2 -> prevInputMode
        }
        updateKeyboardMode()
    }

    private val isSymbolMode get() = inputMode == InputMode.SYMBOL || inputMode == InputMode.SYMBOL2 || inputMode == InputMode.SYMBOL3
            || inputMode == InputMode.DUBEOL_SYMBOL || inputMode == InputMode.DUBEOL_SYMBOL2

    private fun switchToSymbol() {
        commitComposing()
        if (isSymbolMode) {
            inputMode = prevInputMode
        } else {
            prevInputMode = inputMode
            // 泥쒖??몄? 湲곗〈 ?щ낵, ?먮쾶???곸뼱???먮쾶???꾩슜 ?щ낵
            inputMode = if (prevInputMode == InputMode.CHEONJIIN) InputMode.SYMBOL else InputMode.DUBEOL_SYMBOL
        }
        updateKeyboardMode()
    }

    private fun onPunctCycle() {
        vibrateKey()
        commitComposing()
        val ic = currentInputConnection ?: return
        val now = System.currentTimeMillis()
        if (lastPunctCycleIdx >= 0 && now - lastPunctCycleTime < 1500L) {
            ic.deleteSurroundingText(1, 0)
            lastPunctCycleIdx = (lastPunctCycleIdx + 1) % punctCycleList.size
        } else {
            lastPunctCycleIdx = 0
        }
        ic.commitText(punctCycleList[lastPunctCycleIdx].toString(), 1)
        lastPunctCycleTime = now
        // ?좏깮??援щ몢??踰꾪듉 ?띿뒪?몄뿉 ?꾩옱 臾몄옄 ?쒖떆 (keyPopup ?ㅼ젙怨?臾닿??섍쾶 ??긽)
        val punctBtn = keyboardView.findViewById<android.widget.TextView>(R.id.key_cj_punct)
        if (punctBtn != null) {
            punctBtn.text = punctCycleList[lastPunctCycleIdx].toString()
            // keyPopup 耳쒖쭊 寃쎌슦 ?앹뾽??異붽? ?쒖떆
            if (SettingsManager.keyPopup) {
                lastKeyPreviewTime = 0L
                showKeyPreview(punctBtn, punctCycleList[lastPunctCycleIdx].toString())
            }
            // 1500ms ???먮옒 ?띿뒪?몃줈 蹂듭썝
            handler.removeCallbacks(punctBtnResetRunnable)
            handler.postDelayed(punctBtnResetRunnable, 1500L)
        }
        scheduleAutoCorrect()
    }

    private fun setupSymbolKeys() {
        // ?섏씠吏 1
        val sym1Map = mapOf(
            R.id.sym_excl to "!", R.id.sym_ques to "?", R.id.sym_period to ".",
            R.id.sym_comma to ",", R.id.sym_lpar to "(", R.id.sym_rpar to ")",
            R.id.sym_at to "@", R.id.sym_colon to ":", R.id.sym_semi to ";",
            R.id.sym_slash to "/", R.id.sym_minus to "-", R.id.sym_heart to "?",
            R.id.sym_star to "*", R.id.sym_under to "_", R.id.sym_pct to "%",
            R.id.sym_tilde to "~", R.id.sym_caret to "^", R.id.sym_hash to "#"
        )
        // ?섏씠吏 2
        val sym2Map = mapOf(
            R.id.sym2_plus to "+", R.id.sym2_times to "횞", R.id.sym2_div to "첨",
            R.id.sym2_eq to "=", R.id.sym2_dquot to "\"", R.id.sym2_squot to "'",
            R.id.sym2_amp to "&", R.id.sym2_spade to "?", R.id.sym2_fstar to "?",
            R.id.sym2_club to "?", R.id.sym2_bslash to "\\", R.id.sym2_won to "?",
            R.id.sym2_lt to "<", R.id.sym2_gt to ">", R.id.sym2_lcurl to "{",
            R.id.sym2_rcurl to "}", R.id.sym2_lbr to "[", R.id.sym2_rbr to "]"
        )
        // ?섏씠吏 3
        val sym3Map = mapOf(
            R.id.sym3_grave to "`", R.id.sym3_pipe to "|", R.id.sym3_dollar to "$",
            R.id.sym3_euro to "?", R.id.sym3_pound to "?", R.id.sym3_yen to "?",
            R.id.sym3_degree to "?", R.id.sym3_wcirc to "?", R.id.sym3_bcirc to "?",
            R.id.sym3_wsquare to "?", R.id.sym3_bsquare to "?", R.id.sym3_diamond to "?",
            R.id.sym3_ref to "?", R.id.sym3_lguil to "?", R.id.sym3_rguil to "?",
            R.id.sym3_currency to "?", R.id.sym3_dotlessi to "?", R.id.sym3_iquest to "?"
        )
        for ((id, sym) in sym1Map + sym2Map + sym3Map) {
            keyboardView.findViewById<Button>(id)?.onKeyDown {
                vibrateKey(); currentInputConnection?.commitText(sym, 1)
            }
        }

        for (id in listOf(R.id.sym_punct, R.id.sym2_punct, R.id.sym3_punct)) {
            keyboardView.findViewById<Button>(id)?.onKeyDown { onPunctCycle() }
        }
        // ?ㅽ럹?댁뒪
        for (id in listOf(R.id.sym_space, R.id.sym2_space, R.id.sym3_space)) {
            keyboardView.findViewById<Button>(id)?.onKeyDown {
                vibrateKey(); currentInputConnection?.commitText(" ", 1)
            }
        }
        for (id in listOf(R.id.sym_apos, R.id.sym2_apos, R.id.sym3_apos)) {
            keyboardView.findViewById<Button>(id)?.onKeyDown {
                vibrateKey(); currentInputConnection?.commitText("'", 1)
            }
        }
        // ?뷀꽣
        for (id in listOf(R.id.sym_enter, R.id.sym2_enter, R.id.sym3_enter)) {
            keyboardView.findViewById<Button>(id)?.onKeyDown {
                vibrateKey(); sendDefaultEditorAction(true)
            }
        }
        // ??젣
        setupDeleteButton(R.id.sym_del)
        setupDeleteButton(R.id.sym2_del)
        setupDeleteButton(R.id.sym3_del)

        for (id in listOf(R.id.sym_ko, R.id.sym2_ko, R.id.sym3_ko)) {
            keyboardView.findViewById<Button>(id)?.onKeyDown {
                vibrateKey()
                commitComposing()
                inputMode = prevInputMode
                updateKeyboardMode()
            }
        }
        for (id in listOf(R.id.sym_abc, R.id.sym2_abc, R.id.sym3_abc)) {
            keyboardView.findViewById<Button>(id)?.onKeyDown {
                vibrateKey(); switchToSymbol()
            }
        }
        // 泥쒖????щ낵 ?섏씠吏 ?꾪솚
        keyboardView.findViewById<Button>(R.id.sym_page)?.onKeyDown {
            vibrateKey(); inputMode = InputMode.SYMBOL2; updateKeyboardMode()
        }
        keyboardView.findViewById<Button>(R.id.sym2_page)?.onKeyDown {
            vibrateKey(); inputMode = InputMode.SYMBOL3; updateKeyboardMode()
        }
        keyboardView.findViewById<Button>(R.id.sym3_page)?.onKeyDown {
            vibrateKey(); inputMode = InputMode.SYMBOL; updateKeyboardMode()
        }
        // ?먮쾶???щ낵 ?섏씠吏 ?꾪솚
        keyboardView.findViewById<Button>(R.id.dsym_page)?.onKeyDown {
            vibrateKey(); inputMode = InputMode.DUBEOL_SYMBOL2; updateKeyboardMode()
        }
        keyboardView.findViewById<Button>(R.id.dsym2_page)?.onKeyDown {
            vibrateKey(); inputMode = InputMode.DUBEOL_SYMBOL; updateKeyboardMode()
        }
        for (id in listOf(R.id.dsym_ko, R.id.dsym2_ko)) {
            keyboardView.findViewById<Button>(id)?.onKeyDown { vibrateKey(); commitComposing(); inputMode = prevInputMode; updateKeyboardMode() }
        }
        for (id in listOf(R.id.dsym_space, R.id.dsym2_space)) {
            keyboardView.findViewById<Button>(id)?.onKeyDown { vibrateKey(); currentInputConnection?.commitText(" ", 1) }
        }
        for (id in listOf(R.id.dsym_enter, R.id.dsym2_enter)) {
            keyboardView.findViewById<Button>(id)?.onKeyDown { vibrateKey(); sendDefaultEditorAction(true) }
        }
        for (id in listOf(R.id.dsym_del, R.id.dsym2_del)) {
            setupDeleteButton(id)
        }
        val dsym1Keys = mapOf(
            R.id.dsym_n1 to "1", R.id.dsym_n2 to "2", R.id.dsym_n3 to "3", R.id.dsym_n4 to "4", R.id.dsym_n5 to "5",
            R.id.dsym_n6 to "6", R.id.dsym_n7 to "7", R.id.dsym_n8 to "8", R.id.dsym_n9 to "9", R.id.dsym_n0 to "0",
            R.id.dsym_plus to "+", R.id.dsym_times to "횞", R.id.dsym_div to "첨", R.id.dsym_eq to "=",
            R.id.dsym_slash to "/", R.id.dsym_under to "_", R.id.dsym_lt to "<", R.id.dsym_gt to ">",
            R.id.dsym_lbr to "[", R.id.dsym_rbr to "]",
            R.id.dsym_excl to "!", R.id.dsym_at to "@", R.id.dsym_hash to "#", R.id.dsym_won to "?",
            R.id.dsym_pct to "%", R.id.dsym_caret to "^", R.id.dsym_amp to "&", R.id.dsym_star to "*",
            R.id.dsym_lpar to "(", R.id.dsym_rpar to ")",
            R.id.dsym_minus to "-", R.id.dsym_apos to "'", R.id.dsym_quot to "\"",
            R.id.dsym_colon to ":", R.id.dsym_semi to ";", R.id.dsym_comma to ",", R.id.dsym_ques to "?",
            R.id.dsym_apos_bt to "'", R.id.dsym_period_bt to "."
        )
        val dsym2Keys = mapOf(
            R.id.dsym2_n1 to "1", R.id.dsym2_n2 to "2", R.id.dsym2_n3 to "3", R.id.dsym2_n4 to "4", R.id.dsym2_n5 to "5",
            R.id.dsym2_n6 to "6", R.id.dsym2_n7 to "7", R.id.dsym2_n8 to "8", R.id.dsym2_n9 to "9", R.id.dsym2_n0 to "0",
            R.id.dsym2_grave to "`", R.id.dsym2_tilde to "~", R.id.dsym2_bslash to "\\", R.id.dsym2_pipe to "|",
            R.id.dsym2_lcurl to "{", R.id.dsym2_rcurl to "}", R.id.dsym2_euro to "?", R.id.dsym2_pound to "?",
            R.id.dsym2_yen to "?", R.id.dsym2_dollar to "$",
            R.id.dsym2_degree to "?", R.id.dsym2_dot to "?", R.id.dsym2_circle to "?", R.id.dsym2_bullet to "?",
            R.id.dsym2_square to "?", R.id.dsym2_blacksq to "?", R.id.dsym2_spade to "?", R.id.dsym2_heart to "?",
            R.id.dsym2_diam to "?", R.id.dsym2_club to "?",
            R.id.dsym2_starout to "?", R.id.dsym2_smallsq to "?", R.id.dsym2_curr to "?",
            R.id.dsym2_lguil to "?", R.id.dsym2_rguil to "?", R.id.dsym2_invexcl to "?", R.id.dsym2_invques to "?",
            R.id.dsym2_apos_bt to "'", R.id.dsym2_period to "."
        )
        for ((id, ch) in dsym1Keys + dsym2Keys) {
            keyboardView.findViewById<Button>(id)?.onKeyDown { vibrateKey(); currentInputConnection?.commitText(ch, 1); scheduleAutoCorrect() }
        }
        // ?먮쾶???щ낵 ?????꾪솚 踰꾪듉
        for (id in listOf(R.id.dsym_mode, R.id.dsym2_mode)) {
            keyboardView.findViewById<Button>(id)?.onKeyDown {
                vibrateKey(); commitComposing(); inputMode = InputMode.ENGLISH; updateKeyboardMode()
            }
        }
    }

    private fun updateKeyboardMode() {
        if (inputMode != InputMode.ENGLISH && (isShiftOn || isCapsLock)) {
            isShiftOn = false
            isCapsLock = false
        }

        keyboardView.findViewById<View>(R.id.container_dubeolsik).visibility =
            if (inputMode == InputMode.DUBEOLSIK) View.VISIBLE else View.GONE
        keyboardView.findViewById<View>(R.id.container_cheonjiin).visibility =
            if (inputMode == InputMode.CHEONJIIN) View.VISIBLE else View.GONE
        keyboardView.findViewById<View>(R.id.container_english).visibility =
            if (inputMode == InputMode.ENGLISH) View.VISIBLE else View.GONE
        keyboardView.findViewById<View>(R.id.container_symbols).visibility =
            if (inputMode == InputMode.SYMBOL) View.VISIBLE else View.GONE
        keyboardView.findViewById<View>(R.id.container_symbols2).visibility =
            if (inputMode == InputMode.SYMBOL2) View.VISIBLE else View.GONE
        keyboardView.findViewById<View>(R.id.container_symbols3).visibility =
            if (inputMode == InputMode.SYMBOL3) View.VISIBLE else View.GONE
        keyboardView.findViewById<View>(R.id.container_dubeol_sym1).visibility =
            if (inputMode == InputMode.DUBEOL_SYMBOL) View.VISIBLE else View.GONE
        keyboardView.findViewById<View>(R.id.container_dubeol_sym2).visibility =
            if (inputMode == InputMode.DUBEOL_SYMBOL2) View.VISIBLE else View.GONE

        // 怨듭쑀 ?섎떒 ?? 泥쒖???諛??щ낵 紐⑤뱶?먯꽌 ?④?
        keyboardView.findViewById<LinearLayout>(R.id.bottomRow).visibility =
            if (inputMode == InputMode.CHEONJIIN || isSymbolMode) View.GONE else View.VISIBLE

        // ?レ옄 ?? ?щ낵 紐⑤뱶?먯꽌 ?④?
        keyboardView.findViewById<View>(R.id.rowNumbers)?.visibility =
            if (isSymbolMode) View.GONE else View.VISIBLE

        val spec = currentThemeSpec()

        // !#1 / ABC 踰꾪듉 ?됱긽: ?щ낵 紐⑤뱶????媛뺤“
        val keyNumMode = keyboardView.findViewById<Button>(R.id.key_num_mode)
        keyNumMode?.apply {
            text = if (isSymbolMode) "ABC" else "!#1"
            if (isSymbolMode) {
                background = createKeyDrawable(spec.selectedFill, spec.selectedPressedFill)
                setTextColor(spec.selectedText)
            } else {
                background = createKeyDrawable(spec.functionFill, spec.functionPressedFill)
                setTextColor(spec.functionText)
            }
        }

        // ?낅젰 紐⑤뱶 踰꾪듉 ?됱긽: ?곸뼱 紐⑤뱶????媛뺤“
        val keyMode = keyboardView.findViewById<ImageButton>(R.id.key_mode)
        keyMode?.apply {
            if (inputMode == InputMode.ENGLISH) {
                background = createKeyDrawable(spec.selectedFill, spec.selectedPressedFill)
                imageTintList = ColorStateList.valueOf(spec.selectedText)
            } else {
                background = createKeyDrawable(spec.functionFill, spec.functionPressedFill)
                imageTintList = ColorStateList.valueOf(spec.secondaryIconTint)
            }
        }

        updateEnglishShift()
        applyStableKeyboardHeight()
    }

    private fun updateEnglishShift() {
        val btn = keyboardView.findViewById<ImageButton>(R.id.key_en_shift)
        val spec = currentThemeSpec()
        when {
            isCapsLock -> {
                // CapsLock: 선택색 + 테두리로 일반 Shift와 구분
                btn.background = createKeyDrawable(spec.selectedFill, spec.selectedPressedFill)
                btn.backgroundTintList = null
                btn.imageTintList = ColorStateList.valueOf(spec.selectedText)
                btn.alpha = 1.0f
            }
            isShiftOn -> {
                btn.background = createKeyDrawable(spec.selectedFill, spec.selectedPressedFill)
                btn.backgroundTintList = null
                btn.imageTintList = ColorStateList.valueOf(spec.selectedText)
                btn.alpha = 0.7f  // 일반 Shift는 살짝 투명하게 → CapsLock과 구분
            }
            else -> {
                btn.background = createKeyDrawable(spec.functionFill, spec.functionPressedFill)
                btn.backgroundTintList = null
                btn.imageTintList = ColorStateList.valueOf(spec.functionText)
                btn.alpha = 1.0f
            }
        }

        val englishMap = mapOf(
            R.id.key_en_q to 'q', R.id.key_en_w to 'w', R.id.key_en_e to 'e',
            R.id.key_en_r to 'r', R.id.key_en_t to 't', R.id.key_en_y to 'y',
            R.id.key_en_u to 'u', R.id.key_en_i to 'i', R.id.key_en_o to 'o',
            R.id.key_en_p to 'p', R.id.key_en_a to 'a', R.id.key_en_s to 's',
            R.id.key_en_d to 'd', R.id.key_en_f to 'f', R.id.key_en_g to 'g',
            R.id.key_en_h to 'h', R.id.key_en_j to 'j', R.id.key_en_k to 'k',
            R.id.key_en_l to 'l', R.id.key_en_z to 'z', R.id.key_en_x to 'x',
            R.id.key_en_c to 'c', R.id.key_en_v to 'v', R.id.key_en_b to 'b',
            R.id.key_en_n to 'n', R.id.key_en_m to 'm'
        )
        for ((id, letter) in englishMap) {
            keyboardView.findViewById<Button>(id)?.text =
                if (isShiftOn) letter.uppercaseChar().toString() else letter.toString()
        }
    }

    private fun scheduleAutoCorrect() {
        handler.removeCallbacks(autoCorrectRunnable)
        if (!prepareAiAction(showBlockedMessage = false)) return
        handler.postDelayed(autoCorrectRunnable, 1000)
    }

    private fun performAutoCorrect() {
        if (!prepareAiAction(showBlockedMessage = false)) return
        val cost = if (isFormalMode) CreditsManager.COST_FORMAL else CreditsManager.COST_CORRECT
        if (!CreditsManager.canAfford(cost)) {
            showNoCredits()
            return
        }
        val ic = currentInputConnection ?: return
        val extracted = ic.getExtractedText(ExtractedTextRequest(), 0)
        val text = extracted?.text?.toString() ?: return
        if (text.isBlank()) return

        suggestionMode = SuggestionMode.CORRECTION
        showSuggestion("맞춤법 교정 중...", false)

        ApiClient.correct(
            text, isFormalMode,
            SettingsManager.includePunct, SettingsManager.includeDialect,
            SettingsManager.normalizeFormalLevel(SettingsManager.formalLevel),
            SettingsManager.formalIncludePunct
        ) { result ->
            handler.post {
                if (!isServiceActive) return@post
                when (result) {
                    is ApiClient.Result.Success -> {
                        if (result.text.trim() == text.trim()) {
                            hideSuggestionBar()
                        } else {
                            correctedText = result.text
                            translatedText = ""
                            showSuggestion(result.text, true)
                        }
                    }
                    is ApiClient.Result.Error -> {
                        correctedText = ""
                        translatedText = ""
                        showSuggestion(result.message, false)
                    }
                    is ApiClient.Result.NoCredits -> showNoCredits()
                }
            }
        }
    }

    private fun performTranslation(targetLang: String) {
        if (!prepareAiAction(showBlockedMessage = true)) return
        if (!CreditsManager.canAfford(CreditsManager.COST_TRANSLATE)) {
            showNoCredits()
            return
        }
        val ic = currentInputConnection ?: return
        val extracted = ic.getExtractedText(ExtractedTextRequest(), 0)
        val text = extracted?.text?.toString() ?: return
        if (text.isBlank()) return

        val langName = when (targetLang) {
            "ko" -> "한국어"; "en" -> "영어"; "zh" -> "중국어"; "ja" -> "일본어"; else -> targetLang
        }
        suggestionMode = SuggestionMode.TRANSLATION
        showSuggestion("$langName 번역 중...", false)

        ApiClient.translate(text, targetLang) { result ->
            handler.post {
                if (!isServiceActive) return@post
                when (result) {
                    is ApiClient.Result.Success -> {
                        correctedText = ""
                        translatedText = result.text
                        showSuggestion("[$langName] ${result.text}", true)
                    }
                    is ApiClient.Result.Error -> {
                        correctedText = ""
                        translatedText = ""
                        showSuggestion(result.message, false)
                    }
                    is ApiClient.Result.NoCredits -> handler.post { showNoCredits() }
                }
            }
        }
    }

    private fun showNoCredits() {
        suggestionMode = SuggestionMode.NO_CREDITS
        keyboardView.findViewById<TextView>(R.id.tvSuggestion).text =
            "크레딧이 부족합니다. 광고를 보면 500크레딧을 더 받을 수 있어요."
        keyboardView.findViewById<Button>(R.id.btnApply).visibility = View.GONE
        keyboardView.findViewById<Button>(R.id.btnWatchAd).visibility = View.VISIBLE
        keyboardView.findViewById<View>(R.id.suggestionBar).visibility = View.VISIBLE
    }

    private fun showSuggestion(text: String, showApply: Boolean) {
        keyboardView.findViewById<TextView>(R.id.tvSuggestion).text = text
        keyboardView.findViewById<Button>(R.id.btnApply).visibility =
            if (showApply) View.VISIBLE else View.GONE
        val suggBar = keyboardView.findViewById<View>(R.id.suggestionBar)
        suggBar.visibility = View.VISIBLE
        if (showApply) startSuggestionBarShimmer(suggBar)
    }

    private fun startSuggestionBarShimmer(view: View) {
        view.post {
            if (view !is android.view.ViewGroup) return@post
            val w = view.width
            val h = view.height
            if (w == 0) return@post
            val shimmerView = View(this)
            shimmerView.background = android.graphics.drawable.GradientDrawable(
                android.graphics.drawable.GradientDrawable.Orientation.LEFT_RIGHT,
                intArrayOf(Color.TRANSPARENT, 0x55FFFFFF, Color.TRANSPARENT)
            )
            shimmerView.layout(0, 0, w / 3, h)
            view.overlay.add(shimmerView)
            val anim = ObjectAnimator.ofFloat(shimmerView, View.TRANSLATION_X, -(w / 3).toFloat(), w.toFloat())
            anim.duration = 900
            anim.addListener(object : AnimatorListenerAdapter() {
                override fun onAnimationEnd(animation: Animator) {
                    view.overlay.remove(shimmerView)
                }
            })
            anim.start()
        }
    }

    private fun hideSuggestionBar() {
        keyboardView.findViewById<View>(R.id.suggestionBar).visibility = View.GONE
        keyboardView.findViewById<Button>(R.id.btnApply).visibility = View.GONE
        keyboardView.findViewById<Button>(R.id.btnWatchAd).visibility = View.GONE
        correctedText = ""
        translatedText = ""
        suggestionMode = SuggestionMode.CORRECTION
    }

    override fun onDestroy() {
        isServiceActive = false
        customThemeRenderVersion++
        val prefs = getSharedPreferences("settings", android.content.Context.MODE_PRIVATE)
        prefs.unregisterOnSharedPreferenceChangeListener(settingsChangeListener)
        super.onDestroy()
        handler.removeCallbacks(deleteRepeatRunnable)
        handler.removeCallbacks(autoCorrectRunnable)
        icThread.quitSafely()
        keyPreviewPopup?.dismiss()
        clearAppliedBackgroundBitmap()
        cachedBitmap?.recycle()
        cachedBitmap = null
    }
}

