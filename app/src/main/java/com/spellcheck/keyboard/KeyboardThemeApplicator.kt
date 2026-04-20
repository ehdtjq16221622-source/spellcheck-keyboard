package com.spellcheck.keyboard

import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.StateListDrawable
import android.util.TypedValue
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.content.res.ResourcesCompat
import kotlin.math.roundToInt

object KeyboardThemeApplicator {

    private var cachedPretendard: Typeface? = null

    data class Spec(
        val background: Int,
        val chromeBackground: Int,
        val toolbarBackground: Int,
        val toolbarStatusText: Int,
        val toolbarDivider: Int,
        val toolbarChipFill: Int,
        val toolbarChipStroke: Int,
        val toolbarChipText: Int,
        val suggestionBackground: Int,
        val suggestionText: Int,
        val suggestionActionFill: Int,
        val suggestionActionPressedFill: Int,
        val suggestionActionText: Int,
        val cancelText: Int,
        val letterFill: Int,
        val letterPressedFill: Int,
        val letterText: Int,
        val letterSubText: Int,
        val numberFill: Int,
        val numberPressedFill: Int,
        val numberText: Int,
        val functionFill: Int,
        val functionPressedFill: Int,
        val functionText: Int,
        val functionIconTint: Int,
        val secondaryIconTint: Int,
        val spaceFill: Int,
        val spacePressedFill: Int,
        val spaceText: Int,
        val selectedFill: Int,
        val selectedPressedFill: Int,
        val selectedText: Int,
        val outlineFill: Int,
        val outlineStroke: Int,
        val outlineText: Int
    )

    enum class KeyRole { LETTER, NUMBER, FUNCTION, SPACE }

