package fi.lagrange.services

import fi.lagrange.config.TelegramSettings
import org.slf4j.LoggerFactory
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse

class TelegramNotifier(private val settings: TelegramSettings) {
    private val log = LoggerFactory.getLogger(TelegramNotifier::class.java)
    private val http = HttpClient.newHttpClient()

    fun sendAlert(message: String) {
        if (settings.botToken.isBlank()) {
            log.warn("Telegram not configured, skipping alert: $message")
            return
        }

        try {
            val url = "https://api.telegram.org/bot${settings.botToken}/sendMessage"
            val body = """{"chat_id":"${settings.chatId}","text":"[lagrangefi] $message","parse_mode":"HTML"}"""
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
