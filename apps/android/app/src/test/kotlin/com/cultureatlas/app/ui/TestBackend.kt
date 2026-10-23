package com.cultureatlas.app.ui

import com.cultureatlas.capture.core.contract.NativeSessionTokens
import com.cultureatlas.capture.core.identity.SessionManager
import com.cultureatlas.capture.core.identity.StoredSession
import com.cultureatlas.capture.core.identity.TokenVault
import com.cultureatlas.capture.core.net.AtlasApi
import com.cultureatlas.capture.core.net.AtlasHttp
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import java.util.concurrent.CopyOnWriteArrayList

/** An in-memory signed-in session and a scripted API, so screens render real wire data on the JVM. */
class TestBackend : AutoCloseable {
    val server = MockWebServer()
    val requests = CopyOnWriteArrayList<String>()
    private val routes = LinkedHashMap<Regex, (RecordedRequest) -> MockResponse>()

    private val vault = object : TokenVault {
        private var session: StoredSession? = StoredSession(
            NativeSessionTokens(
                sessionId = "s", installationId = "i", accountId = ACCOUNT,
                accessToken = "cna_test", refreshToken = "r",
                accessExpiresAt = "2099-01-01T00:00:00Z", refreshExpiresAt = "2099-01-01T00:00:00Z",
            ),
        )
        override fun read() = session
        override fun write(session: StoredSession) {
            this.session = session
        }
        override fun clear() {
            session = null
        }
    }

    val api: AtlasApi
    val sessions: SessionManager

    init {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val line = "${request.method} ${request.path}"
                requests += line
                val path = request.path!!.substringBefore('?')
                val handler = routes.entries.firstOrNull { it.key.matches("${request.method} $path") }?.value
                return handler?.invoke(request) ?: MockResponse().setResponseCode(404).setBody("""{"code":"not_found","message":"no route"}""")
            }
        }
        server.start()
        val http = AtlasHttp(server.url("/"))
        sessions = SessionManager(http, vault)
        api = AtlasApi(http, sessions)
    }

    fun on(methodAndPath: String, status: Int = 200, body: (RecordedRequest) -> String) {
        routes[Regex(methodAndPath)] = { MockResponse().setResponseCode(status).setHeader("content-type", "application/json").setBody(body(it)) }
    }

    override fun close() = server.shutdown()

    companion object {
        const val ACCOUNT = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d"
        const val MEDIA = "6f1a2b3c-4d5e-4f60-8a7b-9c0d1e2f3a4b"
        const val ANALYSIS = "7f1a2b3c-4d5e-4f60-8a7b-9c0d1e2f3a4b"
        const val CAPTURE = "8f1a2b3c-4d5e-4f60-8a7b-9c0d1e2f3a4b"

        /** Typographic-poster cards (no image): never a stand-in picture. */
        fun card(id: String, title: String, category: String = "wear", subtitle: String? = null, kind: String = "qloo_entity") =
            """{"id":"$id","kind":"$kind","category":"$category","title":"$title"${subtitle?.let { ",\"subtitle\":\"$it\"" } ?: ""},
               "is_example":false,"saved":false,"evidence_available":true}"""

        val FEED_CARDS = listOf(
            card("c1", "Herman Miller", "wear", "Furniture maker"),
            card("c2", "Kind of Blue", "play", "Miles Davis"),
            card("c3", "In the Mood for Love", "watch", "Wong Kar-wai"),
            card("c4", "Noma", "eat", "Copenhagen"),
            card("c5", "Dieter Rams", "wear", "Industrial designer"),
            card("c6", "Blue Train", "play", "John Coltrane"),
        )

        fun discoveries(cards: List<String> = FEED_CARDS) =
            """{"items":[${cards.joinToString(",")}],"next_cursor":null,"feed_id":"f","feed_revision":1,
               "is_example_feed":false,"available_categories":["wear","play","watch","eat"]}"""

        fun item(id: String, title: String) = """{"item":${card(id, title, "wear", "Furniture maker")},
            "description":"An American furniture company known for modern office and home pieces.",
            "detail":"Founded 1905 · Zeeland, Michigan","reason":"Because you picked Eames.",
            "references":[
              {"id":"r1","name":"Eames Lounge Chair","type":"work","relation":"depicted","qualified":false,"has_page":true},
              {"id":"r2","name":"Bauhaus","type":"style","relation":"resembles","qualified":true,"has_page":false}],
            "related":[${card("s1", "Vitra", "wear", "Design house")},${card("s2", "Knoll", "wear", "Furniture")},${card("s3", "Muji", "wear", "Retailer")}],
            "related_state":"ready","collection_ids":[]}"""
    }
}
