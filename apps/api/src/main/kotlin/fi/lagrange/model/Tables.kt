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
    /** active | stopped */
    val status = varchar("status", 16).default("active")
    val createdAt = timestamp("created_at")
    val stoppedAt = timestamp("stopped_at").nullable()
    /** Initial deposit amounts (raw units) and USD value at strategy creation time */
    val initialToken0Amount = varchar("initial_token0_amount", 78).nullable()
    val initialToken1Amount = varchar("initial_token1_amount", 78).nullable()
    val initialValueUsd = double("initial_value_usd").nullable()
    /** ETH price at strategy open time (for historical deposit USD calculations) */
    val openEthPriceUsd = double("open_eth_price_usd").nullable()
    /** JSON array of tx hashes for the initial mint transaction(s) */
    val openTxHashes = text("open_tx_hashes").nullable()
    override val primaryKey = PrimaryKey(id)
}

object StrategyStats : Table("strategy_stats") {
    val strategyId = integer("strategy_id").references(Strategies.id)
    val totalRebalances = integer("total_rebalances").default(0)
    /** Raw token amounts stored as decimal strings */
    val feesCollectedToken0 = varchar("fees_collected_token0", 78).default("0")
    val feesCollectedToken1 = varchar("fees_collected_token1", 78).default("0")
    /** Total gas cost across all rebalances, in wei, stored as decimal string */
    val gasCostWei = varchar("gas_cost_wei", 78).default("0")
    /** Total gas cost in USD, accumulated at the ETH price at time of each rebalance */
    val gasCostUsd = double("gas_cost_usd").default(0.0)
    /** Total fees collected in USD, accumulated at historical ETH price per rebalance */
    val feesCollectedUsd = double("fees_collected_usd").default(0.0)
    /** Snapshot of ETH price, fees, and gas at the time the strategy was stopped */
    val closeEthPriceUsd = double("close_eth_price_usd").nullable()
    val closeFeesUsd = double("close_fees_usd").nullable()
    val closeGasUsd = double("close_gas_usd").nullable()
    /** Token amounts and USD value at close (principal + fees collected, raw units) */
    val closeToken0Amount = varchar("close_token0_amount", 78).nullable()
    val closeToken1Amount = varchar("close_token1_amount", 78).nullable()
    val closeValueUsd = double("close_value_usd").nullable()
    /** JSON array of tx hashes for the close transaction(s) */
    val closeTxHashes = text("close_tx_hashes").nullable()
    val totalPollTicks = integer("total_poll_ticks").default(0)
    val inRangeTicks = integer("in_range_ticks").default(0)
    val timeInRangePct = double("time_in_range_pct").default(0.0)
    val updatedAt = timestamp("updated_at")
    override val primaryKey = PrimaryKey(strategyId)
}

object RebalanceEvents : Table("rebalance_events") {
    val id = integer("id").autoIncrement()
    val strategyId = integer("strategy_id").references(Strategies.id)
    val tokenId = varchar("token_id", 78)
    val idempotencyKey = varchar("idempotency_key", 64).uniqueIndex()
    /** pending | success | failed */
    val status = varchar("status", 20)
    val newTickLower = integer("new_tick_lower").nullable()
    val newTickUpper = integer("new_tick_upper").nullable()
    val newTokenId = varchar("new_token_id", 78).nullable()
    val txHashes = text("tx_hashes").nullable() // JSON array
    val txSteps = text("tx_steps").nullable() // JSON array of step labels matching txHashes
    val feesCollectedToken0 = varchar("fees_collected_token0", 78).nullable()
    val feesCollectedToken1 = varchar("fees_collected_token1", 78).nullable()
    val gasCostWei = varchar("gas_cost_wei", 78).nullable()
    val positionToken0Start = varchar("position_token0_start", 78).nullable()
    val positionToken1Start = varchar("position_token1_start", 78).nullable()
    val positionToken0End = varchar("position_token0_end", 78).nullable()
    val positionToken1End = varchar("position_token1_end", 78).nullable()
    /** ETH price in USD (USDC per WETH) at the time of the rebalance, for tax reporting */
    val ethPriceUsd = varchar("eth_price_usd", 32).nullable()
    val errorMessage = text("error_message").nullable()
    val triggeredAt = timestamp("triggered_at")
    val completedAt = timestamp("completed_at").nullable()
    override val primaryKey = PrimaryKey(id)
}
