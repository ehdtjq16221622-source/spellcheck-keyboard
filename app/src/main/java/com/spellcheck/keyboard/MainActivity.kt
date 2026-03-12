package com.spellcheck.keyboard

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.spellcheck.keyboard.ui.theme.맞춤법키보드Theme

// iOS 26 Liquid Glass 색상 팔레트
private val GlassWhite       = Color(0xF2FFFFFF)
private val GlassBg          = Color(0xFFF2F2F7)   // iOS systemGroupedBackground
private val GlassCard        = Color(0xFFFAFAFC)    // 카드 배경 (약간 유리느낌)
private val AccentGreen      = Color(0xFF34C759)    // iOS system green
private val AccentBlue       = Color(0xFF007AFF)    // iOS system blue
private val LabelPrimary     = Color(0xFF000000)
private val LabelSecondary   = Color(0xFF6C6C70)
private val LabelTertiary    = Color(0xFF8E8E93)
private val Separator        = Color(0xFFD1D1D6)
private val DestructiveRed   = Color(0xFFFF3B30)

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        SettingsManager.init(this)
        TrialManager.init(this)
        setContent {
            맞춤법키보드Theme {
                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = GlassBg
                ) {
                    SettingsScreen(
                        onOpenKeyboardSettings = {
                            startActivity(Intent(Settings.ACTION_INPUT_METHOD_SETTINGS))
                        },
                        onOpenPrivacyPolicy = {
                            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://ehdtjq16221622.github.io/spellcheck-keyboard/privacy")))
                        }
                    )
                }
            }
        }
    }
}

@Composable
fun SettingsScreen(onOpenKeyboardSettings: () -> Unit, onOpenPrivacyPolicy: () -> Unit) {
    var vibration    by remember { mutableStateOf(SettingsManager.vibrationEnabled) }
    var doubleSpace  by remember { mutableStateOf(SettingsManager.doubleSpacePeriod) }
    var keyPopup     by remember { mutableStateOf(SettingsManager.keyPopup) }
    var formalDefault by remember { mutableStateOf(SettingsManager.formalDefault) }
    var defaultMode  by remember { mutableStateOf(SettingsManager.defaultMode) }
    var includePunct by remember { mutableStateOf(SettingsManager.includePunct) }
    var includeDialect by remember { mutableStateOf(SettingsManager.includeDialect) }
    var formalLevel  by remember { mutableStateOf(SettingsManager.formalLevel) }
    var formalIncludePunct by remember { mutableStateOf(SettingsManager.formalIncludePunct) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 20.dp)
    ) {
        Spacer(Modifier.height(60.dp))

        // ── 대형 타이틀 (iOS 26 Large Title)
        Text(
            "맞춤법 키보드",
            fontSize = 34.sp,
            fontWeight = FontWeight.Bold,
            color = LabelPrimary,
            lineHeight = 41.sp
        )
        Text(
            "AI 한국어 맞춤법 교정",
            fontSize = 15.sp,
            color = LabelSecondary,
            modifier = Modifier.padding(top = 4.dp)
        )

        Spacer(Modifier.height(28.dp))

        // ── 구독 현황 카드 (Liquid Glass Hero)
        SubscriptionHeroCard()

        Spacer(Modifier.height(28.dp))

        // ── 키보드 활성화
        IosSection(label = "시작하기") {
            IosRow(
                title = "키보드 설정 열기",
                subtitle = "활성화 후 기본 키보드로 설정하세요",
                trailingType = TrailingType.Chevron,
                accentColor = AccentBlue,
                onClick = onOpenKeyboardSettings
            )
        }
        SetupStepsCard()

        Spacer(Modifier.height(28.dp))

        // ── 키보드 설정
        IosSection(label = "키보드") {
            // 기본 입력 모드 세그먼트
            Column(Modifier.padding(horizontal = 16.dp, vertical = 14.dp)) {
                Text("기본 입력 모드", fontSize = 13.sp, color = LabelSecondary)
                Spacer(Modifier.height(10.dp))
                IosSegmentedControl(
                    options = listOf("두벌식", "천지인"),
                    selected = defaultMode,
                    onSelect = { defaultMode = it; SettingsManager.defaultMode = it }
                )
            }
            IosDivider()
            IosRow(
                title = "키 누를 때 진동",
                trailingType = TrailingType.Toggle(vibration) {
                    vibration = it; SettingsManager.vibrationEnabled = it
                }
            )
            IosDivider()
            IosRow(
                title = "키 누를 때 크게 보이기",
                trailingType = TrailingType.Toggle(keyPopup) {
                    keyPopup = it; SettingsManager.keyPopup = it
                }
            )
            IosDivider()
            IosRow(
                title = "스페이스 두 번 → 마침표",
                trailingType = TrailingType.Toggle(doubleSpace) {
                    doubleSpace = it; SettingsManager.doubleSpacePeriod = it
                }
            )
            IosDivider()
            IosRow(
                title = "회사말투 기본 ON",
                trailingType = TrailingType.Toggle(formalDefault) {
                    formalDefault = it; SettingsManager.formalDefault = it
                }
            )
        }

        Spacer(Modifier.height(28.dp))

        // ── 교정 설정
        IosSection(label = "맞춤법 교정") {
            IosRow(
                title = "구두점 포함 교정",
                subtitle = "쉼표·마침표 위치 교정",
                trailingType = TrailingType.Toggle(includePunct) {
                    includePunct = it; SettingsManager.includePunct = it
                }
            )
            IosDivider()
            IosRow(
                title = "사투리 표준어 교정",
                trailingType = TrailingType.Toggle(includeDialect) {
                    includeDialect = it; SettingsManager.includeDialect = it
                }
            )
        }

        Spacer(Modifier.height(28.dp))

        // ── 회사말투 설정
        IosSection(label = "회사말투 방식") {
            listOf(
                "적당한 존댓말"  to "-요/-세요 체",
                "엄격 격식체"   to "-습니다/-입니다 체",
                "스마트 교정"   to "AI가 비즈니스 격식체로 재작성"
            ).forEachIndexed { i, (level, desc) ->
                if (i > 0) IosDivider()
                val selected = formalLevel == level
                IosRow(
                    title = level,
                    subtitle = desc,
                    trailingType = TrailingType.Checkmark(selected),
                    onClick = { formalLevel = level; SettingsManager.formalLevel = level }
                )
            }
            IosDivider()
            IosRow(
                title = "회사말투 시 구두점 교정",
                trailingType = TrailingType.Toggle(formalIncludePunct) {
                    formalIncludePunct = it; SettingsManager.formalIncludePunct = it
                }
            )
        }

        Spacer(Modifier.height(28.dp))

        // ── 정보
        IosSection(label = "정보") {
            IosRow(
                title = "개인정보처리방침",
                trailingType = TrailingType.Chevron,
                onClick = onOpenPrivacyPolicy
            )
        }

        Spacer(Modifier.height(36.dp))

        Text(
            "버전 1.0",
            fontSize = 13.sp,
            color = LabelTertiary,
            modifier = Modifier.fillMaxWidth(),
            textAlign = TextAlign.Center
        )
        Text(
            "입력하신 텍스트는 맞춤법 교정을 위해 AI 서버로 전송되며 저장되지 않습니다",
            fontSize = 11.sp,
            color = LabelTertiary,
            modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
            textAlign = TextAlign.Center
        )
        Spacer(Modifier.height(32.dp))
    }
}

