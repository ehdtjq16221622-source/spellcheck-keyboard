package com.spellcheck.keyboard

import android.app.Activity
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Paint
import android.os.Bundle
import android.provider.Settings
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas as ComposeCanvas
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.painter.BitmapPainter
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import com.spellcheck.keyboard.ui.theme.맞춤법키보드Theme
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.math.max
import kotlin.math.roundToInt

private val AccentGreen = Color(0xFF22C55E)
private val AccentBlue = Color(0xFF0A84FF)
private val DestructiveRed = Color(0xFFFF5F57)
private val AppleDark = Color(0xFF111317)
private val AppleSurface = Color(0xFF1E2127)

private val LocalKColors = staticCompositionLocalOf { lightKColors() }

private enum class AppScreen {
    MAIN,
    START,
    KEYBOARD,
    SPELLCHECK,
    FORMAL,
    PRIVACY,
    FEEDBACK
}

private data class KColors(
    val background: Color,
    val surface: Color,
    val surfaceAlt: Color,
    val card: Color,
    val border: Color,
    val textPrimary: Color,
    val textSecondary: Color,
    val textMuted: Color,
    val accent: Color,
    val accentSoft: Color,
    val success: Color,
    val danger: Color,
    val sliderInactive: Color,
    val switchTrack: Color,
    val topBar: Color
)


private sealed class TrailingType {
    object Chevron : TrailingType()
    data class Toggle(val checked: Boolean, val onChanged: (Boolean) -> Unit) : TrailingType()
    data class Checkmark(val visible: Boolean) : TrailingType()
}

private object AppLinks {
    const val privacyUrl = "https://ehdtjq16221622-source.github.io/spellcheck-keyboard/privacy.html"
    const val feedbackUrl = "https://ehdtjq16221622-source.github.io/spellcheck-keyboard/feedback.html"
}

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        SettingsManager.init(this)
        TrialManager.init(this)
        CreditsManager.init(this)
        BillingManager.init(this)

        setContent {
            맞춤법키보드Theme {
                val themeMode = remember {
                    mutableStateOf(normalizeAppTheme(SettingsManager.appTheme))
                }
                val isDark = when (themeMode.value) {
                    "라이트" -> false
                    "다크" -> true
                    else -> true
                }
                val colors = if (isDark) darkKColors() else lightKColors()

                val baseDensity = androidx.compose.ui.platform.LocalDensity.current
                CompositionLocalProvider(
                    LocalKColors provides colors,
                    androidx.compose.ui.platform.LocalDensity provides androidx.compose.ui.unit.Density(
                        density = baseDensity.density,
                        fontScale = 1.0f
                    )
                ) {
                    Surface(
                        modifier = Modifier.fillMaxSize(),
                        color = colors.background
                    ) {
                        AppNavigator(
                            selectedTheme = themeMode.value,
                            onThemeChange = {
                                val normalized = normalizeAppTheme(it)
                                themeMode.value = normalized
                                SettingsManager.appTheme = normalized
                            },
                            onOpenKeyboardSettings = {
                                startActivity(android.content.Intent(Settings.ACTION_INPUT_METHOD_SETTINGS))
                            },
                            onOpenPrivacyPolicy = { AppLinks.privacyUrl },
                            onOpenFeedback = { AppLinks.feedbackUrl }
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun AppNavigator(
    selectedTheme: String,
    onThemeChange: (String) -> Unit,
    onOpenKeyboardSettings: () -> Unit,
    onOpenPrivacyPolicy: () -> String,
    onOpenFeedback: () -> String
) {
    var screen by remember { mutableStateOf(AppScreen.MAIN) }

    BackHandler(enabled = screen != AppScreen.MAIN) {
        screen = AppScreen.MAIN
    }

    when (screen) {
        AppScreen.MAIN -> MainScreen(
            selectedTheme = selectedTheme,
            onThemeChange = onThemeChange,
            onNavigate = { screen = it },
            onOpenPrivacyPolicy = { screen = AppScreen.PRIVACY },
            onOpenFeedback = { screen = AppScreen.FEEDBACK }
        )
        AppScreen.START -> SubScreenShell("시작하기", onBack = { screen = AppScreen.MAIN }) {
            StartScreenContent(onOpenKeyboardSettings)
        }
        AppScreen.KEYBOARD -> SubScreenShell("키보드 설정", onBack = { screen = AppScreen.MAIN }) {
            KeyboardScreenContent()
        }
        AppScreen.SPELLCHECK -> SubScreenShell("맞춤법 교정 설정", onBack = { screen = AppScreen.MAIN }) {
            SpellcheckScreenContent()
        }
        AppScreen.FORMAL -> SubScreenShell("말투 교정 설정", onBack = { screen = AppScreen.MAIN }) {
            FormalScreenContent()
        }
        AppScreen.PRIVACY -> WebScreen(
            title = "개인정보처리방침",
            url = onOpenPrivacyPolicy(),
            onBack = { screen = AppScreen.MAIN }
        )
        AppScreen.FEEDBACK -> WebScreen(
            title = "건의사항 보내기",
            url = onOpenFeedback(),
            onBack = { screen = AppScreen.MAIN }
        )
    }
}

@Composable
private fun MainScreen(
    selectedTheme: String,
    onThemeChange: (String) -> Unit,
    onNavigate: (AppScreen) -> Unit,
    onOpenPrivacyPolicy: () -> Unit,
    onOpenFeedback: () -> Unit
) {
    val colors = LocalKColors.current
    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 20.dp, vertical = 24.dp)
    ) {
        Text("킹보드", color = colors.textPrimary, fontSize = 34.sp, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(6.dp))
        Text("AI 한국어 맞춤법 · 말투 교정 키보드", color = colors.textSecondary, fontSize = 15.sp)

        Spacer(Modifier.height(20.dp))
        KSectionLabel("내 크레딧")
        CreditSectionCard()

        Spacer(Modifier.height(22.dp))
        KSectionLabel("구독 플랜")
        PlanSectionCard()

        Spacer(Modifier.height(22.dp))
        KSectionLabel("설정")
        KSection {
            KRow("시작하기", "키보드 활성화 방법", TrailingType.Chevron) { onNavigate(AppScreen.START) }
            KDivider()
            KRow("키보드 설정", "테마, 입력 모드, 진동", TrailingType.Chevron) { onNavigate(AppScreen.KEYBOARD) }
            KDivider()
            KRow("맞춤법 교정 설정", "구두점, 사투리 교정", TrailingType.Chevron) { onNavigate(AppScreen.SPELLCHECK) }
            KDivider()
            KRow("말투 교정 설정", "말투 스타일 선택", TrailingType.Chevron) { onNavigate(AppScreen.FORMAL) }
        }

        Spacer(Modifier.height(22.dp))
        KSectionLabel("앱 화면")
        KSection {
            Column(Modifier.padding(16.dp)) {
                Text("화면 모드", color = colors.textSecondary, fontSize = 13.sp)
                Spacer(Modifier.height(10.dp))
                KSegmentedControl(
                    options = listOf("시스템", "라이트", "다크"),
                    selected = normalizeAppTheme(selectedTheme),
                    onSelect = onThemeChange
                )
            }
        }

        Spacer(Modifier.height(22.dp))
        KSectionLabel("정보")
        KSection {
            KRow("건의사항 보내기", trailingType = TrailingType.Chevron) { onOpenFeedback() }
            KDivider()
            KRow("개인정보처리방침", trailingType = TrailingType.Chevron) { onOpenPrivacyPolicy() }
        }

        Spacer(Modifier.height(24.dp))
        Text(
            "버전 1.0",
            modifier = Modifier.fillMaxWidth(),
            textAlign = TextAlign.Center,
            color = colors.textMuted,
            fontSize = 12.sp
        )
        Spacer(Modifier.height(4.dp))
        Text(
            "입력하신 텍스트는 맞춤법 교정과 번역을 위해 AI 서버로 전송되며 저장되지 않습니다.",
            modifier = Modifier.fillMaxWidth(),
            textAlign = TextAlign.Center,
            color = colors.textMuted,
            fontSize = 11.sp
        )
        Spacer(Modifier.height(28.dp))
    }
}

@Composable
private fun SubScreenShell(
    title: String,
    onBack: () -> Unit,
    content: @Composable ColumnScope.() -> Unit
) {
    val colors = LocalKColors.current
    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(colors.background)
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .background(colors.topBar)
                .padding(horizontal = 16.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Row(
                modifier = Modifier.clickable(onClick = onBack),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text("<", color = colors.accent, fontSize = 26.sp, fontWeight = FontWeight.Medium)
                Text("설정", color = colors.accent, fontSize = 15.sp)
            }
            Box(modifier = Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                Text(title, color = colors.textPrimary, fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
            }
        }

        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp, vertical = 20.dp),
            content = content
        )
    }
}

@Composable
private fun StartScreenContent(onOpenKeyboardSettings: () -> Unit) {
    val colors = LocalKColors.current
    KSectionLabel("시작하기")
    KSection {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp)
        ) {
            StepRow("1", "키보드 설정에서 킹보드를 활성화하세요")
            StepRow("2", "보안 경고가 표시되면 내용을 확인하고 계속 진행하세요")
            StepRow("3", "기본 키보드를 킹보드로 변경하세요")
            Spacer(Modifier.height(6.dp))
            Button(
                onClick = onOpenKeyboardSettings,
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(14.dp),
                colors = ButtonDefaults.buttonColors(containerColor = colors.accent)
            ) {
                Text("키보드 설정 열기", color = Color.White, fontWeight = FontWeight.SemiBold)
            }
        }
    }
}

