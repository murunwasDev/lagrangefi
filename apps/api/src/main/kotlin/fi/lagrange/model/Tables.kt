package fi.lagrange.model

import org.jetbrains.exposed.sql.Table
import org.jetbrains.exposed.sql.kotlin.datetime.timestamp

object Users : Table("users") {
    val id = integer("id").autoIncrement()
    val username = varchar("username", 64).uniqueIndex()
    val passwordHash = varchar("password_hash", 128)
    val createdAt = timestamp("created_at")
    override val primaryKey = PrimaryKey(id)
}

object Wallets : Table("wallets") {
    val id = integer("id").autoIncrement()
    val userId = integer("user_id").references(Users.id).uniqueIndex()
    /** AES-256-GCM encrypted wallet phrase (mnemonic or private key), base64 encoded */
    val encryptedPhrase = text("encrypted_phrase")
    val createdAt = timestamp("created_at")
    val updatedAt = timestamp("updated_at")
    override val primaryKey = PrimaryKey(id)
}

object Strategies : Table("strategies") {
    val id = integer("id").autoIncrement()
    val userId = integer("user_id").references(Users.id)
    val name = varchar("name", 128)
    val currentTokenId = varchar("current_token_id", 78)
    val token0 = varchar("token0", 42)
    val token1 = varchar("token1", 42)
    val fee = integer("fee")
    val token0Decimals = integer("token0_decimals").default(18)
    val token1Decimals = integer("token1_decimals").default(6)
    val rangePercent = double("range_percent").default(0.05)
    val slippageTolerance = double("slippage_tolerance").default(0.005)
    val pollIntervalSeconds = long("poll_interval_seconds").default(60)
    /** INITIATING | ACTIVE | STOPPED_MANUALLY | STOPPED_ON_ERROR */
    val status = varchar("status", 20).default("ACTIVE")
    val createdAt = timestamp("created_at")
    val stoppedAt = timestamp("stopped_at").nullable()
    val stopReason = text("stop_reason").nullable()
    /** Open snapshot — recorded at strategy creation time */
    val initialToken0Amount = varchar("initial_token0_amount", 78).nullable()
    val initialToken1Amount = varchar("initial_token1_amount", 78).nullable()
    val initialValueUsd = decimal("initial_value_usd", 18, 2).nullable()
    val openEthPriceUsd = decimal("open_eth_price_usd", 18, 8).nullable()
    /** End snapshot — recorded when strategy is stopped */
    val endToken0Amount = varchar("end_token0_amount", 78).nullable()
    val endToken1Amount = varchar("end_token1_amount", 78).nullable()
    val endValueUsd = decimal("end_value_usd", 18, 2).nullable()
    val endEthPriceUsd = decimal("end_eth_price_usd", 18, 8).nullable()
    /** Leftover tokens that did not fit into the last LP position (carried into the next rebalance) */
    val pendingToken0 = varchar("pending_token0", 78).default("0")
    val pendingToken1 = varchar("pending_token1", 78).default("0")
    override val primaryKey = PrimaryKey(id)
}

object StrategyStats : Table("strategy_stats") {
    val strategyId = integer("strategy_id").references(Strategies.id)
    val totalRebalances = integer("total_rebalances").default(0)
    /** Raw token amounts stored as decimal strings (arbitrary precision ERC-20 values) */
    val feesCollectedToken0 = varchar("fees_collected_token0", 78).default("0")
    val feesCollectedToken1 = varchar("fees_collected_token1", 78).default("0")
    /** Total gas cost across all rebalances in wei (fits in Long: max ~9.2×10^18 wei) */
    val gasCostWei = long("gas_cost_wei").default(0L)
    /** Total gas and fees in USD, accumulated at historical ETH price per rebalance */
    val gasCostUsd = decimal("gas_cost_usd", 18, 2).default(java.math.BigDecimal.ZERO)
    val feesCollectedUsd = decimal("fees_collected_usd", 18, 2).default(java.math.BigDecimal.ZERO)
    // Swap cost accumulation
    val swapCostToken0   = varchar("swap_cost_token0", 78).default("0")
    val swapCostToken1   = varchar("swap_cost_token1", 78).default("0")
    val swapCostUsd      = decimal("swap_cost_usd", 18, 2).default(java.math.BigDecimal.ZERO)
    // Average price drift per rebalance (running average, not a sum)
    val avgPriceDriftPct = decimal("avg_price_drift_pct", 8, 4).default(java.math.BigDecimal.ZERO)
    // Rebalancing drag snapshot from the most recent rebalance (hodlValue - lpValue at priceAtDecision)
    val currentRebalancingDragUsd = decimal("current_rebalancing_drag_usd", 18, 2).nullable()
    val totalPollTicks = integer("total_poll_ticks").default(0)
    val inRangeTicks = integer("in_range_ticks").default(0)
    val timeInRangePct = double("time_in_range_pct").default(0.0)
    val updatedAt = timestamp("updated_at")
    override val primaryKey = PrimaryKey(strategyId)
}

