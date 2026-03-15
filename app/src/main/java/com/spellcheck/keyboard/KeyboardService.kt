package com.spellcheck.keyboard

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.BitmapShader
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.RenderEffect
import android.graphics.Shader
import android.graphics.drawable.BitmapDrawable
import android.inputmethodservice.InputMethodService
import android.view.ViewTreeObserver
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.ExtractedTextRequest
import android.widget.Button
import android.widget.LinearLayout
import android.widget.PopupWindow
import android.widget.Switch
import android.widget.TextView

class KeyboardService : InputMethodService() {

    enum class InputMode { DUBEOLSIK, CHEONJIIN, ENGLISH, SYMBOL, SYMBOL2, SYMBOL3 }
    private enum class SuggestionMode { CORRECTION, TRANSLATION }

    private lateinit var keyboardView: View
    private val dubeolsikComposer = HangulComposer()
    private val cheonjiinComposer = CheonjiinComposer()
    private val handler = Handler(Looper.getMainLooper())

    // InputConnection IPC 호출을 별도 스레드로 분리 (메인 스레드 블로킹 방지)
    private val icThread = android.os.HandlerThread("ICThread").also { it.start() }
    private val icHandler = Handler(icThread.looper)

    private fun postIC(block: () -> Unit) = icHandler.post(block)

    private var inputMode = InputMode.DUBEOLSIK
    private var prevInputMode = InputMode.DUBEOLSIK  // mode before entering symbol keyboard
    private var lastKoreanMode = InputMode.DUBEOLSIK  // last active Korean mode for 한/영 cycle
    private var isServiceActive = false
    private var isFormalMode = false
    private var isShiftOn = false       // 영어 shift
    private var isDubeolShift = false   // 두벌식 쌍자음 shift
    private var correctedText = ""
    private var translatedText = ""
    private var suggestionMode = SuggestionMode.CORRECTION

    // 커서 위치 캐시 (getExtractedText IPC 호출 대체 → 입력 씹힘 방지)
    private var cachedSelStart = -1
    private var cachedSelEnd = -1

    // 두벌식 쌍자음 두 번 연속 입력용
    private var lastConsonant: Char = ' '
    private var lastConsonantTime: Long = 0
    private val DOUBLE_TAP_MS = 400L
    private val doubleConsonantMap = mapOf(
        'ㄱ' to 'ㄲ', 'ㄷ' to 'ㄸ', 'ㅂ' to 'ㅃ', 'ㅅ' to 'ㅆ', 'ㅈ' to 'ㅉ'
    )

    // 천지인 자음 순환 (삼성 방식)
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

    // .,?! 순환 입력
    private val punctCycleList = listOf('.', ',', '?', '!')
    private var lastPunctCycleIdx = -1
    private var lastPunctCycleTime = 0L

    // 더블 스페이스 → 마침표
    private var lastSpaceTime = 0L

    // custom image bitmap cache to avoid re-reading file on every keyboard show
    private var cachedBitmapPath = ""
    private var cachedBitmap: Bitmap? = null

    // 꾹 누르기 반복 삭제
    private val deleteRepeatRunnable = object : Runnable {
        override fun run() {
            onBackspace()
            handler.postDelayed(this, 50)
        }
    }

    // 자동 교정 (3초 대기)
    private val autoCorrectRunnable = Runnable { performAutoCorrect() }
    private val keyPreviewDismissRunnable = Runnable { keyPreviewPopup?.dismiss() }

    // 키 팝업
    private var keyPreviewPopup: PopupWindow? = null
    private var keyPreviewTextView: TextView? = null

    // 진동
    @Suppress("DEPRECATION")
    private val vibrator by lazy { getSystemService(Context.VIBRATOR_SERVICE) as Vibrator }

    // ACTION_DOWN에서 처리 + isPressed 직접 관리 → 부드러운 시각 피드백
    private fun View.onKeyDown(block: (View) -> Unit) {
        setOnTouchListener { v, event ->
            when (event.action) {
                MotionEvent.ACTION_DOWN -> {
                    v.isPressed = true
                    block(v)
                    true
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    v.isPressed = false
                    true
                }
                else -> true
            }
        }
    }

