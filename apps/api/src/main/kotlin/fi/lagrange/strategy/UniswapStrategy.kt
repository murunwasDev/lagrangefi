package fi.lagrange.strategy

import fi.lagrange.services.ChainClient
import fi.lagrange.services.PoolStateResponse
import fi.lagrange.services.PositionNotFoundException
import fi.lagrange.services.RebalanceResponse
import fi.lagrange.services.StrategyRecord
import fi.lagrange.services.StrategyService
import fi.lagrange.services.SwapCostResponse
import fi.lagrange.services.TelegramNotifier
import io.ktor.client.plugins.HttpRequestTimeoutException
import org.slf4j.LoggerFactory
import java.math.BigDecimal
import java.math.BigInteger
import java.math.RoundingMode
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
     * Executes one rebalance check/cycle for a single strategy.
     * Returns true if the tick is complete (in range, succeeded, or timed out),
     * false if the rebalance failed and the caller should retry immediately.
     */
    suspend fun execute(strategy: StrategyRecord, walletPhrase: String): Boolean {
        log.debug("Checking strategy=${strategy.id} user=${strategy.userId} tokenId=${strategy.currentTokenId}")
        val poolState = fetchStateOrSkip(strategy) ?: return true

        val (newTickLower, newTickUpper) = calcTickRange(poolState.tick, strategy.fee, strategy.rangePercent)
        val idempotencyKey = UUID.randomUUID().toString()
        val ethPrice       = BigDecimal(poolState.price).setScale(8, RoundingMode.HALF_UP)
        val eventId        = strategyService.insertPendingRebalanceEvent(strategy.id, idempotencyKey)

        try {
            val result = chainClient.rebalance(
                idempotencyKey    = idempotencyKey,
                tokenId           = strategy.currentTokenId,
                newTickLower      = newTickLower,
                newTickUpper      = newTickUpper,
                slippageTolerance = strategy.slippageTolerance,
                walletPrivateKey  = walletPhrase,
                pendingToken0     = strategy.pendingToken0,
                pendingToken1     = strategy.pendingToken1,
                token0            = strategy.token0,
                token1            = strategy.token1,
                fee               = strategy.fee,
            )
            return if (result.success) {
                onRebalanceSuccess(strategy, result, eventId, ethPrice, newTickLower, newTickUpper)
                true
            } else {
                onRebalanceFailed(strategy, result, eventId, ethPrice)
                false
            }
        } catch (e: Exception) {
            onRebalanceException(strategy, eventId, e)
            return true  // timed out: chain may still be executing, do not retry
        }
    }

    /**
     * Fetch position state and decide whether this tick should trigger a rebalance.
     * Returns the pool state to rebalance against, or null to skip this tick.
     * Handles the recovery path (burned NFT) transparently.
     */
    private suspend fun fetchStateOrSkip(strategy: StrategyRecord): PoolStateResponse? {
        if (strategyService.hasRebalanceInProgress(strategy.id)) {
            log.warn("Strategy=${strategy.id} has a rebalance in progress — skipping tick")
            return null
        }
        return try {
            val position  = chainClient.getPosition(strategy.currentTokenId)
            val poolState = chainClient.getPoolState(strategy.currentTokenId)
            val inRange   = poolState.tick >= position.tickLower && poolState.tick < position.tickUpper
            strategyService.recordPollTick(strategy.id, inRange)
            if (inRange) {
                log.debug("Strategy=${strategy.id} in range (tick=${poolState.tick} range=[${position.tickLower},${position.tickUpper}])")
                null
            } else {
                log.info("Strategy=${strategy.id} OUT OF RANGE — tick=${poolState.tick} range=[${position.tickLower},${position.tickUpper}]. Rebalancing.")
                telegram.sendAlert("[${strategy.name}] Out of range! tick=${poolState.tick} range=[${position.tickLower},${position.tickUpper}]. Rebalancing...")
                poolState
            }
        } catch (e: PositionNotFoundException) {
            // Position NFT was burned in a previous failed rebalance. Re-check for a concurrent
            // in-progress event before starting recovery — a timeout recovery may have been
            // inserted after our first check.
            if (strategyService.hasRebalanceInProgress(strategy.id)) {
                log.warn("Strategy=${strategy.id} already has a pending/in-progress event after recovery detection — skipping tick")
                return null
            }
            log.warn("Strategy=${strategy.id} position ${strategy.currentTokenId} no longer exists — triggering recovery rebalance")
            telegram.sendAlert("[${strategy.name}] Recovering lost position — re-minting with wallet balance...")
            chainClient.getPoolByPair(strategy.token0, strategy.token1, strategy.fee)
        }
    }

    private fun onRebalanceSuccess(
        strategy: StrategyRecord,
        result: RebalanceResponse,
        eventId: Int,
        ethPrice: BigDecimal,
        newTickLower: Int,
        newTickUpper: Int,
    ) {
        val recoveryNote = if (result.isRecovery == true) " (recovery)" else ""
        log.info("Strategy=${strategy.id} rebalance succeeded${recoveryNote}. newTokenId=${result.newTokenId}")
        telegram.sendAlert("[${strategy.name}] Rebalance successful${recoveryNote}! New tokenId=${result.newTokenId}")

        val fees0        = result.feesCollected?.amount0 ?: "0"
        val fees1        = result.feesCollected?.amount1 ?: "0"
        val totalGasWei  = result.gasUsedWei?.toLongOrNull() ?: 0L
        val txRecords    = buildTxRecords(result.txDetails, result.txHashes, result.txSteps, totalGasWei)

        strategyService.recordRebalanceEvent(
            strategy            = strategy,
            eventId             = eventId,
            fees0               = fees0,
            fees1               = fees1,
            totalGasWei         = totalGasWei,
            ethPriceUsd         = ethPrice,
            txRecords           = txRecords,
            oldNftTokenId       = strategy.currentTokenId,
            newNftTokenId       = result.newTokenId,
            newTickLower        = newTickLower,
            newTickUpper        = newTickUpper,
            positionToken0Start = result.positionToken0Start ?: "0",
            positionToken1Start = result.positionToken1Start ?: "0",
            positionToken0End   = result.positionToken0End   ?: "0",
            positionToken1End   = result.positionToken1End   ?: "0",
            swapCost            = result.swapCost?.let {
                SwapCostResponse(it.amountIn, it.amountOut, it.fairAmountOut, it.direction)
            },
            priceAtDecision     = ethPrice,
            priceAtEnd          = result.priceAtEnd?.let { BigDecimal(it) },
        )

        result.newTokenId?.let { strategyService.updateTokenId(strategy.id, it) }
        strategyService.updatePending(strategy.id, result.leftoverToken0 ?: "0", result.leftoverToken1 ?: "0")

        // Snapshot position value after rebalance
        val dec0   = strategy.token0Decimals
        val dec1   = strategy.token1Decimals
        val t0End  = result.positionToken0End ?: "0"
        val t1End  = result.positionToken1End ?: "0"
        val snapValueUsd = toUsd(t0End, dec0, ethPrice, dec0 == 18)
            .add(toUsd(t1End, dec1, ethPrice, dec0 != 18))
            .setScale(2, RoundingMode.HALF_UP)
        strategyService.recordStrategySnapshot(strategy.id, t0End, t1End, snapValueUsd, ethPrice)
    }

    private fun onRebalanceFailed(
        strategy: StrategyRecord,
        result: RebalanceResponse,
        eventId: Int,
        ethPrice: BigDecimal,
    ) {
        log.error("Strategy=${strategy.id} rebalance failed: ${result.error}")
        telegram.sendAlert("[${strategy.name}] Rebalance FAILED: ${result.error}")
        strategyService.markRebalanceEventFailed(eventId, result.error)

        val gasLong   = result.gasUsedWei?.toLongOrNull() ?: 0L
        val txRecords = buildTxRecords(result.txDetails, result.txHashes, result.txSteps, gasLong)
        if (txRecords.isNotEmpty()) {
            strategyService.recordFailedRebalanceOnChainWork(
                strategy    = strategy,
                eventId     = eventId,
                totalGasWei = gasLong.takeIf { it > 0L } ?: txRecords.sumOf { it.gasUsedWei },
                ethPriceUsd = ethPrice,
                txRecords   = txRecords,
                fees0       = result.feesCollected?.amount0 ?: "0",
                fees1       = result.feesCollected?.amount1 ?: "0",
            )
        }

        // Persist recovered tokens so the next rebalance re-invests them
        val r0 = (result.recoveredToken0 ?: "0").toBigIntegerOrNull() ?: BigInteger.ZERO
        val r1 = (result.recoveredToken1 ?: "0").toBigIntegerOrNull() ?: BigInteger.ZERO
        if (r0 > BigInteger.ZERO || r1 > BigInteger.ZERO) {
            val newPending0 = ((strategy.pendingToken0.toBigIntegerOrNull() ?: BigInteger.ZERO) + r0).toString()
            val newPending1 = ((strategy.pendingToken1.toBigIntegerOrNull() ?: BigInteger.ZERO) + r1).toString()
            strategyService.updatePending(strategy.id, newPending0, newPending1)
            log.info("Strategy=${strategy.id} recovered tokens saved as pending: token0=$newPending0 token1=$newPending1")
        }
    }

    private fun onRebalanceException(strategy: StrategyRecord, eventId: Int, e: Exception) {
        if (e is HttpRequestTimeoutException) {
            // Chain service may still be executing — mark in_progress so subsequent ticks skip polling.
            log.error("Strategy=${strategy.id} rebalance timed out — chain service may still be running", e)
            telegram.sendAlert("[${strategy.name}] Rebalance timed out — still executing on-chain. Manual check required.")
            strategyService.markRebalanceEventInProgress(eventId, e.message)
        } else {
            log.error("Strategy=${strategy.id} rebalance threw an exception", e)
            telegram.sendAlert("[${strategy.name}] Rebalance ERROR: ${e.message}")
            strategyService.markRebalanceEventFailed(eventId, e.message)
            throw e
        }
    }
}