@Composable
private fun StepRow(index: String, text: String) {
    val colors = LocalKColors.current
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(
            modifier = Modifier
                .size(26.dp)
                .clip(CircleShape)
                .background(colors.accentSoft),
            contentAlignment = Alignment.Center
        ) {
            Text(index, color = colors.accent, fontSize = 12.sp, fontWeight = FontWeight.Bold)
        }
        Spacer(Modifier.width(12.dp))
        Text(text, color = colors.textPrimary, fontSize = 14.sp)
    }
}

@Composable
private fun KeyboardScreenContent() {
    val colors = LocalKColors.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    var vibration by remember { mutableStateOf(SettingsManager.vibrationEnabled) }
    var doubleSpace by remember { mutableStateOf(SettingsManager.doubleSpacePeriod) }
    var keyPopup by remember { mutableStateOf(SettingsManager.keyPopup) }
    var defaultMode by remember { mutableStateOf(normalizeDefaultMode(SettingsManager.defaultMode)) }
    var keyboardTheme by remember { mutableStateOf(normalizeKeyboardTheme(SettingsManager.keyboardTheme)) }
    var customImagePath by remember { mutableStateOf(SettingsManager.customImagePath) }
    var customImageMode by remember { mutableStateOf(normalizeCustomImageMode(SettingsManager.customImageMode)) }
    var customOverlay by remember { mutableFloatStateOf(SettingsManager.customImageOverlay.toFloat()) }
    var customKeyText by remember { mutableStateOf(normalizeCustomKeyText(SettingsManager.customKeyTextColor)) }
    var customChromeTheme by remember { mutableStateOf(normalizeCustomChromeTheme(SettingsManager.customChromeTheme)) }
    var customBtnOpacity by remember { mutableFloatStateOf(SettingsManager.customButtonOpacity.toFloat()) }
    var customImageScale by remember { mutableFloatStateOf(SettingsManager.customImageScale) }
    var customBlurAmount by remember { mutableFloatStateOf(SettingsManager.customBlurAmount.toFloat()) }
    var soundEnabled by remember { mutableStateOf(SettingsManager.soundEnabled) }
    var customImageOffsetX by remember { mutableFloatStateOf(SettingsManager.customImageOffsetX) }
    var customImageOffsetY by remember { mutableFloatStateOf(SettingsManager.customImageOffsetY) }
    var imageVersion by remember { mutableIntStateOf(0) }

    val cropLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val path = result.data?.getStringExtra(CropImageActivity.EXTRA_RESULT_PATH)
        if (result.resultCode == Activity.RESULT_OK && !path.isNullOrEmpty()) {
            customImagePath = path
            keyboardTheme = "커스텀"
            customImageMode = "꽉채우기"
            customImageScale = 1.0f
            customImageOffsetX = 0f
            customImageOffsetY = 0f
            imageVersion++

            SettingsManager.customImagePath = path
            SettingsManager.keyboardTheme = "커스텀"
            SettingsManager.customImageMode = "꽉채우기"
            SettingsManager.customImageScale = 1.0f
            SettingsManager.customImageOffsetX = 0f
            SettingsManager.customImageOffsetY = 0f
        }
    }

    val imagePicker = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.GetContent()
    ) { uri ->
        uri?.let { cropLauncher.launch(CropImageActivity.createIntent(context, it)) }
    }

    val customActive = keyboardTheme == "커스텀" && customImagePath.isNotBlank()

    KSectionLabel("입력")
    KSection {
        Column(Modifier.padding(16.dp)) {
            Text("기본 입력 모드", color = colors.textSecondary, fontSize = 13.sp)
            Spacer(Modifier.height(10.dp))
            KSegmentedControl(
                options = listOf("두벌식", "천지인"),
                selected = defaultMode,
                onSelect = {
                    defaultMode = it
                    SettingsManager.defaultMode = it
                }
            )
        }
    }

    Spacer(Modifier.height(18.dp))
    KSectionLabel("테마")
    KSection {
        Column(Modifier.padding(16.dp)) {
            Text("키보드 테마", color = colors.textSecondary, fontSize = 13.sp)
            Spacer(Modifier.height(12.dp))

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween
            ) {
                ThemeSwatch(
                    label = "화이트",
                    selected = keyboardTheme == "화이트",
                    fill = Color.White,
                    labelColor = Color(0xFF1C1C1E),
                    onClick = { keyboardTheme = "화이트"; SettingsManager.keyboardTheme = "화이트" }
                )
                ThemeSwatch(
                    label = "블랙",
                    selected = keyboardTheme == "블랙",
                    fill = Color(0xFF1A1C21),
                    labelColor = Color.White,
                    onClick = { keyboardTheme = "블랙"; SettingsManager.keyboardTheme = "블랙" }
                )
                ThemeSwatch(
                    label = "핑크",
                    selected = keyboardTheme == "핑크",
                    fill = Color(0xFFFF6FA8),
                    labelColor = Color.White,
                    onClick = { keyboardTheme = "핑크"; SettingsManager.keyboardTheme = "핑크" }
                )
                ThemeSwatch(
                    label = "커스텀",
                    selected = keyboardTheme == "커스텀",
                    fill = Color(0xFF1C2E47),
                    imagePath = customImagePath,
                    imageVersion = imageVersion,
                    onClick = { imagePicker.launch("image/*") }
                )
            }

            if (!customActive) {
                Spacer(Modifier.height(18.dp))
                Text("미리보기", color = colors.textSecondary, fontSize = 13.sp)
                Spacer(Modifier.height(10.dp))
                KeyboardDesignPreview(
                    keyboardTheme = keyboardTheme,
                    imagePath = customImagePath,
                    imageMode = customImageMode,
                    chromeTheme = customChromeTheme,
                    defaultMode = defaultMode,
                    buttonOpacity = customBtnOpacity,
                    overlay = customOverlay,
                    imageScale = customImageScale,
                    blurAmount = customBlurAmount,
                    offsetX = customImageOffsetX,
                    offsetY = customImageOffsetY,
                    keyText = customKeyText,
                    imageVersion = imageVersion,
                    onOffsetChange = { nextX, nextY ->
                        customImageOffsetX = nextX
                        customImageOffsetY = nextY
                    }
                )
            }

            if (customActive) {
                Spacer(Modifier.height(16.dp))
                LabelValueRow("버튼 투명도", "${customBtnOpacity.roundToInt()}%")
                Slider(
                    value = customBtnOpacity,
                    onValueChange = { customBtnOpacity = it },
                    valueRange = 0f..100f,
                    colors = SliderDefaults.colors(
                        thumbColor = colors.accent,
                        activeTrackColor = colors.accent,
                        inactiveTrackColor = colors.sliderInactive
                    )
                )

                Spacer(Modifier.height(6.dp))
                Text("표시 방식", color = colors.textSecondary, fontSize = 13.sp)
                Spacer(Modifier.height(10.dp))
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(12.dp)
                ) {
                    ModeChoice("꽉채우기", "□", customImageMode == "꽉채우기") { customImageMode = "꽉채우기" }
                    ModeChoice("타일", "□", customImageMode == "타일") { customImageMode = "타일" }
                    ModeChoice("바둑판", "□", customImageMode == "바둑판") { customImageMode = "바둑판" }
                    ModeChoice("블러", "□", customImageMode == "블러") { customImageMode = "블러" }
                }

                Spacer(Modifier.height(6.dp))
                LabelValueRow("이미지 크기", "${"%.1f".format(customImageScale)}x")
                Slider(
                    value = customImageScale,
                    onValueChange = { customImageScale = it },
                    valueRange = 0.5f..3.0f,
                    colors = SliderDefaults.colors(
                        thumbColor = colors.accent,
                        activeTrackColor = colors.accent,
                        inactiveTrackColor = colors.sliderInactive
                    )
                )

                if (customImageMode == "블러") {
                    Spacer(Modifier.height(6.dp))
                    LabelValueRow("블러 강도", customBlurAmount.roundToInt().toString())
                    Slider(
                        value = customBlurAmount,
                        onValueChange = { customBlurAmount = it },
                        valueRange = 1f..25f,
                        colors = SliderDefaults.colors(
                            thumbColor = colors.accent,
                            activeTrackColor = colors.accent,
                            inactiveTrackColor = colors.sliderInactive
                        )
                    )
                }

                Spacer(Modifier.height(6.dp))
                LabelValueRow("어둡기", "${customOverlay.roundToInt()}%")
                Slider(
                    value = customOverlay,
                    onValueChange = { customOverlay = it },
                    valueRange = 0f..80f,
                    colors = SliderDefaults.colors(
                        thumbColor = colors.accent,
                        activeTrackColor = colors.accent,
                        inactiveTrackColor = colors.sliderInactive
                    )
                )

                Spacer(Modifier.height(10.dp))
                Text("키 글자 색상", color = colors.textSecondary, fontSize = 13.sp)
                Spacer(Modifier.height(10.dp))
                KSegmentedControl(
                    options = listOf("어둠", "밝음"),
                    selected = customKeyText,
                    onSelect = { customKeyText = it }
                )

                Spacer(Modifier.height(10.dp))
                Text("번역/말투 줄", color = colors.textSecondary, fontSize = 13.sp)
                Spacer(Modifier.height(10.dp))
                KSegmentedControl(
                    options = listOf("화이트", "블랙"),
                    selected = customChromeTheme,
                    onSelect = { customChromeTheme = it }
                )

                Spacer(Modifier.height(10.dp))
                Text(
                    "이미지 다시 선택",
                    color = colors.accent,
                    fontSize = 14.sp,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.clickable { imagePicker.launch("image/*") }
                )

                Spacer(Modifier.height(18.dp))
                Text("미리보기", color = colors.textSecondary, fontSize = 13.sp)
                Spacer(Modifier.height(10.dp))
                KeyboardDesignPreview(
                    keyboardTheme = keyboardTheme,
                    imagePath = customImagePath,
                    imageMode = customImageMode,
                    chromeTheme = customChromeTheme,
                    defaultMode = defaultMode,
                    buttonOpacity = customBtnOpacity,
                    overlay = customOverlay,
                    imageScale = customImageScale,
                    blurAmount = customBlurAmount,
                    offsetX = customImageOffsetX,
                    offsetY = customImageOffsetY,
                    keyText = customKeyText,
                    imageVersion = imageVersion,
                    onOffsetChange = { nextX, nextY ->
                        customImageOffsetX = nextX
                        customImageOffsetY = nextY
                    }
                )

                Spacer(Modifier.height(16.dp))
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                    Button(
                        onClick = {
                            SettingsManager.keyboardTheme = keyboardTheme
                            SettingsManager.customImagePath = customImagePath
                            SettingsManager.customImageMode = customImageMode
                            SettingsManager.customImageScale = customImageScale
                            SettingsManager.customBlurAmount = customBlurAmount.roundToInt().coerceAtLeast(1)
                            SettingsManager.customImageOverlay = customOverlay.roundToInt()
                            SettingsManager.customKeyTextColor = customKeyText
                            SettingsManager.customChromeTheme = customChromeTheme
                            SettingsManager.customButtonOpacity = customBtnOpacity.roundToInt()
                            SettingsManager.customImageOffsetX = customImageOffsetX
                            SettingsManager.customImageOffsetY = customImageOffsetY
                        },
                        shape = RoundedCornerShape(10.dp),
                        colors = ButtonDefaults.buttonColors(containerColor = AccentBlue),
                        contentPadding = PaddingValues(horizontal = 24.dp, vertical = 10.dp)
                    ) {
                        Text("적용", color = Color.White, fontWeight = FontWeight.SemiBold)
                    }
                }
            }
        }
    }

    Spacer(Modifier.height(18.dp))
    KSectionLabel("입력 옵션")
    KSection {
        KRow("키 소리", trailingType = TrailingType.Toggle(soundEnabled) {
            soundEnabled = it
            SettingsManager.soundEnabled = it
        })
        KDivider()
        KRow("키 진동", trailingType = TrailingType.Toggle(vibration) {
            vibration = it
            SettingsManager.vibrationEnabled = it
        })
        KDivider()
        KRow("키 크게 보기", trailingType = TrailingType.Toggle(keyPopup) {
            keyPopup = it
            SettingsManager.keyPopup = it
        })
        KDivider()
        KRow("스페이스 두 번 마침표", trailingType = TrailingType.Toggle(doubleSpace) {
            doubleSpace = it
            SettingsManager.doubleSpacePeriod = it
        })
    }

    LaunchedEffect(Unit) {
        scope.launch {
            BillingManager.refresh()
        }
    }
}