    override fun onCreate() {
        super.onCreate()
        isServiceActive = true
        SettingsManager.init(this)
        TrialManager.init(this)
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
            v.setPadding(0, 0, 0, bottom)
            insets
        }
        val koreanMode = when (SettingsManager.defaultMode) {
            "천지인" -> InputMode.CHEONJIIN
            else -> InputMode.DUBEOLSIK
        }
        inputMode = koreanMode
        prevInputMode = koreanMode
        lastKoreanMode = koreanMode
        isFormalMode = SettingsManager.formalDefault
        applyTheme()
        setupButtons()
        updateKeyboardMode()
        return keyboardView
    }

    private fun applyTheme() {
        val theme = SettingsManager.keyboardTheme

        if (theme == "커스텀") {
            applyCustomImageTheme()
            return
        }

        val bgColor = when (theme) {
            "블랙" -> Color.parseColor("#1C1C1E")
            "핑크" -> Color.parseColor("#FFD6E8")
            else   -> Color.parseColor("#F0F0F0")
        }
        val keyColor = when (theme) {
            "블랙" -> Color.parseColor("#2C2C2E")
            "핑크" -> Color.parseColor("#FF6B9D")
            else   -> Color.parseColor("#FFFFFF")
        }
        val textColor = when (theme) {
            "블랙" -> Color.WHITE
            "핑크" -> Color.WHITE
            else   -> Color.parseColor("#1C1C1E")
        }
        val toolbarBg = when (theme) {
            "블랙" -> Color.parseColor("#2A2A2E")
            "핑크" -> Color.parseColor("#FFB3CF")
            else   -> Color.parseColor("#FFFFFF")
        }
        val formalRowBg = when (theme) {
            "블랙" -> Color.parseColor("#252528")
            "핑크" -> Color.parseColor("#FFC8DF")
            else   -> Color.parseColor("#EEF0FF")
        }

        keyboardView.setBackgroundColor(bgColor)
        keyboardView.findViewById<View>(R.id.toolbar)?.setBackgroundColor(toolbarBg)
        keyboardView.findViewById<View>(R.id.formalOptionsRow)?.setBackgroundColor(formalRowBg)
        applyContainerBackgrounds(bgColor)
        applyButtonStyle(keyColor, textColor)
    }

    private fun applyContainerBackgrounds(bgColor: Int) {
        val containerIds = listOf(
            R.id.container_dubeolsik, R.id.container_cheonjiin,
            R.id.container_english,
            R.id.container_symbols, R.id.container_symbols2, R.id.container_symbols3,
            R.id.rowNumbers, R.id.bottomRow
        )
        fun setNestedBg(view: View) {
            if (view is LinearLayout) view.setBackgroundColor(bgColor)
            if (view is android.view.ViewGroup) for (i in 0 until view.childCount) setNestedBg(view.getChildAt(i))
        }
        containerIds.forEach { id -> keyboardView.findViewById<View>(id)?.let { setNestedBg(it) } }
    }

    private fun applyCustomImageTheme() {
        val path = SettingsManager.customImagePath
        if (path.isEmpty()) {
            keyboardView.setBackgroundColor(Color.parseColor("#F0F0F0"))
            return
        }

        // Use cached bitmap to avoid re-reading file on every keyboard show
        val srcBitmap: Bitmap = if (path == cachedBitmapPath && cachedBitmap != null) {
            cachedBitmap!!
        } else {
            val bmp = try { BitmapFactory.decodeFile(path) } catch (e: Exception) { null }
            if (bmp == null) {
                keyboardView.setBackgroundColor(Color.parseColor("#F0F0F0"))
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

        fun applyWithSize() {
            val w = keyboardView.width.takeIf { it > 0 } ?: 1080
            val h = keyboardView.height.takeIf { it > 0 } ?: 800

            val processed: Bitmap = when (mode) {
                "꽉채우기" -> centerCropBitmap(srcBitmap, w, h)
                "늘리기"   -> Bitmap.createScaledBitmap(srcBitmap, w, h, true)
                "가운데"   -> centerBitmap(srcBitmap, w, h)
                "타일"     -> tileBitmap(srcBitmap, w, h, mirror = false)
                "미러타일" -> tileBitmap(srcBitmap, w, h, mirror = true)
                "블러"     -> blurBitmap(centerCropBitmap(srcBitmap, w, h))
                else       -> centerCropBitmap(srcBitmap, w, h)
            }

            val finalBitmap = applyOverlay(processed, overlayAlpha)
            keyboardView.background = BitmapDrawable(resources, finalBitmap)
            applyButtonStyle(
                keyColor = Color.argb(80, 255, 255, 255),
                textColor = textColor
            )
        }

        if (keyboardView.width > 0 && keyboardView.height > 0) {
            applyWithSize()
        } else {
            keyboardView.viewTreeObserver.addOnGlobalLayoutListener(object : ViewTreeObserver.OnGlobalLayoutListener {
                override fun onGlobalLayout() {
                    keyboardView.viewTreeObserver.removeOnGlobalLayoutListener(this)
                    applyWithSize()
                }
            })
        }
    }

    // CENTER CROP: 비율 유지, 꽉 채우기
    private fun centerCropBitmap(src: Bitmap, w: Int, h: Int): Bitmap {
        val srcRatio = src.width.toFloat() / src.height
        val dstRatio = w.toFloat() / h
        val (scaledW, scaledH) = if (srcRatio > dstRatio)
            (src.height * dstRatio).toInt() to src.height
        else
            src.width to (src.width / dstRatio).toInt()
        val x = (src.width - scaledW) / 2
        val y = (src.height - scaledH) / 2
        val cropped = Bitmap.createBitmap(src, x, y, scaledW, scaledH)
        val result = Bitmap.createScaledBitmap(cropped, w, h, true)
        if (cropped !== src) cropped.recycle()
        return result
    }

    // 가운데 배치 (패딩)
    private fun centerBitmap(src: Bitmap, w: Int, h: Int): Bitmap {
        val result = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(result)
        canvas.drawColor(Color.parseColor("#F0F0F0"))
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

    // 타일 반복
    private fun tileBitmap(src: Bitmap, w: Int, h: Int, mirror: Boolean): Bitmap {
        val tileSize = minOf(w, h) / 3  // 타일 크기 = 키보드 짧은 쪽의 1/3
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
        return result
    }

    // 블러
    private fun blurBitmap(src: Bitmap): Bitmap {
        // 소프트웨어 블러 (API 레벨 무관)
        val scale = 0.1f
        val small = Bitmap.createScaledBitmap(
            src, (src.width * scale).toInt().coerceAtLeast(1),
            (src.height * scale).toInt().coerceAtLeast(1), true
        )
        return Bitmap.createScaledBitmap(small, src.width, src.height, true)
    }

    // 오버레이 (반투명 어두운 레이어)
    private fun applyOverlay(src: Bitmap, alphaPercent: Int): Bitmap {
        if (alphaPercent == 0) return src
        val result = src.copy(Bitmap.Config.ARGB_8888, true)
        val canvas = Canvas(result)
        val paint = Paint()
        paint.color = Color.argb((alphaPercent * 2.55f).toInt(), 0, 0, 0)
        canvas.drawRect(0f, 0f, result.width.toFloat(), result.height.toFloat(), paint)
        return result
    }

    // 버튼 스타일 일괄 적용
    private fun applyButtonStyle(keyColor: Int, textColor: Int) {
        fun applyToButtons(view: View) {
            if (view is android.widget.Button) {
                view.setTextColor(textColor)
                view.backgroundTintList = ColorStateList.valueOf(keyColor)
            } else if (view is android.view.ViewGroup) {
                for (i in 0 until view.childCount) applyToButtons(view.getChildAt(i))
            }
        }
        applyToButtons(keyboardView)
    }

    // 키보드가 나타날 때마다 기본 모드 설정 반영 + 테마 재적용
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
        applyTheme()
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
    }

    private fun setupButtons() {
        // 교정 버튼
        keyboardView.findViewById<Button>(R.id.btnCorrect).onKeyDown {
            vibrateKey()
            handler.removeCallbacks(autoCorrectRunnable)
            performAutoCorrect()
        }

        // 번역 버튼
        keyboardView.findViewById<Button>(R.id.btnTranslate).onKeyDown {
            vibrateKey()
            val row = keyboardView.findViewById<View>(R.id.langSelectRow)
            if (row.visibility == View.VISIBLE) {
                row.visibility = View.GONE
            } else {
                if (!TrialManager.canUseAI) {
                    showSuggestion("구독 후 번역 기능을 이용할 수 있습니다", false)
                    return@onKeyDown
                }
                row.visibility = View.VISIBLE
            }
        }

        // 언어 선택 버튼
        val langButtons = mapOf(
            R.id.btn_lang_ko to "ko",
            R.id.btn_lang_en to "en",
            R.id.btn_lang_zh to "zh",
            R.id.btn_lang_ja to "ja"
        )
        for ((id, lang) in langButtons) {
            keyboardView.findViewById<Button>(id)?.onKeyDown {
                vibrateKey()
                keyboardView.findViewById<View>(R.id.langSelectRow).visibility = View.GONE
                performTranslation(lang)
            }
        }
        keyboardView.findViewById<Button>(R.id.btn_lang_cancel)?.onKeyDown {
            vibrateKey()
            keyboardView.findViewById<View>(R.id.langSelectRow).visibility = View.GONE
        }

        // 말투 교정 토글 + 옵션 행
        val switchFormal = keyboardView.findViewById<Switch>(R.id.switchFormal)
        val formalOptionsRow = keyboardView.findViewById<View>(R.id.formalOptionsRow)
        switchFormal.isChecked = isFormalMode
        formalOptionsRow.visibility = if (isFormalMode) View.VISIBLE else View.GONE
        switchFormal.setOnCheckedChangeListener { _, checked ->
            isFormalMode = checked
            formalOptionsRow.visibility = if (checked) View.VISIBLE else View.GONE
        }

        // 말투 옵션 버튼들
        val formalOptionButtons = mapOf(
            R.id.btnFormal_jondaemal to "적당한 존댓말",
            R.id.btnFormal_gyeoksik to "엄격 격식체",
            R.id.btnFormal_sanae to "사내 메시지",
            R.id.btnFormal_gogaek to "고객 응대",
            R.id.btnFormal_hakbumo to "학부모 안내",
            R.id.btnFormal_sogaeting to "소개팅"
        )
        fun updateFormalOptionHighlight() {
            val current = SettingsManager.formalLevel
            formalOptionButtons.forEach { (id, level) ->
                val btn = keyboardView.findViewById<Button>(id) ?: return@forEach
                if (level == current) {
                    btn.setBackgroundResource(R.drawable.key_primary)
                    btn.setTextColor(android.graphics.Color.WHITE)
                } else {
                    btn.setBackgroundResource(R.drawable.key_letter)
                    btn.setTextColor(android.graphics.Color.parseColor("#1A1A1A"))
                }
            }
        }
        updateFormalOptionHighlight()
        formalOptionButtons.forEach { (id, level) ->
            keyboardView.findViewById<Button>(id)?.setOnClickListener {
                vibrateKey()
                SettingsManager.formalLevel = level
                updateFormalOptionHighlight()
            }
        }

        // 교정/번역 결과 적용 (버튼 또는 텍스트 클릭)
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

        // 교정 결과 닫기
        keyboardView.findViewById<Button>(R.id.btnCloseSuggestion).onKeyDown {
            vibrateKey()
            hideSuggestionBar()
            keyboardView.findViewById<View>(R.id.langSelectRow).visibility = View.GONE
        }

        // 모드 전환
        keyboardView.findViewById<Button>(R.id.key_mode).onKeyDown {
            vibrateKey()
            cycleInputMode()
        }

        // 숫자 행
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

        // ===== 두벌식 키 =====
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

        // 두벌식 shift
        keyboardView.findViewById<Button>(R.id.key_shift)?.onKeyDown {
            vibrateKey()
            isDubeolShift = !isDubeolShift
            updateDubeolShift()
        }

        // ===== 천지인 키 =====
        // 결합 자음 키 (두 번 탭 → 보조 자음)
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
        // 모음 키
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
        // 천지인 전용 하단 버튼
        keyboardView.findViewById<Button>(R.id.key_cj_enter)?.onKeyDown {
            vibrateKey(); lastCJKeyId = 0; commitComposing(); sendDefaultEditorAction(true)
        }
        keyboardView.findViewById<Button>(R.id.key_cj_space)?.onKeyDown {
            vibrateKey(); lastCJKeyId = 0
            val now = System.currentTimeMillis()
            if (SettingsManager.doubleSpacePeriod && now - lastSpaceTime < 600L) {
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
        keyboardView.findViewById<Button>(R.id.key_cj_mode)?.onKeyDown {
            vibrateKey(); lastCJKeyId = 0; cycleInputMode()
        }
        setupDeleteButton(R.id.key_cj_delete)

        // ===== 영어 키 =====
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
            keyboardView.findViewById<Button>(id)?.onKeyDown { view ->
                vibrateKey()
                val ch = if (isShiftOn) letter.uppercaseChar() else letter
                showKeyPreview(view, ch.toString())
                currentInputConnection?.commitText(ch.toString(), 1)
                if (isShiftOn) { isShiftOn = false; updateEnglishShift() }
                scheduleAutoCorrect()
            }
        }
        keyboardView.findViewById<Button>(R.id.key_en_shift).onKeyDown {
            vibrateKey()
            isShiftOn = !isShiftOn
            updateEnglishShift()
        }
        setupDeleteButton(R.id.key_en_delete)

        // ===== 공유 하단 버튼 =====
        keyboardView.findViewById<Button>(R.id.key_space).onKeyDown {
            vibrateKey()
            val now = System.currentTimeMillis()
            if (SettingsManager.doubleSpacePeriod && now - lastSpaceTime < 600L) {
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

        // 새 바닥 행: 따옴표 키
        keyboardView.findViewById<Button>(R.id.key_quote)?.onKeyDown {
            vibrateKey()
            commitComposing()
            currentInputConnection?.commitText("'", 1)
        }

        // !#1 / ABC 버튼 → 특수문자 키보드 토글
        keyboardView.findViewById<Button>(R.id.key_num_mode)?.onKeyDown {
            vibrateKey()
            switchToSymbol()
        }

        setupSymbolKeys()

        keyboardView.findViewById<Button>(R.id.key_enter).onKeyDown {
            vibrateKey()
            commitComposing()
            sendDefaultEditorAction(true)
        }
    }

    private val vibrationEffect by lazy {
        VibrationEffect.createOneShot(25, VibrationEffect.DEFAULT_AMPLITUDE)
    }

    private fun vibrateKey() {
        if (!SettingsManager.vibrationEnabled) return
        try { vibrator.vibrate(vibrationEffect) } catch (e: Exception) { }
    }

    private fun showKeyPreview(anchor: View, text: String) {
        if (!SettingsManager.keyPopup) return
        val density = resources.displayMetrics.density
        val w = (68 * density).toInt()
        val h = (60 * density).toInt()

        // 팝업/TextView 재사용 (매번 생성 X → 입력 지연 방지)
        val tv = keyPreviewTextView ?: TextView(this).apply {
            textSize = 22f
            gravity = Gravity.CENTER
            setTextColor(Color.parseColor("#222222"))
            background = android.graphics.drawable.GradientDrawable().apply {
                setColor(Color.WHITE)
                cornerRadius = 16 * density
                setStroke((1 * density).toInt(), Color.parseColor("#CCCCCC"))
            }
            setPadding(
                (16 * density).toInt(), (8 * density).toInt(),
                (16 * density).toInt(), (8 * density).toInt()
            )
        }.also { keyPreviewTextView = it }

        tv.text = text

        val popup = keyPreviewPopup ?: PopupWindow(tv, w, h, false).apply {
            elevation = 8f
        }.also { keyPreviewPopup = it }

        try {
            val xOff = (anchor.width - w) / 2
            val yOff = -(anchor.height + h + (4 * density).toInt())
            if (popup.isShowing) {
                popup.update(anchor, xOff, yOff, w, h)
            } else {
                popup.showAsDropDown(anchor, xOff, yOff)
            }
            handler.removeCallbacks(keyPreviewDismissRunnable)
            handler.postDelayed(keyPreviewDismissRunnable, 120)
        } catch (e: Exception) { }
    }

    private fun setupDeleteButton(id: Int) {
        keyboardView.findViewById<Button>(id)?.setOnTouchListener { _, event ->
            when (event.action) {
                MotionEvent.ACTION_DOWN -> {
                    vibrateKey()
                    onBackspace()
                    handler.postDelayed(deleteRepeatRunnable, 400)
                    true
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    handler.removeCallbacks(deleteRepeatRunnable)
                    true
                }
                else -> false
            }
        }
    }

    // 두벌식 입력 (쌍자음 두 번 연속 지원 + shift 지원)
    private fun onDubeolsikJamo(jamo: Char, anchor: View? = null) {
        vibrateKey()

        // shift ON: 쌍자음 직접 입력
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
        val btn = keyboardView.findViewById<Button>(R.id.key_shift) ?: return
        btn.setBackgroundResource(if (isDubeolShift) R.drawable.key_primary else R.drawable.key_func)
    }

    // 천지인 입력
    private fun onCheonjiinInput(key: Char, anchor: View? = null) {
        vibrateKey()
        anchor?.let { showKeyPreview(it, key.toString()) }
        val result = cheonjiinComposer.input(key)
        val committed = result.committed
        val composing = result.composing?.toString()
        postIC {
            val ic = currentInputConnection ?: return@postIC
            ic.beginBatchEdit()
            when {
                committed == "\b" -> ic.deleteSurroundingText(1, 0)
                committed.isNotEmpty() -> ic.commitText(committed, 1)
            }
            if (composing != null) ic.setComposingText(composing, 1)
            else ic.finishComposingText()
            ic.endBatchEdit()
        }
        scheduleAutoCorrect()
    }

    // 천지인 결합 자음 키 (순환: ㄱ→ㅋ→ㄲ→ㄱ→...)
    private fun onCJCombinedKey(keyId: Int, primary: Char, anchor: View) {
        val now = System.currentTimeMillis()
        val cycleList = cjCycleLists[primary] ?: listOf(primary)

        if (keyId == lastCJKeyId && now - lastCJKeyTime < DOUBLE_TAP_MS) {
            // 같은 키 연속 탭 → 다음 순환 자음으로 교체
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
            // 새 키 또는 시간 초과 → 첫 번째 자음부터 시작
            lastCJKeyId = keyId
            lastCJKeyTime = now
            lastCJCycleIdx = 0
            onCheonjiinInput(primary, anchor)
        }
    }

    private fun onHangulInput(jamo: Char, composer: HangulComposer) {
        val result = composer.input(jamo)  // 메인 스레드에서 조합 (순수 로직)
        val committed = result.committed
        val composing = result.composing?.toString()
        postIC {
            val ic = currentInputConnection ?: return@postIC
            ic.beginBatchEdit()
            when {
                committed == "\b" -> ic.deleteSurroundingText(1, 0)
                committed.isNotEmpty() -> ic.commitText(committed, 1)
            }
            if (composing != null) ic.setComposingText(composing, 1)
            else ic.finishComposingText()
            ic.endBatchEdit()
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
            InputMode.ENGLISH, InputMode.SYMBOL, InputMode.SYMBOL2, InputMode.SYMBOL3 -> deleteSelectedOrPrevChar(ic)
        }
    }

    private fun deleteSelectedOrPrevChar(ic: android.view.inputmethod.InputConnection) {
        if (cachedSelStart >= 0 && cachedSelStart != cachedSelEnd) {
            ic.commitText("", 1)  // 선택된 텍스트 삭제
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
            InputMode.ENGLISH, InputMode.SYMBOL, InputMode.SYMBOL2, InputMode.SYMBOL3 -> {}
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
            InputMode.SYMBOL, InputMode.SYMBOL2, InputMode.SYMBOL3 -> prevInputMode
        }
        updateKeyboardMode()
    }

    private val isSymbolMode get() = inputMode == InputMode.SYMBOL || inputMode == InputMode.SYMBOL2 || inputMode == InputMode.SYMBOL3

    private fun switchToSymbol() {
        commitComposing()
        if (isSymbolMode) {
            inputMode = prevInputMode
        } else {
            prevInputMode = inputMode
            inputMode = InputMode.SYMBOL
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
        scheduleAutoCorrect()
    }

    private fun setupSymbolKeys() {
        // 페이지 1
        val sym1Map = mapOf(
            R.id.sym_excl to "!", R.id.sym_ques to "?", R.id.sym_period to ".",
            R.id.sym_comma to ",", R.id.sym_lpar to "(", R.id.sym_rpar to ")",
            R.id.sym_at to "@", R.id.sym_colon to ":", R.id.sym_semi to ";",
            R.id.sym_slash to "/", R.id.sym_minus to "-", R.id.sym_heart to "♡",
            R.id.sym_star to "*", R.id.sym_under to "_", R.id.sym_pct to "%",
            R.id.sym_tilde to "~", R.id.sym_caret to "^", R.id.sym_hash to "#"
        )
        // 페이지 2
        val sym2Map = mapOf(
            R.id.sym2_plus to "+", R.id.sym2_times to "×", R.id.sym2_div to "÷",
            R.id.sym2_eq to "=", R.id.sym2_dquot to "\"", R.id.sym2_squot to "'",
            R.id.sym2_amp to "&", R.id.sym2_spade to "♠", R.id.sym2_fstar to "☆",
            R.id.sym2_club to "♣", R.id.sym2_bslash to "\\", R.id.sym2_won to "₩",
            R.id.sym2_lt to "<", R.id.sym2_gt to ">", R.id.sym2_lcurl to "{",
            R.id.sym2_rcurl to "}", R.id.sym2_lbr to "[", R.id.sym2_rbr to "]"
        )
        // 페이지 3
        val sym3Map = mapOf(
            R.id.sym3_grave to "`", R.id.sym3_pipe to "|", R.id.sym3_dollar to "$",
            R.id.sym3_euro to "€", R.id.sym3_pound to "£", R.id.sym3_yen to "¥",
            R.id.sym3_degree to "°", R.id.sym3_wcirc to "○", R.id.sym3_bcirc to "●",
            R.id.sym3_wsquare to "□", R.id.sym3_bsquare to "■", R.id.sym3_diamond to "◇",
            R.id.sym3_ref to "※", R.id.sym3_lguil to "«", R.id.sym3_rguil to "»",
            R.id.sym3_currency to "¤", R.id.sym3_dotlessi to "ı", R.id.sym3_iquest to "¿"
        )
        for ((id, sym) in sym1Map + sym2Map + sym3Map) {
            keyboardView.findViewById<Button>(id)?.onKeyDown {
                vibrateKey(); currentInputConnection?.commitText(sym, 1)
            }
        }

        // .,?! 순환 키
        for (id in listOf(R.id.sym_punct, R.id.sym2_punct, R.id.sym3_punct)) {
            keyboardView.findViewById<Button>(id)?.onKeyDown { onPunctCycle() }
        }
        // 스페이스
        for (id in listOf(R.id.sym_space, R.id.sym2_space, R.id.sym3_space)) {
            keyboardView.findViewById<Button>(id)?.onKeyDown {
                vibrateKey(); currentInputConnection?.commitText(" ", 1)
            }
        }
        // 따옴표
        for (id in listOf(R.id.sym_apos, R.id.sym2_apos, R.id.sym3_apos)) {
            keyboardView.findViewById<Button>(id)?.onKeyDown {
                vibrateKey(); currentInputConnection?.commitText("'", 1)
            }
        }
        // 엔터
        for (id in listOf(R.id.sym_enter, R.id.sym2_enter, R.id.sym3_enter)) {
            keyboardView.findViewById<Button>(id)?.onKeyDown {
                vibrateKey(); sendDefaultEditorAction(true)
            }
        }
        // 삭제
        setupDeleteButton(R.id.sym_del)
        setupDeleteButton(R.id.sym2_del)
        setupDeleteButton(R.id.sym3_del)

        // 가 → 이전 한국어 모드로
        for (id in listOf(R.id.sym_ko, R.id.sym2_ko, R.id.sym3_ko)) {
            keyboardView.findViewById<Button>(id)?.onKeyDown {
                vibrateKey()
                commitComposing()
                inputMode = prevInputMode
                updateKeyboardMode()
            }
        }
        // 123 → 이전 모드로
        for (id in listOf(R.id.sym_abc, R.id.sym2_abc, R.id.sym3_abc)) {
            keyboardView.findViewById<Button>(id)?.onKeyDown {
                vibrateKey(); switchToSymbol()
            }
        }
        // 페이지 전환
        keyboardView.findViewById<Button>(R.id.sym_page)?.onKeyDown {
            vibrateKey(); inputMode = InputMode.SYMBOL2; updateKeyboardMode()
        }
        keyboardView.findViewById<Button>(R.id.sym2_page)?.onKeyDown {
            vibrateKey(); inputMode = InputMode.SYMBOL3; updateKeyboardMode()
        }
        keyboardView.findViewById<Button>(R.id.sym3_page)?.onKeyDown {
            vibrateKey(); inputMode = InputMode.SYMBOL; updateKeyboardMode()
        }
    }

    private fun updateKeyboardMode() {
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

        // 공유 하단 행: 천지인 및 심볼 모드에서 숨김
        keyboardView.findViewById<LinearLayout>(R.id.bottomRow).visibility =
            if (inputMode == InputMode.CHEONJIIN || isSymbolMode) View.GONE else View.VISIBLE

        // 숫자 행: 심볼 모드에서 숨김
        keyboardView.findViewById<View>(R.id.rowNumbers)?.visibility =
            if (isSymbolMode) View.GONE else View.VISIBLE

        // !#1 / ABC 버튼 색상: 심볼 모드일 때 파란색
        val keyNumMode = keyboardView.findViewById<Button>(R.id.key_num_mode)
        keyNumMode?.text = if (isSymbolMode) "ABC" else "!#1"
        keyNumMode?.setBackgroundResource(if (isSymbolMode) R.drawable.key_primary else R.drawable.key_func)

        // 한/영 버튼 색상: 영어 모드일 때 파란색
        val keyMode = keyboardView.findViewById<Button>(R.id.key_mode)
        keyMode?.text = "한/영"
        keyMode?.setBackgroundResource(if (inputMode == InputMode.ENGLISH) R.drawable.key_primary else R.drawable.key_func)
    }

    private fun updateEnglishShift() {
        val btn = keyboardView.findViewById<Button>(R.id.key_en_shift)
        btn.setBackgroundResource(if (isShiftOn) R.drawable.key_primary else R.drawable.key_func)
        // key_primary (blue) always has white text; key_func color depends on theme
        val theme = SettingsManager.keyboardTheme
        val textColor = if (isShiftOn || theme == "블랙") Color.WHITE else Color.parseColor("#1C1C1E")
        btn.setTextColor(textColor)

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
        handler.postDelayed(autoCorrectRunnable, 1000)
    }

    private fun performAutoCorrect() {
        if (!TrialManager.canUseAI) {
            showSuggestion("무료 체험이 종료되었습니다. 앱에서 구독해 주세요.", false)
            return
        }
        val ic = currentInputConnection ?: return
        val extracted = ic.getExtractedText(ExtractedTextRequest(), 0)
        val text = extracted?.text?.toString() ?: return
        if (text.isBlank()) return

        suggestionMode = SuggestionMode.CORRECTION
        showSuggestion("맞춤법 확인 중...", false)

        ApiClient.correct(
            text, isFormalMode,
            SettingsManager.includePunct, SettingsManager.includeDialect,
            SettingsManager.formalLevel, SettingsManager.formalIncludePunct
        ) { result ->
            handler.post {
                if (!isServiceActive) return@post
                if (result.trim() == text.trim()) {
                    hideSuggestionBar()
                } else {
                    correctedText = result
                    showSuggestion(result, true)
                }
            }
        }
    }

    private fun performTranslation(targetLang: String) {
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
                translatedText = result
                showSuggestion("[$langName] $result", true)
            }
        }
    }

    private fun showSuggestion(text: String, showApply: Boolean) {
        keyboardView.findViewById<TextView>(R.id.tvSuggestion).text = text
        keyboardView.findViewById<Button>(R.id.btnApply).visibility =
            if (showApply) View.VISIBLE else View.GONE
        keyboardView.findViewById<View>(R.id.suggestionBar).visibility = View.VISIBLE
    }

    private fun hideSuggestionBar() {
        keyboardView.findViewById<View>(R.id.suggestionBar).visibility = View.GONE
        correctedText = ""
        translatedText = ""
        suggestionMode = SuggestionMode.CORRECTION
    }

    override fun onDestroy() {
        isServiceActive = false
        super.onDestroy()
        handler.removeCallbacks(deleteRepeatRunnable)
        handler.removeCallbacks(autoCorrectRunnable)
        icThread.quitSafely()
        keyPreviewPopup?.dismiss()
        cachedBitmap?.recycle()
        cachedBitmap = null
    }
}