// ── 구독 히어로 카드 (Liquid Glass)
@Composable
fun SubscriptionHeroCard() {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .shadow(elevation = 2.dp, shape = RoundedCornerShape(20.dp), clip = false)
            .clip(RoundedCornerShape(20.dp))
            .background(
                Brush.linearGradient(
                    colors = listOf(Color(0xFFE8F5E9), Color(0xFFF1F8E9))
                )
            )
            .padding(20.dp)
    ) {
        when {
            TrialManager.isSubscribed -> {
                Column {
                    Text("구독 중", fontSize = 13.sp, color = AccentGreen, fontWeight = FontWeight.SemiBold)
                    Spacer(Modifier.height(4.dp))
                    Text("모든 AI 기능 이용 가능", fontSize = 20.sp, fontWeight = FontWeight.Bold, color = LabelPrimary)
                }
            }
            TrialManager.isInTrial -> {
                Column {
                    Text("무료 체험", fontSize = 13.sp, color = AccentBlue, fontWeight = FontWeight.SemiBold)
                    Spacer(Modifier.height(4.dp))
                    Text("${TrialManager.remainingTrialDays}일 남음", fontSize = 20.sp, fontWeight = FontWeight.Bold, color = LabelPrimary)
                    Spacer(Modifier.height(14.dp))
                    Button(
                        onClick = { /* TODO: Google Play 구독 연결 */ },
                        modifier = Modifier.fillMaxWidth().height(46.dp),
                        shape = RoundedCornerShape(12.dp),
                        colors = ButtonDefaults.buttonColors(containerColor = AccentGreen)
                    ) {
                        Text("월 1,000원으로 구독하기", color = Color.White, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
                    }
                }
            }
            else -> {
                Column {
                    Text("체험 종료", fontSize = 13.sp, color = DestructiveRed, fontWeight = FontWeight.SemiBold)
                    Spacer(Modifier.height(4.dp))
                    Text("구독이 필요합니다", fontSize = 20.sp, fontWeight = FontWeight.Bold, color = LabelPrimary)
                    Spacer(Modifier.height(14.dp))
                    Button(
                        onClick = { /* TODO: Google Play 구독 연결 */ },
                        modifier = Modifier.fillMaxWidth().height(46.dp),
                        shape = RoundedCornerShape(12.dp),
                        colors = ButtonDefaults.buttonColors(containerColor = AccentGreen)
                    ) {
                        Text("월 1,000원으로 구독하기", color = Color.White, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
                    }
                }
            }
        }
    }
}

// ── 활성화 단계 카드
@Composable
fun SetupStepsCard() {
    Spacer(Modifier.height(10.dp))
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .shadow(elevation = 1.dp, shape = RoundedCornerShape(16.dp), clip = false)
            .clip(RoundedCornerShape(16.dp))
            .background(GlassCard)
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp)
    ) {
        listOf(
            "1" to "아래 버튼을 눌러 키보드 설정으로 이동",
            "2" to "'맞춤법 키보드' 항목을 찾아 토글 ON",
            "3" to "'기본 키보드 변경'에서 맞춤법 키보드 선택"
        ).forEach { (num, text) ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    modifier = Modifier
                        .size(26.dp)
                        .background(AccentBlue.copy(alpha = 0.12f), CircleShape),
                    contentAlignment = Alignment.Center
                ) {
                    Text(num, fontSize = 12.sp, fontWeight = FontWeight.Bold, color = AccentBlue)
                }
                Spacer(Modifier.width(12.dp))
                Text(text, fontSize = 14.sp, color = LabelPrimary)
            }
        }
    }
}

