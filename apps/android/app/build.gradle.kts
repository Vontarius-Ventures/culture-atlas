plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

// Included from settings.gradle.kts only when an Android SDK is present.

val atlasApiHost: String = providers.gradleProperty("atlasApiHost").get()
// Ready-notice push (FCM). Supplied by CI for release builds; empty keeps push
// off (notices then appear only while the app is open). No google-services.json
// is committed: Firebase is initialized from these values at runtime.
fun pushProperty(name: String): String = providers.gradleProperty(name).orElse("").get()

android {
    namespace = "com.cultureatlas.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.cultureatlas.app"
        minSdk = 29
        targetSdk = 35
        versionCode = 1
        versionName = "1.0.0"
        buildConfigField("String", "ATLAS_API_HOST", "\"$atlasApiHost\"")
        buildConfigField("String", "ATLAS_PUSH_ENVIRONMENT", "\"${pushProperty("atlasPushEnvironment").ifEmpty { "production" }}\"")
        buildConfigField("String", "FCM_PROJECT_ID", "\"${pushProperty("atlasFcmProjectId")}\"")
        buildConfigField("String", "FCM_APP_ID", "\"${pushProperty("atlasFcmAppId")}\"")
        buildConfigField("String", "FCM_API_KEY", "\"${pushProperty("atlasFcmApiKey")}\"")
        buildConfigField("String", "FCM_SENDER_ID", "\"${pushProperty("atlasFcmSenderId")}\"")
    }

    // Two independent variants (PRODUCT-AND-ARCHITECTURE "Experimental release policy"):
    //   store         public camera/upload build; never contains the Meta SDK.
    //   experimental  contains the Meta Wearables Device Access Toolkit; only for
    //                 permitted channels (internal testing / Meta release channel).
    flavorDimensions += "distribution"
    productFlavors {
        create("store") {
            dimension = "distribution"
            buildConfigField("boolean", "META_DAT", "false")
        }
        create("experimental") {
            dimension = "distribution"
            applicationIdSuffix = ".experimental"
            versionNameSuffix = "-experimental"
            buildConfigField("boolean", "META_DAT", "true")
            // Injected by CI for the release channel; empty = Meta Developer Mode.
            manifestPlaceholders["metaAppId"] = providers.environmentVariable("META_APP_ID").orElse("").get()
            manifestPlaceholders["metaClientToken"] = providers.environmentVariable("META_CLIENT_TOKEN").orElse("").get()
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

dependencies {
    implementation(project(":core"))
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.process)
    implementation(libs.androidx.camera.core)
    implementation(libs.androidx.camera.camera2)
    implementation(libs.androidx.camera.lifecycle)
    implementation(libs.androidx.camera.video)
    implementation(libs.androidx.camera.view)
    implementation(libs.androidx.work.runtime)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.firebase.messaging)

    "experimentalImplementation"(libs.meta.wearables.core)
    "experimentalImplementation"(libs.meta.wearables.camera)
}