    fun builtInSpec(theme: String): Spec = when (theme) {
        "블랙" -> Spec(
            background = Color.parseColor("#0A0A0A"),
            chromeBackground = Color.parseColor("#020617"),
            toolbarBackground = Color.parseColor("#0A0A0A"),
            toolbarStatusText = Color.parseColor("#64748B"),
            toolbarDivider = Color.parseColor("#334155"),
            toolbarChipFill = Color.parseColor("#332563EB"),
            toolbarChipStroke = Color.parseColor("#662563EB"),
            toolbarChipText = Color.parseColor("#60A5FA"),
            suggestionBackground = Color.parseColor("#0F172A"),
            suggestionText = Color.parseColor("#F8FAFC"),
            suggestionActionFill = Color.parseColor("#332563EB"),
            suggestionActionPressedFill = Color.parseColor("#552563EB"),
            suggestionActionText = Color.parseColor("#60A5FA"),
            cancelText = Color.parseColor("#64748B"),
            letterFill = Color.parseColor("#334155"),
            letterPressedFill = Color.parseColor("#293548"),
            letterText = Color.WHITE,
            letterSubText = Color.parseColor("#94A3B8"),
            numberFill = Color.parseColor("#334155"),
            numberPressedFill = Color.parseColor("#293548"),
            numberText = Color.WHITE,
            functionFill = Color.parseColor("#1E293B"),
            functionPressedFill = Color.parseColor("#172132"),
            functionText = Color.WHITE,
            functionIconTint = Color.WHITE,
            secondaryIconTint = Color.parseColor("#94A3B8"),
            spaceFill = Color.parseColor("#334155"),
            spacePressedFill = Color.parseColor("#293548"),
            spaceText = Color.parseColor("#80FFFFFF"),
            selectedFill = Color.parseColor("#2563EB"),
            selectedPressedFill = Color.parseColor("#1D4ED8"),
            selectedText = Color.WHITE,
            outlineFill = Color.TRANSPARENT,
            outlineStroke = Color.parseColor("#334155"),
            outlineText = Color.parseColor("#94A3B8")
        )
        "핑크" -> Spec(
            background = Color.parseColor("#FDF2F8"),
            chromeBackground = Color.parseColor("#FCE7F3"),
            toolbarBackground = Color.parseColor("#FFF0F9"),
            toolbarStatusText = Color.parseColor("#BE185D"),
            toolbarDivider = Color.parseColor("#FBCFE8"),
            toolbarChipFill = Color.parseColor("#FDF2F8"),
            toolbarChipStroke = Color.parseColor("#FBCFE8"),
            toolbarChipText = Color.parseColor("#9D174D"),
            suggestionBackground = Color.parseColor("#FBCFE8"),
            suggestionText = Color.parseColor("#831843"),
            suggestionActionFill = Color.parseColor("#DB2777"),
            suggestionActionPressedFill = Color.parseColor("#BE185D"),
            suggestionActionText = Color.WHITE,
            cancelText = Color.parseColor("#F472B6"),
            letterFill = Color.WHITE,
            letterPressedFill = Color.parseColor("#FDE7F1"),
            letterText = Color.parseColor("#831843"),
            letterSubText = Color.parseColor("#BE185D"),
            numberFill = Color.WHITE,
            numberPressedFill = Color.parseColor("#FDE7F1"),
            numberText = Color.parseColor("#831843"),
            functionFill = Color.parseColor("#FBCFE8"),
            functionPressedFill = Color.parseColor("#F5B5D3"),
            functionText = Color.parseColor("#9D174D"),
            functionIconTint = Color.parseColor("#9D174D"),
            secondaryIconTint = Color.parseColor("#9D174D"),
            spaceFill = Color.WHITE,
            spacePressedFill = Color.parseColor("#FDE7F1"),
            spaceText = Color.parseColor("#831843"),
            selectedFill = Color.parseColor("#DB2777"),
            selectedPressedFill = Color.parseColor("#BE185D"),
            selectedText = Color.WHITE,
            outlineFill = Color.parseColor("#FDF2F8"),
            outlineStroke = Color.parseColor("#FBCFE8"),
            outlineText = Color.parseColor("#9D174D")
        )
        else -> Spec(
            background = Color.parseColor("#E4E4E6"),
            chromeBackground = Color.parseColor("#F6F6F8"),
            toolbarBackground = Color.parseColor("#F6F6F8"),
            toolbarStatusText = Color.parseColor("#363736"),
            toolbarDivider = Color.parseColor("#E7E7E9"),
            toolbarChipFill = Color.parseColor("#EDF4FF"),
            toolbarChipStroke = Color.parseColor("#66005BC1"),
            toolbarChipText = Color.parseColor("#005BC1"),
            suggestionBackground = Color.parseColor("#F6F6F8"),
            suggestionText = Color.parseColor("#004EA8"),
            suggestionActionFill = Color.parseColor("#26004EA8"),
            suggestionActionPressedFill = Color.parseColor("#32004EA8"),
            suggestionActionText = Color.parseColor("#004EA8"),
            cancelText = Color.parseColor("#595F6A"),
            letterFill = Color.WHITE,
            letterPressedFill = Color.parseColor("#ECEFF7"),
            letterText = Color.parseColor("#363736"),
            letterSubText = Color.parseColor("#838A95"),
            numberFill = Color.WHITE,
            numberPressedFill = Color.parseColor("#ECEFF7"),
            numberText = Color.parseColor("#363736"),
            functionFill = Color.parseColor("#C9C9CB"),
            functionPressedFill = Color.parseColor("#BBBBBE"),
            functionText = Color.parseColor("#363736"),
            functionIconTint = Color.parseColor("#363736"),
            secondaryIconTint = Color.parseColor("#363736"),
            spaceFill = Color.WHITE,
            spacePressedFill = Color.parseColor("#ECEFF7"),
            spaceText = Color.parseColor("#363736"),
            selectedFill = Color.parseColor("#0064FF"),
            selectedPressedFill = Color.parseColor("#0054D6"),
            selectedText = Color.WHITE,
            outlineFill = Color.TRANSPARENT,
            outlineStroke = Color.parseColor("#D3DAE9"),
            outlineText = Color.parseColor("#595F6A")
        )
    }

