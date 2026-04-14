package fi.lagrange.services

import fi.lagrange.model.ChainTransactions
import fi.lagrange.model.EventStatus
import fi.lagrange.model.RebalanceDetails
import fi.lagrange.model.Strategies
import fi.lagrange.model.StrategyEvents
import fi.lagrange.strategy.RebalanceMetrics
import kotlinx.datetime.Clock
import org.jetbrains.exposed.sql.*
import org.jetbrains.exposed.sql.transactions.transaction

class StrategyEventRepository {

    fun insertPendingEvent(strategyId: Int, action: String, idempotencyKey: String): Int = transaction {
        StrategyEvents.insert {
            it[StrategyEvents.strategyId] = strategyId
            it[StrategyEvents.action] = action
            it[StrategyEvents.idempotencyKey] = idempotencyKey
            it[status] = EventStatus.PENDING.value
            it[triggeredAt] = Clock.System.now()
        }[StrategyEvents.id]
    }

    fun insertSuccessEvent(strategyId: Int, action: String, idempotencyKey: String): Int = transaction {
        val now = Clock.System.now()
        StrategyEvents.insert {
            it[StrategyEvents.strategyId] = strategyId
            it[StrategyEvents.action] = action
            it[StrategyEvents.idempotencyKey] = idempotencyKey
            it[status] = EventStatus.SUCCESS.value
            it[triggeredAt] = now
            it[completedAt] = now
        }[StrategyEvents.id]
    }

    fun markEventSuccess(eventId: Int) = transaction {
        StrategyEvents.update({ StrategyEvents.id eq eventId }) {
            it[status] = EventStatus.SUCCESS.value
            it[completedAt] = Clock.System.now()
        }
    }

    fun markEventFailed(eventId: Int, errorMessage: String?) = transaction {
        StrategyEvents.update({ StrategyEvents.id eq eventId }) {
            it[status] = EventStatus.FAILED.value
            it[StrategyEvents.errorMessage] = errorMessage
            it[completedAt] = Clock.System.now()
        }
    }

    fun markEventInProgress(eventId: Int, errorMessage: String?) = transaction {
        StrategyEvents.update({ StrategyEvents.id eq eventId }) {
            it[status] = EventStatus.IN_PROGRESS.value
            it[StrategyEvents.errorMessage] = errorMessage
        }
    }

    fun hasActiveEvent(strategyId: Int): Boolean = transaction {
        StrategyEvents.selectAll()
            .where {
                (StrategyEvents.strategyId eq strategyId) and
                (StrategyEvents.status inList listOf(EventStatus.PENDING.value, EventStatus.IN_PROGRESS.value))
            }
            .any()
    }

    fun insertChainTransactions(
        eventId: Int,
        txRecords: List<TxRecord>,
        ethPriceUsd: java.math.BigDecimal,
    ) = transaction {
        val now = Clock.System.now()
        for (tx in txRecords) {
            try {
                ChainTransactions.insert {
                    it[strategyEventId] = eventId
                    it[txHash] = tx.txHash
                    it[action] = tx.action
                    it[gasCostWei] = tx.gasUsedWei
                    it[ethToUsdPrice] = ethPriceUsd
                    it[txTimestamp] = now
                    it[createdAt] = now
                }
            } catch (_: Exception) {
                // Ignore duplicate tx_hash — idempotent on retry
            }
        }
    }

    fun insertRebalanceDetails(
        eventId: Int,
        strategyId: Int,
        metrics: RebalanceMetrics,
        fees0: String,
        fees1: String,
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
        val HALF_UP = java.math.RoundingMode.HALF_UP
        RebalanceDetails.insert {
            it[strategyEventId] = eventId
            it[RebalanceDetails.strategyId] = strategyId
            it[RebalanceDetails.oldNftTokenId] = oldNftTokenId
            it[RebalanceDetails.newNftTokenId] = newNftTokenId
            it[RebalanceDetails.newTickLower] = newTickLower
            it[RebalanceDetails.newTickUpper] = newTickUpper
            it[feesCollectedToken0] = fees0
            it[feesCollectedToken1] = fees1
            it[RebalanceDetails.positionToken0Start] = positionToken0Start
            it[RebalanceDetails.positionToken1Start] = positionToken1Start
            it[RebalanceDetails.positionToken0End] = positionToken0End
            it[RebalanceDetails.positionToken1End] = positionToken1End
            it[RebalanceDetails.swapCostAmountIn]      = swapCost?.amountIn
            it[RebalanceDetails.swapCostAmountOut]     = swapCost?.amountOut
            it[RebalanceDetails.swapCostFairAmountOut] = swapCost?.fairAmountOut
            it[RebalanceDetails.swapCostDirection]     = swapCost?.direction
            it[RebalanceDetails.swapCostUsd]           = if (swapCost != null) metrics.swapCostUsd else null
            it[RebalanceDetails.priceAtDecision]       = priceAtDecision.setScale(8, HALF_UP)
            it[RebalanceDetails.priceAtEnd]            = priceAtEnd?.setScale(8, HALF_UP)
            it[RebalanceDetails.priceDriftPct]         = metrics.driftPct
            it[RebalanceDetails.priceDriftUsd]         = metrics.driftUsd
            it[RebalanceDetails.rebalancingDragUsd]    = metrics.dragUsd
            it[RebalanceDetails.hodlValueUsd]          = metrics.hodlValueUsd
        }
    }

