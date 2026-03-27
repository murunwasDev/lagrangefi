package fi.lagrange.strategy

import fi.lagrange.model.RebalanceEvents
import fi.lagrange.services.ChainClient
import fi.lagrange.services.StrategyRecord
import fi.lagrange.services.StrategyService
import fi.lagrange.services.TelegramNotifier
import kotlinx.datetime.Clock
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.jetbrains.exposed.sql.insert
import org.jetbrains.exposed.sql.transactions.transaction
import org.jetbrains.exposed.sql.update
import org.slf4j.LoggerFactory
import java.util.UUID

/**
 * Executes one rebalance check/cycle for a single strategy.
 * No scheduler logic here — that lives in StrategyScheduler.
 */
class UniswapStrategy(
    private val chainClient: ChainClient,
    private val telegram: TelegramNotifier,
    private val strategyService: StrategyService,
) {
    private val log = LoggerFactory.getLogger(UniswapStrategy::class.java)

    /**
     * Run one poll cycle for the given strategy using the provided wallet phrase.
     * - Updates time-in-range stats every tick
     * - Triggers rebalance only when out of range
     */
    suspend fun execute(strategy: StrategyRecord, walletPhrase: String) {
        val tokenId = strategy.currentTokenId
        log.debug("Checking strategy=${strategy.id} user=${strategy.userId} tokenId=$tokenId")

        val position = chainClient.getPosition(tokenId)
        val poolState = chainClient.getPoolState(tokenId)

        val currentTick = poolState.tick
        val inRange = currentTick >= position.tickLower && currentTick < position.tickUpper

        // Record tick for time-in-range tracking
        strategyService.recordPollTick(strategy.id, inRange)

        if (inRange) {
            log.debug("Strategy=${strategy.id} in range (tick=$currentTick range=[${position.tickLower},${position.tickUpper}])")
            return
        }

        log.info("Strategy=${strategy.id} OUT OF RANGE — tick=$currentTick range=[${position.tickLower},${position.tickUpper}]. Rebalancing.")
        telegram.sendAlert("[${strategy.name}] Out of range! tick=$currentTick range=[${position.tickLower},${position.tickUpper}]. Rebalancing...")

        val (newTickLower, newTickUpper) = calculateNewRange(currentTick, position.fee, strategy.rangePercent)
        val idempotencyKey = UUID.randomUUID().toString()

        // Insert pending event
        val eventId = transaction {
            RebalanceEvents.insert {
                it[strategyId] = strategy.id
                it[RebalanceEvents.tokenId] = tokenId
                it[RebalanceEvents.idempotencyKey] = idempotencyKey
                it[status] = "pending"
                it[RebalanceEvents.newTickLower] = newTickLower
                it[RebalanceEvents.newTickUpper] = newTickUpper
                it[triggeredAt] = Clock.System.now()
            } get RebalanceEvents.id
        }

        try {
            val result = chainClient.rebalance(
                idempotencyKey = idempotencyKey,
                tokenId = tokenId,
                newTickLower = newTickLower,
                newTickUpper = newTickUpper,
                slippageTolerance = strategy.slippageTolerance,
                walletPrivateKey = walletPhrase,
            )

            if (result.success) {
                log.info("Strategy=${strategy.id} rebalance succeeded. newTokenId=${result.newTokenId}")
                telegram.sendAlert("[${strategy.name}] Rebalance successful! New tokenId=${result.newTokenId}")

                val fees0 = result.feesCollected?.amount0 ?: "0"
                val fees1 = result.feesCollected?.amount1 ?: "0"
                val gasWei = result.gasUsedWei ?: "0"

                transaction {
                    RebalanceEvents.update({ RebalanceEvents.id eq eventId }) {
                        it[status] = "success"
                        it[newTokenId] = result.newTokenId
                        it[txHashes] = Json.encodeToString(result.txHashes)
                        it[feesCollectedToken0] = fees0
                        it[feesCollectedToken1] = fees1
                        it[gasCostWei] = gasWei
                        it[positionToken0Start] = result.positionToken0Start
                        it[positionToken1Start] = result.positionToken1Start
                        it[positionToken0End] = result.positionToken0End
                        it[positionToken1End] = result.positionToken1End
                        it[ethPriceUsd] = poolState.price
                        it[completedAt] = Clock.System.now()
                    }
                }

                result.newTokenId?.let { newId ->
                    strategyService.updateTokenId(strategy.id, newId)
                }
                strategyService.recordRebalanceSuccess(strategy.id, fees0, fees1, gasWei, poolState.price.toDoubleOrNull() ?: 0.0)
            } else {
                log.error("Strategy=${strategy.id} rebalance failed: ${result.error}")
                telegram.sendAlert("[${strategy.name}] Rebalance FAILED: ${result.error}")

                transaction {
                    RebalanceEvents.update({ RebalanceEvents.id eq eventId }) {
                        it[status] = "failed"
                        it[errorMessage] = result.error
                        it[txHashes] = result.txHashes.takeIf { it.isNotEmpty() }?.let { Json.encodeToString(it) }
                        it[completedAt] = Clock.System.now()
                    }
                }
            }
        } catch (e: Exception) {
            log.error("Strategy=${strategy.id} rebalance threw an exception", e)
            telegram.sendAlert("[${strategy.name}] Rebalance ERROR: ${e.message}")

            transaction {
                RebalanceEvents.update({ RebalanceEvents.id eq eventId }) {
                    it[status] = "failed"
                    it[errorMessage] = e.message
                    it[completedAt] = Clock.System.now()
                }
            }
            throw e
        }
    }

    // Calculate new tick range centered on current price ± rangePercent
    private fun calculateNewRange(currentTick: Int, fee: Int, rangePercent: Double): Pair<Int, Int> {
        val tickSpacing = feeToTickSpacing(fee)
        val tickDelta = (Math.log(1.0 + rangePercent) / Math.log(1.0001)).toInt()
        val rawLower = currentTick - tickDelta
        val rawUpper = currentTick + tickDelta
        val tickLower = (rawLower / tickSpacing) * tickSpacing
        val tickUpper = (rawUpper / tickSpacing) * tickSpacing
        return Pair(tickLower, tickUpper)
    }

    private fun feeToTickSpacing(fee: Int): Int = when (fee) {
        100 -> 1
        500 -> 10
        3000 -> 60
        10000 -> 200
        else -> 60
    }
}
