package fi.lagrange

import fi.lagrange.auth.JwtConfig
import fi.lagrange.config.AppConfig
import fi.lagrange.config.DatabaseConfig
import fi.lagrange.plugins.configureRouting
import fi.lagrange.plugins.configureSerialization
import fi.lagrange.plugins.configureStatusPages
import fi.lagrange.services.ChainClient
import fi.lagrange.services.StrategyService
import fi.lagrange.services.TelegramNotifier
import fi.lagrange.services.UserService
import fi.lagrange.services.WalletService
import fi.lagrange.strategy.StrategyScheduler
import io.ktor.server.application.*
import io.ktor.server.engine.*
import io.ktor.server.netty.*

fun main() {
    val config = AppConfig.load()

    DatabaseConfig.init(config.database)

    JwtConfig.init(config.jwt.secret)

    val chainClient = ChainClient(config.chainServiceUrl)
    val telegramNotifier = TelegramNotifier(config.telegram)
    val userService = UserService()
    val walletService = WalletService(config.wallet.encryptionKey)
    val strategyService = StrategyService()
    val scheduler = StrategyScheduler(chainClient, telegramNotifier, walletService, strategyService)

    // Start schedulers for any strategies that were active before restart
    scheduler.loadAndStartAll()

    embeddedServer(Netty, port = config.port, host = config.host) {
        JwtConfig.configureKtor(this)
        configureSerialization()
        configureStatusPages()
        configureRouting(chainClient, userService, walletService, strategyService, scheduler, telegramNotifier)
    }.start(wait = true)
}
