package fi.lagrange.strategy

import fi.lagrange.services.ChainClient
import fi.lagrange.services.StrategyRecord
import fi.lagrange.services.StrategyRepository
import fi.lagrange.services.StrategyService
import fi.lagrange.services.TelegramNotifier
import fi.lagrange.services.WalletService
import kotlinx.coroutines.runBlocking
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
    private val strategyRepo: StrategyRepository,
) {
    private val log      = LoggerFactory.getLogger(StrategyScheduler::class.java)
    private val jobs     = ConcurrentHashMap<Int, Timer>()
    private val executor = UniswapStrategy(chainClient, telegram, strategyService)

    companion object {
        private const val MAX_REBALANCE_ATTEMPTS = 10
    }

    /** Called at startup — load all active strategies from DB and start their timers. */
    fun loadAndStartAll() {
        val strategies = strategyRepo.findAllActive()
        strategies.forEach { start(it) }
        log.info("Loaded ${strategies.size} active strategies")
    }

    /** Start a timer for a strategy. No-op if already running. */
    fun start(strategy: StrategyRecord) {
        if (jobs.containsKey(strategy.id)) return
        val timer = fixedRateTimer(
            name   = "strategy-${strategy.id}",
            daemon = true,
            period = strategy.pollIntervalSeconds * 1_000L,
        ) {
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

    /** Cancel and remove a strategy's timer. */
    fun stop(strategyId: Int) {
        jobs.remove(strategyId)?.cancel()
        log.info("Stopped scheduler for strategy=$strategyId")
    }

    private suspend fun executeOnce(strategyId: Int) {
        for (attempt in 1..MAX_REBALANCE_ATTEMPTS) {
            val strategy = strategyRepo.findActiveById(strategyId)
            if (strategy == null) {
                stop(strategyId)
                return
            }
            val walletPhrase = walletService.getDecryptedPhrase(strategy.userId)
            if (walletPhrase == null) {
                log.warn("No wallet configured for user=${strategy.userId} (strategy=$strategyId). Skipping tick.")
                return
            }
            val done = executor.execute(strategy, walletPhrase)
            if (done) return
            if (attempt == MAX_REBALANCE_ATTEMPTS) {
                log.warn("Strategy=$strategyId: $MAX_REBALANCE_ATTEMPTS rebalance attempts all failed this tick — giving up until next poll")
                telegram.sendAlert(
                    "[${strategy.name}] (id=${strategy.id}) Rebalance failed $MAX_REBALANCE_ATTEMPTS times in a row this tick. " +
                    "Position #${strategy.currentTokenId} may be out of range. Retrying at next poll interval."
                )
            }
        }
    }
}