    fun customSpec(textColor: Int, buttonAlpha: Int, chromeTheme: String): Spec {
        val baseFill = Color.argb(buttonAlpha, 255, 255, 255)
        val pressedFill = Color.argb(buttonAlpha, 235, 240, 248)
        val overlayFill = Color.argb((buttonAlpha * 0.72f).toInt().coerceIn(0, 255), 255, 255, 255)
        val outlineStroke = if (Color.alpha(textColor) == 0) {
            Color.argb(140, 255, 255, 255)
        } else {
            Color.argb(180, 255, 255, 255)
        }
        val accent = Color.parseColor("#0064FF")
        val chromeSpec = builtInSpec(if (chromeTheme == "블랙") "블랙" else "화이트")
        return Spec(
            background = Color.TRANSPARENT,
            chromeBackground = chromeSpec.chromeBackground,
            toolbarBackground = chromeSpec.toolbarBackground,
            toolbarStatusText = chromeSpec.toolbarStatusText,
            toolbarDivider = chromeSpec.toolbarDivider,
            toolbarChipFill = chromeSpec.toolbarChipFill,
            toolbarChipStroke = chromeSpec.toolbarChipStroke,
            toolbarChipText = chromeSpec.toolbarChipText,
            suggestionBackground = chromeSpec.suggestionBackground,
            suggestionText = chromeSpec.suggestionText,
            suggestionActionFill = chromeSpec.suggestionActionFill,
            suggestionActionPressedFill = chromeSpec.suggestionActionPressedFill,
            suggestionActionText = chromeSpec.suggestionActionText,
            cancelText = chromeSpec.cancelText,
            letterFill = baseFill,
            letterPressedFill = pressedFill,
            letterText = textColor,
            letterSubText = Color.argb(170, Color.red(textColor), Color.green(textColor), Color.blue(textColor)),
            numberFill = baseFill,
            numberPressedFill = pressedFill,
            numberText = textColor,
            functionFill = overlayFill,
            functionPressedFill = Color.argb((buttonAlpha * 0.82f).toInt().coerceIn(0, 255), 230, 234, 242),
            functionText = textColor,
            functionIconTint = textColor,
            secondaryIconTint = Color.argb(180, Color.red(textColor), Color.green(textColor), Color.blue(textColor)),
            spaceFill = baseFill,
            spacePressedFill = pressedFill,
            spaceText = Color.argb(170, Color.red(textColor), Color.green(textColor), Color.blue(textColor)),
            selectedFill = accent,
            selectedPressedFill = Color.parseColor("#0054D6"),
            selectedText = Color.WHITE,
            outlineFill = chromeSpec.outlineFill,
            outlineStroke = if (chromeTheme == "블랙") chromeSpec.outlineStroke else outlineStroke,
            outlineText = chromeSpec.outlineText
        )
    }

    fun createKeyDrawable(
        density: Float,
        fill: Int,
        pressedFill: Int,
        radiusDp: Float = 5f,
        strokeColor: Int? = null,
        strokeWidthDp: Float = 0f
    ): StateListDrawable {
        fun shape(color: Int) = GradientDrawable().apply {
            cornerRadius = radiusDp * density
            setColor(color)
            if (strokeColor != null && strokeWidthDp > 0f) {
                setStroke((strokeWidthDp * density).toInt().coerceAtLeast(1), strokeColor)
            }
        }
        return StateListDrawable().apply {
            addState(intArrayOf(android.R.attr.state_pressed), shape(pressedFill))
            addState(intArrayOf(), shape(fill))
        }
    }

    fun applyContainerBackgrounds(rootView: View, bgColor: Int, includeBody: Boolean = true) {
        val containerIds = mutableListOf<Int>()
        if (includeBody) containerIds += R.id.keyboardBody
        containerIds += listOf(
            R.id.container_dubeolsik, R.id.container_cheonjiin, R.id.container_english,
            R.id.container_symbols, R.id.container_symbols2, R.id.container_symbols3,
            R.id.container_dubeol_sym1, R.id.container_dubeol_sym2, R.id.rowNumbers, R.id.bottomRow
        )
        fun setNestedBg(view: View) {
            if (view is LinearLayout) view.setBackgroundColor(bgColor)
            if (view is ViewGroup) {
                for (i in 0 until view.childCount) setNestedBg(view.getChildAt(i))
            }
        }
        containerIds.forEach { id -> rootView.findViewById<View>(id)?.let(::setNestedBg) }
    }

    fun applyChrome(rootView: View, spec: Spec, density: Float) {
        rootView.findViewById<View>(R.id.suggestionBar)?.setBackgroundColor(spec.suggestionBackground)
        rootView.findViewById<TextView>(R.id.tvSuggestion)?.setTextColor(spec.suggestionText)
        rootView.findViewById<Button>(R.id.btnApply)?.apply {
            background = createKeyDrawable(density, spec.suggestionActionFill, spec.suggestionActionPressedFill, radiusDp = 4f)
            setTextColor(spec.suggestionActionText)
        }
        rootView.findViewById<Button>(R.id.btnWatchAd)?.apply {
            background = createKeyDrawable(density, spec.suggestionActionFill, spec.suggestionActionPressedFill, radiusDp = 4f)
            setTextColor(spec.suggestionActionText)
        }
        rootView.findViewById<Button>(R.id.btnCloseSuggestion)?.apply {
            background = null
            setTextColor(spec.cancelText)
        }
        rootView.findViewById<View>(R.id.langSelectRow)?.setBackgroundColor(spec.chromeBackground)
        rootView.findViewById<Button>(R.id.btn_lang_cancel)?.apply {
            background = null
            setTextColor(spec.cancelText)
        }
        rootView.findViewById<View>(R.id.formalOptionsRow)?.setBackgroundColor(spec.chromeBackground)
        rootView.findViewById<View>(R.id.toolbar)?.setBackgroundColor(spec.toolbarBackground)
        rootView.findViewById<TextView>(R.id.toolbarStatusDot)?.setTextColor(Color.parseColor("#22C55E"))
        rootView.findViewById<TextView>(R.id.toolbarStatusLabel)?.setTextColor(spec.toolbarStatusText)
        rootView.findViewById<View>(R.id.toolbarDivider)?.setBackgroundColor(spec.toolbarDivider)
        listOf(R.id.btnTranslate, R.id.btnFormalToggle).forEach { id ->
            rootView.findViewById<Button>(id)?.apply {
                background = createKeyDrawable(
                    density = density,
                    fill = spec.toolbarChipFill,
                    pressedFill = spec.chromeBackground,
                    radiusDp = 4f,
                    strokeColor = spec.toolbarChipStroke,
                    strokeWidthDp = 1f
                )
                setTextColor(spec.toolbarChipText)
            }
        }
        applyPretendard(rootView)
    }

