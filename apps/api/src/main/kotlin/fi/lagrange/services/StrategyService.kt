package fi.lagrange.services

import fi.lagrange.model.Strategies
import fi.lagrange.model.StrategyStats
import fi.lagrange.strategy.buildTxRecords
import fi.lagrange.strategy.computeRebalanceMetrics
import fi.lagrange.strategy.toUsd
import kotlinx.datetime.Clock
import kotlinx.serialization.Serializable
import org.jetbrains.exposed.sql.*
import org.jetbrains.exposed.sql.transactions.transaction

@Serializable
data class StrategyRecord(
    val id: Int,
    val userId: Int,
    val name: String,
    val currentTokenId: String,
    val token0: String,
    val token1: String,
    val fee: Int,
    val token0Decimals: Int,
    val token1Decimals: Int,
    val rangePercent: Double,
    val slippageTolerance: Double,
    val pollIntervalSeconds: Long,
    val status: String,
    val createdAt: String,
    val stoppedAt: String?,
    val stopReason: String?,
    val initialToken0Amount: String?,
    val initialToken1Amount: String?,
    val initialValueUsd: Double?,
    val openEthPriceUsd: Double?,
    val endToken0Amount: String?,
    val endToken1Amount: String?,
    val endValueUsd: Double?,
    val endEthPriceUsd: Double?,
    val pendingToken0: String,
    val pendingToken1: String,
)

@Serializable
data class StrategyStatsDto(
    val strategyId: Int,
    val totalRebalances: Int,
    val feesCollectedToken0: String,
    val feesCollectedToken1: String,
    val gasCostWei: Long,
    val gasCostUsd: Double,
    val feesCollectedUsd: Double,
    val totalPollTicks: Int,
    val inRangeTicks: Int,
    val timeInRangePct: Double,
    val avgRebalanceIntervalHours: Double?,
    val updatedAt: String,
    val swapCostToken0: String,
    val swapCostToken1: String,
    val swapCostUsd: Double,
    val avgPriceDriftPct: Double,
    val currentRebalancingDragUsd: Double?,
)

@Serializable
data class ChainTransactionDto(
    val id: Int,
    val txHash: String,
    val action: String,
    val gasUsedWei: Long,
    val ethToUsdPrice: Double,
    val txTimestamp: String,
    val createdAt: String,
)

@Serializable
data class RebalanceDetailsDto(
    val oldNftTokenId: String?,
    val newNftTokenId: String?,
    val newTickLower: Int,
    val newTickUpper: Int,
    val feesCollectedToken0: String,
    val feesCollectedToken1: String,
    val positionToken0Start: String,
    val positionToken1Start: String,
    val positionToken0End: String,
    val positionToken1End: String,
    val gasUsedWei: Long?,
    val ethPriceUsd: Double?,
    val swapCostAmountIn: String?,
    val swapCostAmountOut: String?,
    val swapCostFairAmountOut: String?,
    val swapCostDirection: String?,
    val swapCostUsd: Double?,
    val priceAtDecision: Double?,
    val priceAtEnd: Double?,
    val priceDriftPct: Double?,
    val priceDriftUsd: Double?,
    val rebalancingDragUsd: Double?,
    val hodlValueUsd: Double?,
)

@Serializable
data class StrategyEventDto(
    val id: Int,
    val strategyId: Int,
    val action: String,
    val status: String,
    val errorMessage: String?,
    val triggeredAt: String,
    val completedAt: String?,
    val rebalanceDetails: RebalanceDetailsDto?,
    val transactions: List<ChainTransactionDto>,
)

