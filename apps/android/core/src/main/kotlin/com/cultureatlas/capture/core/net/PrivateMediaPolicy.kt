package com.cultureatlas.capture.core.net

/**
 * Which image requests carry the installation's bearer token. Only renditions
 * of the owner's own media on this build's API host (`/v2/media/{id}/content/…`)
 * do; Qloo pictures and public `/samples/…` assets never see the token.
 */
object PrivateMediaPolicy {
    private const val PRIVATE_PREFIX = "/v2/media/"

    /** [apiHost] is the build's `atlasApiHost` ("app.cultureatlas.com" or "host:port"). */
    fun needsBearer(scheme: String, host: String, port: Int, path: String, apiHost: String): Boolean {
        if (scheme != "https") return false
        val expectedHost = apiHost.substringBefore(':').lowercase()
        val expectedPort = apiHost.substringAfter(':', "").toIntOrNull() ?: 443
        if (host.lowercase() != expectedHost || port != expectedPort) return false
        if (!path.startsWith(PRIVATE_PREFIX)) return false
        // No traversal out of the media tree.
        return path.split('/').none { it == ".." || it == "." }
    }

    /** Private renditions are never written to the image disk cache (memory only). */
    fun isPrivate(url: String, apiBase: String): Boolean =
        url.startsWith(apiBase.trimEnd('/') + PRIVATE_PREFIX)
}
