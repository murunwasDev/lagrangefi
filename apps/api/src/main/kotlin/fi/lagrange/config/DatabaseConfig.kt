package fi.lagrange.config

import com.zaxxer.hikari.HikariConfig
import com.zaxxer.hikari.HikariDataSource
import fi.lagrange.model.ChainTransactions
import fi.lagrange.model.RebalanceDetails
import fi.lagrange.model.Strategies
import fi.lagrange.model.StrategyEvents
import fi.lagrange.model.StrategySnapshots
import fi.lagrange.model.StrategyStats
import fi.lagrange.model.Users
import fi.lagrange.model.Wallets
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
            SchemaUtils.createMissingTablesAndColumns(
                Users,
                Wallets,
                Strategies,
                StrategyStats,
                StrategyEvents,
                RebalanceDetails,
                ChainTransactions,
                StrategySnapshots,
            )

            // Index: strategies.user_id — SchemaUtils won't add indexes to existing tables
            exec("CREATE INDEX IF NOT EXISTS strategies_user_id ON strategies(user_id);")

            // Trigger: enforce rebalance_details.strategy_id == strategy_events.strategy_id
            exec("""
                CREATE OR REPLACE FUNCTION check_rebalance_details_strategy_id()
                RETURNS TRIGGER AS ${'$'}${'$'}
                BEGIN
                    IF NEW.strategy_id != (SELECT strategy_id FROM strategy_events WHERE id = NEW.strategy_event_id) THEN
                        RAISE EXCEPTION 'rebalance_details.strategy_id (%) does not match strategy_events.strategy_id for event_id=%',
                            NEW.strategy_id, NEW.strategy_event_id;
                    END IF;
                    RETURN NEW;
                END;
                ${'$'}${'$'} LANGUAGE plpgsql;

                DROP TRIGGER IF EXISTS trg_check_rebalance_details_strategy_id ON rebalance_details;
                CREATE TRIGGER trg_check_rebalance_details_strategy_id
                BEFORE INSERT OR UPDATE ON rebalance_details
                FOR EACH ROW EXECUTE FUNCTION check_rebalance_details_strategy_id();
            """.trimIndent())
        }
    }
}