@Composable
private fun ThemeSwatch(
    label: String,
    selected: Boolean,
    fill: Color,
    labelColor: Color = Color.White,
    imagePath: String = "",
    imageVersion: Int = 0,
    onClick: () -> Unit
) {
    val colors = LocalKColors.current
    val bitmap by produceState<Bitmap?>(null, imagePath, imageVersion) {
        value = withContext(Dispatchers.IO) {
            if (imagePath.isBlank()) null else decodeSampledBitmap(imagePath, 240, 240)
        }
    }

    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        modifier = Modifier.width(64.dp)
    ) {
        Box(
            modifier = Modifier
                .size(56.dp)
                .clip(RoundedCornerShape(16.dp))
                .background(fill)
                .border(
                    width = if (selected) 2.dp else 1.dp,
                    color = if (selected) colors.accent else colors.border,
                    shape = RoundedCornerShape(16.dp)
                )
                .clickable(onClick = onClick),
            contentAlignment = Alignment.Center
        ) {
            if (bitmap != null) {
                Image(
                    painter = BitmapPainter(bitmap!!.asImageBitmap()),
                    contentDescription = null,
                    contentScale = ContentScale.Crop,
                    modifier = Modifier.fillMaxSize()
                )
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .background(Color.Black.copy(alpha = 0.15f))
                )
            }
            if (selected) {
                Text("✓", color = labelColor, fontWeight = FontWeight.Bold, fontSize = 18.sp)
            }
        }
        Spacer(Modifier.height(8.dp))
        Text(
            label,
            color = if (selected) colors.accent else colors.textSecondary,
            fontSize = 12.sp,
            fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal
        )
    }
}

