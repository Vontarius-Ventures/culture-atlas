pluginManagement {
    repositories {
        // Maven Central / Plugin Portal first so :core:test does not need Google Maven.
        mavenCentral()
        gradlePluginPortal()
        google()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        mavenCentral()
        google()
        // Meta Wearables Device Access Toolkit (experimental flavor only).
        // GitHub Packages requires a token with read:packages; CI provides
        // GITHUB_ACTOR / GITHUB_TOKEN. Never commit a token.
        maven {
            name = "MetaWearablesDAT"
            url = uri("https://maven.pkg.github.com/facebook/meta-wearables-dat-android")
            credentials {
                username = providers.environmentVariable("GITHUB_ACTOR").orNull ?: ""
                password = providers.environmentVariable("GITHUB_TOKEN").orNull ?: ""
            }
            content { includeGroup("com.meta.wearable") }
        }
    }
}

rootProject.name = "culture-atlas-android"
include(":core")

fun androidSdkPresent(): Boolean {
    val fromEnv = sequenceOf("ANDROID_HOME", "ANDROID_SDK_ROOT")
        .mapNotNull { System.getenv(it)?.trim()?.takeIf(String::isNotEmpty) }
        .firstOrNull()
    if (fromEnv != null) return true
    val local = file("local.properties")
    if (!local.exists()) return false
    return local.readLines().any { line ->
        line.startsWith("sdk.dir=") && line.substringAfter("sdk.dir=").isNotBlank()
    }
}

// :app needs the Android SDK and Google Maven (AGP, AndroidX, Firebase).
// Without them, :core:test still runs on a plain JVM.
if (androidSdkPresent()) {
    include(":app")
}
