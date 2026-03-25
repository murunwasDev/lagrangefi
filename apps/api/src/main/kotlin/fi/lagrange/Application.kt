package fi.lagrange

import fi.lagrange.config.AppConfig
import fi.lagrange.config.DatabaseConfig
import fi.lagrange.plugins.configureRouting
import fi.lagrange.plugins.configureSerialization
import fi.lagrange.plugins.configureStatusPages
import fi.lagrange.services.ChainClient
import fi.lagrange.services.TelegramNotifier
import fi.lagrange.strategy.UniswapStrategy
import io.ktor.server.application.*
import io.ktor.server.engine.*
import io.ktor.server.netty.*

fun main() {
    val config = AppConfig.load()

    DatabaseConfig.init(config.database)

    val chainClient = ChainClient(config.chainServiceUrl)
    val telegramNotifier = TelegramNotifier(config.telegram)
    val strategy = UniswapStrategy(chainClient, telegramNotifier, config)

    strategy.startScheduler()

    embeddedServer(Netty, port = config.port, host = config.host) {
        configureSerialization()
        configureStatusPages()
        configureRouting(chainClient, config, strategy)
    }.start(wait = true)
}