@Composable
private fun ModeChoice(
    label: String,
    icon: String,
    selected: Boolean,
    onClick: () -> Unit
) {
    val colors = LocalKColors.current
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        modifier = Modifier.widthIn(min = 58.dp)
    ) {
        Box(
            modifier = Modifier
                .size(48.dp)
                .clip(RoundedCornerShape(12.dp))
                .background(if (selected) colors.accentSoft else colors.surfaceAlt)
                .border(
                    width = if (selected) 1.5.dp else 1.dp,
                    color = if (selected) colors.accent else colors.border,
                    shape = RoundedCornerShape(12.dp)
                )
                .clickable(onClick = onClick),
            contentAlignment = Alignment.Center
        ) {
            Text(icon, color = colors.textPrimary, fontSize = 18.sp)
        }
        Spacer(Modifier.height(6.dp))
        Text(label, color = if (selected) colors.accent else colors.textSecondary, fontSize = 11.sp)
    }
}

@Composable
private fun LabelValueRow(label: String, value: String) {
    val colors = LocalKColors.current
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(label, color = colors.textSecondary, fontSize = 13.sp)
        Spacer(Modifier.width(8.dp))
        Text(value, color = colors.textPrimary, fontSize = 13.sp, fontWeight = FontWeight.Medium)
    }
}

@Composable
private fun KeyboardDesignPreview(
    keyboardTheme: String,
    imagePath: String,
    imageMode: String,
    chromeTheme: String,
    defaultMode: String,
    buttonOpacity: Float,
    overlay: Float,
    imageScale: Float,
    blurAmount: Float,
    offsetX: Float,
    offsetY: Float,
    keyText: String,
    imageVersion: Int,
    onOffsetChange: (Float, Float) -> Unit
) {
    val colors = LocalKColors.current
    val context = LocalContext.current
    val density = context.resources.displayMetrics.density
    val keyboardBodyHeightPx = (222f * density).roundToInt()
    val suggestionBarHeightPx = 36f * density
    val spec = remember(keyboardTheme, buttonOpacity, keyText, chromeTheme) {
        if (keyboardTheme == "커스텀") {
            val textColor = if (keyText == "밝음") android.graphics.Color.WHITE else android.graphics.Color.parseColor("#1C1C1E")
            val alpha = (buttonOpacity * 255f / 100f).roundToInt().coerceIn(0, 255)
            KeyboardThemeApplicator.customSpec(textColor, alpha, chromeTheme)
        } else {
            KeyboardThemeApplicator.builtInSpec(keyboardTheme)
        }
    }
    var previewSize by remember { mutableStateOf(IntSize.Zero) }
    var bodyPreviewSize by remember { mutableStateOf(IntSize.Zero) }
    val shimmerX by rememberInfiniteTransition(label = "previewSuggestionShimmer").animateFloat(
        initialValue = -0.45f,
        targetValue = 1.2f,
        animationSpec = infiniteRepeatable(animation = tween(durationMillis = 1100)),
        label = "previewSuggestionShimmerX"
    )
    val bitmap by produceState<Bitmap?>(null, imagePath, imageVersion) {
        value = withContext(Dispatchers.IO) {
            if (imagePath.isBlank()) null else decodeSampledBitmap(imagePath, 2400, 1600)
        }
    }
    val previewBitmap by produceState<Bitmap?>(null, keyboardTheme, bitmap, imageMode, bodyPreviewSize.width, imageScale, blurAmount, overlay, offsetX, offsetY) {
        value = withContext(Dispatchers.IO) {
            val renderPreviewWidthPx = bodyPreviewSize.width
            val actualBodyWidthPx = SettingsManager.keyboardBodyWidthPx.takeIf { it > 0 } ?: renderPreviewWidthPx
            val actualBodyHeightPx = SettingsManager.keyboardBodyHeightPx.takeIf { it > 0 } ?: keyboardBodyHeightPx
            if (keyboardTheme != "커스텀" || bitmap == null || actualBodyWidthPx <= 0 || actualBodyHeightPx <= 0 || renderPreviewWidthPx <= 0) {
                null
            } else {
                renderPreviewBackgroundBitmap(
                    source = bitmap!!,
                    width = renderPreviewWidthPx,
                    height = keyboardBodyHeightPx,
                    actualWidth = actualBodyWidthPx,
                    actualHeight = actualBodyHeightPx,
                    mode = imageMode,
                    imageScale = imageScale,
                    blurAmount = blurAmount,
                    overlay = overlay,
                    offsetX = offsetX,
                    offsetY = offsetY
                )
            }
        }
    }

    Box(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(18.dp))
            .border(1.dp, colors.border, RoundedCornerShape(18.dp))
            .onSizeChanged { previewSize = it }
    ) {
        AndroidView(
            factory = { ctx ->
                android.view.LayoutInflater.from(ctx).inflate(R.layout.keyboard_view, null, false).also { root ->
                    listOf(
                        R.id.langSelectRow,
                        R.id.formalOptionsRow,
                        R.id.container_english,
                        R.id.container_symbols,
                        R.id.container_symbols2,
                        R.id.container_symbols3,
                        R.id.container_dubeol_sym1,
                        R.id.container_dubeol_sym2
                    ).forEach { id ->
                        root.findViewById<android.view.View>(id)?.visibility = android.view.View.GONE
                    }
                    root.findViewById<android.view.View>(R.id.suggestionBar)?.visibility = android.view.View.VISIBLE
                    root.findViewById<android.widget.Button>(R.id.btnWatchAd)?.visibility = android.view.View.GONE
                    root.findViewById<android.widget.Button>(R.id.btnApply)?.visibility = android.view.View.VISIBLE
                    root.findViewById<android.widget.TextView>(R.id.tvSuggestion)?.text = "반갑습니다:)"
                }
            },
            update = { root ->
                val isDubeolsik = defaultMode != "천지인"
                root.findViewById<android.view.View>(R.id.container_dubeolsik)?.visibility =
                    if (isDubeolsik) android.view.View.VISIBLE else android.view.View.GONE
                root.findViewById<android.view.View>(R.id.container_cheonjiin)?.visibility =
                    if (isDubeolsik) android.view.View.GONE else android.view.View.VISIBLE
                root.findViewById<android.view.View>(R.id.bottomRow)?.visibility =
                    if (isDubeolsik) android.view.View.VISIBLE else android.view.View.GONE

                root.findViewById<android.widget.Button>(R.id.btnWatchAd)?.visibility = android.view.View.GONE
                root.findViewById<android.widget.Button>(R.id.btnApply)?.visibility = android.view.View.VISIBLE
                root.findViewById<android.widget.TextView>(R.id.tvSuggestion)?.text = "반갑습니다:)"

                val bodyView = root.findViewById<android.view.View>(R.id.keyboardBody)
                bodyView?.layoutParams = bodyView?.layoutParams?.apply { height = keyboardBodyHeightPx }
                bodyView?.requestLayout()

                val snapshotBitmap = previewBitmap
                if (keyboardTheme == "커스텀" && snapshotBitmap != null) {
                    bodyView?.background = android.graphics.drawable.BitmapDrawable(root.resources, snapshotBitmap)
                    root.setBackgroundColor(android.graphics.Color.TRANSPARENT)
                    KeyboardThemeApplicator.applyContainerBackgrounds(root, android.graphics.Color.TRANSPARENT, includeBody = false)
                } else {
                    bodyView?.background = null
                    root.setBackgroundColor(spec.background)
                    bodyView?.setBackgroundColor(spec.background)
                    KeyboardThemeApplicator.applyContainerBackgrounds(root, spec.background)
                }

                val d = root.resources.displayMetrics.density
                KeyboardThemeApplicator.applyChrome(root, spec, d)
                KeyboardThemeApplicator.applyKeyStyles(root, spec, d)
            },
            modifier = Modifier
                .fillMaxWidth()
                .height(294.dp)
        )

        Box(
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .fillMaxWidth()
                .height(222.dp)
                .onSizeChanged { bodyPreviewSize = it }
                .pointerInput(keyboardTheme, imagePath, bodyPreviewSize) {
                    if (keyboardTheme == "커스텀" && imagePath.isNotBlank()) {
                        detectDragGestures { change, dragAmount ->
                            change.consume()
                            if (bodyPreviewSize.width > 0 && bodyPreviewSize.height > 0) {
                                val nextX = (offsetX + dragAmount.x / bodyPreviewSize.width).coerceIn(-1f, 1f)
                                val nextY = (offsetY + dragAmount.y / bodyPreviewSize.height).coerceIn(-1f, 1f)
                                onOffsetChange(nextX, nextY)
                            }
                        }
                    }
                }
        ) {
            if (keyboardTheme == "커스텀" && imagePath.isNotBlank()) {
                Box(
                    modifier = Modifier
                        .matchParentSize()
                        .border(
                            width = 1.dp,
                            color = Color.White.copy(alpha = 0.28f),
                            shape = RoundedCornerShape(bottomStart = 18.dp, bottomEnd = 18.dp)
                        )
                )
                Box(
                    modifier = Modifier
                        .align(Alignment.TopEnd)
                        .padding(top = 8.dp, end = 10.dp)
                        .clip(RoundedCornerShape(999.dp))
                        .background(Color.Black.copy(alpha = 0.22f))
                        .padding(horizontal = 8.dp, vertical = 4.dp)
                ) {
                    Text(
                        "사진 적용 영역",
                        color = Color.White.copy(alpha = 0.92f),
                        fontSize = 10.sp,
                        fontWeight = FontWeight.Medium
                    )
                }
            }
        }

        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(36.dp)
                .background(
                    brush = Brush.linearGradient(
                        colors = listOf(
                            Color.Transparent,
                            Color.White.copy(alpha = 0.40f),
                            Color.Transparent
                        ),
                        start = Offset(previewSize.width * shimmerX - previewSize.width * 0.35f, 0f),
                        end = Offset(previewSize.width * shimmerX, suggestionBarHeightPx)
                    )
                )
        )
    }
}