    fun isDescendantOf(view: View, ancestorId: Int): Boolean {
        var parent = view.parent
        while (parent is View) {
            if (parent.id == ancestorId) return true
            parent = parent.parent
        }
        return false
    }

    fun isChromeView(view: View): Boolean {
        val chromeContainers = listOf(R.id.suggestionBar, R.id.langSelectRow, R.id.formalOptionsRow, R.id.toolbar)
        return view.id in chromeContainers || chromeContainers.any { isDescendantOf(view, it) }
    }

    fun keyRoleOf(view: View): KeyRole? {
        if (isChromeView(view)) return null
        if (view.id == View.NO_ID) return null
        if (isDescendantOf(view, R.id.rowNumbers)) return KeyRole.NUMBER
        val name = runCatching { view.resources.getResourceEntryName(view.id) }.getOrNull() ?: return null
        if (name.contains("space")) return KeyRole.SPACE
        return when {
            name.startsWith("dsym_n") || name.startsWith("dsym2_n") -> KeyRole.NUMBER
            name.contains("delete") || name.endsWith("_del") || name.contains("enter") || name.contains("shift") ||
                name.endsWith("_mode") || name.contains("_num") || name.contains("_page") ||
                name.endsWith("_abc") || name.endsWith("_ko") || name.contains("punct") -> KeyRole.FUNCTION
            else -> KeyRole.LETTER
        }
    }

    fun applyKeyStyles(rootView: View, spec: Spec, density: Float) {
        applyLayoutMetrics(rootView, density)

        fun styleButton(button: Button, role: KeyRole) {
            val (fill, pressedFill, textColor) = when (role) {
                KeyRole.LETTER -> Triple(spec.letterFill, spec.letterPressedFill, spec.letterText)
                KeyRole.NUMBER -> Triple(spec.numberFill, spec.numberPressedFill, spec.numberText)
                KeyRole.FUNCTION -> Triple(spec.functionFill, spec.functionPressedFill, spec.functionText)
                KeyRole.SPACE -> Triple(spec.spaceFill, spec.spacePressedFill, spec.spaceText)
            }
            button.background = createKeyDrawable(density, fill, pressedFill)
            button.backgroundTintList = null
            button.setTextColor(textColor)
            val fontSize = when (role) {
                KeyRole.LETTER -> 16f
                KeyRole.NUMBER -> 15f
                KeyRole.FUNCTION -> 15f
                KeyRole.SPACE -> 12f
            }
            button.setTextSize(TypedValue.COMPLEX_UNIT_SP, fontSize)
            button.stateListAnimator = null
            button.elevation = density * 1.25f
            updateHorizontalMargins(button, density)
        }

        fun styleImageButton(button: ImageButton, role: KeyRole) {
            val fill = if (role == KeyRole.FUNCTION) spec.functionFill else spec.letterFill
            val pressed = if (role == KeyRole.FUNCTION) spec.functionPressedFill else spec.letterPressedFill
            val iconTint = when (button.id) {
                R.id.key_mode, R.id.key_cj_mode -> spec.secondaryIconTint
                else -> spec.functionIconTint
            }
            button.background = createKeyDrawable(density, fill, pressed)
            button.backgroundTintList = null
            button.imageTintList = ColorStateList.valueOf(iconTint)
            button.stateListAnimator = null
            button.elevation = density * 1.25f
            updateHorizontalMargins(button, density)
            val iconInset = (9f * density).toInt()
            button.setPadding(iconInset, iconInset, iconInset, iconInset)
        }

        fun styleFrameKey(frame: FrameLayout) {
            frame.background = createKeyDrawable(density, spec.letterFill, spec.letterPressedFill)
            frame.backgroundTintList = null
            frame.elevation = density * 1.25f
            updateHorizontalMargins(frame, density)
            for (i in 0 until frame.childCount) {
                val child = frame.getChildAt(i)
                if (child is TextView) {
                    if (child.textSize > 13f * density) {
                        child.setTextColor(spec.letterText)
                        child.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
                    } else {
                        child.setTextColor(spec.letterSubText)
                    }
                }
            }
        }

        fun applyRecursively(view: View) {
            if (view is ViewGroup) {
                view.clipChildren = false
                view.clipToPadding = false
            }
            val role = keyRoleOf(view)
            when {
                view is Button && role != null -> styleButton(view, role)
                view is ImageButton && role != null -> styleImageButton(view, role)
                view is FrameLayout && view.isClickable && !isChromeView(view) -> styleFrameKey(view)
            }
            if (view is ViewGroup && !isChromeView(view)) {
                for (i in 0 until view.childCount) applyRecursively(view.getChildAt(i))
            }
        }
        applyRecursively(rootView)
        applyPretendard(rootView)
    }