object StrategyEvents : Table("strategy_events") {
    val id = integer("id").autoIncrement()
    val strategyId = integer("strategy_id").references(Strategies.id)
    /** REBALANCE | START_STRATEGY | CLOSE_STRATEGY */
    val action = varchar("action", 32)
    val idempotencyKey = varchar("idempotency_key", 64).uniqueIndex()
    /** pending | success | failed */
    val status = varchar("status", 20)
    val errorMessage = text("error_message").nullable()
    val triggeredAt = timestamp("triggered_at")
    val completedAt = timestamp("completed_at").nullable()
    override val primaryKey = PrimaryKey(id)
}

object RebalanceDetails : Table("rebalance_details") {
    val strategyEventId = integer("strategy_event_id").references(StrategyEvents.id)
    /** Denormalized for query convenience. Must always equal StrategyEvents.strategyId for the same event. */
    val strategyId = integer("strategy_id").references(Strategies.id)
    val oldNftTokenId = varchar("old_nft_token_id", 78).nullable()
    val newNftTokenId = varchar("new_nft_token_id", 78).nullable()
    val newTickLower = integer("new_tick_lower")
    val newTickUpper = integer("new_tick_upper")
    val feesCollectedToken0 = varchar("fees_collected_token0", 78)
    val feesCollectedToken1 = varchar("fees_collected_token1", 78)
    val positionToken0Start = varchar("position_token0_start", 78)
    val positionToken1Start = varchar("position_token1_start", 78)
    val positionToken0End = varchar("position_token0_end", 78)
    val positionToken1End = varchar("position_token1_end", 78)
    // Swap cost (null when no swap was needed)
    val swapCostAmountIn      = varchar("swap_cost_amount_in", 78).nullable()
    val swapCostAmountOut     = varchar("swap_cost_amount_out", 78).nullable()
    val swapCostFairAmountOut = varchar("swap_cost_fair_amount_out", 78).nullable()
    val swapCostDirection     = varchar("swap_cost_direction", 12).nullable()  // zeroForOne | oneForZero
    val swapCostUsd           = decimal("swap_cost_usd", 18, 2).nullable()
    // Price drift
    val priceAtDecision = decimal("price_at_decision", 18, 8).nullable()
    val priceAtEnd      = decimal("price_at_end", 18, 8).nullable()
    val priceDriftPct   = decimal("price_drift_pct", 8, 4).nullable()
    val priceDriftUsd   = decimal("price_drift_usd", 18, 2).nullable()
    // Rebalancing drag at this rebalance moment (hodlValueUsd - lpValueUsd at priceAtDecision)
    val rebalancingDragUsd = decimal("rebalancing_drag_usd", 18, 2).nullable()
    val hodlValueUsd       = decimal("hodl_value_usd", 18, 2).nullable()
    override val primaryKey = PrimaryKey(strategyEventId)
}

object ChainTransactions : Table("chain_transactions") {
    val id = integer("id").autoIncrement()
    val strategyEventId = integer("strategy_event_id").references(StrategyEvents.id)
    val txHash = varchar("tx_hash", 66).uniqueIndex()
    /** COLLECT_FEES | BURN | APPROVE | SWAP | MINT | WITHDRAW_TO_WALLET | UNKNOWN */
    val action = varchar("action", 32)
    val gasCostWei = long("gas_cost_wei")
    val ethToUsdPrice = decimal("eth_to_usd_price", 18, 8)
    val txTimestamp = timestamp("tx_timestamp")
    val createdAt = timestamp("created_at")
    override val primaryKey = PrimaryKey(id)
}

object StrategySnapshots : Table("strategy_snapshots") {
    val id = integer("id").autoIncrement()
    val strategyId = integer("strategy_id").references(Strategies.id)
    val token0Amount = varchar("token0_amount", 78)
    val token1Amount = varchar("token1_amount", 78)
    val valueUsd = decimal("value_usd", 18, 2)
    val ethPriceUsd = decimal("eth_price_usd", 18, 8)
    val snapshotAt = timestamp("snapshot_at")
    override val primaryKey = PrimaryKey(id)
}