@Composable
private fun SpellcheckScreenContent() {
    var includePunct by remember { mutableStateOf(SettingsManager.includePunct) }
    var includeDialect by remember { mutableStateOf(SettingsManager.includeDialect) }

    KSectionLabel("맞춤법")
    KSection {
        KRow(
            title = "구두점 포함 교정",
            subtitle = "쉼표, 마침표, 위치까지 교정",
            trailingType = TrailingType.Toggle(includePunct) {
                includePunct = it
                SettingsManager.includePunct = it
            }
        )
        KDivider()
        KRow(
            title = "사투리 표현 교정",
            subtitle = "사투리 표현도 더 자연스럽게 정리",
            trailingType = TrailingType.Toggle(includeDialect) {
                includeDialect = it
                SettingsManager.includeDialect = it
            }
        )
    }
}

@Composable
private fun FormalScreenContent() {
    var formalLevel by remember { mutableStateOf(normalizeFormalLevel(SettingsManager.formalLevel)) }
    var formalIncludePunct by remember { mutableStateOf(SettingsManager.formalIncludePunct) }

    KSectionLabel("말투 스타일")
    KSection {
        val items = listOf(
            "존댓말" to "부드럽고 자연스러운 존댓말로 교정",
            "격식체" to "격식 있는 문장으로 정리",
            "사내 메시지" to "업무용 메신저 톤으로 다듬기",
            "고객 안내" to "고객 응대용 문장으로 정중하게 정리",
            "공문 안내" to "안내문과 공지문처럼 또렷하게 정리",
            "친근체" to "가볍고 편한 말투로 바꾸기"
        )
        items.forEachIndexed { index, (title, subtitle) ->
            if (index > 0) KDivider()
            KRow(
                title = title,
                subtitle = subtitle,
                trailingType = TrailingType.Checkmark(formalLevel == title),
                onClick = {
                    formalLevel = title
                    SettingsManager.formalLevel = title
                }
            )
        }
    }

    Spacer(Modifier.height(18.dp))
    KSectionLabel("추가 옵션")
    KSection {
        KRow(
            title = "말투 교정 시 구두점 교정",
            trailingType = TrailingType.Toggle(formalIncludePunct) {
                formalIncludePunct = it
                SettingsManager.formalIncludePunct = it
            }
        )
    }
}

@Composable
private fun CreditSectionCard() {
    val c = LocalKColors.current
    val creditState by CreditsManager.state.collectAsState()
    val subscriptionState by TrialManager.state.collectAsState()
    val totalCredits = creditState.totalCredits
    val maxCredits = if (subscriptionState.isSubscribed) 10000 else 5000
    val progress = (totalCredits.toFloat() / maxCredits).coerceIn(0f, 1f)

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(18.dp))
            .background(c.card)
            .border(1.dp, c.border, RoundedCornerShape(18.dp))
            .padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        Text(
            text = "$totalCredits",
            fontSize = 40.sp,
            fontWeight = FontWeight.Bold,
            color = c.textPrimary,
            letterSpacing = (-1).sp
        )
        LinearProgressIndicator(
            progress = { progress },
            modifier = Modifier.fillMaxWidth().height(6.dp).clip(RoundedCornerShape(980.dp)),
            color = c.accent,
            trackColor = c.sliderInactive
        )
        Text(
            "매일 자정 무료 크레딧 50 자동 지급",
            fontSize = 14.sp,
            fontWeight = FontWeight.Medium,
            color = c.textSecondary
        )
    }
}