    fun getEventHistory(strategyId: Int, userId: Int, limit: Int = 50): List<StrategyEventDto>? = transaction {
        Strategies.selectAll()
            .where { (Strategies.id eq strategyId) and (Strategies.userId eq userId) }
            .firstOrNull() ?: return@transaction null

        StrategyEvents.selectAll()
            .where { StrategyEvents.strategyId eq strategyId }
            .orderBy(StrategyEvents.triggeredAt, SortOrder.DESC)
            .limit(limit)
            .map { eventRow ->
                val eventId = eventRow[StrategyEvents.id]
                val txRows = ChainTransactions.selectAll()
                    .where { ChainTransactions.strategyEventId eq eventId }
                    .orderBy(ChainTransactions.txTimestamp, SortOrder.ASC)
                    .toList()

                val txs = txRows.map { tx ->
                    ChainTransactionDto(
                        id = tx[ChainTransactions.id],
                        txHash = tx[ChainTransactions.txHash],
                        action = tx[ChainTransactions.action],
                        gasUsedWei = tx[ChainTransactions.gasCostWei],
                        ethToUsdPrice = tx[ChainTransactions.ethToUsdPrice].toDouble(),
                        txTimestamp = tx[ChainTransactions.txTimestamp].toString(),
                        createdAt = tx[ChainTransactions.createdAt].toString(),
                    )
                }

                val totalGasUsed = txRows.sumOf { it[ChainTransactions.gasCostWei] }.takeIf { it > 0L }
                val firstEthPrice = txRows.firstOrNull()?.get(ChainTransactions.ethToUsdPrice)?.toDouble()

                val details = RebalanceDetails.selectAll()
                    .where { RebalanceDetails.strategyEventId eq eventId }
                    .firstOrNull()?.let { d ->
                        RebalanceDetailsDto(
                            oldNftTokenId         = d[RebalanceDetails.oldNftTokenId],
                            newNftTokenId         = d[RebalanceDetails.newNftTokenId],
                            newTickLower          = d[RebalanceDetails.newTickLower],
                            newTickUpper          = d[RebalanceDetails.newTickUpper],
                            feesCollectedToken0   = d[RebalanceDetails.feesCollectedToken0],
                            feesCollectedToken1   = d[RebalanceDetails.feesCollectedToken1],
                            positionToken0Start   = d[RebalanceDetails.positionToken0Start],
                            positionToken1Start   = d[RebalanceDetails.positionToken1Start],
                            positionToken0End     = d[RebalanceDetails.positionToken0End],
                            positionToken1End     = d[RebalanceDetails.positionToken1End],
                            gasUsedWei            = totalGasUsed,
                            ethPriceUsd           = d[RebalanceDetails.priceAtDecision]?.toDouble() ?: firstEthPrice,
                            swapCostAmountIn      = d[RebalanceDetails.swapCostAmountIn],
                            swapCostAmountOut     = d[RebalanceDetails.swapCostAmountOut],
                            swapCostFairAmountOut = d[RebalanceDetails.swapCostFairAmountOut],
                            swapCostDirection     = d[RebalanceDetails.swapCostDirection],
                            swapCostUsd           = d[RebalanceDetails.swapCostUsd]?.toDouble(),
                            priceAtDecision       = d[RebalanceDetails.priceAtDecision]?.toDouble(),
                            priceAtEnd            = d[RebalanceDetails.priceAtEnd]?.toDouble(),
                            priceDriftPct         = d[RebalanceDetails.priceDriftPct]?.toDouble(),
                            priceDriftUsd         = d[RebalanceDetails.priceDriftUsd]?.toDouble(),
                            rebalancingDragUsd    = d[RebalanceDetails.rebalancingDragUsd]?.toDouble(),
                            hodlValueUsd          = d[RebalanceDetails.hodlValueUsd]?.toDouble(),
                        )
                    }

                StrategyEventDto(
                    id              = eventId,
                    strategyId      = eventRow[StrategyEvents.strategyId],
                    action          = eventRow[StrategyEvents.action],
                    status          = eventRow[StrategyEvents.status],
                    errorMessage    = eventRow[StrategyEvents.errorMessage],
                    triggeredAt     = eventRow[StrategyEvents.triggeredAt].toString(),
                    completedAt     = eventRow[StrategyEvents.completedAt]?.toString(),
                    rebalanceDetails = details,
                    transactions    = txs,
                )
            }
    }
}
