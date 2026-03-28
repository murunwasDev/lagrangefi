package fi.lagrange.services

import fi.lagrange.model.RebalanceEvents
import fi.lagrange.model.Strategies
import fi.lagrange.model.StrategyStats
import kotlinx.datetime.Clock
import kotlinx.serialization.Serializable
import org.jetbrains.exposed.sql.*
import org.jetbrains.exposed.sql.transactions.transaction
import kotlin.time.Duration.Companion.hours

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
    val initialToken0Amount: String?,
    val initialToken1Amount: String?,
    val initialValueUsd: Double?,
    val openEthPriceUsd: Double?,
    val openTxHashes: String?,
)

@Serializable
data class StrategyStatsDto(
    val strategyId: Int,
    val totalRebalances: Int,
    val feesCollectedToken0: String,
    val feesCollectedToken1: String,
    val gasCostWei: String,
    val gasCostUsd: Double,
    val feesCollectedUsd: Double,
    val closeEthPriceUsd: Double?,
    val closeFeesUsd: Double?,
    val closeGasUsd: Double?,
    val closeToken0Amount: String?,
    val closeToken1Amount: String?,
    val closeValueUsd: Double?,
    val closeTxHashes: String?,
    val totalPollTicks: Int,
    val inRangeTicks: Int,
    val timeInRangePct: Double,
    val avgRebalanceIntervalHours: Double?,
    val updatedAt: String,
)

class StrategyService {