class StrategyService(
    private val strategyRepo: StrategyRepository,
    private val eventRepo: StrategyEventRepository,
    private val stats: StatsAccumulator,
) {
    // ── CRUD delegation ──────────────────────────────────────────────────────

    fun create(
        userId: Int,
        name: String,
        tokenId: String,
        token0: String,
        token1: String,
        fee: Int,
        token0Decimals: Int = 18,
        token1Decimals: Int = 6,
        rangePercent: Double = 0.05,
        slippageTolerance: Double = 0.005,
        pollIntervalSeconds: Long = 60,
        initialToken0Amount: String? = null,
        initialToken1Amount: String? = null,
        initialValueUsd: java.math.BigDecimal? = null,
        openEthPriceUsd: java.math.BigDecimal? = null,
        pendingToken0: String = "0",
        pendingToken1: String = "0",
    ): StrategyRecord = strategyRepo.create(
        userId, name, tokenId, token0, token1, fee,
        token0Decimals, token1Decimals, rangePercent, slippageTolerance, pollIntervalSeconds,
        initialToken0Amount, initialToken1Amount, initialValueUsd, openEthPriceUsd,
        pendingToken0, pendingToken1,
    )

    fun findById(strategyId: Int, userId: Int): StrategyRecord? = strategyRepo.findById(strategyId, userId)
    fun listForUser(userId: Int): List<StrategyRecord>          = strategyRepo.listForUser(userId)
    fun stop(strategyId: Int, userId: Int, stopReason: String? = null, isError: Boolean = false): Boolean =
        strategyRepo.stop(strategyId, userId, stopReason, isError)
    fun updateTokenId(strategyId: Int, newTokenId: String)                        = strategyRepo.updateTokenId(strategyId, newTokenId)
    fun updatePending(strategyId: Int, pending0: String, pending1: String)        = strategyRepo.updatePending(strategyId, pending0, pending1)
    fun recordStrategySnapshot(strategyId: Int, t0: String, t1: String, v: java.math.BigDecimal, p: java.math.BigDecimal) =
        strategyRepo.recordSnapshot(strategyId, t0, t1, v, p)
    fun recordPollTick(strategyId: Int, inRange: Boolean)                         = stats.recordPollTick(strategyId, inRange)
    fun getEventHistory(strategyId: Int, userId: Int): List<StrategyEventDto>?    = eventRepo.getEventHistory(strategyId, userId)
    fun hasRebalanceInProgress(strategyId: Int): Boolean                          = eventRepo.hasActiveEvent(strategyId)

    // ── Event lifecycle delegation ────────────────────────────────────────────

    fun insertPendingRebalanceEvent(strategyId: Int, idempotencyKey: String): Int =
        eventRepo.insertPendingEvent(strategyId, "REBALANCE", idempotencyKey)

    fun insertPendingCloseEvent(strategyId: Int, idempotencyKey: String): Int =
        eventRepo.insertPendingEvent(strategyId, "CLOSE_STRATEGY", idempotencyKey)

    fun markCloseEventFailed(eventId: Int, errorMessage: String?)    = eventRepo.markEventFailed(eventId, errorMessage)
    fun markRebalanceEventFailed(eventId: Int, errorMessage: String?) = eventRepo.markEventFailed(eventId, errorMessage)
    fun markRebalanceEventInProgress(eventId: Int, errorMessage: String?) = eventRepo.markEventInProgress(eventId, errorMessage)

    // ── Cross-table query ─────────────────────────────────────────────────────

    fun getStats(strategyId: Int, userId: Int): StrategyStatsDto? = transaction {
        val strategy = Strategies.selectAll()
            .where { (Strategies.id eq strategyId) and (Strategies.userId eq userId) }
            .firstOrNull() ?: return@transaction null
        val statsRow = StrategyStats.selectAll().where { StrategyStats.strategyId eq strategyId }.firstOrNull()
            ?: return@transaction null

        val totalRebalances = statsRow[StrategyStats.totalRebalances]
        val avgInterval: Double? = if (totalRebalances > 0) {
            val totalHours = (Clock.System.now() - strategy[Strategies.createdAt]).inWholeMinutes / 60.0
            totalHours / totalRebalances
        } else null

        StrategyStatsDto(
            strategyId                = strategyId,
            totalRebalances           = totalRebalances,
            feesCollectedToken0       = statsRow[StrategyStats.feesCollectedToken0],
            feesCollectedToken1       = statsRow[StrategyStats.feesCollectedToken1],
            gasCostWei                = statsRow[StrategyStats.gasCostWei],
            gasCostUsd                = statsRow[StrategyStats.gasCostUsd].toDouble(),
            feesCollectedUsd          = statsRow[StrategyStats.feesCollectedUsd].toDouble(),
            totalPollTicks            = statsRow[StrategyStats.totalPollTicks],
            inRangeTicks              = statsRow[StrategyStats.inRangeTicks],
            timeInRangePct            = statsRow[StrategyStats.timeInRangePct],
            avgRebalanceIntervalHours = avgInterval,
            updatedAt                 = statsRow[StrategyStats.updatedAt].toString(),
            swapCostToken0            = statsRow[StrategyStats.swapCostToken0],
            swapCostToken1            = statsRow[StrategyStats.swapCostToken1],
            swapCostUsd               = statsRow[StrategyStats.swapCostUsd].toDouble(),
            avgPriceDriftPct          = statsRow[StrategyStats.avgPriceDriftPct].toDouble(),
            currentRebalancingDragUsd = statsRow[StrategyStats.currentRebalancingDragUsd]?.toDouble(),
        )
    }

    // ── Multi-step orchestrations ─────────────────────────────────────────────

    /** Record a completed rebalance: mark event success, persist details + txs, accumulate stats. */
    fun recordRebalanceEvent(
        strategy: StrategyRecord,
        eventId: Int,
        fees0: String,
        fees1: String,
        totalGasWei: Long,
        ethPriceUsd: java.math.BigDecimal,
        txRecords: List<TxRecord>,
        oldNftTokenId: String?,
        newNftTokenId: String?,
        newTickLower: Int,
        newTickUpper: Int,
        positionToken0Start: String,
        positionToken1Start: String,
        positionToken0End: String,
        positionToken1End: String,
        swapCost: SwapCostResponse?,
        priceAtDecision: java.math.BigDecimal,
        priceAtEnd: java.math.BigDecimal?,
    ) = transaction {
        val dec0           = strategy.token0Decimals
        val dec1           = strategy.token1Decimals
        val ethSideIsToken0 = dec0 == 18
        val metrics = computeRebalanceMetrics(
            fees0 = fees0, fees1 = fees1, totalGasWei = totalGasWei, ethPriceUsd = ethPriceUsd,
            dec0 = dec0, dec1 = dec1, ethSideIsToken0 = ethSideIsToken0,
            swapCost = swapCost,
            positionToken0Start = positionToken0Start, positionToken1Start = positionToken1Start,
            priceAtDecision = priceAtDecision, priceAtEnd = priceAtEnd,
            initialToken0Amount = strategy.initialToken0Amount,
            initialToken1Amount = strategy.initialToken1Amount,
        )
        eventRepo.markEventSuccess(eventId)
        eventRepo.insertRebalanceDetails(
            eventId, strategy.id, metrics, fees0, fees1,
            oldNftTokenId, newNftTokenId, newTickLower, newTickUpper,
            positionToken0Start, positionToken1Start, positionToken0End, positionToken1End,
            swapCost, priceAtDecision, priceAtEnd,
        )
        eventRepo.insertChainTransactions(eventId, txRecords, ethPriceUsd)
        stats.addRebalance(strategy.id, metrics, fees0, fees1, totalGasWei, ethPriceUsd, swapCost?.direction)
    }

    /** Record partial on-chain work from a failed rebalance (no rebalance count increment). */
    fun recordFailedRebalanceOnChainWork(
        strategy: StrategyRecord,
        eventId: Int,
        totalGasWei: Long,
        ethPriceUsd: java.math.BigDecimal,
        txRecords: List<TxRecord>,
        fees0: String,
        fees1: String,
    ) = transaction {
        eventRepo.insertChainTransactions(eventId, txRecords, ethPriceUsd)
        val dec0 = strategy.token0Decimals
        val dec1 = strategy.token1Decimals
        stats.addGasAndFees(strategy.id, totalGasWei, ethPriceUsd, fees0, fees1, dec0, dec1, dec0 == 18)
    }

    /** Record the START_STRATEGY event + mint transactions + seed gas into stats. */
    fun recordStartStrategy(strategyId: Int, mintResult: MintResponse, ethPrice: java.math.BigDecimal) = transaction {
        val mintGasLong  = mintResult.gasUsedWei?.toLongOrNull() ?: 0L
        val txRecords    = buildTxRecords(mintResult.txDetails, mintResult.txHashes, null, mintGasLong)
        val idempotencyKey = "start-${strategyId}-${mintResult.tokenId}"
        val eventId      = eventRepo.insertSuccessEvent(strategyId, "START_STRATEGY", idempotencyKey)
        eventRepo.insertChainTransactions(eventId, txRecords, ethPrice)
        stats.addGasCost(strategyId, mintGasLong, ethPrice)
    }

    /**
     * Finalize a close: snapshot end position, update event status, insert chain txs, accumulate stats.
     * Everything in one transaction — a crash cannot leave position snapshotted but stats unrecorded.
     */
    fun finalizeCloseEvent(
        strategyId: Int,
        eventId: Int,
        strategy: StrategyRecord,
        closeResult: CloseResponse?,
        closeEthPriceBD: java.math.BigDecimal,
    ) {
        val HALF_UP        = java.math.RoundingMode.HALF_UP
        val closedOk       = closeResult?.success == true
        val token0Amt      = closeResult?.token0Amount
        val token1Amt      = closeResult?.token1Amount
        val dec0           = strategy.token0Decimals
        val dec1           = strategy.token1Decimals
        val ethSideIsToken0 = dec0 == 18

        val closeValueUsd: java.math.BigDecimal? = if (token0Amt != null && token1Amt != null) {
            toUsd(token0Amt, dec0, closeEthPriceBD, ethSideIsToken0)
                .add(toUsd(token1Amt, dec1, closeEthPriceBD, !ethSideIsToken0))
                .setScale(2, HALF_UP)
        } else null

        transaction {
            strategyRepo.snapshotEnd(strategyId, token0Amt, token1Amt, closeValueUsd, closeEthPriceBD)
            if (closedOk) eventRepo.markEventSuccess(eventId) else eventRepo.markEventFailed(eventId, null)

            if (closedOk && closeResult != null) {
                val closeGasLong = closeResult.gasUsedWei?.toLongOrNull() ?: 0L
                val txRecords    = buildTxRecords(closeResult.txDetails, closeResult.txHashes ?: emptyList(), closeResult.txSteps, closeGasLong)
                eventRepo.insertChainTransactions(eventId, txRecords, closeEthPriceBD)

                val fees0 = closeResult.feesCollected?.amount0 ?: "0"
                val fees1 = closeResult.feesCollected?.amount1 ?: "0"
                stats.addGasAndFees(strategyId, closeGasLong, closeEthPriceBD, fees0, fees1, dec0, dec1, ethSideIsToken0)
            }
        }
    }
}
