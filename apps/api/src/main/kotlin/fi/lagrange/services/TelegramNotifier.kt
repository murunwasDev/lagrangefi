package fi.lagrange.services

import fi.lagrange.config.TelegramSettings
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.slf4j.LoggerFactory
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse

@Serializable
private data class TelegramMessage(
    @SerialName("chat_id") val chatId: String,
    val text: String,
    @SerialName("parse_mode") val parseMode: String,
)

class TelegramNotifier(private val settings: TelegramSettings) {
    private val log = LoggerFactory.getLogger(TelegramNotifier::class.java)
    private val http = HttpClient.newHttpClient()
    private val json = Json { encodeDefaults = true }

    fun sendAlert(message: String) {
        if (settings.botToken.isBlank()) {
            log.warn("Telegram not configured, skipping alert: $message")
            return
        }

        try {
            val url = "https://api.telegram.org/bot${settings.botToken}/sendMessage"
            val body = json.encodeToString(TelegramMessage(
                chatId = settings.chatId,
                text = "[lagrangefi] $message",
                parseMode = "HTML",
            ))
            val request = HttpRequest.newBuilder()
                .uri(URI.create(url))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(body))
                .build()
            http.sendAsync(request, HttpResponse.BodyHandlers.ofString())
            log.debug("Telegram alert sent: $message")
        } catch (e: Exception) {
            log.error("Failed to send Telegram alert", e)
        }
    }
}
