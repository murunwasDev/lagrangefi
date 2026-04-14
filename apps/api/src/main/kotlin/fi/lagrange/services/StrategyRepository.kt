package fi.lagrange.services

import fi.lagrange.model.Strategies
import fi.lagrange.model.StrategySnapshots
import fi.lagrange.model.StrategyStats
import fi.lagrange.model.StrategyStatus
import kotlinx.datetime.Clock
import org.jetbrains.exposed.sql.*
import org.jetbrains.exposed.sql.transactions.transaction

class StrategyRepository {

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
    ): StrategyRecord = transaction {
        val activeCount = Strategies.selectAll()
            .where {
                (Strategies.userId eq userId) and
                (Strategies.status inList listOf(StrategyStatus.ACTIVE.value, StrategyStatus.INITIATING.value))
            }
            .count()
        require(activeCount == 0L) { "You already have an active strategy. Pause or stop it before creating a new one." }

        val now = Clock.System.now()
        val HALF_UP = java.math.RoundingMode.HALF_UP
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
            it[status] = StrategyStatus.ACTIVE.value
            it[createdAt] = now
            it[stoppedAt] = null
            it[Strategies.initialToken0Amount] = initialToken0Amount
            it[Strategies.initialToken1Amount] = initialToken1Amount
            it[Strategies.initialValueUsd] = initialValueUsd?.setScale(2, HALF_UP)
            it[Strategies.openEthPriceUsd] = openEthPriceUsd?.setScale(8, HALF_UP)
            it[Strategies.pendingToken0] = pendingToken0
            it[Strategies.pendingToken1] = pendingToken1
        } get Strategies.id

        StrategyStats.insert {
            it[strategyId] = id
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

    fun findAllActive(): List<StrategyRecord> = transaction {
        Strategies.selectAll()
            .where { Strategies.status eq StrategyStatus.ACTIVE.value }
            .map { rowToRecord(it) }
    }

    fun findActiveById(strategyId: Int): StrategyRecord? = transaction {
        Strategies.selectAll()
            .where { (Strategies.id eq strategyId) and (Strategies.status eq StrategyStatus.ACTIVE.value) }
            .firstOrNull()?.let { rowToRecord(it) }
    }

    fun stop(strategyId: Int, userId: Int, stopReason: String? = null, isError: Boolean = false): Boolean = transaction {
        val newStatus = if (isError) StrategyStatus.STOPPED_ON_ERROR.value else StrategyStatus.STOPPED_MANUALLY.value
        Strategies.update({
            (Strategies.id eq strategyId) and
            (Strategies.userId eq userId) and
            (Strategies.status neq StrategyStatus.STOPPED_MANUALLY.value) and
            (Strategies.status neq StrategyStatus.STOPPED_ON_ERROR.value)
        }) {
            it[status] = newStatus
            it[stoppedAt] = Clock.System.now()
            it[Strategies.stopReason] = stopReason
        } > 0
    }

    fun updateTokenId(strategyId: Int, newTokenId: String) = transaction {
        Strategies.update({ Strategies.id eq strategyId }) { it[currentTokenId] = newTokenId }
    }

    fun updatePending(strategyId: Int, pending0: String, pending1: String) = transaction {
        Strategies.update({ Strategies.id eq strategyId }) {
            it[pendingToken0] = pending0
            it[pendingToken1] = pending1
        }
    }

    fun snapshotEnd(
        strategyId: Int,
        token0Amt: String?,
        token1Amt: String?,
        valueUsd: java.math.BigDecimal?,
        ethPriceBD: java.math.BigDecimal,
    ) = transaction {
        Strategies.update({ Strategies.id eq strategyId }) {
            it[Strategies.endToken0Amount] = token0Amt
            it[Strategies.endToken1Amount] = token1Amt
            it[Strategies.endValueUsd] = valueUsd
            it[Strategies.endEthPriceUsd] = ethPriceBD.setScale(8, java.math.RoundingMode.HALF_UP)
        }
    }

    fun recordSnapshot(
        strategyId: Int,
        token0Amount: String,
        token1Amount: String,
        valueUsd: java.math.BigDecimal,
        ethPriceUsd: java.math.BigDecimal,
    ) = transaction {
        StrategySnapshots.insert {
            it[StrategySnapshots.strategyId] = strategyId
            it[StrategySnapshots.token0Amount] = token0Amount
            it[StrategySnapshots.token1Amount] = token1Amount
            it[StrategySnapshots.valueUsd] = valueUsd
            it[StrategySnapshots.ethPriceUsd] = ethPriceUsd
            it[snapshotAt] = Clock.System.now()
        }
    }

    internal fun rowToRecord(row: ResultRow) = StrategyRecord(
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
        stopReason = row[Strategies.stopReason],
        initialToken0Amount = row[Strategies.initialToken0Amount],
        initialToken1Amount = row[Strategies.initialToken1Amount],
        initialValueUsd = row[Strategies.initialValueUsd]?.toDouble(),
        openEthPriceUsd = row[Strategies.openEthPriceUsd]?.toDouble(),
        endToken0Amount = row[Strategies.endToken0Amount],
        endToken1Amount = row[Strategies.endToken1Amount],
        endValueUsd = row[Strategies.endValueUsd]?.toDouble(),
        endEthPriceUsd = row[Strategies.endEthPriceUsd]?.toDouble(),
        pendingToken0 = row[Strategies.pendingToken0],
        pendingToken1 = row[Strategies.pendingToken1],
    )
}
