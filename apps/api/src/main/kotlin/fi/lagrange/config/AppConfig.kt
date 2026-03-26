package fi.lagrange.config

import com.sksamuel.hoplite.ConfigLoaderBuilder
import com.sksamuel.hoplite.addResourceOrFileSource

data class AppConfig(
    val host: String = "0.0.0.0",
    val port: Int = 3000,
    val chainServiceUrl: String,
    val database: DatabaseSettings,
    val telegram: TelegramSettings,
    val jwt: JwtSettings,
    val wallet: WalletSettings,
) {
    companion object {
        fun load(): AppConfig =
            ConfigLoaderBuilder.default()
                .addResourceOrFileSource("/application.yaml")
                .build()
                .loadConfigOrThrow()
    }
}

data class DatabaseSettings(
    val url: String,
    val user: String,
    val password: String,
    val poolSize: Int = 10,
)

data class TelegramSettings(
    val botToken: String,
    val chatId: String,
)

data class JwtSettings(
    val secret: String,
)

data class WalletSettings(
    /** Base64-encoded 32-byte AES-256 key for encrypting wallet phrases at rest */
    val encryptionKey: String,
)
