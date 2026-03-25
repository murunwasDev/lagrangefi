package fi.lagrange.config

import com.sksamuel.hoplite.ConfigLoaderBuilder
import com.sksamuel.hoplite.addResourceOrFileSource

data class AppConfig(
    val host: String = "0.0.0.0",
    val port: Int = 3000,
    val chainServiceUrl: String,
    val database: DatabaseSettings,
    val telegram: TelegramSettings,
    val rebalancer: RebalancerSettings,
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

data class RebalancerSettings(
    val positionTokenId: String,
    val rangePercent: Double = 0.05, // 5% each side
    val pollIntervalSeconds: Long = 60,
    val slippageTolerance: Double = 0.005, // 0.5%
)
