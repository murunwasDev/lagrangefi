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
    val rangePercent: Double,
    val slippageTolerance: Double,
    val pollIntervalSeconds: Long,
    val status: String,
    val createdAt: String,
    val stoppedAt: String?,
)

@Serializable
data class StrategyStatsDto(
    val strategyId: Int,
    val totalRebalances: Int,
    val feesCollectedToken0: String,
    val feesCollectedToken1: String,
    val gasCostWei: String,
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
        rangePercent: Double = 0.05,
        slippageTolerance: Double = 0.005,
        pollIntervalSeconds: Long = 60,
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
            it[Strategies.rangePercent] = rangePercent
            it[Strategies.slippageTolerance] = slippageTolerance
            it[Strategies.pollIntervalSeconds] = pollIntervalSeconds
            it[status] = "active"
            it[createdAt] = now
            it[stoppedAt] = null
        } get Strategies.id

        // Create empty stats row
        StrategyStats.insert {
            it[strategyId] = id
            it[totalRebalances] = 0
            it[feesCollectedToken0] = "0"
            it[feesCollectedToken1] = "0"
            it[gasCostWei] = "0"
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

    fun pause(strategyId: Int, userId: Int): Boolean = transaction {
        Strategies.update({ (Strategies.id eq strategyId) and (Strategies.userId eq userId) and (Strategies.status eq "active") }) {
            it[status] = "paused"
        } > 0
    }

    fun resume(strategyId: Int, userId: Int): Boolean = transaction {
        // Ensure no other active strategy exists
        val activeCount = Strategies.selectAll()
            .where { (Strategies.userId eq userId) and (Strategies.status eq "active") and (Strategies.id neq strategyId) }
            .count()
        require(activeCount == 0L) { "Stop or pause your other active strategy first." }

        Strategies.update({ (Strategies.id eq strategyId) and (Strategies.userId eq userId) and (Strategies.status eq "paused") }) {
            it[status] = "active"
        } > 0
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

        StrategyStats.update({ StrategyStats.strategyId eq strategyId }) {
            it[totalRebalances] = row[StrategyStats.totalRebalances] + 1
            it[feesCollectedToken0] = newFees0.toString()
            it[feesCollectedToken1] = newFees1.toString()
            it[gasCostWei] = newGas.toString()
            it[updatedAt] = now
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
                    feesCollectedToken0 = row[RebalanceEvents.feesCollectedToken0],
                    feesCollectedToken1 = row[RebalanceEvents.feesCollectedToken1],
                    gasCostWei = row[RebalanceEvents.gasCostWei],
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
        rangePercent = row[Strategies.rangePercent],
        slippageTolerance = row[Strategies.slippageTolerance],
        pollIntervalSeconds = row[Strategies.pollIntervalSeconds],
        status = row[Strategies.status],
        createdAt = row[Strategies.createdAt].toString(),
        stoppedAt = row[Strategies.stoppedAt]?.toString(),
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
    val feesCollectedToken0: String?,
    val feesCollectedToken1: String?,
    val gasCostWei: String?,
    val errorMessage: String?,
    val triggeredAt: String,
    val completedAt: String?,
)
