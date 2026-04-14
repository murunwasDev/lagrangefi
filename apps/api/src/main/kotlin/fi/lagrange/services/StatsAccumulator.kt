package fi.lagrange.services

import fi.lagrange.model.StrategyStats
import fi.lagrange.strategy.RebalanceMetrics
import fi.lagrange.strategy.toUsd
import fi.lagrange.strategy.weiToEth
import kotlinx.datetime.Clock
import org.jetbrains.exposed.sql.selectAll
import org.jetbrains.exposed.sql.transactions.transaction
import org.jetbrains.exposed.sql.update

class StatsAccumulator {

    fun recordPollTick(strategyId: Int, inRange: Boolean) = transaction {
        val row = StrategyStats.selectAll().where { StrategyStats.strategyId eq strategyId }.firstOrNull()
            ?: return@transaction
        val newTotal   = row[StrategyStats.totalPollTicks] + 1
        val newInRange = row[StrategyStats.inRangeTicks] + (if (inRange) 1 else 0)
        StrategyStats.update({ StrategyStats.strategyId eq strategyId }) {
            it[totalPollTicks]  = newTotal
            it[inRangeTicks]    = newInRange
            it[timeInRangePct]  = newInRange.toDouble() * 100.0 / newTotal
            it[updatedAt]       = Clock.System.now()
        }
    }

    /** Accumulate stats for a completed rebalance (increments rebalance count). */
    fun addRebalance(
        strategyId: Int,
        metrics: RebalanceMetrics,
        fees0: String,
        fees1: String,
        totalGasWei: Long,
        ethPriceUsd: java.math.BigDecimal,
        swapCostDirection: String?,
    ) = transaction {
        val HALF_UP  = java.math.RoundingMode.HALF_UP
        val statsRow = StrategyStats.selectAll().where { StrategyStats.strategyId eq strategyId }.firstOrNull()
            ?: return@transaction

        val newFees0 = (statsRow[StrategyStats.feesCollectedToken0].toBigIntegerOrNull() ?: java.math.BigInteger.ZERO) +
                       (fees0.toBigIntegerOrNull() ?: java.math.BigInteger.ZERO)
        val newFees1 = (statsRow[StrategyStats.feesCollectedToken1].toBigIntegerOrNull() ?: java.math.BigInteger.ZERO) +
                       (fees1.toBigIntegerOrNull() ?: java.math.BigInteger.ZERO)

        val (newSwapCost0, newSwapCost1) = when (swapCostDirection) {
            "oneForZero" -> {
                val prev = statsRow[StrategyStats.swapCostToken0].toBigIntegerOrNull() ?: java.math.BigInteger.ZERO
                (prev + metrics.swapCostTokenOutRaw).toString() to statsRow[StrategyStats.swapCostToken1]
            }
            "zeroForOne" -> {
                val prev = statsRow[StrategyStats.swapCostToken1].toBigIntegerOrNull() ?: java.math.BigInteger.ZERO
                statsRow[StrategyStats.swapCostToken0] to (prev + metrics.swapCostTokenOutRaw).toString()
            }
            else -> statsRow[StrategyStats.swapCostToken0] to statsRow[StrategyStats.swapCostToken1]
        }

        val newTotalRebalances = statsRow[StrategyStats.totalRebalances] + 1
        val newAvgDrift = if (newTotalRebalances == 1) metrics.driftPct
        else (statsRow[StrategyStats.avgPriceDriftPct].multiply(java.math.BigDecimal(newTotalRebalances - 1)) + metrics.driftPct)
            .divide(java.math.BigDecimal(newTotalRebalances), 4, HALF_UP)

        StrategyStats.update({ StrategyStats.strategyId eq strategyId }) {
            it[totalRebalances]            = newTotalRebalances
            it[feesCollectedToken0]        = newFees0.toString()
            it[feesCollectedToken1]        = newFees1.toString()
            it[gasCostWei]                 = statsRow[StrategyStats.gasCostWei] + totalGasWei
            it[gasCostUsd]                 = statsRow[StrategyStats.gasCostUsd] +
                                             metrics.gasEth.multiply(ethPriceUsd).setScale(2, HALF_UP)
            it[feesCollectedUsd]           = statsRow[StrategyStats.feesCollectedUsd] + metrics.feesUsd
            it[swapCostToken0]             = newSwapCost0
            it[swapCostToken1]             = newSwapCost1
            it[StrategyStats.swapCostUsd]  = statsRow[StrategyStats.swapCostUsd] + metrics.swapCostUsd
            it[avgPriceDriftPct]           = newAvgDrift
            it[StrategyStats.currentRebalancingDragUsd] = metrics.dragUsd
            it[updatedAt]                  = Clock.System.now()
        }
    }

    /** Accumulate gas + fees for partial on-chain work (failed rebalance, close). Does NOT increment rebalance count. */
    fun addGasAndFees(
        strategyId: Int,
        totalGasWei: Long,
        ethPriceUsd: java.math.BigDecimal,
        fees0: String,
        fees1: String,
        dec0: Int,
        dec1: Int,
        ethSideIsToken0: Boolean,
    ) = transaction {
        val HALF_UP  = java.math.RoundingMode.HALF_UP
        val statsRow = StrategyStats.selectAll().where { StrategyStats.strategyId eq strategyId }.firstOrNull()
            ?: return@transaction

        val gasEth   = weiToEth(totalGasWei)
        val feesUsd  = (toUsd(fees0, dec0, ethPriceUsd, ethSideIsToken0) +
                        toUsd(fees1, dec1, ethPriceUsd, !ethSideIsToken0)).setScale(2, HALF_UP)
        val newFees0 = (statsRow[StrategyStats.feesCollectedToken0].toBigIntegerOrNull() ?: java.math.BigInteger.ZERO) +
                       (fees0.toBigIntegerOrNull() ?: java.math.BigInteger.ZERO)
        val newFees1 = (statsRow[StrategyStats.feesCollectedToken1].toBigIntegerOrNull() ?: java.math.BigInteger.ZERO) +
                       (fees1.toBigIntegerOrNull() ?: java.math.BigInteger.ZERO)

        StrategyStats.update({ StrategyStats.strategyId eq strategyId }) {
            it[gasCostWei]          = statsRow[StrategyStats.gasCostWei] + totalGasWei
            it[gasCostUsd]          = statsRow[StrategyStats.gasCostUsd] + gasEth.multiply(ethPriceUsd).setScale(2, HALF_UP)
            it[feesCollectedToken0] = newFees0.toString()
            it[feesCollectedToken1] = newFees1.toString()
            it[feesCollectedUsd]    = statsRow[StrategyStats.feesCollectedUsd] + feesUsd
            it[updatedAt]           = Clock.System.now()
        }
    }

    /** Accumulate only gas cost (no fees) — used for START_STRATEGY recording. */
    fun addGasCost(strategyId: Int, totalGasWei: Long, ethPriceUsd: java.math.BigDecimal) = transaction {
        val HALF_UP  = java.math.RoundingMode.HALF_UP
        val statsRow = StrategyStats.selectAll().where { StrategyStats.strategyId eq strategyId }.firstOrNull()
            ?: return@transaction
        val gasEth = weiToEth(totalGasWei)
        StrategyStats.update({ StrategyStats.strategyId eq strategyId }) {
            it[gasCostWei] = statsRow[StrategyStats.gasCostWei] + totalGasWei
            it[gasCostUsd] = statsRow[StrategyStats.gasCostUsd] + gasEth.multiply(ethPriceUsd).setScale(2, HALF_UP)
            it[updatedAt]  = Clock.System.now()
        }
    }
}