@Composable
private fun PlanSectionCard() {
    val c = LocalKColors.current
    val context = LocalContext.current
    val activity = context as? Activity
    val billingState by BillingManager.state.collectAsState()
    val subscriptionState by TrialManager.state.collectAsState()
    val isBusy = billingState.isPurchaseInProgress
    val cardShape = RoundedCornerShape(18.dp)

    val auroraGradient = Brush.linearGradient(
        colors = listOf(Color(0xFF9B59F5), Color(0xFF647DEE), Color(0xFF00B4DB), Color(0xFF43E97B)),
        start = Offset(0f, 0f),
        end = Offset(Float.POSITIVE_INFINITY, Float.POSITIVE_INFINITY)
    )

    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        if (subscriptionState.isSubscribed) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(cardShape)
                    .background(c.card)
                    .border(1.dp, c.border, cardShape)
                    .padding(20.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp)
            ) {
                Text("구독 중", color = c.success, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                Text("모든 AI 기능 이용 가능", color = c.textPrimary, fontSize = 18.sp, fontWeight = FontWeight.Bold)
                Button(
                    onClick = { BillingManager.openSubscriptionManagement(context) },
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(14.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = c.surfaceAlt)
                ) { Text("구독 관리하기", color = c.textPrimary) }
            }
        } else {
            Row(
                modifier = Modifier.fillMaxWidth().height(IntrinsicSize.Max),
                horizontalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                // 베이직
                val plan1Enabled = activity != null && billingState.isProductReady && !isBusy
                Column(
                    modifier = Modifier.weight(1f).fillMaxHeight()
                        .clip(cardShape).background(c.card).border(1.dp, c.border, cardShape)
                        .padding(16.dp),
                    verticalArrangement = Arrangement.SpaceBetween
                ) {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text("베이직", fontSize = 12.sp, color = c.textSecondary)
                        Column {
                            Text(billingState.productPrice ?: "₩2,000",
                                fontSize = 22.sp, fontWeight = FontWeight.SemiBold, color = c.textPrimary)
                            Text("/ 월", fontSize = 12.sp, color = c.textMuted)
                        }
                        HorizontalDivider(color = c.border, thickness = 0.5.dp)
                        Text("매일 5,000 크레딧", fontSize = 16.sp, fontWeight = FontWeight.SemiBold, color = c.textPrimary)
                    }
                    Button(
                        onClick = { activity?.let { BillingManager.launchSubscriptionPurchase(it, 1) } },
                        enabled = plan1Enabled,
                        modifier = Modifier.fillMaxWidth().height(40.dp).padding(top = 4.dp),
                        shape = RoundedCornerShape(980.dp),
                        colors = ButtonDefaults.buttonColors(
                            containerColor = AccentBlue,
                            disabledContainerColor = AccentBlue.copy(alpha = 0.38f)
                        ),
                        contentPadding = PaddingValues(0.dp)
                    ) {
                        if (isBusy) androidx.compose.material3.CircularProgressIndicator(
                            Modifier.size(16.dp), color = Color.White, strokeWidth = 2.dp
                        )
                        else Text("구독하기", color = Color.White, fontSize = 14.sp)
                    }
                }

                // ?꾨━誘몄뾼
                val plan2Enabled = activity != null && billingState.isPlan2Ready && !isBusy
                Column(
                    modifier = Modifier.weight(1f).fillMaxHeight()
                        .clip(cardShape)
                        .background(
                            Brush.linearGradient(
                                listOf(Color(0xFF9B59F5).copy(alpha = 0.08f), Color(0xFF00B4DB).copy(alpha = 0.08f)),
                                start = Offset(0f, 0f), end = Offset(Float.POSITIVE_INFINITY, Float.POSITIVE_INFINITY)
                            )
                        )
                        .border(
                            1.5.dp,
                            Brush.linearGradient(
                                listOf(Color(0xFF9B59F5), Color(0xFF647DEE), Color(0xFF00B4DB)),
                                start = Offset(0f, 0f), end = Offset(Float.POSITIVE_INFINITY, 0f)
                            ),
                            cardShape
                        )
                        .padding(16.dp),
                    verticalArrangement = Arrangement.SpaceBetween
                ) {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Row(
                            Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Text("프리미엄", fontSize = 12.sp, color = c.textSecondary)
                            Box(
                                Modifier.clip(RoundedCornerShape(980.dp))
                                    .background(auroraGradient)
                                    .padding(horizontal = 7.dp, vertical = 3.dp)
                            ) {
                                Text("25% 할인", fontSize = 10.sp, color = Color.White, fontWeight = FontWeight.SemiBold)
                            }
                        }
                        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                Text(
                                    text = buildAnnotatedString {
                                        withStyle(SpanStyle(textDecoration = TextDecoration.LineThrough)) { append("₩2,000") }
                                    },
                                    fontSize = 13.sp,
                                    color = c.textMuted
                                )
                                Text(billingState.plan2Price ?: "₩1,500",
                                    fontSize = 22.sp, fontWeight = FontWeight.SemiBold, color = c.textPrimary)
                            }
                            Text("/ 월", fontSize = 12.sp, color = c.textMuted)
                        }
                        HorizontalDivider(color = c.border, thickness = 0.5.dp)
                        Text("매일 10,000 크레딧", fontSize = 16.sp, fontWeight = FontWeight.SemiBold, color = c.textPrimary)
                    }
                    Box(
                        modifier = Modifier.fillMaxWidth().height(40.dp).padding(top = 4.dp)
                            .clip(RoundedCornerShape(980.dp))
                            .then(
                                if (plan2Enabled) Modifier.background(auroraGradient)
                                else Modifier.background(
                                    Brush.linearGradient(
                                        listOf(Color(0xFF9B59F5).copy(0.38f), Color(0xFF43E97B).copy(0.38f)),
                                        Offset(0f, 0f), Offset(Float.POSITIVE_INFINITY, Float.POSITIVE_INFINITY)
                                    )
                                )
                            )
                            .clickable(enabled = plan2Enabled) {
                                activity?.let { BillingManager.launchSubscriptionPurchase(it, 2) }
                            },
                        contentAlignment = Alignment.Center
                    ) {
                        if (isBusy) androidx.compose.material3.CircularProgressIndicator(
                            Modifier.size(16.dp), color = Color.White, strokeWidth = 2.dp
                        )
                        else Text("구독하기", color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
                    }
                }
            }

            Text(
                "광고비와 구독비는 요약 AI 서비스 비용으로 사용됩니다. 따로 수익은 거의 없어요.",
                fontSize = 12.sp,
                fontWeight = FontWeight.Bold,
                color = c.textSecondary,
                modifier = Modifier.padding(horizontal = 4.dp)
            )
        }
    }
}

@Composable
private fun SubscriptionHeroCardV2() {
    val colors = LocalKColors.current
    val context = LocalContext.current
    val activity = context as? Activity
    val billingState by BillingManager.state.collectAsState()
    val creditState by CreditsManager.state.collectAsState()
    val subscriptionState by TrialManager.state.collectAsState()

    Box(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(24.dp))
            .background(
                Brush.linearGradient(
                    listOf(colors.card, colors.surface)
                )
            )
            .border(1.dp, colors.border, RoundedCornerShape(24.dp))
            .padding(20.dp)
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(
                text = if (subscriptionState.isSubscribed) "구독 중" else "무료 체험 종료",
                color = if (subscriptionState.isSubscribed) colors.success else colors.accent,
                fontSize = 13.sp,
                fontWeight = FontWeight.SemiBold
            )
            Text(
                text = if (subscriptionState.isSubscribed) {
                    "모든 AI 기능 이용 가능"
                } else {
                    "구독 없이도 기본 교정과 번역을 사용할 수 있어요"
                },
                color = colors.textPrimary,
                fontSize = 22.sp,
                fontWeight = FontWeight.Bold
            )

            val expiry = subscriptionState.expiryTimeMillis
            Text(
                text = if (subscriptionState.isSubscribed && expiry != null) {
                    "만료일 ${formatSubscriptionDate(expiry)} · 크레딧 ${creditState.totalCredits}"
                } else {
                    "현재 크레딧 ${creditState.totalCredits}"
                },
                color = colors.textSecondary,
                fontSize = 14.sp
            )

            if (subscriptionState.isSubscribed) {
                Button(
                    onClick = { BillingManager.openSubscriptionManagement(context) },
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(14.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = colors.surfaceAlt)
                ) {
                    Text("구독 관리하기", color = colors.textPrimary)
                }
            } else {
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Button(
                        onClick = {
                            if (activity != null) BillingManager.launchSubscriptionPurchase(activity, plan = 1)
                        },
                        enabled = activity != null && billingState.isProductReady && !billingState.isPurchaseInProgress,
                        modifier = Modifier.weight(1f),
                        shape = RoundedCornerShape(14.dp),
                        colors = ButtonDefaults.buttonColors(containerColor = colors.accent)
                    ) {
                        Text(billingState.productPrice ?: "베이직 구독", color = Color.White, fontWeight = FontWeight.SemiBold)
                    }
                    Button(
                        onClick = {
                            if (activity != null) BillingManager.launchSubscriptionPurchase(activity, plan = 2)
                        },
                        enabled = activity != null && billingState.isPlan2Ready && !billingState.isPurchaseInProgress,
                        modifier = Modifier.weight(1f),
                        shape = RoundedCornerShape(14.dp),
                        colors = ButtonDefaults.buttonColors(containerColor = AccentGreen)
                    ) {
                        Text(billingState.plan2Price ?: "프리미엄 구독", color = Color.White, fontWeight = FontWeight.SemiBold)
                    }
                }
            }
        }
    }
}

