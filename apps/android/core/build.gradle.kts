// Pure Kotlin/JVM: protocol models and every policy that does not need
// Android APIs, so `./gradlew :core:test` runs on any JVM (no Android SDK).
plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlin.serialization)
}

kotlin {
    jvmToolchain(17)
}

dependencies {
    api(libs.kotlinx.serialization.json)
    api(libs.kotlinx.coroutines.core)
    api(libs.okhttp)
    testImplementation(libs.junit.jupiter)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.okhttp.mockwebserver)
}

tasks.test {
    useJUnitPlatform()
    // Shared fixtures consumed by the iOS tests and the server-side TS test too.
    systemProperty(
        "atlas.fixtures",
        rootProject.projectDir.resolve("../../fixtures/native-contract").canonicalPath,
    )
}
