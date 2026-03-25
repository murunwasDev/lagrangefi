package fi.lagrange.strategy

import fi.lagrange.config.AppConfig
import fi.lagrange.services.ChainClient
import fi.lagrange.services.TelegramNotifier
import kotlinx.coroutines.runBlocking
import org.slf4j.LoggerFactory
import java.util.Timer
import java.util.UUID
import kotlin.concurrent.fixedRateTimer
import kotlin.math.pow

class UniswapStrategy(
    private val chainClient: ChainClient,
    private val telegram: TelegramNotifier,
    private val config: AppConfig,
) : ProtocolStrategy {

    private val log = LoggerFactory.getLogger(UniswapStrategy::class.java)
    private var timer: Timer? = null

    override fun startScheduler() {
        val intervalMs = config.rebalancer.pollIntervalSeconds * 1000
        timer = fixedRateTimer("rebalancer", daemon = true, period = intervalMs) {
            runBlocking {
                try {
                    execute()
                } catch (e: Exception) {
                    log.error("Rebalance cycle failed", e)
                    telegram.sendAlert("Rebalancer error: ${e.message}")
                }
            }
        }
        log.info("Rebalancer scheduler started, polling every ${config.rebalancer.pollIntervalSeconds}s")
    }

    override fun stopScheduler() {
        timer?.cancel()
    }

    override suspend fun execute() {
        val tokenId = config.rebalancer.positionTokenId
        log.debug("Checking position tokenId=$tokenId")

        val position = chainClient.getPosition(tokenId)
        val poolState = chainClient.getPoolState(tokenId)

        val currentTick = poolState.tick
        val inRange = currentTick >= position.tickLower && currentTick < position.tickUpper

        if (inRange) {
            log.debug("Position in range (tick=$currentTick, range=[${position.tickLower}, ${position.tickUpper}])")
            return
        }

        log.info("Position OUT OF RANGE — tick=$currentTick, range=[${position.tickLower}, ${position.tickUpper}]. Triggering rebalance.")
        telegram.sendAlert("Position out of range! tick=$currentTick range=[${position.tickLower}, ${position.tickUpper}]. Rebalancing...")

        val (newTickLower, newTickUpper) = calculateNewRange(poolState.tick, position.fee)

        val idempotencyKey = UUID.randomUUID().toString()
        val result = chainClient.rebalance(
            idempotencyKey = idempotencyKey,
            tokenId = tokenId,
            newTickLower = newTickLower,
            newTickUpper = newTickUpper,
            slippageTolerance = config.rebalancer.slippageTolerance,
        )

        if (result.success) {
            log.info("Rebalance succeeded. New tokenId=${result.newTokenId}, txs=${result.txHashes}")
            telegram.sendAlert("Rebalance successful! New position tokenId=${result.newTokenId}")

            // Update tracked tokenId in DB to the new position
            result.newTokenId?.let { newId ->
                // TODO: persist updated tokenId
            }
        } else {
            log.error("Rebalance failed: ${result.error}")
            telegram.sendAlert("Rebalance FAILED: ${result.error}")
        }
    }

    // Calculate new tick range centered on current price with +/- rangePercent
    // Uses the relationship: price = 1.0001^tick
    private fun calculateNewRange(currentTick: Int, fee: Int): Pair<Int, Int> {
        val tickSpacing = feeToTickSpacing(fee)
        val rangePercent = config.rebalancer.rangePercent

        // Convert percent to tick delta: tickDelta = log(1 + rangePercent) / log(1.0001)
        val tickDelta = (Math.log(1.0 + rangePercent) / Math.log(1.0001)).toInt()

        val rawLower = currentTick - tickDelta
        val rawUpper = currentTick + tickDelta

        // Snap to tick spacing
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