    private fun applyLayoutMetrics(rootView: View, density: Float) {
        fun dp(value: Float) = (value * density).roundToInt()

        fun styleRow(row: View?, heightDp: Float, padXDp: Float = 4f, padTopDp: Float = 5f, padBottomDp: Float = 5f) {
            row ?: return
            row.layoutParams = row.layoutParams?.also { it.height = dp(heightDp + padTopDp + padBottomDp) }
            row.setPaddingRelative(dp(padXDp), dp(padTopDp), dp(padXDp), dp(padBottomDp))
        }

        fun styleContainerRows(containerId: Int, rowHeightDp: Float) {
            val container = rootView.findViewById<ViewGroup>(containerId) ?: return
            for (i in 0 until container.childCount) {
                val child = container.getChildAt(i)
                if (child is LinearLayout) {
                    styleRow(child, rowHeightDp)
                }
            }
        }

        styleRow(rootView.findViewById(R.id.toolbar), 38f, padXDp = 8f, padTopDp = 0f, padBottomDp = 0f)
        styleRow(rootView.findViewById(R.id.rowNumbers), 34f)
        styleContainerRows(R.id.container_dubeolsik, 42f)
        styleContainerRows(R.id.container_english, 42f)
        styleContainerRows(R.id.container_symbols, 42f)
        styleContainerRows(R.id.container_symbols2, 42f)
        styleContainerRows(R.id.container_symbols3, 42f)
        styleContainerRows(R.id.container_dubeol_sym1, 42f)
        styleContainerRows(R.id.container_dubeol_sym2, 42f)
        styleRow(rootView.findViewById(R.id.bottomRow), 42f)

        fun setSpacerWeight(containerId: Int, rowIndex: Int, weight: Float) {
            val container = rootView.findViewById<ViewGroup>(containerId) ?: return
            val row = container.getChildAt(rowIndex) as? ViewGroup ?: return
            val first = row.getChildAt(0)
            val last = row.getChildAt(row.childCount - 1)
            listOf(first, last).forEach { spacer ->
                val params = spacer.layoutParams
                if (params is LinearLayout.LayoutParams) {
                    params.weight = weight
                    spacer.layoutParams = params
                }
            }
        }

        setSpacerWeight(R.id.container_dubeolsik, 1, 0.7f)
        setSpacerWeight(R.id.container_english, 1, 0.7f)

        listOf(R.id.key_shift, R.id.key_delete, R.id.key_en_shift, R.id.key_en_delete).forEach { id ->
            val view = rootView.findViewById<View>(id) ?: return@forEach
            val params = view.layoutParams
            if (params is LinearLayout.LayoutParams) {
                params.weight = 1.2f
                params.width = 0
                view.layoutParams = params
            }
        }
    }

    private fun applyPretendard(rootView: View) {
        val typeface = cachedPretendard
            ?: ResourcesCompat.getFont(rootView.context, R.font.pretendard_regular)?.also {
                cachedPretendard = it
            }
            ?: return

        fun visit(view: View) {
            if (view is TextView) {
                view.typeface = typeface
            }
            if (view is ViewGroup) {
                for (i in 0 until view.childCount) visit(view.getChildAt(i))
            }
        }

        visit(rootView)
    }

    private fun updateHorizontalMargins(view: View, density: Float) {
        val params = view.layoutParams
        if (params is ViewGroup.MarginLayoutParams) {
            if (params.marginStart > 0 || params.marginEnd > 0) {
                val margin = (2.5f * density).roundToInt()
                params.marginStart = margin
                params.marginEnd = margin
                view.layoutParams = params
            }
        }
    }
}