@Composable
private fun WebScreen(
    title: String,
    url: String,
    onBack: () -> Unit
) {
    val colors = LocalKColors.current
    var isLoading by remember { mutableStateOf(true) }
    var pageTitle by remember { mutableStateOf(title) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(colors.background)
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .background(colors.topBar)
                .padding(horizontal = 16.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Row(
                modifier = Modifier.clickable(onClick = onBack),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text("<", color = colors.accent, fontSize = 26.sp)
                Text("설정", color = colors.accent, fontSize = 15.sp)
            }
            Box(modifier = Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                Text(pageTitle, color = colors.textPrimary, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
            }
        }

        if (isLoading) {
            LinearProgressIndicator(
                modifier = Modifier.fillMaxWidth(),
                color = colors.accent,
                trackColor = colors.sliderInactive
            )
        }

        AndroidView(
            modifier = Modifier.fillMaxSize(),
            factory = { ctx ->
                WebView(ctx).apply {
                    settings.javaScriptEnabled = true
                    settings.domStorageEnabled = true
                    webViewClient = object : WebViewClient() {
                        override fun onPageFinished(view: WebView?, url: String?) {
                            isLoading = false
                        }
                    }
                    webChromeClient = object : WebChromeClient() {
                        override fun onReceivedTitle(view: WebView?, receivedTitle: String?) {
                            if (!receivedTitle.isNullOrBlank()) pageTitle = receivedTitle
                        }
                    }
                    loadUrl(url)
                }
            },
            update = { view ->
                if (view.url != url) {
                    isLoading = true
                    view.loadUrl(url)
                }
            }
        )
    }
}


@Composable
private fun KSectionLabel(text: String) {
    val colors = LocalKColors.current
    Text(
        text = text,
        color = colors.textSecondary,
        fontSize = 14.sp,
        fontWeight = FontWeight.SemiBold,
        modifier = Modifier.padding(start = 6.dp, bottom = 10.dp)
    )
}

@Composable
private fun KSection(
    content: @Composable ColumnScope.() -> Unit
) {
    val colors = LocalKColors.current
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(18.dp))
            .background(colors.card)
            .border(1.dp, colors.border, RoundedCornerShape(18.dp)),
        content = content
    )
}

@Composable
private fun KDivider() {
    val colors = LocalKColors.current
    HorizontalDivider(
        color = colors.border,
        thickness = 0.8.dp,
        modifier = Modifier.padding(start = 16.dp)
    )
}

@Composable
private fun KRow(
    title: String,
    subtitle: String? = null,
    trailingType: TrailingType = TrailingType.Chevron,
    onClick: (() -> Unit)? = null
) {
    val colors = LocalKColors.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(enabled = onClick != null) { onClick?.invoke() }
            .padding(horizontal = 16.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(title, color = colors.textPrimary, fontSize = 16.sp)
            if (subtitle != null) {
                Spacer(Modifier.height(3.dp))
                Text(subtitle, color = colors.textSecondary, fontSize = 13.sp)
            }
        }
        Spacer(Modifier.width(12.dp))
        when (trailingType) {
            is TrailingType.Chevron -> Text(">", color = colors.textMuted, fontSize = 22.sp)
            is TrailingType.Toggle -> {
                Switch(
                    checked = trailingType.checked,
                    onCheckedChange = trailingType.onChanged,
                    colors = SwitchDefaults.colors(
                        checkedThumbColor = Color.White,
                        checkedTrackColor = colors.switchTrack,
                        uncheckedTrackColor = colors.surfaceAlt,
                        uncheckedThumbColor = Color.White,
                        uncheckedBorderColor = Color.Transparent,
                        checkedBorderColor = Color.Transparent
                    )
                )
            }
            is TrailingType.Checkmark -> {
                if (trailingType.visible) {
                    Text("✓", color = colors.accent, fontSize = 18.sp, fontWeight = FontWeight.Bold)
                }
            }
        }
    }
}

@Composable
private fun KSegmentedControl(
    options: List<String>,
    selected: String,
    onSelect: (String) -> Unit
) {
    val colors = LocalKColors.current
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(colors.surfaceAlt)
            .padding(3.dp),
        horizontalArrangement = Arrangement.spacedBy(3.dp)
    ) {
        options.forEach { option ->
            val isSelected = selected == option
            Box(
                modifier = Modifier
                    .weight(1f)
                    .clip(RoundedCornerShape(11.dp))
                    .background(if (isSelected) colors.card else Color.Transparent)
                    .clickable { onSelect(option) }
                    .padding(vertical = 10.dp),
                contentAlignment = Alignment.Center
            ) {
                Text(
                    option,
                    color = if (isSelected) colors.textPrimary else colors.textSecondary,
                    fontSize = 14.sp,
                    fontWeight = if (isSelected) FontWeight.SemiBold else FontWeight.Normal
                )
            }
        }
    }
}


private fun lightKColors(): KColors = KColors(
    background = Color(0xFFF4F7FB),
    surface = Color(0xFFEAF0F7),
    surfaceAlt = Color(0xFFE3E9F1),
    card = Color(0xFFFFFFFF),
    border = Color(0xFFD8E0EA),
    textPrimary = Color(0xFF1B2430),
    textSecondary = Color(0xFF5E6B7C),
    textMuted = Color(0xFF8C99AA),
    accent = AccentBlue,
    accentSoft = AccentBlue.copy(alpha = 0.12f),
    success = AccentGreen,
    danger = DestructiveRed,
    sliderInactive = Color(0xFFDDE5F0),
    switchTrack = AccentGreen,
    topBar = Color(0xFFF7FAFE)
)

private fun darkKColors(): KColors = KColors(
    background = AppleDark,
    surface = Color(0xFF181B21),
    surfaceAlt = Color(0xFF292D34),
    card = AppleSurface,
    border = Color(0xFF2D3139),
    textPrimary = Color(0xFFF5F7FA),
    textSecondary = Color(0xFF9DA6B3),
    textMuted = Color(0xFF7C8592),
    accent = AccentBlue,
    accentSoft = AccentBlue.copy(alpha = 0.16f),
    success = AccentGreen,
    danger = DestructiveRed,
    sliderInactive = Color(0xFF4B425F),
    switchTrack = AccentGreen,
    topBar = Color(0xFF121419)
)

