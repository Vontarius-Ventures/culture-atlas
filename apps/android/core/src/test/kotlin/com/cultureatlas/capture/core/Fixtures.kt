package com.cultureatlas.capture.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import java.io.File

/** Reads fixtures/native-contract (path passed by Gradle as `atlas.fixtures`). */
object Fixtures {
    private val root: File = File(
        System.getProperty("atlas.fixtures") ?: error("atlas.fixtures system property is not set"),
    )

    fun json(name: String): JsonObject = Json.parseToJsonElement(File(root, name).readText()).jsonObject

    fun message(key: String): JsonElement =
        json("messages.json")["messages"]!!.jsonObject[key]?.jsonObject?.get("body") ?: error("missing message $key")

    fun messageText(key: String): String = message(key).toString()
}

val JsonElement?.str: String? get() = (this as? JsonPrimitive)?.takeIf { it !is JsonNull }?.contentOrNull
val JsonElement?.int: Int? get() = (this as? JsonPrimitive)?.intOrNull
val JsonElement?.long: Long? get() = (this as? JsonPrimitive)?.longOrNull
val JsonElement?.bool: Boolean? get() = (this as? JsonPrimitive)?.booleanOrNull
val JsonElement.obj: JsonObject get() = jsonObject
val JsonElement.arr get() = jsonArray
val JsonElement.prim get() = jsonPrimitive
