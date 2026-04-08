package fi.lagrange.strategy

import fi.lagrange.model.StrategyEvents
import fi.lagrange.services.ChainClient
import fi.lagrange.services.PoolStateResponse
import fi.lagrange.services.PositionNotFoundException
import fi.lagrange.services.StrategyRecord
import fi.lagrange.services.StrategyService
import fi.lagrange.services.TelegramNotifier
import fi.lagrange.services.TxRecord
import io.ktor.client.plugins.HttpRequestTimeoutException
import kotlinx.datetime.Clock
import org.jetbrains.exposed.sql.and
import org.jetbrains.exposed.sql.insert
import org.jetbrains.exposed.sql.selectAll
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
     * - Triggers immediate recovery rebalance if the position NFT no longer exists on-chain
     */
    suspend fun execute(strategy: StrategyRecord, walletPhrase: String) {
        val tokenId = strategy.currentTokenId
        log.debug("Checking strategy=${strategy.id} user=${strategy.userId} tokenId=$tokenId")

        // Skip position polling while a rebalance is still in-flight (timed out but possibly still
        // executing on-chain). Prevents "Invalid token ID" errors on a burned position.
        val hasInProgress = transaction {
            StrategyEvents.selectAll()
                .where {
                    (StrategyEvents.strategyId eq strategy.id) and
                    (StrategyEvents.status inList listOf("pending", "in_progress"))
                }
                .any()
        }
        if (hasInProgress) {
            log.warn("Strategy=${strategy.id} has a rebalance in progress — skipping tick")
            return
        }

        // Get position and pool state. If the NFT no longer exists (burned in a prior failed
        // rebalance), skip the in-range check and trigger a recovery rebalance immediately.
        var poolState: PoolStateResponse
        try {
            val position = chainClient.getPosition(tokenId)
            poolState = chainClient.getPoolState(tokenId)

            val currentTick = poolState.tick
            val inRange = currentTick >= position.tickLower && currentTick < position.tickUpper

            strategyService.recordPollTick(strategy.id, inRange)

            if (inRange) {
                log.debug("Strategy=${strategy.id} in range (tick=$currentTick range=[${position.tickLower},${position.tickUpper}])")
                return
            }
            log.info("Strategy=${strategy.id} OUT OF RANGE — tick=$currentTick range=[${position.tickLower},${position.tickUpper}]. Rebalancing.")
            telegram.sendAlert("[${strategy.name}] Out of range! tick=$currentTick range=[${position.tickLower},${position.tickUpper}]. Rebalancing...")
        } catch (e: PositionNotFoundException) {
            // Position NFT was burned in a previous failed rebalance. Tokens are in the wallet
            // (saved as pending). Skip in-range check and trigger a recovery rebalance now.
            log.warn("Strategy=${strategy.id} position $tokenId no longer exists — triggering recovery rebalance")
            telegram.sendAlert("[${strategy.name}] Recovering lost position — re-minting with wallet balance...")
            poolState = chainClient.getPoolByPair(strategy.token0, strategy.token1, strategy.fee)
        }

        val hasPending = transaction {
            StrategyEvents.selectAll()
                .where {
                    (StrategyEvents.strategyId eq strategy.id) and
                    (StrategyEvents.status inList listOf("pending", "in_progress"))
                }
                .any()
        }
        if (hasPending) {
            log.warn("Strategy=${strategy.id} already has a pending/in-progress rebalance event — skipping tick to avoid duplicate execution")
            return
        }

        val (newTickLower, newTickUpper) = calculateNewRange(poolState.tick, strategy.fee, strategy.rangePercent)
        val idempotencyKey = UUID.randomUUID().toString()
        val ethPrice = java.math.BigDecimal(poolState.price).setScale(8, java.math.RoundingMode.HALF_UP)

        val eventId = transaction {
            StrategyEvents.insert {
                it[strategyId] = strategy.id
                it[action] = "REBALANCE"
                it[StrategyEvents.idempotencyKey] = idempotencyKey
                it[status] = "pending"
                it[triggeredAt] = Clock.System.now()
            }[StrategyEvents.id]
        }

        try {
            val result = chainClient.rebalance(
                idempotencyKey = idempotencyKey,
                tokenId = tokenId,
                newTickLower = newTickLower,
                newTickUpper = newTickUpper,
                slippageTolerance = strategy.slippageTolerance,
                walletPrivateKey = walletPhrase,
                pendingToken0 = strategy.pendingToken0,
                pendingToken1 = strategy.pendingToken1,
                token0 = strategy.token0,
                token1 = strategy.token1,
                fee = strategy.fee,
            )

            if (result.success) {
                val recoveryNote = if (result.isRecovery == true) " (recovery)" else ""
                log.info("Strategy=${strategy.id} rebalance succeeded${recoveryNote}. newTokenId=${result.newTokenId}")
                telegram.sendAlert("[${strategy.name}] Rebalance successful${recoveryNote}! New tokenId=${result.newTokenId}")

                val fees0 = result.feesCollected?.amount0 ?: "0"
                val fees1 = result.feesCollected?.amount1 ?: "0"
                val totalGasWei = result.gasUsedWei?.toLongOrNull() ?: 0L

                val txRecords = buildTxRecords(result.txDetails, result.txHashes, result.txSteps, totalGasWei)

                strategyService.recordRebalanceEvent(
                    strategyId = strategy.id,
                    eventId = eventId,
                    fees0 = fees0,
                    fees1 = fees1,
                    totalGasWei = totalGasWei,
                    ethPriceUsd = ethPrice,
                    txRecords = txRecords,
                    oldNftTokenId = tokenId,
                    newNftTokenId = result.newTokenId,
                    newTickLower = newTickLower,
                    newTickUpper = newTickUpper,
                    positionToken0Start = result.positionToken0Start ?: "0",
                    positionToken1Start = result.positionToken1Start ?: "0",
                    positionToken0End = result.positionToken0End ?: "0",
                    positionToken1End = result.positionToken1End ?: "0",
                    swapCost = result.swapCost?.let {
                        fi.lagrange.services.SwapCostResponse(
                            amountIn      = it.amountIn,
                            amountOut     = it.amountOut,
                            fairAmountOut = it.fairAmountOut,
                            direction     = it.direction,
                        )
                    },
                    priceAtDecision = ethPrice,
                    priceAtEnd = result.priceAtEnd?.let { java.math.BigDecimal(it) },
                )

                result.newTokenId?.let { newId ->
                    strategyService.updateTokenId(strategy.id, newId)
                }

                // Persist leftover tokens for the next rebalance cycle
                strategyService.updatePending(
                    strategyId = strategy.id,
                    pending0 = result.leftoverToken0 ?: "0",
                    pending1 = result.leftoverToken1 ?: "0",
                )

                // Snapshot position after successful rebalance
                val t0End = result.positionToken0End ?: "0"
                val t1End = result.positionToken1End ?: "0"
                val dec0 = strategy.token0Decimals
                val dec1 = strategy.token1Decimals
                val t0Human = (t0End.toBigIntegerOrNull() ?: java.math.BigInteger.ZERO)
                    .toBigDecimal().divide(java.math.BigDecimal.TEN.pow(dec0), dec0, java.math.RoundingMode.HALF_UP)
                val t1Human = (t1End.toBigIntegerOrNull() ?: java.math.BigInteger.ZERO)
                    .toBigDecimal().divide(java.math.BigDecimal.TEN.pow(dec1), dec1, java.math.RoundingMode.HALF_UP)
                val snapValueUsd = if (dec0 == 18)
                    t0Human.multiply(ethPrice).add(t1Human).setScale(2, java.math.RoundingMode.HALF_UP)
                else
                    t1Human.multiply(ethPrice).add(t0Human).setScale(2, java.math.RoundingMode.HALF_UP)
                strategyService.recordStrategySnapshot(strategy.id, t0End, t1End, snapValueUsd, ethPrice)

            } else {
                log.error("Strategy=${strategy.id} rebalance failed: ${result.error}")
                telegram.sendAlert("[${strategy.name}] Rebalance FAILED: ${result.error}")
                transaction {
                    StrategyEvents.update({ StrategyEvents.id eq eventId }) {
                        it[status] = "failed"
                        it[errorMessage] = result.error
                        it[completedAt] = Clock.System.now()
                    }
                }

                // If on-chain transactions ran before the failure (e.g. decreaseLiquidity + collect
                // completed but burn was rejected), record their gas and any collected fees so that
                // strategy_stats and chain_transactions stay accurate.
                val txRecords = buildTxRecords(result.txDetails, result.txHashes, result.txSteps, result.gasUsedWei?.toLongOrNull() ?: 0L)
                if (txRecords.isNotEmpty()) {
                    val fees0 = result.feesCollected?.amount0 ?: "0"
                    val fees1 = result.feesCollected?.amount1 ?: "0"
                    val totalGasWei = result.gasUsedWei?.toLongOrNull()
                        ?: txRecords.sumOf { it.gasUsedWei }
                    strategyService.recordFailedRebalanceOnChainWork(
                        strategyId = strategy.id,
                        eventId = eventId,
                        totalGasWei = totalGasWei,
                        ethPriceUsd = ethPrice,
                        txRecords = txRecords,
                        fees0 = fees0,
                        fees1 = fees1,
                    )
                }

                // Persist recovered token amounts as pending so the next rebalance re-invests them.
                // These are the principal + fees that were collected to the wallet before the failure.
                val recovered0 = result.recoveredToken0 ?: "0"
                val recovered1 = result.recoveredToken1 ?: "0"
                val r0 = recovered0.toBigIntegerOrNull() ?: java.math.BigInteger.ZERO
                val r1 = recovered1.toBigIntegerOrNull() ?: java.math.BigInteger.ZERO
                if (r0 > java.math.BigInteger.ZERO || r1 > java.math.BigInteger.ZERO) {
                    val newPending0 = ((strategy.pendingToken0.toBigIntegerOrNull() ?: java.math.BigInteger.ZERO) + r0).toString()
                    val newPending1 = ((strategy.pendingToken1.toBigIntegerOrNull() ?: java.math.BigInteger.ZERO) + r1).toString()
                    strategyService.updatePending(strategy.id, newPending0, newPending1)
                    log.info("Strategy=${strategy.id} recovered tokens saved as pending: token0=$newPending0 token1=$newPending1")
                }
            }
        } catch (e: Exception) {
            val isTimeout = e is HttpRequestTimeoutException
            if (isTimeout) {
                // Rebalance timed out: the chain service may still be executing on-chain.
                // Mark as in_progress so subsequent ticks skip position polling until resolved.
                log.error("Strategy=${strategy.id} rebalance timed out — chain service may still be running", e)
                telegram.sendAlert("[${strategy.name}] Rebalance timed out — still executing on-chain. Manual check required.")
                transaction {
                    StrategyEvents.update({ StrategyEvents.id eq eventId }) {
                        it[status] = "in_progress"
                        it[errorMessage] = e.message
                    }
                }
            } else {
                log.error("Strategy=${strategy.id} rebalance threw an exception", e)
                telegram.sendAlert("[${strategy.name}] Rebalance ERROR: ${e.message}")
                transaction {
                    StrategyEvents.update({ StrategyEvents.id eq eventId }) {
                        it[status] = "failed"
                        it[errorMessage] = e.message
                        it[completedAt] = Clock.System.now()
                    }
                }
                throw e
            }
        }
    }

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

/**
 * Build TxRecord list from chain response.
 * Prefers txDetails if chain service provides them; falls back to parallel txHashes + txSteps arrays.
 * When falling back, total gas is attributed to the last tx; all others get 0.
 */
internal fun buildTxRecords(
    txDetails: List<TxRecord>?,
    txHashes: List<String>,
    txSteps: List<String>?,
    totalGasWei: Long,
): List<TxRecord> {
    if (txDetails != null) return txDetails
    val steps = txSteps ?: txHashes.map { "UNKNOWN" }
    return txHashes.zip(steps).mapIndexed { idx, (hash, step) ->
        TxRecord(
            txHash = hash,
            action = stepToAction(step),
            gasUsedWei = if (idx == txHashes.lastIndex) totalGasWei else 0L,
        )
    }
}

private fun stepToAction(step: String): String = when (step.lowercase()) {
    "collect_fees", "collectfees" -> "COLLECT_FEES"
    "burn" -> "BURN"
    "approve" -> "APPROVE"
    "swap" -> "SWAP"
    "mint" -> "MINT"
    "wrap" -> "WRAP"
    "withdraw", "withdraw_to_wallet" -> "WITHDRAW_TO_WALLET"
    else -> "UNKNOWN"
}
