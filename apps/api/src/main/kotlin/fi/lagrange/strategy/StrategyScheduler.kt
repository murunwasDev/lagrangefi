package fi.lagrange.strategy

import fi.lagrange.model.Strategies
import fi.lagrange.services.ChainClient
import fi.lagrange.services.StrategyRecord
import fi.lagrange.services.StrategyService
import fi.lagrange.services.TelegramNotifier
import fi.lagrange.services.WalletService
import kotlinx.coroutines.runBlocking
import org.jetbrains.exposed.sql.and
import org.jetbrains.exposed.sql.selectAll
import org.jetbrains.exposed.sql.transactions.transaction
import org.slf4j.LoggerFactory
import java.util.Timer
import java.util.concurrent.ConcurrentHashMap
import kotlin.concurrent.fixedRateTimer

/**
 * Manages per-strategy schedulers for all users.
 * Each active strategy gets its own fixed-rate timer.
 */
class StrategyScheduler(
    private val chainClient: ChainClient,
    private val telegram: TelegramNotifier,
    private val walletService: WalletService,
    private val strategyService: StrategyService,
) {
    private val log = LoggerFactory.getLogger(StrategyScheduler::class.java)
    private val jobs = ConcurrentHashMap<Int, Timer>() // strategyId → Timer
    private val executor = UniswapStrategy(chainClient, telegram, strategyService)

    /** Called at startup — load all active strategies from DB and start their timers */
    fun loadAndStartAll() {
        val strategies = transaction {
            Strategies.selectAll()
                .where { Strategies.status eq "active" }
                .map { row ->
                    StrategyRecord(
                        id = row[Strategies.id],
                        userId = row[Strategies.userId],
                        name = row[Strategies.name],
                        currentTokenId = row[Strategies.currentTokenId],
                        token0 = row[Strategies.token0],
                        token1 = row[Strategies.token1],
                        fee = row[Strategies.fee],
                        rangePercent = row[Strategies.rangePercent],
                        slippageTolerance = row[Strategies.slippageTolerance],
                        pollIntervalSeconds = row[Strategies.pollIntervalSeconds],
                        status = row[Strategies.status],
                        createdAt = row[Strategies.createdAt].toString(),
                        stoppedAt = row[Strategies.stoppedAt]?.toString(),
                    )
                }
        }
        strategies.forEach { start(it) }
        log.info("Loaded ${strategies.size} active strategies")
    }

    /** Start a timer for a strategy. No-op if already running. */
    fun start(strategy: StrategyRecord) {
        if (jobs.containsKey(strategy.id)) return
        val intervalMs = strategy.pollIntervalSeconds * 1_000L
        val timer = fixedRateTimer("strategy-${strategy.id}", daemon = true, period = intervalMs) {
            runBlocking {
                try {
                    executeOnce(strategy.id)
                } catch (e: Exception) {
                    log.error("Unhandled error in strategy ${strategy.id}", e)
                    telegram.sendAlert("Unhandled error in strategy '${strategy.name}': ${e.message}")
                }
            }
        }
        jobs[strategy.id] = timer
        log.info("Started scheduler for strategy=${strategy.id} user=${strategy.userId} interval=${strategy.pollIntervalSeconds}s")
    }

    /** Cancel and remove a strategy's timer */
    fun stop(strategyId: Int) {
        jobs.remove(strategyId)?.cancel()
        log.info("Stopped scheduler for strategy=$strategyId")
    }

    private suspend fun executeOnce(strategyId: Int) {
        // Re-load strategy state from DB each tick (picks up tokenId changes and status updates)
        val strategy = transaction {
            Strategies.selectAll()
                .where { (Strategies.id eq strategyId) and (Strategies.status eq "active") }
                .firstOrNull()?.let { row ->
                    StrategyRecord(
                        id = row[Strategies.id],
                        userId = row[Strategies.userId],
                        name = row[Strategies.name],
                        currentTokenId = row[Strategies.currentTokenId],
                        token0 = row[Strategies.token0],
                        token1 = row[Strategies.token1],
                        fee = row[Strategies.fee],
                        rangePercent = row[Strategies.rangePercent],
                        slippageTolerance = row[Strategies.slippageTolerance],
                        pollIntervalSeconds = row[Strategies.pollIntervalSeconds],
                        status = row[Strategies.status],
                        createdAt = row[Strategies.createdAt].toString(),
                        stoppedAt = row[Strategies.stoppedAt]?.toString(),
                    )
                }
        }

        if (strategy == null) {
            // Strategy was paused/stopped externally — cancel the timer
            stop(strategyId)
            return
        }

        val walletPhrase = walletService.getDecryptedPhrase(strategy.userId)
        if (walletPhrase == null) {
            log.warn("No wallet configured for user=${strategy.userId} (strategy=$strategyId). Skipping tick.")
            return
        }

        executor.execute(strategy, walletPhrase)
    }
}
