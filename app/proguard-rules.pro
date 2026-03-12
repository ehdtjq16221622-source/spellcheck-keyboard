# 맞춤법 키보드 ProGuard 규칙

# 스택 트레이스 디버깅을 위한 줄 번호 유지
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile

# Kotlin 관련
-keep class kotlin.** { *; }
-keep class kotlinx.** { *; }
-dontwarn kotlin.**

# Android IME (키보드 서비스) 유지 - 난독화하면 키보드가 안 뜸
-keep class com.spellcheck.keyboard.KeyboardService { *; }
-keep class com.spellcheck.keyboard.MainActivity { *; }

# JSON 파싱 (org.json)
-keep class org.json.** { *; }

# Google Play Billing
-keep class com.android.billingclient.** { *; }
-dontwarn com.android.billingclient.**

# Compose 관련
-keep class androidx.compose.** { *; }
-dontwarn androidx.compose.**

# 앱 전체 클래스 유지 (소규모 앱이라 전체 유지)
-keep class com.spellcheck.keyboard.** { *; }
