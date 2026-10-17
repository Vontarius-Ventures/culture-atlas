pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
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
include(":core", ":app")