    /** Create a new strategy for a user. Only one active strategy per user is allowed. */
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
        initialValueUsd: Double? = null,
        initialGasWei: String? = null,
        openEthPriceUsd: Double? = null,
        openTxHashes: String? = null,
    ): StrategyRecord = transaction {
        val activeCount = Strategies.selectAll()
            .where { (Strategies.userId eq userId) and (Strategies.status eq "active") }
            .count()
        require(activeCount == 0L) { "You already have an active strategy. Pause or stop it before creating a new one." }

        val now = Clock.System.now()
        val id = Strategies.insert {
            it[Strategies.userId] = userId
            it[Strategies.name] = name
            it[currentTokenId] = tokenId
            it[Strategies.token0] = token0
            it[Strategies.token1] = token1
            it[Strategies.fee] = fee
            it[Strategies.token0Decimals] = token0Decimals
            it[Strategies.token1Decimals] = token1Decimals
            it[Strategies.rangePercent] = rangePercent
            it[Strategies.slippageTolerance] = slippageTolerance
            it[Strategies.pollIntervalSeconds] = pollIntervalSeconds
            it[status] = "active"
            it[createdAt] = now
            it[stoppedAt] = null
            it[Strategies.initialToken0Amount] = initialToken0Amount
            it[Strategies.initialToken1Amount] = initialToken1Amount
            it[Strategies.initialValueUsd] = initialValueUsd
            it[Strategies.openEthPriceUsd] = openEthPriceUsd
            it[Strategies.openTxHashes] = openTxHashes
        } get Strategies.id

        // Create empty stats row
        StrategyStats.insert {
            it[strategyId] = id
            it[totalRebalances] = 0
            it[feesCollectedToken0] = "0"
            it[feesCollectedToken1] = "0"
            it[gasCostWei] = initialGasWei ?: "0"
            it[totalPollTicks] = 0
            it[inRangeTicks] = 0
            it[timeInRangePct] = 0.0
            it[updatedAt] = now
        }

        rowToRecord(Strategies.selectAll().where { Strategies.id eq id }.single())
    }

    fun findById(strategyId: Int, userId: Int): StrategyRecord? = transaction {
        Strategies.selectAll()
            .where { (Strategies.id eq strategyId) and (Strategies.userId eq userId) }
            .firstOrNull()?.let { rowToRecord(it) }
    }

    fun listForUser(userId: Int): List<StrategyRecord> = transaction {
        Strategies.selectAll()
            .where { Strategies.userId eq userId }
            .orderBy(Strategies.createdAt, SortOrder.DESC)
            .map { rowToRecord(it) }
    }

    fun stop(strategyId: Int, userId: Int): Boolean = transaction {
        val now = Clock.System.now()
        Strategies.update({ (Strategies.id eq strategyId) and (Strategies.userId eq userId) and (Strategies.status neq "stopped") }) {
            it[status] = "stopped"
            it[stoppedAt] = now
        } > 0
    }

    /** Update the current tokenId after a successful rebalance (NFT changes on each rebalance) */
    fun updateTokenId(strategyId: Int, newTokenId: String) = transaction {
        Strategies.update({ Strategies.id eq strategyId }) {
            it[currentTokenId] = newTokenId
        }
    }

    /** Record a poll tick and update time-in-range stats */
    fun recordPollTick(strategyId: Int, inRange: Boolean) = transaction {
        val now = Clock.System.now()
        val row = StrategyStats.selectAll().where { StrategyStats.strategyId eq strategyId }.firstOrNull()
            ?: return@transaction

        val newTotal = row[StrategyStats.totalPollTicks] + 1
        val newInRange = row[StrategyStats.inRangeTicks] + (if (inRange) 1 else 0)
        val newPct = newInRange.toDouble() * 100.0 / newTotal

        StrategyStats.update({ StrategyStats.strategyId eq strategyId }) {
            it[totalPollTicks] = newTotal
            it[inRangeTicks] = newInRange
            it[timeInRangePct] = newPct
            it[updatedAt] = now
        }
    }

    /** Accumulate rebalance outcome into stats */
    fun recordRebalanceSuccess(
        strategyId: Int,
        feesToken0: String,
        feesToken1: String,
        gasWei: String,
        ethPriceUsd: Double,
    ) = transaction {
        val now = Clock.System.now()
        val row = StrategyStats.selectAll().where { StrategyStats.strategyId eq strategyId }.firstOrNull()
            ?: return@transaction

        val newFees0 = (row[StrategyStats.feesCollectedToken0].toBigIntegerOrNull() ?: java.math.BigInteger.ZERO) +
                (feesToken0.toBigIntegerOrNull() ?: java.math.BigInteger.ZERO)
        val newFees1 = (row[StrategyStats.feesCollectedToken1].toBigIntegerOrNull() ?: java.math.BigInteger.ZERO) +
                (feesToken1.toBigIntegerOrNull() ?: java.math.BigInteger.ZERO)
        val newGas = (row[StrategyStats.gasCostWei].toBigIntegerOrNull() ?: java.math.BigInteger.ZERO) +
                (gasWei.toBigIntegerOrNull() ?: java.math.BigInteger.ZERO)
        val gasEth = (gasWei.toBigIntegerOrNull() ?: java.math.BigInteger.ZERO)
            .toBigDecimal().divide(java.math.BigDecimal("1000000000000000000"))
        val newGasUsd = row[StrategyStats.gasCostUsd] + gasEth.toDouble() * ethPriceUsd

        // Compute fees in USD using token decimals from the strategy record
        val strategy = Strategies.selectAll().where { Strategies.id eq strategyId }.firstOrNull()
        val dec0 = strategy?.get(Strategies.token0Decimals) ?: 18
        val dec1 = strategy?.get(Strategies.token1Decimals) ?: 6
        val fee0 = (feesToken0.toBigIntegerOrNull() ?: java.math.BigInteger.ZERO)
            .toBigDecimal().divide(java.math.BigDecimal.TEN.pow(dec0))
        val fee1 = (feesToken1.toBigIntegerOrNull() ?: java.math.BigInteger.ZERO)
            .toBigDecimal().divide(java.math.BigDecimal.TEN.pow(dec1))
        // token0 is WETH (18 dec) → multiply by ETH price; token1 is USDC (6 dec) → face value
        val feesUsd = if (dec0 == 18) fee0.toDouble() * ethPriceUsd + fee1.toDouble()
                      else fee1.toDouble() * ethPriceUsd + fee0.toDouble()
        val newFeesUsd = row[StrategyStats.feesCollectedUsd] + feesUsd

        StrategyStats.update({ StrategyStats.strategyId eq strategyId }) {
            it[totalRebalances] = row[StrategyStats.totalRebalances] + 1
            it[feesCollectedToken0] = newFees0.toString()
            it[feesCollectedToken1] = newFees1.toString()
            it[gasCostWei] = newGas.toString()
            it[gasCostUsd] = newGasUsd
            it[feesCollectedUsd] = newFeesUsd
            it[updatedAt] = now
        }
    }

    /** Snapshot fees, gas, ETH price, and withdrawn amounts at the moment a strategy is stopped */
    fun recordClose(
        strategyId: Int,
        closeEthPriceUsd: Double,
        closeToken0Amount: String? = null,
        closeToken1Amount: String? = null,
        closeValueUsd: Double? = null,
        closeTxHashes: String? = null,
    ) = transaction {
        val stats = StrategyStats.selectAll().where { StrategyStats.strategyId eq strategyId }.firstOrNull()
            ?: return@transaction
        StrategyStats.update({ StrategyStats.strategyId eq strategyId }) {
            it[StrategyStats.closeEthPriceUsd] = closeEthPriceUsd
            it[StrategyStats.closeFeesUsd] = stats[StrategyStats.feesCollectedUsd]
            it[StrategyStats.closeGasUsd] = stats[StrategyStats.gasCostUsd]
            it[StrategyStats.closeToken0Amount] = closeToken0Amount
            it[StrategyStats.closeToken1Amount] = closeToken1Amount
            it[StrategyStats.closeValueUsd] = closeValueUsd
            it[StrategyStats.closeTxHashes] = closeTxHashes
        }
    }

    fun getStats(strategyId: Int, userId: Int): StrategyStatsDto? = transaction {
        // Verify ownership
        Strategies.selectAll()
            .where { (Strategies.id eq strategyId) and (Strategies.userId eq userId) }
            .firstOrNull() ?: return@transaction null

        val strategy = Strategies.selectAll().where { Strategies.id eq strategyId }.single()
        val stats = StrategyStats.selectAll().where { StrategyStats.strategyId eq strategyId }.firstOrNull()
            ?: return@transaction null

        val totalRebalances = stats[StrategyStats.totalRebalances]
        val avgInterval: Double? = if (totalRebalances > 0) {
            val createdAt = strategy[Strategies.createdAt]
            val now = Clock.System.now()
            val totalHours = (now - createdAt).inWholeMinutes / 60.0
            totalHours / totalRebalances
        } else null

        StrategyStatsDto(
            strategyId = strategyId,
            totalRebalances = totalRebalances,
            feesCollectedToken0 = stats[StrategyStats.feesCollectedToken0],
            feesCollectedToken1 = stats[StrategyStats.feesCollectedToken1],
            gasCostWei = stats[StrategyStats.gasCostWei],
            gasCostUsd = stats[StrategyStats.gasCostUsd],
            feesCollectedUsd = stats[StrategyStats.feesCollectedUsd],
            closeEthPriceUsd = stats[StrategyStats.closeEthPriceUsd],
            closeFeesUsd = stats[StrategyStats.closeFeesUsd],
            closeGasUsd = stats[StrategyStats.closeGasUsd],
            closeToken0Amount = stats[StrategyStats.closeToken0Amount],
            closeToken1Amount = stats[StrategyStats.closeToken1Amount],
            closeValueUsd = stats[StrategyStats.closeValueUsd],
            closeTxHashes = stats[StrategyStats.closeTxHashes],
            totalPollTicks = stats[StrategyStats.totalPollTicks],
            inRangeTicks = stats[StrategyStats.inRangeTicks],
            timeInRangePct = stats[StrategyStats.timeInRangePct],
            avgRebalanceIntervalHours = avgInterval,
            updatedAt = stats[StrategyStats.updatedAt].toString(),
        )
    }

    fun getRebalanceHistory(strategyId: Int, userId: Int, limit: Int = 50): List<RebalanceEventDtoKt>? = transaction {
        // Verify ownership
        Strategies.selectAll()
            .where { (Strategies.id eq strategyId) and (Strategies.userId eq userId) }
            .firstOrNull() ?: return@transaction null

        RebalanceEvents.selectAll()
            .where { RebalanceEvents.strategyId eq strategyId }
            .orderBy(RebalanceEvents.triggeredAt, SortOrder.DESC)
            .limit(limit)
            .map { row ->
                RebalanceEventDtoKt(
                    id = row[RebalanceEvents.id],
                    strategyId = row[RebalanceEvents.strategyId],
                    tokenId = row[RebalanceEvents.tokenId],
                    status = row[RebalanceEvents.status],
                    newTickLower = row[RebalanceEvents.newTickLower],
                    newTickUpper = row[RebalanceEvents.newTickUpper],
                    newTokenId = row[RebalanceEvents.newTokenId],
                    txHashes = row[RebalanceEvents.txHashes],
                    txSteps = row[RebalanceEvents.txSteps],
                    feesCollectedToken0 = row[RebalanceEvents.feesCollectedToken0],
                    feesCollectedToken1 = row[RebalanceEvents.feesCollectedToken1],
                    gasCostWei = row[RebalanceEvents.gasCostWei],
                    positionToken0Start = row[RebalanceEvents.positionToken0Start],
                    positionToken1Start = row[RebalanceEvents.positionToken1Start],
                    positionToken0End = row[RebalanceEvents.positionToken0End],
                    positionToken1End = row[RebalanceEvents.positionToken1End],
                    ethPriceUsd = row[RebalanceEvents.ethPriceUsd],
                    errorMessage = row[RebalanceEvents.errorMessage],
                    triggeredAt = row[RebalanceEvents.triggeredAt].toString(),
                    completedAt = row[RebalanceEvents.completedAt]?.toString(),
                )
            }
    }

    private fun rowToRecord(row: ResultRow) = StrategyRecord(
        id = row[Strategies.id],
        userId = row[Strategies.userId],
        name = row[Strategies.name],
        currentTokenId = row[Strategies.currentTokenId],
        token0 = row[Strategies.token0],
        token1 = row[Strategies.token1],
        fee = row[Strategies.fee],
        token0Decimals = row[Strategies.token0Decimals],
        token1Decimals = row[Strategies.token1Decimals],
        rangePercent = row[Strategies.rangePercent],
        slippageTolerance = row[Strategies.slippageTolerance],
        pollIntervalSeconds = row[Strategies.pollIntervalSeconds],
        status = row[Strategies.status],
        createdAt = row[Strategies.createdAt].toString(),
        stoppedAt = row[Strategies.stoppedAt]?.toString(),
        initialToken0Amount = row[Strategies.initialToken0Amount],
        initialToken1Amount = row[Strategies.initialToken1Amount],
        initialValueUsd = row[Strategies.initialValueUsd],
        openEthPriceUsd = row[Strategies.openEthPriceUsd],
        openTxHashes = row[Strategies.openTxHashes],
    )
}

@Serializable
data class RebalanceEventDtoKt(
    val id: Int,
    val strategyId: Int,
    val tokenId: String,
    val status: String,
    val newTickLower: Int?,
    val newTickUpper: Int?,
    val newTokenId: String?,
    val txHashes: String?,
    val txSteps: String?,
    val feesCollectedToken0: String?,
    val feesCollectedToken1: String?,
    val gasCostWei: String?,
    val positionToken0Start: String?,
    val positionToken1Start: String?,
    val positionToken0End: String?,
    val positionToken1End: String?,
    val ethPriceUsd: String?,
    val errorMessage: String?,
    val triggeredAt: String,
    val completedAt: String?,
)
