import java.io.FileInputStream
import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
}

layout.buildDirectory.set(
    file("${System.getProperty("user.home")}\\.android\\kingboard-build\\app")
)

val keystoreProperties = Properties()
val keystorePropertiesFile = rootProject.file("keystore.properties")
if (keystorePropertiesFile.exists()) {
    FileInputStream(keystorePropertiesFile).use { keystoreProperties.load(it) }
}

android {
    namespace = "com.spellcheck.keyboard"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.spellcheck.keyboard"
        minSdk = 23
        targetSdk = 36
        versionCode = 1
        versionName = "1.0"
        buildConfigField("String", "PLAY_SUBSCRIPTION_PRODUCT_ID", "\"kingboard_monthly_500\"")
        buildConfigField("String", "PLAY_SUBSCRIPTION_PRODUCT_ID_PLAN2", "\"kingboard_monthly_1000\"")

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    signingConfigs {
        if (keystorePropertiesFile.exists()) {
            create("release") {
                storeFile = rootProject.file(keystoreProperties.getProperty("storeFile"))
                storePassword = keystoreProperties.getProperty("storePassword")
                keyAlias = keystoreProperties.getProperty("keyAlias")
                keyPassword = keystoreProperties.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            if (keystorePropertiesFile.exists()) {
                signingConfig = signingConfigs.getByName("release")
            }
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
        debug {
            isMinifyEnabled = false
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }

    testOptions {
        unitTests.all {
            val javaUnitTestClasses = files("${layout.buildDirectory.get().asFile.path}/intermediates/javac/debugUnitTest/compileDebugUnitTestJavaWithJavac/classes")
            val kotlinUnitTestClasses = files("${layout.buildDirectory.get().asFile.path}/intermediates/built_in_kotlinc/debugUnitTest/compileDebugUnitTestKotlin/classes")
            it.testClassesDirs = it.testClassesDirs.plus(javaUnitTestClasses).plus(kotlinUnitTestClasses)
            it.classpath = it.classpath.plus(javaUnitTestClasses).plus(kotlinUnitTestClasses)
        }
    }

}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.graphics)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)
    implementation("androidx.compose.material:material-icons-extended")
    implementation("com.android.billingclient:billing-ktx:8.3.0")
    implementation("com.google.android.gms:play-services-ads:25.1.0")
    testImplementation(libs.junit)
    androidTestImplementation(libs.androidx.junit)
    androidTestImplementation(libs.androidx.espresso.core)
    androidTestImplementation(platform(libs.androidx.compose.bom))
    androidTestImplementation(libs.androidx.compose.ui.test.junit4)
    debugImplementation(libs.androidx.compose.ui.tooling)
    debugImplementation(libs.androidx.compose.ui.test.manifest)
}

tasks.withType<Test>().configureEach {
    systemProperty("file.encoding", "UTF-8")
    jvmArgs("-Dsun.jnu.encoding=UTF-8")
}
