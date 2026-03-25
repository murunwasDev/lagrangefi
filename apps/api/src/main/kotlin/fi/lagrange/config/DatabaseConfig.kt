package fi.lagrange.config

import com.zaxxer.hikari.HikariConfig
import com.zaxxer.hikari.HikariDataSource
import fi.lagrange.model.Positions
import fi.lagrange.model.RebalanceEvents
import fi.lagrange.model.StrategyState
import org.jetbrains.exposed.sql.Database
import org.jetbrains.exposed.sql.SchemaUtils
import org.jetbrains.exposed.sql.transactions.transaction

object DatabaseConfig {
    fun init(settings: DatabaseSettings) {
        val hikari = HikariDataSource(HikariConfig().apply {
            jdbcUrl = settings.url
            username = settings.user
            password = settings.password
            maximumPoolSize = settings.poolSize
            driverClassName = "org.postgresql.Driver"
        })

        Database.connect(hikari)

        transaction {
            SchemaUtils.createMissingTablesAndColumns(Positions, RebalanceEvents, StrategyState)
        }
    }
}
