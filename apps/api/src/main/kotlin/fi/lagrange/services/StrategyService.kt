package fi.lagrange.services

import fi.lagrange.model.ChainTransactions
import fi.lagrange.model.RebalanceDetails
import fi.lagrange.model.Strategies
import fi.lagrange.model.StrategyEvents
import fi.lagrange.model.StrategySnapshots
import fi.lagrange.model.StrategyStats
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
    val currentIlUsd: Double?,
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
    // Computed from chain_transactions (pre-existing gap)
    val gasUsedWei: Long?,
    val ethPriceUsd: Double?,
    // Swap cost
    val swapCostAmountIn: String?,
    val swapCostAmountOut: String?,
    val swapCostFairAmountOut: String?,
    val swapCostDirection: String?,
    val swapCostUsd: Double?,
    // Price drift
    val priceAtDecision: Double?,
    val priceAtEnd: Double?,
    val priceDriftPct: Double?,
    val priceDriftUsd: Double?,
    // Impermanent loss
    val ilUsd: Double?,
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
        openEthPriceUsd: Double? = null,
        pendingToken0: String = "0",
        pendingToken1: String = "0",
    ): StrategyRecord = transaction {
        val activeCount = Strategies.selectAll()
            .where { (Strategies.userId eq userId) and (Strategies.status inList listOf("ACTIVE", "INITIATING")) }
            .count()
        require(activeCount == 0L) { "You already have an active strategy. Pause or stop it before creating a new one." }

        val now = Clock.System.now()
        val initialValueBD: java.math.BigDecimal? = initialValueUsd?.let { java.math.BigDecimal(it.toString()).setScale(2, java.math.RoundingMode.HALF_UP) }
        val openEthBD: java.math.BigDecimal? = openEthPriceUsd?.let { java.math.BigDecimal(it.toString()).setScale(8, java.math.RoundingMode.HALF_UP) }
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
            it[status] = "ACTIVE"
            it[createdAt] = now
            it[stoppedAt] = null
            it[Strategies.initialToken0Amount] = initialToken0Amount
            it[Strategies.initialToken1Amount] = initialToken1Amount
            it[Strategies.initialValueUsd] = initialValueBD
            it[Strategies.openEthPriceUsd] = openEthBD
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

    fun stop(strategyId: Int, userId: Int, stopReason: String? = null, isError: Boolean = false): Boolean = transaction {
        val now = Clock.System.now()
        val newStatus = if (isError) "STOPPED_ON_ERROR" else "STOPPED_MANUALLY"
        Strategies.update({
            (Strategies.id eq strategyId) and
            (Strategies.userId eq userId) and
            (Strategies.status neq "STOPPED_MANUALLY") and
            (Strategies.status neq "STOPPED_ON_ERROR")
        }) {
            it[status] = newStatus
            it[stoppedAt] = now
            it[Strategies.stopReason] = stopReason
        } > 0
    }

    /** Update the current tokenId after a successful rebalance (NFT changes on each rebalance) */
    fun updateTokenId(strategyId: Int, newTokenId: String) = transaction {
        Strategies.update({ Strategies.id eq strategyId }) {
            it[currentTokenId] = newTokenId
        }
    }

    /** Store leftover tokens that did not fit into the last LP mint — carried into the next rebalance */
    fun updatePending(strategyId: Int, pending0: String, pending1: String) = transaction {
        Strategies.update({ Strategies.id eq strategyId }) {
            it[pendingToken0] = pending0
            it[pendingToken1] = pending1
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

    /**
     * Convert a raw token amount to USD.
     * isEthSide=true  → multiply by ethPrice (token is WETH)
     * isEthSide=false → return as-is (token is a USD stablecoin)
     */
    private fun toUsd(
        rawAmount: String,
        decimals: Int,
        ethPrice: java.math.BigDecimal,
        isEthSide: Boolean,
    ): java.math.BigDecimal {
        val human = (rawAmount.toBigIntegerOrNull() ?: java.math.BigInteger.ZERO)
            .toBigDecimal()
            .divide(java.math.BigDecimal.TEN.pow(decimals), decimals, java.math.RoundingMode.HALF_UP)
        return if (isEthSide) human.multiply(ethPrice) else human
    }

    /**
     * Record on-chain work from a failed rebalance (decreaseLiquidity / collect ran before the error).
     * Inserts ChainTransactions for gas accounting and accumulates gas cost + fees into StrategyStats.
     * Does NOT increment totalRebalances — the rebalance did not complete successfully.
     */
    fun recordFailedRebalanceOnChainWork(
        strategyId: Int,
        eventId: Int,
        totalGasWei: Long,
        ethPriceUsd: java.math.BigDecimal,
        txRecords: List<TxRecord>,
        fees0: String,
        fees1: String,
    ) = transaction {
        val now = Clock.System.now()
        val HALF_UP = java.math.RoundingMode.HALF_UP

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

        val statsRow = StrategyStats.selectAll().where { StrategyStats.strategyId eq strategyId }.firstOrNull()
            ?: return@transaction
        val strategy = Strategies.selectAll().where { Strategies.id eq strategyId }.firstOrNull()
        val dec0 = strategy?.get(Strategies.token0Decimals) ?: 18
        val dec1 = strategy?.get(Strategies.token1Decimals) ?: 6
        val ethSideIsToken0 = dec0 == 18

        val gasEth = java.math.BigDecimal(totalGasWei)
            .divide(java.math.BigDecimal("1000000000000000000"), 18, HALF_UP)
        val feesUsd = (toUsd(fees0, dec0, ethPriceUsd, ethSideIsToken0) +
                       toUsd(fees1, dec1, ethPriceUsd, !ethSideIsToken0)).setScale(2, HALF_UP)
        val newFees0 = (statsRow[StrategyStats.feesCollectedToken0].toBigIntegerOrNull() ?: java.math.BigInteger.ZERO) +
                       (fees0.toBigIntegerOrNull() ?: java.math.BigInteger.ZERO)
        val newFees1 = (statsRow[StrategyStats.feesCollectedToken1].toBigIntegerOrNull() ?: java.math.BigInteger.ZERO) +
                       (fees1.toBigIntegerOrNull() ?: java.math.BigInteger.ZERO)

        StrategyStats.update({ StrategyStats.strategyId eq strategyId }) {
            it[gasCostWei] = statsRow[StrategyStats.gasCostWei] + totalGasWei
            it[gasCostUsd] = statsRow[StrategyStats.gasCostUsd] + gasEth.multiply(ethPriceUsd).setScale(2, HALF_UP)
            it[feesCollectedToken0] = newFees0.toString()
            it[feesCollectedToken1] = newFees1.toString()
            it[feesCollectedUsd] = statsRow[StrategyStats.feesCollectedUsd] + feesUsd
            it[updatedAt] = now
        }
    }

    /**
     * Record a completed rebalance event: updates StrategyEvents to success, inserts RebalanceDetails,
     * inserts ChainTransactions, and accumulates StrategyStats — all in one transaction.
     * Must only be called when the rebalance has fully succeeded.
     */
    fun recordRebalanceEvent(
        strategyId: Int,
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
        val now = Clock.System.now()
        val HALF_UP = java.math.RoundingMode.HALF_UP

        val strategy = Strategies.selectAll().where { Strategies.id eq strategyId }.firstOrNull()
        val dec0 = strategy?.get(Strategies.token0Decimals) ?: 18
        val dec1 = strategy?.get(Strategies.token1Decimals) ?: 6
        val ethSideIsToken0 = dec0 == 18  // WETH/USDC pool; for ETH/USDC (USDC=token0) this is false

        // ── Compute all derived values first so both insert and stats update share them ──

        val gasEth = java.math.BigDecimal(totalGasWei).divide(
            java.math.BigDecimal("1000000000000000000"), 18, HALF_UP
        )

        // Fees USD
        val feesUsdNew = (toUsd(fees0, dec0, ethPriceUsd, ethSideIsToken0) +
                          toUsd(fees1, dec1, ethPriceUsd, !ethSideIsToken0))
            .setScale(2, HALF_UP)

        // Swap cost
        val swapCostTokenOutRaw: java.math.BigInteger = swapCost?.let {
            ((it.fairAmountOut.toBigIntegerOrNull() ?: java.math.BigInteger.ZERO) -
             (it.amountOut.toBigIntegerOrNull() ?: java.math.BigInteger.ZERO))
             .coerceAtLeast(java.math.BigInteger.ZERO)
        } ?: java.math.BigInteger.ZERO

        val swapCostUsdNew: java.math.BigDecimal = swapCost?.let {
            val outIsToken0 = it.direction == "oneForZero"
            val (costDec, costIsEth) = if (outIsToken0) dec0 to ethSideIsToken0 else dec1 to !ethSideIsToken0
            toUsd(swapCostTokenOutRaw.toString(), costDec, ethPriceUsd, costIsEth).setScale(2, HALF_UP)
        } ?: java.math.BigDecimal.ZERO

        // Price drift on ETH-side principal only
        val principalStart = if (ethSideIsToken0) positionToken0Start else positionToken1Start
        val feesSide       = if (ethSideIsToken0) fees0 else fees1
        val principalRaw   = ((principalStart.toBigIntegerOrNull() ?: java.math.BigInteger.ZERO) -
                              (feesSide.toBigIntegerOrNull() ?: java.math.BigInteger.ZERO))
                              .coerceAtLeast(java.math.BigInteger.ZERO)
        val principalEthHuman = principalRaw.toBigDecimal()
            .divide(java.math.BigDecimal.TEN.pow(18), 18, HALF_UP)

        val (driftPct, driftUsd) = if (priceAtEnd != null && priceAtDecision > java.math.BigDecimal.ZERO) {
            val pct = (priceAtEnd - priceAtDecision)
                .divide(priceAtDecision, 6, HALF_UP)
                .multiply(java.math.BigDecimal("100"))
                .setScale(4, HALF_UP)
            val usd = principalEthHuman
                .multiply(priceAtEnd - priceAtDecision)
                .setScale(2, HALF_UP)
            pct to usd
        } else {
            java.math.BigDecimal.ZERO to java.math.BigDecimal.ZERO
        }

        // ── Impermanent loss at decision time ──
        // IL = hodlValueUsd - lpValueUsd, both valued at priceAtDecision.
        // hodlValueUsd: what the *initial* token amounts would be worth right now.
        // lpValueUsd:   what the LP position is worth right now (before this rebalance).
        // Positive IL means HODL is ahead; negative means LP is outperforming pure hold.
        val ilHodlPair = run {
            val init0Str = strategy?.get(Strategies.initialToken0Amount)
            val init1Str = strategy?.get(Strategies.initialToken1Amount)
            if (init0Str != null && init1Str != null && priceAtDecision > java.math.BigDecimal.ZERO) {
                val hodl = toUsd(init0Str, dec0, priceAtDecision, ethSideIsToken0) +
                           toUsd(init1Str, dec1, priceAtDecision, !ethSideIsToken0)
                val lp   = toUsd(positionToken0Start, dec0, priceAtDecision, ethSideIsToken0) +
                           toUsd(positionToken1Start, dec1, priceAtDecision, !ethSideIsToken0)
                (hodl - lp).setScale(2, HALF_UP) to hodl.setScale(2, HALF_UP)
            } else {
                null to null
            }
        }
        val ilUsdNew       = ilHodlPair.first
        val hodlValueUsdNew = ilHodlPair.second

        // ── Persist ──

        StrategyEvents.update({ StrategyEvents.id eq eventId }) {
            it[status] = "success"
            it[completedAt] = now
        }

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
            it[RebalanceDetails.swapCostUsd]           = if (swapCost != null) swapCostUsdNew else null
            it[RebalanceDetails.priceAtDecision]       = priceAtDecision.setScale(8, HALF_UP)
            it[RebalanceDetails.priceAtEnd]            = priceAtEnd?.setScale(8, HALF_UP)
            it[RebalanceDetails.priceDriftPct]         = driftPct
            it[RebalanceDetails.priceDriftUsd]         = driftUsd
            it[RebalanceDetails.ilUsd]                 = ilUsdNew
            it[RebalanceDetails.hodlValueUsd]          = hodlValueUsdNew
        }

        for (tx in txRecords) {
            ChainTransactions.insert {
                it[strategyEventId] = eventId
                it[txHash] = tx.txHash
                it[ChainTransactions.action] = tx.action
                it[gasCostWei] = tx.gasUsedWei
                it[ethToUsdPrice] = ethPriceUsd
                it[txTimestamp] = now
                it[createdAt] = now
            }
        }

        val statsRow = StrategyStats.selectAll().where { StrategyStats.strategyId eq strategyId }.firstOrNull()
            ?: return@transaction

        val newFees0 = (statsRow[StrategyStats.feesCollectedToken0].toBigIntegerOrNull() ?: java.math.BigInteger.ZERO) +
                (fees0.toBigIntegerOrNull() ?: java.math.BigInteger.ZERO)
        val newFees1 = (statsRow[StrategyStats.feesCollectedToken1].toBigIntegerOrNull() ?: java.math.BigInteger.ZERO) +
                (fees1.toBigIntegerOrNull() ?: java.math.BigInteger.ZERO)

        val (newSwapCostToken0, newSwapCostToken1) = if (swapCost != null) {
            if (swapCost.direction == "oneForZero") {
                val prev = statsRow[StrategyStats.swapCostToken0].toBigIntegerOrNull() ?: java.math.BigInteger.ZERO
                (prev + swapCostTokenOutRaw).toString() to statsRow[StrategyStats.swapCostToken1]
            } else {
                val prev = statsRow[StrategyStats.swapCostToken1].toBigIntegerOrNull() ?: java.math.BigInteger.ZERO
                statsRow[StrategyStats.swapCostToken0] to (prev + swapCostTokenOutRaw).toString()
            }
        } else {
            statsRow[StrategyStats.swapCostToken0] to statsRow[StrategyStats.swapCostToken1]
        }

        val newTotalRebalances = statsRow[StrategyStats.totalRebalances] + 1
        val oldAvgDrift = statsRow[StrategyStats.avgPriceDriftPct]
        val newAvgDrift = if (newTotalRebalances == 1) driftPct
        else (oldAvgDrift.multiply(java.math.BigDecimal(newTotalRebalances - 1)) + driftPct)
            .divide(java.math.BigDecimal(newTotalRebalances), 4, HALF_UP)

        StrategyStats.update({ StrategyStats.strategyId eq strategyId }) {
            it[totalRebalances] = newTotalRebalances
            it[feesCollectedToken0] = newFees0.toString()
            it[feesCollectedToken1] = newFees1.toString()
            it[gasCostWei] = statsRow[StrategyStats.gasCostWei] + totalGasWei
            it[gasCostUsd] = statsRow[StrategyStats.gasCostUsd] +
                gasEth.multiply(ethPriceUsd).setScale(2, HALF_UP)
            it[feesCollectedUsd] = statsRow[StrategyStats.feesCollectedUsd] + feesUsdNew
            it[swapCostToken0] = newSwapCostToken0
            it[swapCostToken1] = newSwapCostToken1
            it[StrategyStats.swapCostUsd] = statsRow[StrategyStats.swapCostUsd] + swapCostUsdNew
            it[avgPriceDriftPct] = newAvgDrift
            it[StrategyStats.currentIlUsd] = ilUsdNew
            it[updatedAt] = now
        }
    }

    /** Snapshot end position amounts and ETH price onto Strategies when strategy is stopped */
    fun recordClose(
        strategyId: Int,
        endToken0Amount: String? = null,
        endToken1Amount: String? = null,
        endValueUsd: Double? = null,
        endEthPriceUsd: Double? = null,
    ) = transaction {
        val endValueBD: java.math.BigDecimal? = endValueUsd?.let { java.math.BigDecimal(it.toString()).setScale(2, java.math.RoundingMode.HALF_UP) }
        val endEthBD: java.math.BigDecimal? = endEthPriceUsd?.let { java.math.BigDecimal(it.toString()).setScale(8, java.math.RoundingMode.HALF_UP) }
        Strategies.update({ Strategies.id eq strategyId }) {
            it[Strategies.endToken0Amount] = endToken0Amount
            it[Strategies.endToken1Amount] = endToken1Amount
            it[Strategies.endValueUsd] = endValueBD
            it[Strategies.endEthPriceUsd] = endEthBD
        }
    }

    fun getStats(strategyId: Int, userId: Int): StrategyStatsDto? = transaction {
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
            gasCostUsd = stats[StrategyStats.gasCostUsd].toDouble(),
            feesCollectedUsd = stats[StrategyStats.feesCollectedUsd].toDouble(),
            totalPollTicks = stats[StrategyStats.totalPollTicks],
            inRangeTicks = stats[StrategyStats.inRangeTicks],
            timeInRangePct = stats[StrategyStats.timeInRangePct],
            avgRebalanceIntervalHours = avgInterval,
            updatedAt = stats[StrategyStats.updatedAt].toString(),
            swapCostToken0 = stats[StrategyStats.swapCostToken0],
            swapCostToken1 = stats[StrategyStats.swapCostToken1],
            swapCostUsd = stats[StrategyStats.swapCostUsd].toDouble(),
            avgPriceDriftPct = stats[StrategyStats.avgPriceDriftPct].toDouble(),
            currentIlUsd = stats[StrategyStats.currentIlUsd]?.toDouble(),
        )
    }

    fun getEventHistory(strategyId: Int, userId: Int, limit: Int = 50): List<StrategyEventDto>? = transaction {
        Strategies.selectAll()
            .where { (Strategies.id eq strategyId) and (Strategies.userId eq userId) }
            .firstOrNull() ?: return@transaction null

        val events = StrategyEvents.selectAll()
            .where { StrategyEvents.strategyId eq strategyId }
            .orderBy(StrategyEvents.triggeredAt, SortOrder.DESC)
            .limit(limit)
            .toList()

        events.map { eventRow ->
            val eventId = eventRow[StrategyEvents.id]

            // Query transactions first — needed for gasUsedWei and ethPriceUsd on details
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
                        oldNftTokenId = d[RebalanceDetails.oldNftTokenId],
                        newNftTokenId = d[RebalanceDetails.newNftTokenId],
                        newTickLower = d[RebalanceDetails.newTickLower],
                        newTickUpper = d[RebalanceDetails.newTickUpper],
                        feesCollectedToken0 = d[RebalanceDetails.feesCollectedToken0],
                        feesCollectedToken1 = d[RebalanceDetails.feesCollectedToken1],
                        positionToken0Start = d[RebalanceDetails.positionToken0Start],
                        positionToken1Start = d[RebalanceDetails.positionToken1Start],
                        positionToken0End = d[RebalanceDetails.positionToken0End],
                        positionToken1End = d[RebalanceDetails.positionToken1End],
                        gasUsedWei = totalGasUsed,
                        ethPriceUsd = d[RebalanceDetails.priceAtDecision]?.toDouble() ?: firstEthPrice,
                        swapCostAmountIn      = d[RebalanceDetails.swapCostAmountIn],
                        swapCostAmountOut     = d[RebalanceDetails.swapCostAmountOut],
                        swapCostFairAmountOut = d[RebalanceDetails.swapCostFairAmountOut],
                        swapCostDirection     = d[RebalanceDetails.swapCostDirection],
                        swapCostUsd           = d[RebalanceDetails.swapCostUsd]?.toDouble(),
                        priceAtDecision       = d[RebalanceDetails.priceAtDecision]?.toDouble(),
                        priceAtEnd            = d[RebalanceDetails.priceAtEnd]?.toDouble(),
                        priceDriftPct         = d[RebalanceDetails.priceDriftPct]?.toDouble(),
                        priceDriftUsd         = d[RebalanceDetails.priceDriftUsd]?.toDouble(),
                        ilUsd                 = d[RebalanceDetails.ilUsd]?.toDouble(),
                        hodlValueUsd          = d[RebalanceDetails.hodlValueUsd]?.toDouble(),
                    )
                }

            StrategyEventDto(
                id = eventId,
                strategyId = eventRow[StrategyEvents.strategyId],
                action = eventRow[StrategyEvents.action],
                status = eventRow[StrategyEvents.status],
                errorMessage = eventRow[StrategyEvents.errorMessage],
                triggeredAt = eventRow[StrategyEvents.triggeredAt].toString(),
                completedAt = eventRow[StrategyEvents.completedAt]?.toString(),
                rebalanceDetails = details,
                transactions = txs,
            )
        }
    }

    fun recordStrategySnapshot(
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