// ── iOS 섹션 컨테이너
@Composable
fun IosSection(label: String, content: @Composable ColumnScope.() -> Unit) {
    Text(
        label.uppercase(),
        fontSize = 13.sp,
        fontWeight = FontWeight.Medium,
        color = LabelSecondary,
        modifier = Modifier.padding(start = 6.dp, bottom = 8.dp)
    )
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .shadow(elevation = 1.dp, shape = RoundedCornerShape(16.dp), clip = false)
            .clip(RoundedCornerShape(16.dp))
            .background(GlassCard),
        content = content
    )
}

// ── 구분선
@Composable
fun IosDivider() {
    HorizontalDivider(
        modifier = Modifier.padding(start = 16.dp),
        color = Separator,
        thickness = 0.5.dp
    )
}

// ── 트레일링 타입
sealed class TrailingType {
    object Chevron : TrailingType()
    data class Toggle(val checked: Boolean, val onChanged: (Boolean) -> Unit) : TrailingType()
    data class Checkmark(val visible: Boolean) : TrailingType()
}

// ── iOS 스타일 행
@Composable
fun IosRow(
    title: String,
    subtitle: String? = null,
    trailingType: TrailingType = TrailingType.Chevron,
    accentColor: Color = AccentBlue,
    onClick: (() -> Unit)? = null
) {
    val modifier = if (onClick != null) {
        Modifier
            .fillMaxWidth()
            .clickable { onClick() }
            .padding(horizontal = 16.dp, vertical = 12.dp)
    } else {
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 12.dp)
    }

    Row(
        modifier = modifier,
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween
    ) {
        Column(modifier = Modifier.weight(1f).padding(end = 8.dp)) {
            Text(
                title,
                fontSize = 16.sp,
                color = LabelPrimary
            )
            if (subtitle != null) {
                Text(
                    subtitle,
                    fontSize = 13.sp,
                    color = LabelSecondary,
                    modifier = Modifier.padding(top = 2.dp)
                )
            }
        }
        when (trailingType) {
            is TrailingType.Chevron -> {
                Text("›", fontSize = 20.sp, color = LabelTertiary)
            }
            is TrailingType.Toggle -> {
                Switch(
                    checked = trailingType.checked,
                    onCheckedChange = trailingType.onChanged,
                    colors = SwitchDefaults.colors(
                        checkedThumbColor = Color.White,
                        checkedTrackColor = AccentGreen
                    )
                )
            }
            is TrailingType.Checkmark -> {
                if (trailingType.visible) {
                    Text("✓", fontSize = 16.sp, color = AccentBlue, fontWeight = FontWeight.Bold)
                }
            }
        }
    }

    // 클릭 가능한 행은 Surface로 감싸기
    if (onClick != null) {
        // Surface clickable 처리는 IosSection 밖에서도 가능하나
        // 여기선 Row 자체에 clickable modifier 적용이 더 간단
    }
}

// ── iOS 세그먼트 컨트롤
@Composable
fun IosSegmentedControl(
    options: List<String>,
    selected: String,
    onSelect: (String) -> Unit
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(10.dp))
            .background(Color(0xFFE5E5EA))
            .padding(2.dp),
        horizontalArrangement = Arrangement.spacedBy(2.dp)
    ) {
        options.forEach { option ->
            val isSelected = selected == option
            Box(
                modifier = Modifier
                    .weight(1f)
                    .clip(RoundedCornerShape(8.dp))
                    .background(if (isSelected) Color.White else Color.Transparent)
                    .padding(vertical = 8.dp),
                contentAlignment = Alignment.Center
            ) {
                Text(
                    option,
                    fontSize = 14.sp,
                    fontWeight = if (isSelected) FontWeight.SemiBold else FontWeight.Normal,
                    color = if (isSelected) LabelPrimary else LabelSecondary
                )
            }
        }
    }
}