private fun normalizeDefaultMode(value: String): String = when {
    value.contains("천") -> "천지인"
    else -> "두벌식"
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

private fun normalizeCustomKeyText(value: String): String = when {
    value.contains("밝") -> "밝음"
    else -> "어둠"
}

private fun normalizeCustomChromeTheme(value: String): String = when {
    value.contains("블") -> "블랙"
    else -> "화이트"
}

private fun normalizeAppTheme(value: String): String = when {
    value.contains("라") -> "라이트"
    value.contains("다") -> "다크"
    else -> "시스템"
}

private fun normalizeFormalLevel(value: String): String = when {
    value.contains("격") -> "격식체"
    value.contains("사내") -> "사내 메시지"
    value.contains("고객") -> "고객 안내"
    value.contains("공문") -> "공문 안내"
    value.contains("친근") -> "친근체"
    else -> "존댓말"
}

private fun formatSubscriptionDate(timeMillis: Long): String {
    val formatter = SimpleDateFormat("yyyy.MM.dd", Locale.getDefault())
    return formatter.format(Date(timeMillis))
}

private fun decodeSampledBitmap(path: String, reqWidth: Int, reqHeight: Int): Bitmap? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(path, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null

    var sampleSize = 1
    while (bounds.outWidth / sampleSize > reqWidth * 2 || bounds.outHeight / sampleSize > reqHeight * 2) {
        sampleSize *= 2
    }

    val options = BitmapFactory.Options().apply {
        inSampleSize = sampleSize.coerceAtLeast(1)
        inPreferredConfig = Bitmap.Config.ARGB_8888
    }
    return BitmapFactory.decodeFile(path, options)
}

private fun renderPreviewBackgroundBitmap(
    source: Bitmap,
    width: Int,
    height: Int,
    actualWidth: Int,
    actualHeight: Int,
    mode: String,
    imageScale: Float,
    blurAmount: Float,
    overlay: Float,
    offsetX: Float,
    offsetY: Float
): Bitmap {
    val renderWidth = actualWidth.coerceAtLeast(1)
    val renderHeight = actualHeight.coerceAtLeast(1)
    val base = when {
        mode.contains("타") -> tilePreviewBitmap(source, renderWidth, renderHeight, mirror = false, scale = imageScale)
        mode.contains("바") -> tilePreviewBitmap(source, renderWidth, renderHeight, mirror = true, scale = imageScale)
        kotlin.math.abs(imageScale - 1f) < 0.001f &&
            kotlin.math.abs(offsetX) < 0.001f &&
            kotlin.math.abs(offsetY) < 0.001f ->
            scalePreviewBitmapToSize(source, renderWidth, renderHeight)
        else -> centerCropPreviewBitmap(source, renderWidth, renderHeight, imageScale, offsetX, offsetY)
    }
    val blurred = if (mode.contains("블")) blurPreviewBitmap(base, blurAmount.roundToInt()) else base
    val overlaid = applyPreviewOverlay(blurred, overlay.roundToInt())
    if (renderWidth == width && renderHeight == height) return overlaid
    val scaled = Bitmap.createScaledBitmap(overlaid, width.coerceAtLeast(1), height.coerceAtLeast(1), true)
    if (scaled !== overlaid) overlaid.recycle()
    return scaled
}
private fun centerCropPreviewBitmap(
    source: Bitmap,
    width: Int,
    height: Int,
    scale: Float,
    offsetX: Float,
    offsetY: Float
): Bitmap {
    val srcRatio = source.width.toFloat() / source.height.toFloat()
    val dstRatio = width.toFloat() / height.toFloat()
    if (kotlin.math.abs(srcRatio - dstRatio) < 0.01f &&
        kotlin.math.abs(scale - 1f) < 0.001f &&
        kotlin.math.abs(offsetX) < 0.001f &&
        kotlin.math.abs(offsetY) < 0.001f
    ) {
        return Bitmap.createScaledBitmap(source, width, height, true)
    }
    val (baseWidth, baseHeight) = if (srcRatio > dstRatio) {
        (source.height * dstRatio).toInt() to source.height
    } else {
        source.width to (source.width / dstRatio).toInt()
    }
    val cropWidth = (baseWidth / scale.coerceAtLeast(0.1f)).toInt().coerceIn(1, source.width)
    val cropHeight = (baseHeight / scale.coerceAtLeast(0.1f)).toInt().coerceIn(1, source.height)
    val centerX = (source.width - cropWidth) / 2
    val centerY = (source.height - cropHeight) / 2
    val maxOffsetX = centerX
    val maxOffsetY = centerY
    val x = (centerX + offsetX * maxOffsetX).toInt().coerceIn(0, (source.width - cropWidth).coerceAtLeast(0))
    val y = (centerY + offsetY * maxOffsetY).toInt().coerceIn(0, (source.height - cropHeight).coerceAtLeast(0))
    val cropped = Bitmap.createBitmap(source, x, y, cropWidth, cropHeight)
    val scaled = Bitmap.createScaledBitmap(cropped, width, height, true)
    if (cropped !== source && cropped !== scaled) cropped.recycle()
    return scaled
}

private fun scalePreviewBitmapToSize(source: Bitmap, width: Int, height: Int): Bitmap {
    if (source.width == width && source.height == height) {
        return source.copy(Bitmap.Config.ARGB_8888, false)
    }
    val result = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(result)
    val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
    canvas.drawBitmap(source, null, android.graphics.Rect(0, 0, width, height), paint)
    return result
}

private fun tilePreviewBitmap(
    source: Bitmap,
    width: Int,
    height: Int,
    mirror: Boolean,
    scale: Float
): Bitmap {
    val tileSize = ((minOf(width, height) / 3f) * scale.coerceAtLeast(0.5f)).roundToInt().coerceAtLeast(1)
    val tile = Bitmap.createScaledBitmap(source, tileSize, tileSize, true)
    val result = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(result)
    var row = 0
    var top = 0
    while (top < height) {
        var col = 0
        var left = 0
        while (left < width) {
            val shouldMirror = mirror && (row + col) % 2 == 1
            if (shouldMirror) {
                canvas.save()
                canvas.translate((left + tile.width).toFloat(), top.toFloat())
                canvas.scale(-1f, 1f)
                canvas.drawBitmap(tile, 0f, 0f, null)
                canvas.restore()
            } else {
                canvas.drawBitmap(tile, left.toFloat(), top.toFloat(), null)
            }
            left += tile.width
            col += 1
        }
        top += tile.height
        row += 1
    }
    if (tile !== source) tile.recycle()
    return result
}

private fun blurPreviewBitmap(source: Bitmap, amount: Int): Bitmap {
    val passes = (amount.coerceIn(1, 25) / 5).coerceAtLeast(1)
    var current = source
    repeat(passes) {
        val scaledDown = Bitmap.createScaledBitmap(
            current,
            (current.width / 6).coerceAtLeast(1),
            (current.height / 6).coerceAtLeast(1),
            true
        )
        val scaledUp = Bitmap.createScaledBitmap(scaledDown, current.width, current.height, true)
        if (current !== source) current.recycle()
        scaledDown.recycle()
        current = scaledUp
    }
    return current
}

private fun applyPreviewOverlay(source: Bitmap, overlay: Int): Bitmap {
    val result = Bitmap.createBitmap(source.width, source.height, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(result)
    canvas.drawBitmap(source, 0f, 0f, null)
    val alpha = ((overlay.coerceIn(0, 80) / 100f) * 255).roundToInt()
    if (alpha > 0) {
        val paint = Paint().apply { color = android.graphics.Color.argb(alpha, 0, 0, 0) }
        canvas.drawRect(0f, 0f, source.width.toFloat(), source.height.toFloat(), paint)
    }
    return result
}


